// 任务 D · 零模型检索自校准（第一步：只采集，不调权重）
//
// 要回答的问题只有一句：**检索出来的会话，后来真的被打开了吗？**
//   · 检索侧（MCP srelay_search / CLI srelay search）：把本次候选（会话 id + 名次）
//     留在**进程内存**里，TTL 5 分钟；
//   · 打开侧（MCP srelay_show / CLI srelay show）：同一进程内、该会话在候选里 →
//     往全局库 search_feedback 记一条 open。
//
// 三点刻意选择（都不是随手决定的）：
//   ① 候选只留内存、不落库：它是「刚才那次检索」的瞬时状态，价值只在那几分钟；
//      落库意味着每次检索写一次库，而 MCP 是常驻进程、检索很频繁。
//      代价是：CLI 的 search 与 show 是**两个进程**，这条路对 CLI 实际不生效 ——
//      但契约一致（同进程才成立），写在这里比在 CLI 里另立一套判据好。
//   ② 事件写**全局库**（~/.sessionrelay/global.sqlite），不写项目库：
//      「排序好不好」是跨项目才统计得出来的；且本表**不含正文、不含路径、不含明文查询**
//      —— 只存 query_hash。隐私边界与经验层同一条。
//   ③ 本模块**不参与排序**：第一步只采集。改权重必须等 feedbackStats 攒够样本，
//      否则就是拿几个样本的手感去改一个全局判据（本仓最贵的一类错）。
//
// 纪律：失败不许影响业务。recordSearchOpen 自己吞掉库错误（返回 recorded:false），
// 因为反馈是旁路 —— 反馈库坏了不该让 srelay_show 打不开会话。
// feedbackStats 相反：它是**读**接口，出错了要让人看见，不假装"没有数据"。
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { normalize } from '../core/tokenize/tokenizer.js';
import { openGlobal } from '../store/global.js';

/** 检索回看的有效期：检索后 5 分钟内的 open 才算「这次检索的命中」。**唯一判据**。 */
export const FEEDBACK_TTL_MS = 5 * 60 * 1000;

/** 查询长度分桶（按归一化后的**字符**数）。给未来校准用：长查询与短查询的最优排序本就不该同一套。 */
export const QUERY_LEN_BUCKETS = ['1-4', '5-9', '10-19', '20+'] as const;
export type QueryLenBucket = (typeof QUERY_LEN_BUCKETS)[number] | '0';

/** 查询长度桶：**唯一实现**（检索侧写库、统计侧分桶都走它，不许各写一份）。 */
export function queryLenBucket(query: string): QueryLenBucket {
  const n = Array.from(normalize(String(query ?? '').trim())).length;
  if (n === 0) return '0';
  if (n <= 4) return '1-4';
  if (n <= 9) return '5-9';
  if (n <= 19) return '10-19';
  return '20+';
}

/** 查询指纹：明文查询**不入库**。归一化（NFC/全角→半角/小写/空白折叠）后取 sha256 前 16 位。 */
export function queryHash(query: string): string {
  return createHash('sha256').update(normalize(String(query ?? '').trim())).digest('hex').slice(0, 16);
}

/** open 事件的来源入口。用字符串联合而不是布尔：以后加入口不必改表。 */
export type OpenKind = 'mcp_show' | 'cli_show';

/** 表结构（**唯一** DDL 来源）。列与任务约定一致：at/project/query_hash/query_len_bucket/position/session_id/open_kind。
 *  id 只是行号（去重判据在内存，见 recorded）；索引给统计（按项目/时间切窗）与将来按 query 聚合用。 */
