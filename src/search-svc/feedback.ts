// 任务 D · 零模型检索自校准（第一步：只采集，不调权重）
//
// 要回答的问题只有一句：**检索出来的会话，后来真的被打开了吗？**
//   · 检索侧（MCP srelay_search / CLI srelay search）：把本次候选（会话 id + 名次）落成
//     一份**磁盘快照**（每个项目一份，TTL 5 分钟）；
//   · 打开侧（MCP srelay_show / CLI srelay show）：快照里有该会话 → 往全局库 search_feedback 记一条 open。
//
// ─────────────────────────────────────────────────────────────────────────────
// [1020 修正①] 快照为什么必须落盘（**实测，不是推测**）
//
// 原实现只把候选留在**进程内存**里，注释写着「同进程才成立」。而真实调用链是：
//   DSH 插件 srelay_search → 起一个 node 子进程跑 `srelay search`（跑完进程就退）
//   DSH 插件 srelay_show   → 再起**另一个** node 子进程跑 `srelay show`
// ⇒ 两次调用永远不在同一个进程，候选永远借不到，search_feedback **一次都没记上**
//   （实测：重启 DSH、真跑 search+show 之后，全局库里连表都不存在）。
//   结论：D 的第一步从来没真生效，只是"代码在"。现在候选落盘、show 侧按 TTL 读回，
//   MCP 与 CLI 走**同一条**判据，不再分叉。
//
// [1020 修正②] 去重判据从「进程内 Set」改成「库级唯一索引 (search_id, session_id)」。
//   跨进程时内存 Set 天然失效（同一份候选里 show 两次会记两条）。search_id 是**这次检索**
//   的身份（随机 uuid），去重只有一条判据：库里有没有同一 (search_id, session_id) 的行。
//   NULL search_id 的历史行不受唯一索引约束（SQLite 唯一索引允许多个 NULL），老库能就地升级。
//
// 三点刻意选择（都不是随手决定的）：
//   ① 快照落**全局目录**（<global home>/last-search/），不写用户项目目录：与 search_feedback
//      同处，项目根一个字节都不碰；文件里**不含正文、不含明文查询、不含路径** ——
//      只有 sessionId、名次、查询哈希、长度桶。隐私边界与经验层同一条。
//   ② 事件写**全局库**（~/.sessionrelay/global.sqlite），不写项目库：
//      「排序好不好」是跨项目才统计得出来的。
//   ③ 本模块**不参与排序**：第一步只采集。改权重必须等 feedbackStats 攒够样本，
//      否则就是拿几个样本的手感去改一个全局判据（本仓最贵的一类错）。
//
// 纪律：失败不许影响业务。rememberSearch / recordSearchOpen 自己吞掉 IO 与库错误
// （返回 persisted:false / recorded:false），因为反馈是旁路 —— 反馈坏了不该让检索或 show 失败。
// feedbackStats / lastSearchStatus 相反：它们是**读**接口，出错了要让人看见，不假装"没有数据"。
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { normalize } from '../core/tokenize/tokenizer.js';
import { openGlobal } from '../store/global.js';
import { globalDbFile } from '../shared/paths.js';

/** 检索回看的有效期：检索后 5 分钟内的 open 才算「这次检索的命中」。**唯一判据**。 */
export const FEEDBACK_TTL_MS = 5 * 60 * 1000;

/**
 * 校准建议所需的最小 open 样本数。**唯一判据**：`srelay feedback` 与校准脚本都读它。
 * 低于它只报「样本不足」，不许出建议 —— 几个样本的手感不是证据（本仓最贵的一类错）。
 */
export const MIN_OPENS_FOR_CALIBRATION = 30;

/** 候选快照的文件格式版本。读到别的版本号就当成"没有快照"（不许猜字段）。 */
export const SNAPSHOT_VERSION = 1;

/** 查询长度分桶（按归一化后的**字符**数）。给未来校准用：长查询与短查询的最优排序本就不该同一套。 */
export const QUERY_LEN_BUCKETS = ['1-4', '5-9', '10-19', '20+'] as const;
export type QueryLenBucket = (typeof QUERY_LEN_BUCKETS)[number] | '0';

