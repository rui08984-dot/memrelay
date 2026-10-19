// session-groups.ts —— 把检索命中的会话按「共享 topic / 共享文件」聚成组。
//
// 为什么需要它：用户问的是「在哪几次会话里……」，答案本来是一组会话；
// 但 srelay_search 只返回一条条平铺的会话，agent 得自己从标题里猜哪几条是同一件事。
//
// 判据（全部确定性、零模型）：
//   · 两个会话共享至少 1 个 topic（sessions.topics）→ 同组
//   · 或共享至少 1 个被提及文件（sessions.files_mentioned）→ 同组
// 只在**已返回的命中集合内**做并查集，不引入集合外会话（不改变检索结果，只改变呈现）。
//
// 不做的事（诚实登记）：
//   · 不做语义聚类（零模型约束）；共享 topic 只是"同一主题"的必要不充分条件
//   · 不跨项目、不跨 scope
import type { DB } from '../store/db.js';

export interface SessionGroupInput {
  sessionId: string;
  score: number;
}

export interface SessionGroup {
  /** 组内会话 id（按原顺序） */
  sessionIds: string[];
  /** 组内共享的 topic / 文件（最多各 5 个，用于解释"为什么它们在一组"） */
  sharedTopics: string[];
  sharedFiles: string[];
  /** 最高分会话（代表） */
  lead: string;
}

const parseList = (raw: string | null): string[] => {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : [];
  } catch { return []; }
};

/**
 * 在命中集合内聚组（并查集）。返回按「代表会话的最高分」降序排列的组。
 * 单条命中也成组（sessionIds 长度 1），保证覆盖所有命中。
 */
/**
 * 信号特异性阈值：一个 topic/file 若在库内超过这么多**会话**里出现，就不作为成组依据。
 *
 * 为什么必须过滤：实测未过滤时 95/95 道 X 题都出现 [9,1] 这种巨组——
 * 「模型」「插件」「交接」这类通用词把不相关会话全粘在一起，分组等于没分。
 * 阈值取「≤8 个会话 且 ≤5% 的会话」：既排掉通用词，又不误杀只有 2~3 条的中频主题。
 */
// 实测 topic df：p50=1、p90=7、p99=29、max=130（680 会话的项目）。
// 「文件/模型/dsh/插件」覆盖 69~130 个会话 ⇒ 阈值必须远小于 8。
// 取 ≤5 个会话：只留「真的只被少数几场提过」的具体信号。
const SIGNAL_MAX_SESSIONS = 5;
const SIGNAL_MAX_RATIO = 0.02;
/** 成组至少需要 2 个共享信号（防单词巧合把不相干会话粘一起） */
const MIN_SHARED_SIGNALS = 2;

