// why-empty.ts —— 检索 0 命中时的**确定性诊断**：告诉用户为什么没找到，而不是只说「未找到」。
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

export function diagnoseEmpty(inp: EmptyDiagnosisInput): EmptyDiagnosis {
  const reasons: string[] = [];
  const suggestions: string[] = [];
  const tokens = (parseQuery(inp.query).units.flat()).filter((t) => t.length >= 2);
  const counts: Array<{ token: string; sessions: number }> = [];
  const denom = Math.max(1, inp.sessions);
  for (const t of tokens) {
    let n = 0;
    try {
      n = (inp.db.prepare('SELECT COUNT(DISTINCT session_id) AS c FROM messages WHERE project_id IS NULL AND search_text LIKE ?').get('%' + t + '%') as { c: number }).c;
    } catch {
      try { n = (inp.db.prepare('SELECT COUNT(DISTINCT session_id) AS c FROM messages WHERE search_text LIKE ?').get('%' + t + '%') as { c: number }).c; } catch { n = 0; }
    }
    counts.push({ token: t, sessions: n });
  }
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
  if (tokens.length > 3) {
    reasons.push('约束太多：' + tokens.length + ' 个词元按 AND 匹配，每多一个词都更难同时命中');
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