/** 查询长度桶：**唯一实现**（检索侧写快照、统计侧分桶都走它，不许各写一份）。 */
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

/** 表结构（**唯一** DDL 来源）。search_id 是这次检索的身份，去重靠 (search_id, session_id) 唯一索引。 */
export const SEARCH_FEEDBACK_DDL =
  'CREATE TABLE IF NOT EXISTS search_feedback ('
  + ' id INTEGER PRIMARY KEY AUTOINCREMENT,'
  + ' at TEXT NOT NULL,'
  + ' project TEXT NOT NULL,'
  + ' search_id TEXT,'
  + ' query_hash TEXT NOT NULL,'
  + ' query_len_bucket TEXT NOT NULL,'
  + ' position INTEGER NOT NULL,'
  + ' session_id TEXT NOT NULL,'
  + ' open_kind TEXT NOT NULL'
  + ');'
  + 'CREATE INDEX IF NOT EXISTS search_feedback_at ON search_feedback(at);'
  + 'CREATE INDEX IF NOT EXISTS search_feedback_project ON search_feedback(project, at);'
  + 'CREATE INDEX IF NOT EXISTS search_feedback_query ON search_feedback(query_hash);';

/**
 * 建表 + 就地升级（幂等）。recordSearchOpen / feedbackStats 都会先调它 —— 装在 global.ts 里会让
 * 「反馈表归谁」多一处真相；这里自持，openGlobal 只管开库与它自己的 lessons 表。
 *
 * 唯一索引单独建：老库的 search_feedback 可能没有 search_id 列，必须先 ALTER 再建索引
 * （顺序反了会 SQLITE_ERROR，而不是"没有索引"这种能自愈的状态）。
 */
export function ensureFeedbackTable(db: Database.Database): void {
  db.exec(SEARCH_FEEDBACK_DDL);
  const cols = db.prepare('PRAGMA table_info(search_feedback)').all() as Array<{ name?: string }>;
  if (!cols.some((c) => c.name === 'search_id')) {
    db.exec('ALTER TABLE search_feedback ADD COLUMN search_id TEXT');
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS search_feedback_search ON search_feedback(search_id, session_id);');
}

// ── 候选快照（磁盘，一个项目一份） ─────────────────────────────────────────────

export interface SearchSnapshot {
  /** 格式版本（= SNAPSHOT_VERSION） */
  v: number;
  /** 检索发生的时刻（epoch ms） */
  at: number;
  /** 项目 id（与记录侧同口径；文件里再存一份，读回时自校验，防止哈希碰撞张冠李戴） */
  project: string;
  /** 这次检索的身份（去重键之一） */
  searchId: string;
  queryHash: string;
  bucket: QueryLenBucket;
  /** sessionId → 1 起的名次（同一会话重复出现只留最靠前的一次） */
  positions: Record<string, number>;
  /** 候选总数（用于"检索了几条"这种诊断；不含正文） */
  candidates: number;
}

/** 快照目录：与全局库同级（<SRELAY_GLOBAL_HOME>/last-search）。测试改 SRELAY_GLOBAL_HOME 即隔离。 */
export function snapshotDir(): string {
  return path.join(path.dirname(globalDbFile()), 'last-search');
}

/** 快照文件路径：项目 id 取 sha256 前 16 位做文件名（项目 id 里可能带空格/斜杠，不能直接当文件名）。 */
export function snapshotFileOf(project: string): string {
  const key = createHash('sha256').update(String(project ?? '')).digest('hex').slice(0, 16);
  return path.join(snapshotDir(), key + '.json');
}

export interface RememberResult {
  /** 这次检索的身份（写不进去也有值：它是内存态的身份，去重键） */
  searchId: string;
  at: number;
  candidates: number;
  /** 快照文件路径（无论写没写成，便于诊断） */
  file: string;
  /** 真的落到磁盘了吗（false 时 error 里有原因；**不影响检索本身**） */
  persisted: boolean;
  error?: string;
}

/**
 * 记下本次检索的候选（供随后的 show 判定）。**只写快照、不改检索结果**。
 * 调用点：MCP srelay_search(kind=sessions) / CLI srelay search。
 * 候选为空也照记：新检索会顶掉旧的，免得把「这次什么都没搜到」后的打开算到上一次头上。
 *
 * 原子写：先写 .tmp 再 rename —— 否则 show 恰好读到写了一半的 JSON，会误判成"没检索过"。
 * 失败**不抛**（返回 persisted:false），反馈是旁路；原因可用 srelay feedback 看到。
 */
export function rememberSearch(
  project: string,
  query: string,
  sessionIds: readonly string[],
  opts: { now?: number } = {},
): RememberResult {
  const key = String(project ?? '').trim();
  const now = opts.now ?? Date.now();
  const positions: Record<string, number> = {};
  sessionIds.forEach((id, i) => {
    const sid = String(id ?? '').trim();
    if (sid && positions[sid] === undefined) positions[sid] = i + 1;
  });
  const snap: SearchSnapshot = {
    v: SNAPSHOT_VERSION,
    at: now,
    project: key,
    searchId: randomUUID(),
    queryHash: queryHash(query),
    bucket: queryLenBucket(query),
    positions,
    candidates: Object.keys(positions).length,
  };
  const base: RememberResult = {
    searchId: snap.searchId,
    at: snap.at,
    candidates: snap.candidates,
    file: snapshotFileOf(key),
    persisted: false,
  };
  if (!key) return { ...base, error: '项目 id 为空（没有可归属的项目，不写快照）' };

  const file = base.file;
  const tmp = file + '.' + process.pid + '.tmp';
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(snap), 'utf8');
    fs.renameSync(tmp, file);
    return { ...base, persisted: true };
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 清不掉临时文件不影响结论 */ }
    return { ...base, error: (e as Error).message };
  }
}