/** 项目内每个 topic/file 出现在多少个会话里（用于判「通用/具体」） */
function signalDf(db: DB, project: string): Set<string> {
  const generic = new Set<string>();
  try {
    const total = (db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE project_id = ?').get(project) as { n: number }).n;
    const cap = Math.max(SIGNAL_MAX_SESSIONS, Math.floor(total * SIGNAL_MAX_RATIO));
    const rows = db.prepare('SELECT topics, files_mentioned FROM sessions WHERE project_id = ?').all(project) as Array<{ topics: string | null; files_mentioned: string | null }>;
    const counts = new Map<string, number>();
    for (const r of rows) {
      for (const t of new Set(parseList(r.topics))) { const k = 't:' + t.toLowerCase(); counts.set(k, (counts.get(k) ?? 0) + 1); }
      for (const f of new Set(parseList(r.files_mentioned))) { const k = 'f:' + f.toLowerCase(); counts.set(k, (counts.get(k) ?? 0) + 1); }
    }
    for (const [k, v] of counts) if (v > cap) generic.add(k);
  } catch { /* 计数失败就不做通用词过滤，退化为旧行为 */ }
  return generic;
}

export function groupSessions(db: DB, hits: SessionGroupInput[]): SessionGroup[] {
  if (hits.length === 0) return [];
  const ids = hits.map((h) => h.sessionId);
  const ph = ids.map(() => '?').join(',');
  const rows = db.prepare(
    'SELECT id, topics, files_mentioned FROM sessions WHERE id IN (' + ph + ')',
  ).all(...ids) as Array<{ id: string; topics: string | null; files_mentioned: string | null }>;
  const meta = new Map(rows.map((r) => [r.id, { topics: parseList(r.topics), files: parseList(r.files_mentioned) }]));

  const parent = new Map<string, string>(ids.map((id) => [id, id]));
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    while (parent.get(x) !== r) { const next = parent.get(x)!; parent.set(x, r); x = next; }
    return r;
  };
  const union = (a: string, b: string): void => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };

  // 用「信号 → 会话」倒排，避免 O(n²) 全配对
  const generic = signalDf(db, (db.prepare('SELECT project_id AS p FROM sessions WHERE id = ?').get(ids[0]) as { p: string } | undefined)?.p ?? '');
  const bySignal = new Map<string, string[]>();
  for (const id of ids) {
    const m = meta.get(id);
    if (!m) continue;
    for (const t of m.topics) {
      const k = 't:' + t.toLowerCase();
      if (generic.has(k)) continue; // 通用词不成组依据
      (bySignal.get(k) ?? bySignal.set(k, []).get(k)!).push(id);
    }
    for (const f of m.files) {
      const k = 'f:' + f.toLowerCase();
      if (generic.has(k)) continue;
      (bySignal.get(k) ?? bySignal.set(k, []).get(k)!).push(id);
    }
  }
  // 成组要求：一对会话共享 ≥ MIN_SHARED_SIGNALS 个具体信号，或共享 1 个信号且该信号只出现在这 2 条命中里。
  // 先按信号倒排统计「这一对共享了几个信号」；单信号直连只在该信号命中数 == 2 时成立。
  const pairSignals = new Map<string, number>();
  for (const [k, members] of bySignal) {
    if (members.length < 2) continue;
    const uniq = [...new Set(members)];
    for (let i = 0; i < uniq.length; i++) {
      for (let j = i + 1; j < uniq.length; j++) {
        const key = uniq[i] < uniq[j] ? uniq[i] + '|' + uniq[j] : uniq[j] + '|' + uniq[i];
        pairSignals.set(key, (pairSignals.get(key) ?? 0) + 1);
      }
    }
    if (uniq.length === 2 && !generic.has(k)) union(uniq[0], uniq[1]);
  }
  for (const [key, cnt] of pairSignals) {
    if (cnt < MIN_SHARED_SIGNALS) continue;
    const [a, b] = key.split('|');
    union(a, b);
  }

  // 收集每组共享信号
  const groups = new Map<string, { ids: string[]; topics: Set<string>; files: Set<string> }>();
  for (const id of ids) {
    const root = find(id);
    const g = groups.get(root) ?? { ids: [], topics: new Set(), files: new Set() };
    g.ids.push(id);
    const m = meta.get(id);
    // 共享信号 = 组内至少 2 个会话都有的
    for (const t of m?.topics ?? []) if ((bySignal.get('t:' + t.toLowerCase()) ?? []).length >= 2) g.topics.add(t);
    for (const f of m?.files ?? []) if ((bySignal.get('f:' + f.toLowerCase()) ?? []).length >= 2) g.files.add(f);
    groups.set(root, g);
  }

  const scoreOf = new Map(hits.map((h) => [h.sessionId, h.score]));
  const out: SessionGroup[] = [];
  // 组规模硬上限：超过就按分数保留前 MAX_GROUP_SIZE 条，其余拆成单条组。
  // 为什么是硬上限而不是继续调阈值：实测「文件/模型」这类词在库内覆盖 69~130 个会话，
  //   任何基于 df 的软阈值都会在某个库上失效；硬上限保证输出永远可读、可解释。
  const MAX_GROUP_SIZE = 3;
  for (const g of groups.values()) {
    if (g.ids.length > MAX_GROUP_SIZE) {
      const ranked = [...g.ids].sort((a, b) => (scoreOf.get(b) ?? 0) - (scoreOf.get(a) ?? 0));
      const keep = ranked.slice(0, MAX_GROUP_SIZE);
      const rest = ranked.slice(MAX_GROUP_SIZE);
      const sharedTopics = [...g.topics].slice(0, 5);
      const sharedFiles = [...g.files].slice(0, 5);
      out.push({ sessionIds: keep, sharedTopics, sharedFiles, lead: keep[0] });
      for (const id of rest) out.push({ sessionIds: [id], sharedTopics: [], sharedFiles: [], lead: id });
      continue;
    }
    const lead = [...g.ids].sort((a, b) => (scoreOf.get(b) ?? 0) - (scoreOf.get(a) ?? 0))[0];
    out.push({
      sessionIds: g.ids,
      sharedTopics: [...g.topics].slice(0, 5),
      sharedFiles: [...g.files].slice(0, 5),
      lead,
    });
  }
  out.sort((a, b) => (scoreOf.get(b.lead) ?? 0) - (scoreOf.get(a.lead) ?? 0));
  return out;
}