export const SEARCH_FEEDBACK_DDL =
  'CREATE TABLE IF NOT EXISTS search_feedback ('
  + ' id INTEGER PRIMARY KEY AUTOINCREMENT,'
  + ' at TEXT NOT NULL,'
  + ' project TEXT NOT NULL,'
  + ' query_hash TEXT NOT NULL,'
  + ' query_len_bucket TEXT NOT NULL,'
  + ' position INTEGER NOT NULL,'
  + ' session_id TEXT NOT NULL,'
  + ' open_kind TEXT NOT NULL'
  + ');'
  + 'CREATE INDEX IF NOT EXISTS search_feedback_at ON search_feedback(at);'
  + 'CREATE INDEX IF NOT EXISTS search_feedback_project ON search_feedback(project, at);'
  + 'CREATE INDEX IF NOT EXISTS search_feedback_query ON search_feedback(query_hash);';

/** 建表（幂等）。recordSearchOpen / feedbackStats 都会先调它 —— 装在 global.ts 里会让
 *  「反馈表归谁」多一处真相；这里自持，openGlobal 只管开库与它自己的 lessons 表。 */
export function ensureFeedbackTable(db: Database.Database): void {
  db.exec(SEARCH_FEEDBACK_DDL);
}

/** 进程内的一次检索快照（只在内存里活 TTL 那么久）。 */
interface RecentSearch {
  readonly project: string;
  readonly queryHash: string;
  readonly bucket: QueryLenBucket;
  /** sessionId → 1-based 名次（同一会话重复出现只留最靠前的一次） */
  readonly positions: Map<string, number>;
  /** 检索发生的时刻（epoch ms） */
  readonly at: number;
  /** 已记过的会话：同一份候选里重复 show 同一会话只记一条 */
  readonly recorded: Set<string>;
}

/** project → 最近一次检索。按 project 分键：MCP 一个进程会服务多个项目，混在一起会串味。 */
const recentSearches = new Map<string, RecentSearch>();

/** 清空进程内候选（测试隔离用；语义上等于「本进程没检索过」）。 */
export function resetSearchMemory(): void {
  recentSearches.clear();
}

/** 记下本次检索的候选（供随后的 show 判定）。**只写内存**，不改检索结果、不写库。
 *  调用点：MCP srelay_search(kind=sessions) / CLI srelay search。
 *  候选列表为空也照记：新检索会顶掉旧的，免得把「这次什么都没搜到」后的打开算到上一次头上。 */
export function rememberSearch(
  project: string,
  query: string,
  sessionIds: readonly string[],
  opts: { now?: number } = {},
): void {
  const key = String(project ?? '').trim();
  if (!key) return;
  const now = opts.now ?? Date.now();
  // 顺手清掉过期的：这个 Map 最多一个项目一条，但进程长跑时项目会越来越多
  for (const [k, v] of recentSearches) if (now - v.at >= FEEDBACK_TTL_MS) recentSearches.delete(k);
  const positions = new Map<string, number>();
  sessionIds.forEach((id, i) => {
    const sid = String(id ?? '').trim();
    if (sid && !positions.has(sid)) positions.set(sid, i + 1);
  });
  recentSearches.set(key, { project: key, queryHash: queryHash(query), bucket: queryLenBucket(query), positions, at: now, recorded: new Set() });
}

/** 不记的原因（写进返回值，便于测试与将来诊断「为什么没数据」） */
export type SkipReason = 'no_recent_search' | 'expired' | 'not_in_candidates' | 'duplicate' | 'db_error';

export interface RecordOpenInput {
  /** 项目 id（口径与检索侧一致：cfg.identity.project_id ?? root） */
  project: string;
  /** 被打开的会话 id —— **完整 id**，不是前缀（前缀在调用点已解析） */
  sessionId: string;
  openKind: OpenKind;
  /** 测试注入时钟 */
  now?: number;
  /** 测试注入库；缺省自己开全局库 */
  db?: Database.Database;
}

export interface RecordOpenResult {
  recorded: boolean;
  reason?: SkipReason;
  /** 命中名次（1 起）；不在候选里时无 */
  position?: number;
  queryHash?: string;
  bucket?: QueryLenBucket;
  /** reason='db_error' 时的原始信息（调用方可以选择不看，但别让它彻底消失） */
  error?: string;
}