/** 读回快照时为什么会"没有"（诊断用；recordSearchOpen 把它映射成 SkipReason）。 */
export type SnapshotMiss = 'missing' | 'expired' | 'corrupt' | 'other_project';

/** 读快照并做 TTL 与自校验。**只读**，不删文件（诊断要能看到"过期了"而不是"从来没写过"）。 */
export function loadSnapshot(
  project: string,
  opts: { now?: number } = {},
): { snap?: SearchSnapshot; miss?: SnapshotMiss; error?: string; file: string } {
  const key = String(project ?? '').trim();
  const file = snapshotFileOf(key);
  if (!key) return { miss: 'missing', file };
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { miss: 'missing', file };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { miss: 'corrupt', error: (e as Error).message, file };
  }
  const o = parsed as Partial<SearchSnapshot> | null;
  if (!o || typeof o !== 'object' || o.v !== SNAPSHOT_VERSION || typeof o.at !== 'number'
    || typeof o.project !== 'string' || typeof o.searchId !== 'string'
    || !o.positions || typeof o.positions !== 'object') {
    return { miss: 'corrupt', error: '快照字段不完整或版本不认识', file };
  }
  // 哈希碰撞/项目 id 换过：文件在同一槽位但不是这个项目的 ⇒ 不许借用别人的候选
  if (o.project !== key) return { miss: 'other_project', file };
  const now = opts.now ?? Date.now();
  if (now - o.at >= FEEDBACK_TTL_MS) return { miss: 'expired', file };
  return { snap: o as SearchSnapshot, file };
}

export interface LastSearchStatus {
  project: string;
  file: string;
  /** 磁盘上有没有这份快照（过期也算有） */
  exists: boolean;
  expired: boolean;
  ageMs: number | null;
  at: string | null;
  candidates: number;
  queryHash: string | null;
  bucket: string | null;
  /** missing / expired / corrupt / other_project；有快照且新鲜时为 null */
  note: string | null;
  error?: string;
}

/**
 * 「刚才那次检索还在不在」——只读诊断，给 `srelay feedback` 用。
 *
 * 为什么需要它：采集链路是旁路，用户看到"0 条数据"时必须能分清三种情况
 *   （从没检索过 / 检索过但过期了 / 快照坏了），否则只能猜。**不抛错**，把问题写进 note。
 */
