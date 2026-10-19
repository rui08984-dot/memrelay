// xarm-experiment.ts —— X 臂（跨会话）离线原型：不改产品代码，先量三种零模型重排策略。
//
// 为什么单独做：305 题里 X 臂只有 8.4% hit@1，是最大的一块空白；但它考的是
// 「答案散在两个以上会话里」，而现有检索按**单个会话**打分。这里先量三条零模型路子：
//   A) 会话链接扩展：候选会话与另一条同样命中查询词的会话有 session_links → 加权
//   B) 查询分句/并列词拆分：按子句覆盖率加权
//   C) A + B
// 基线 = 产品默认（titleBoost=1）的 top-50 排名。
//
// 用法：npx tsx scripts/xarm-experiment.ts <db> --questions scripts/bench-questions-paraphrase-v2.json [--json out.json]
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require2 = createRequire(import.meta.url);
const Database = require2('better-sqlite3');
const { searchSessions } = await import('../src/search-svc/engine.js');
const { parseQuery } = await import('../src/core/tokenize/tokenizer.js');

const argv = process.argv.slice(2);
const dbPath = argv[0];
const arg = (n: string, d: string) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const QFILE = arg('questions', 'scripts/bench-questions-paraphrase-v2.json');
const OUT = arg('json', '');
const LIMIT = Number(arg('limit', '50'));
const WEIGHT = Number(arg('weight', '0.5'));

const all = (JSON.parse(fs.readFileSync(QFILE, 'utf8')) as { items: Array<{ arm: string; query: string; target: string }> }).items;
const items = all.filter((x) => x.arm === 'X');
const db = new Database(dbPath, { readonly: true });
const PID = (db.prepare('SELECT project_id FROM sessions LIMIT 1').get() as { project_id: string }).project_id;

const linkStmt = db.prepare('SELECT linked_session_id AS id FROM session_links WHERE session_id = ?');
const linkedOf = (sid: string): Set<string> => {
  try { return new Set((linkStmt.all(sid) as Array<{ id: string }>).map((r) => r.id)); } catch { return new Set(); }
};

/** 查询拆子句：逗号/问号/分号 + 并列连词。返回子句词元数组。 */
function clausesOf(query: string): string[][] {
  const parts = query.split(/[，,。；;？?]|以及|还有|分别|和/).map((s) => s.trim()).filter((s) => s.length >= 2);
  const out: string[][] = [];
  for (const p of parts) {
    const toks = (parseQuery(p) as { units: string[][] }).units.flat().filter((t) => t.length >= 2);
    if (toks.length > 0) out.push(toks);
  }
  return out;
}

interface Row { id: string; score: number; coverage: number }
const variants = ['base', 'link', 'clause', 'both'] as const;
type V = typeof variants[number];
const acc: Record<V, { n: number; h1: number; h10: number; mrr: number }> = {
  base: { n: 0, h1: 0, h10: 0, mrr: 0 }, link: { n: 0, h1: 0, h10: 0, mrr: 0 },
  clause: { n: 0, h1: 0, h10: 0, mrr: 0 }, both: { n: 0, h1: 0, h10: 0, mrr: 0 },
};
const examples: Array<{ q: string; target: string; base: number; link: number; clause: number; both: number }> = [];

for (const it of items) {
  let hits: Array<{ sessionId: string; score: number; coverage: number }> = [];
  try { hits = searchSessions(db, { project: PID, query: it.query, limit: LIMIT, rewrite: true, lengthNorm: true, coreOnly: true } as never); } catch { hits = []; }
  const rows: Row[] = hits.map((h) => ({ id: h.sessionId, score: h.score, coverage: Number(h.coverage ?? 0) }));
  // A：链接扩展——若候选与另一个「也命中查询词」的候选有 link，则加权
  const ids = new Set(rows.map((r) => r.id));
  const linkScore = new Map<string, number>();
  for (const r of rows) {
    let n = 0;
    for (const l of linkedOf(r.id)) if (ids.has(l)) n++;
    linkScore.set(r.id, n);
  }
  // B：子句覆盖——逐子句真检索（不是 coverage 代理）：每个子句跑一次 FTS，
  //    候选命中的子句数 / 子句总数。子句只有 1 个时不加权（与旧行为等价）。
  const clauses = clausesOf(it.query);
  const clauseScore = new Map<string, number>();
  if (clauses.length >= 2) {
    const hitSets: Set<string>[] = [];
    for (const toks of clauses) {
      const q = toks.join(' ');
      try {
        const hs = searchSessions(db, { project: PID, query: q, limit: LIMIT, rewrite: true, lengthNorm: true, coreOnly: true } as never);
        hitSets.push(new Set(hs.map((h) => h.sessionId)));
      } catch { hitSets.push(new Set()); }
    }
    for (const r of rows) {
      const n = hitSets.filter((s) => s.has(r.id)).length;
      clauseScore.set(r.id, n / clauses.length);
    }
  }
  const rankOf = (v: V) => {
    const scored = rows.map((r) => {
      let s = r.score;
      if (v === 'link' || v === 'both') s *= 1 + WEIGHT * Math.min(2, linkScore.get(r.id) ?? 0);
      if (v === 'clause' || v === 'both') s *= 1 + WEIGHT * (clauseScore.get(r.id) ?? 0);
      return { id: r.id, s };
    }).sort((a, b) => b.s - a.s);
    const i = scored.findIndex((x) => x.id === it.target);
    return i >= 0 ? i + 1 : 0;
  };
  const ranks: Record<V, number> = { base: rankOf('base'), link: rankOf('link'), clause: rankOf('clause'), both: rankOf('both') };
  for (const v of variants) {
    const a = acc[v]; a.n++;
    if (ranks[v] === 1) a.h1++;
    if (ranks[v] >= 1 && ranks[v] <= 10) a.h10++;
    if (ranks[v] > 0) a.mrr += 1 / ranks[v];
  }
  examples.push({ q: it.query, target: it.target, base: ranks.base, link: ranks.link, clause: ranks.clause, both: ranks.both });
}

const pct = (x: number, n: number) => (n === 0 ? 0 : Math.round((x / n) * 1000) / 10);
console.log('== X 臂离线原型（n=' + items.length + '，候选上限 ' + LIMIT + '，权重 ' + WEIGHT + '）==');
for (const v of variants) {
  const a = acc[v];
  console.log(v.padEnd(7), 'hit@1 ' + String(pct(a.h1, a.n)).padStart(5) + '%  hit@10 ' + String(pct(a.h10, a.n)).padStart(5) + '%  MRR ' + (a.mrr / a.n * 100).toFixed(1) + '%');
}
const better = examples.filter((e) => e.both > 0 && (e.base === 0 || e.both < e.base)).slice(0, 5);
const worse = examples.filter((e) => e.base > 0 && (e.both === 0 || e.both > e.base)).slice(0, 5);
console.log('\n变好例子（base → both）：');
for (const e of better) console.log('  ' + e.base + ' → ' + e.both + ' | ' + e.q.slice(0, 50));
console.log('变差例子（base → both）：');
for (const e of worse) console.log('  ' + e.base + ' → ' + e.both + ' | ' + e.q.slice(0, 50));
if (OUT) { fs.writeFileSync(OUT, JSON.stringify({ qfile: QFILE, limit: LIMIT, weight: WEIGHT, acc, examples }, null, 1)); console.log('已写', OUT); }