/**
 * 记一条 open 事件。返回「记了没有 + 为什么」，**永不抛错**（反馈是旁路）。
 *
 * 判定顺序（唯一一份）：
 *   ① 没有该项目的检索记录 → no_recent_search
 *   ② 超过 TTL → expired（顺手把它删掉）
 *   ③ 会话不在候选里 → not_in_candidates（「不存在的 session 不记」就是这条）
 *   ④ 同一份候选里已记过 → duplicate
 * 依次过了才写库；写成功才把 session 标进 recorded（写失败不能吞掉下一次机会）。
 */
export function recordSearchOpen(input: RecordOpenInput): RecordOpenResult {
  const now = input.now ?? Date.now();
  const project = String(input.project ?? '').trim();
  const sessionId = String(input.sessionId ?? '').trim();
  if (!project || !sessionId) return { recorded: false, reason: 'no_recent_search' };

  const snap = recentSearches.get(project);
  if (!snap) return { recorded: false, reason: 'no_recent_search' };
  if (now - snap.at >= FEEDBACK_TTL_MS) {
    recentSearches.delete(project);
    return { recorded: false, reason: 'expired' };
  }
  const position = snap.positions.get(sessionId);
  if (position === undefined) return { recorded: false, reason: 'not_in_candidates' };
  if (snap.recorded.has(sessionId)) return { recorded: false, reason: 'duplicate', position };

  let owned: Database.Database | null = null;
  try {
    let db = input.db;
    if (!db) { owned = openGlobal(); db = owned; }
    ensureFeedbackTable(db);
    db.prepare(
      'INSERT INTO search_feedback(at, project, query_hash, query_len_bucket, position, session_id, open_kind)'
      + ' VALUES (?,?,?,?,?,?,?)',
    ).run(new Date(now).toISOString(), project, snap.queryHash, snap.bucket, position, sessionId, input.openKind);
    snap.recorded.add(sessionId);
    return { recorded: true, position, queryHash: snap.queryHash, bucket: snap.bucket };
  } catch (e) {
    return { recorded: false, reason: 'db_error', position, error: (e as Error).message };
  } finally {
    try { owned?.close(); } catch { /* 关不掉不影响结论 */ }
  }
}

export interface FeedbackStatsOptions {
  /** 只看某个项目（缺省 = 全部项目，跨项目才有统计意义） */
  project?: string;
  /** 只看最近 N 天（缺省 = 全部历史） */
  sinceDays?: number;
  /** topSessions 条数（默认 5） */
  topN?: number;
  /** 测试注入时钟 */
  now?: number;
  /** 测试注入库；缺省自己开全局库 */
  db?: Database.Database;
}

export interface FeedbackStats {
  /** open 事件总数 */
  total: number;
  /** 去重后的查询数（同一 query_hash 记 1） */
  queries: number;
  /** 打开了多少个不同会话 */
  sessions: number;
  /** 平均名次（没有事件时为 null，**不是 0**：0 会被当成"全在第 0 名"读出完全相反的意思） */
  avgPosition: number | null;
  /** 名次直方图，按名次升序 */
  positions: Array<{ position: number; opens: number }>;
  /** 按查询长度桶（顺序固定为 QUERY_LEN_BUCKETS，未知桶排最后） */
  buckets: Array<{ bucket: string; opens: number; avgPosition: number | null }>;
  /** 按入口 */
  kinds: Array<{ kind: string; opens: number }>;
  /** 打开最多的会话（同次数按最好名次升序） */
  topSessions: Array<{ sessionId: string; opens: number; bestPosition: number }>;
  /** 时间范围（ISO） */
  firstAt: string | null;
  lastAt: string | null;
}

