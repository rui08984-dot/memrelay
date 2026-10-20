// why-empty.ts —— 检索诊断：告诉用户为什么没找到 / 为什么只找到一部分，而不是只说「未找到」。
//
// 两种场景，同一套判据（`tokenPresence`）：
//   · `diagnoseEmpty`：0 命中 → 五类归因（下面 ①~⑤）；
//   · `diagnoseWeak`：有命中但首条没覆盖全部关键词 → 指出「哪个词在本库根本没出现」。
//     1020 新增：原诊断只在 0 命中时触发，而"任一词元命中就返回"让多词查询几乎总能捞到一条
//     ⇒ 真机上几乎从不出现（功能在、用不上）。
//
// 只做归因，不改检索：
//   ①词太泛（每个词元在库里覆盖太多会话 ⇒ AND 全中很难）
//   ②词不存在（某个词元全库 0 命中 ⇒ 拼写/同义词问题）
//   ③时间窗太窄（pred.since/until 收窄）
//   ④scope 收窄（调用方告知）
//   ⑤约束太多（词元数 > 3）
//
// 判据只用现有分词器与 SQL COUNT，零模型。
import { parseQuery } from '../core/tokenize/tokenizer.js';
import type { DB } from '../store/db.js';

export interface EmptyDiagnosisInput {
  db: DB;
  projectId: string;
  query: string;
  /** 会话总数（分母） */
  sessions: number;
  /** 调用方已收窄 scope（brief/CLI 传） */
  scopeNarrowed?: boolean;
  since?: string;
  until?: string;
}

export interface EmptyDiagnosis {
  reasons: string[];
  suggestions: string[];
  tokens: Array<{ token: string; sessions: number }>;
}

/** 词元覆盖率超过这个比例 ⇒ 视为「太泛」（AND 全中概率低） */
const BROAD_RATIO = 0.3;

export interface TokenPresence { token: string; sessions: number }

/**
 * 词元在**本项目**里出现过多少场会话 —— 诊断的**唯一口径**（diagnoseEmpty 与 diagnoseWeak 共用）。
 *
 * 为什么必须按项目过滤（1020 修）：原实现第一条 SQL 写的是 `WHERE project_id IS NULL`
 * （messages 表根本没有这一列 ⇒ 永远抛错 ⇒ 落进 catch 走的**未过滤**那条路），
 * 于是诊断把**别的项目库**的词也算进来：本库没有的词会被说成"词太泛"，本库有的词会被说成"没出现"。
 * 判定对象是"这个项目的记忆里有没有"，分母也是本项目会话数，口径必须一致。
 */
export function tokenPresence(db: DB, projectId: string, query: string): TokenPresence[] {
  const tokens = (parseQuery(query).units.flat()).filter((t) => t.length >= 2);
  // 正文命中：messages.search_text 子串（与旧实现同口径，保留 LIKE：分词后的中文词可能出现在
  // 更长词内部，FTS 短语匹配会漏）。
  const msgSql = 'SELECT COUNT(DISTINCT m.session_id) AS c FROM messages m JOIN sessions s ON s.id = m.session_id'
    + ' WHERE s.project_id = ? AND m.search_text LIKE ?';
  // meta 命中：sessions_fts（标题/话题/meta_text）。**必须算上** —— 命中可能只来自标题/话题
  // （检索的 viaMeta 路），只看正文会让诊断说出「这个词在本库一次都没出现」而结果标题里就有它
  // （红队实测：搜「数据库 kubernetes」第 2 条标题是「Kubernetes 部署记录」，诊断却说没出现过）。
  const metaSql = "SELECT COUNT(*) AS c FROM sessions_fts f JOIN sessions s ON s.rowid = f.rowid"
    + ' WHERE f.meta_text MATCH ? AND s.project_id = ?';
  return tokens.map((t) => {
    const msg = Number((db.prepare(msgSql).get(projectId, '%' + t + '%') as { c?: number } | undefined)?.c ?? 0);
    let meta = 0;
    try {
      // FTS5 短语查询：token 里可能有引号/连字符，包成短语最稳；实在查不了就退回 0
      meta = Number((db.prepare(metaSql).get('"' + t.replace(/"/g, '""') + '"', projectId) as { c?: number } | undefined)?.c ?? 0);
    } catch { meta = 0; }
    // 两路可能命中同一会话；取较大者（不重复计数、也不虚报"太泛"）。
    return { token: t, sessions: Math.max(msg, meta) };
  });
}

/**
 * **弱命中**诊断：有结果、但首条没覆盖全部关键词时，指出到底哪个词在本库根本没出现过。
 *
 * 为什么需要（1020）：原来的诊断只在"0 命中"时触发，而检索是"任一词元命中就返回"，
 * 多词查询几乎总能捞到一条 ⇒ 诊断在真机上**几乎从不出现**（功能在、用不上）。
 * 现在只要首条覆盖度 <100% 就问一句"缺的是哪个词"，仍然是只归因、不改检索；
 * 强命中（覆盖 100%）**零开销**（不做任何额外查询）。
 */
export interface WeakDiagnosis { missing: TokenPresence[]; note: string | null }

export function diagnoseWeak(inp: { db: DB; projectId: string; query: string }): WeakDiagnosis {
  const missing = tokenPresence(inp.db, inp.projectId, inp.query).filter((t) => t.sessions === 0);
  if (missing.length === 0) return { missing: [], note: null };
  return {
    missing,
    note: '关键词 ' + missing.map((m) => '「' + m.token + '」').join('') + ' 在本库一次都没出现 —— 上面是只命中其余词的结果',
  };
}

export function diagnoseEmpty(inp: EmptyDiagnosisInput): EmptyDiagnosis {
  const reasons: string[] = [];
  const suggestions: string[] = [];
  const counts: Array<{ token: string; sessions: number }> = tokenPresence(inp.db, inp.projectId, inp.query);
  const denom = Math.max(1, inp.sessions);
  const missing = counts.filter((c) => c.sessions === 0);
  if (missing.length > 0) {
    reasons.push('这些词在全库一次都没出现：' + missing.map((c) => c.token).join('、'));
    suggestions.push('换同义词或去掉这些词（先试单个关键词）');
  }
  const broad = counts.filter((c) => c.sessions > 0 && c.sessions / denom >= BROAD_RATIO);
  if (broad.length > 0 && missing.length === 0) {
    reasons.push('词太泛：' + broad.map((c) => c.token + '（' + c.sessions + ' 场）').join('、') + ' 覆盖了 ≥30% 的会话，AND 全中很难');
    suggestions.push('用更具体的词，或把多个词分开搜');
  }
  if (counts.length > 3) {
    reasons.push('约束太多：' + counts.length + ' 个词元按 AND 匹配，每多一个词都更难同时命中');
    suggestions.push('减少到 2-3 个关键词');
  }
  if (inp.since || inp.until) {
    reasons.push('时间窗收窄：' + (inp.since ? 'since=' + inp.since + ' ' : '') + (inp.until ? 'until=' + inp.until : ''));
    suggestions.push('去掉 --since/--until 再试');
  }
  if (inp.scopeNarrowed) {
    reasons.push('结果被 scope 契约收窄');
    suggestions.push('srelay scope 查看范围；srelay scope reset 放宽');
  }
  if (reasons.length === 0) {
    reasons.push('词都能命中，但没有任何一个会话同时命中全部词元（AND 交集为空）');
    suggestions.push('减少关键词，或改用 kind=decisions 先看结论');
  }
  return { reasons, suggestions, tokens: counts };
}