export function lastSearchStatus(project: string, opts: { now?: number } = {}): LastSearchStatus {
  const key = String(project ?? '').trim();
  const now = opts.now ?? Date.now();
  const r = loadSnapshot(key, { now });
  const exists = r.miss !== 'missing';
  const snap = r.snap;
  return {
    project: key,
    file: r.file,
    exists,
    expired: r.miss === 'expired',
    ageMs: snap ? now - snap.at : null,
    at: snap ? new Date(snap.at).toISOString() : null,
    candidates: snap ? Object.keys(snap.positions).length : 0,
    queryHash: snap?.queryHash ?? null,
    bucket: snap?.bucket ?? null,
    note: r.miss ?? null,
    ...(r.error ? { error: r.error } : {}),
  };
}

// ── 记录 open ───────────────────────────────────────────────────────────────

/** 不记的原因（写进返回值，便于测试与将来诊断「为什么没数据」） */
export type SkipReason =
  | 'no_recent_search'
  | 'expired'
  | 'not_in_candidates'
  | 'duplicate'
  | 'snapshot_corrupt'
  | 'other_project'
  | 'db_error';

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
 *   ① 没有该项目的快照 → no_recent_search
 *   ② 超过 TTL → expired
 *   ③ 会话不在候选里 → not_in_candidates（「不存在的 session 不记」就是这条）
 *   ④ 库里已有同一 (search_id, session_id) → duplicate（跨进程也成立）
 * 依次过了才写库。写失败不写进任何内存态 —— 下次还有机会。
 */
export function recordSearchOpen(input: RecordOpenInput): RecordOpenResult {
  const now = input.now ?? Date.now();
  const project = String(input.project ?? '').trim();
  const sessionId = String(input.sessionId ?? '').trim();
  if (!project || !sessionId) return { recorded: false, reason: 'no_recent_search' };

  const loaded = loadSnapshot(project, { now });
  if (!loaded.snap) {
    const reason: SkipReason = loaded.miss === 'expired' ? 'expired'
      : loaded.miss === 'corrupt' ? 'snapshot_corrupt'
        : loaded.miss === 'other_project' ? 'other_project'
          : 'no_recent_search';
    return loaded.error ? { recorded: false, reason, error: loaded.error } : { recorded: false, reason };
  }
  const snap = loaded.snap;
  const position = snap.positions[sessionId];
  if (position === undefined) return { recorded: false, reason: 'not_in_candidates' };

  let owned: Database.Database | null = null;
  try {
    let db = input.db;
    if (!db) { owned = openGlobal(); db = owned; }
    ensureFeedbackTable(db);
    const info = db.prepare(
      'INSERT INTO search_feedback(at, project, search_id, query_hash, query_len_bucket, position, session_id, open_kind)'
      + ' VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(search_id, session_id) DO NOTHING',
    ).run(new Date(now).toISOString(), project, snap.searchId, snap.queryHash, snap.bucket, position, sessionId, input.openKind);
    if (info.changes === 0) {
      return { recorded: false, reason: 'duplicate', position, queryHash: snap.queryHash, bucket: snap.bucket };
    }
    return { recorded: true, position, queryHash: snap.queryHash, bucket: snap.bucket };
  } catch (e) {
    return { recorded: false, reason: 'db_error', position, error: (e as Error).message };
  } finally {
    try { owned?.close(); } catch { /* 关不掉不影响结论 */ }
  }
}

// ── 统计（第二步改权重的输入） ──────────────────────────────────────────────

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
  /** 去重后的检索次数（同一 search_id 记 1；老数据没有 search_id 时为 0 —— 那是"不知道"，不是"没有检索"） */
  searches: number;
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
      'SELECT COUNT(*) AS n, COUNT(DISTINCT search_id) AS searches, COUNT(DISTINCT query_hash) AS queries,'
      + ' COUNT(DISTINCT session_id) AS sessions, AVG(position) AS avgPosition, MIN(at) AS firstAt, MAX(at) AS lastAt'
      + ' FROM search_feedback' + w,
    ).get(...params) as { n?: number; searches?: number; queries?: number; sessions?: number; avgPosition?: number | null; firstAt?: string | null; lastAt?: string | null } | undefined;

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
      searches: Number(head?.searches ?? 0),
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