/** 统计（第二步改权重的输入）。读接口：库打不开就抛，让调用方看见，不假装没有数据。 */
export function feedbackStats(opts: FeedbackStatsOptions = {}): FeedbackStats {
  const now = opts.now ?? Date.now();
  let owned: Database.Database | null = null;
  try {
    let db = opts.db;
    if (!db) { owned = openGlobal(); db = owned; }
    ensureFeedbackTable(db);

    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.project) { where.push('project = ?'); params.push(String(opts.project)); }
    if (opts.sinceDays !== undefined && Number.isFinite(opts.sinceDays) && opts.sinceDays > 0) {
      where.push('at >= ?');
      params.push(new Date(now - opts.sinceDays * 86_400_000).toISOString());
    }
    const w = where.length ? ' WHERE ' + where.join(' AND ') : '';

    const head = db.prepare(
      'SELECT COUNT(*) AS n, COUNT(DISTINCT query_hash) AS queries, COUNT(DISTINCT session_id) AS sessions,'
      + ' AVG(position) AS avgPosition, MIN(at) AS firstAt, MAX(at) AS lastAt'
      + ' FROM search_feedback' + w,
    ).get(...params) as { n?: number; queries?: number; sessions?: number; avgPosition?: number | null; firstAt?: string | null; lastAt?: string | null } | undefined;

    const total = Number(head?.n ?? 0);
    const round2 = (v: number): number => Math.round(v * 100) / 100;

    const positions = (db.prepare(
      'SELECT position AS position, COUNT(*) AS opens FROM search_feedback' + w + ' GROUP BY position ORDER BY position',
    ).all(...params) as Array<{ position: number; opens: number }>)
      .map((r) => ({ position: Number(r.position), opens: Number(r.opens) }));

    const bucketRows = (db.prepare(
      'SELECT query_len_bucket AS bucket, COUNT(*) AS opens, AVG(position) AS avgPosition'
      + ' FROM search_feedback' + w + ' GROUP BY query_len_bucket',
    ).all(...params) as Array<{ bucket: string; opens: number; avgPosition: number | null }>)
      .map((r) => ({
        bucket: String(r.bucket),
        opens: Number(r.opens),
        avgPosition: r.avgPosition === null || r.avgPosition === undefined ? null : round2(Number(r.avgPosition)),
      }));
    const order = new Map<string, number>(QUERY_LEN_BUCKETS.map((b, i) => [b, i]));
    bucketRows.sort((a, b) => (order.get(a.bucket) ?? 99) - (order.get(b.bucket) ?? 99));

    const kinds = (db.prepare(
      'SELECT open_kind AS kind, COUNT(*) AS opens FROM search_feedback' + w + ' GROUP BY open_kind ORDER BY opens DESC, kind',
    ).all(...params) as Array<{ kind: string; opens: number }>)
      .map((r) => ({ kind: String(r.kind), opens: Number(r.opens) }));

    const topN = Math.max(1, Math.floor(Number(opts.topN ?? 5)));
    const topSessions = (db.prepare(
      'SELECT session_id AS sessionId, COUNT(*) AS opens, MIN(position) AS bestPosition'
      + ' FROM search_feedback' + w + ' GROUP BY session_id ORDER BY opens DESC, bestPosition ASC, session_id LIMIT ?',
    ).all(...params, topN) as Array<{ sessionId: string; opens: number; bestPosition: number }>)
      .map((r) => ({ sessionId: String(r.sessionId), opens: Number(r.opens), bestPosition: Number(r.bestPosition) }));

    return {
      total,
      queries: Number(head?.queries ?? 0),
      sessions: Number(head?.sessions ?? 0),
      avgPosition: total > 0 && head?.avgPosition !== null && head?.avgPosition !== undefined ? round2(Number(head.avgPosition)) : null,
      positions,
      buckets: bucketRows,
      kinds,
      topSessions,
      firstAt: head?.firstAt ?? null,
      lastAt: head?.lastAt ?? null,
    };
  } finally {
    try { owned?.close(); } catch { /* 关不掉不影响结论 */ }
  }
}
