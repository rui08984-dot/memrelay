// rank-experiment.ts —— 在**不改产品代码**的前提下，先量「重排特征」值不值得实现。
//
// 输入同一批 305 题；对每题取产品默认 top-50 候选，在候选集上换重排公式，
// 比较 hit@1 / hit@10 / MRR。只有在这里赢了的特征，才值得写进 engine.ts。
//
// 特征全部零模型、确定性：
//   · 时间锚点（上次/最近/昨天/前天…）：查询带锚点时，按 last_event_at 给新会话加权
//   · 标题/话题命中：查询词元在 title/topics 里出现 → 加权
//   · 覆盖度：引擎已算的 coverage（命中单元 / 总单元）
//
// 用法：npx tsx scripts/rank-experiment.ts <db> --questions <q.json> [--json out.json]
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

const items = (JSON.parse(fs.readFileSync(QFILE, 'utf8')) as { items: Array<{ arm: string; query: string; target: string }> }).items;
const db = new Database(dbPath, { readonly: true });
const PID = (db.prepare('SELECT project_id FROM sessions LIMIT 1').get() as { project_id: string }).project_id;

const TIME_ANCHOR = /(上次|上回|最近|刚才|刚刚|昨天|前天|上周|那天|前一天|前两天|这几天|今天)/;
const metaStmt = (n: number) => 'SELECT id, title, topics, last_event_at FROM sessions WHERE id IN (' + Array(n).fill('?').join(',') + ')';

const now = Date.now();
interface Cand { id: string; score: number; coverage: number; titleHit: number; recency: number }
const RANK = {
  base: (c: Cand) => c.score,
  cov: (c: Cand) => c.score * (1 + 0.5 * c.coverage),
  time: (c: Cand) => c.score * (1 + 1.0 * c.recency),
  timeTitle: (c: Cand) => c.score * (1 + 1.0 * c.recency) * (1 + 0.3 * c.titleHit),
  title: (c: Cand) => c.score * (1 + 0.5 * c.titleHit),
};
type RankKey = keyof typeof RANK;
const variants: RankKey[] = ['base', 'cov', 'title', 'time', 'timeTitle'];
const acc: Record<string, { n: number; h1: number; h10: number; mrr: number }> = {};
for (const v of variants) acc[v] = { n: 0, h1: 0, h10: 0, mrr: 0 };

let done = 0;
for (const it of items) {
  let hits: Array<{ sessionId: string; score: number; coverage: number }> = [];
  try { hits = searchSessions(db, { project: PID, query: it.query, limit: LIMIT, rewrite: true, lengthNorm: true, coreOnly: true } as never); } catch { hits = []; }
  if (hits.length === 0) { for (const v of variants) acc[v].n++; continue; }
  const metas = hits.length ? db.prepare(metaStmt(hits.length)).all(...hits.map((h) => h.sessionId)) as Array<{ id: string; title: string | null; topics: string | null; last_event_at: string | null }> : [];
  const metaOf = new Map(metas.map((m) => [m.id, m]));
  const tokens = ((parseQuery(it.query) as { units: string[][] }).units.flat()).filter((t) => t.length >= 2);
  const hasTime = TIME_ANCHOR.test(it.query);
  const cands: Cand[] = hits.map((h) => {
    const m = metaOf.get(h.sessionId);
    const bag = ((m?.title ?? '') + ' ' + (m?.topics ?? '')).toLowerCase();
    const titleHit = tokens.length === 0 ? 0 : tokens.filter((t) => bag.includes(t.toLowerCase())).length / tokens.length;
    let recency = 0;
    if (hasTime && m?.last_event_at) {
      const days = Math.max(0, (now - new Date(m.last_event_at).getTime()) / 86400000);
      recency = Math.exp(-days / 30); // 30 天半衰期，确定性、无参数扫描
    }
    return { id: h.sessionId, score: h.score, coverage: Number(h.coverage ?? 0), titleHit, recency };
  });
  for (const v of variants) {
    const ranked = [...cands].sort((a, b) => RANK[v](b) - RANK[v](a));
    const rank = ranked.findIndex((c) => c.id === it.target) + 1;
    const a = acc[v]; a.n++;
    if (rank === 1) a.h1++;
    if (rank >= 1 && rank <= 10) a.h10++;
    if (rank > 0) a.mrr += 1 / rank;
  }
  if (++done % 25 === 0) console.log('  ...', done, '/', items.length);
}

const pct = (x: number, n: number) => (n === 0 ? 0 : Math.round((x / n) * 1000) / 10);
console.log('== 重排特征实验（n=' + items.length + '，候选上限 ' + LIMIT + '）==');
for (const v of variants) {
  const a = acc[v];
  console.log(v.padEnd(10), 'hit@1 ' + String(pct(a.h1, a.n)).padStart(5) + '%  hit@10 ' + String(pct(a.h10, a.n)).padStart(5) + '%  MRR ' + (a.n ? (a.mrr / a.n * 100).toFixed(1) : '0') + '%');
}
if (OUT) { fs.writeFileSync(OUT, JSON.stringify({ qfile: QFILE, limit: LIMIT, acc }, null, 1)); console.log('已写', OUT); }
