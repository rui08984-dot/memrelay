// recall-oracle.ts —— 把「召回」与「排序」拆开的诊断器（只读，不改任何数据）。
//
// 为什么需要它：305 题基准只报 hit@1 / hit@10，两个数混着「根本没找到」和
// 「找到了但排不进去」。外部方案据此断言"规则提取精度只有 50-60%"，但没有仪器
// 能分开这两件事。SmartSearch 的 oracle 分析（召回 98.6% vs 截断幸存 22.5%）
// 正是这么拆的 —— 本脚本照抄那个思路，换成我们的库与题面。
//
// 三道判据（各回答一个问题）：
//   ① 词法可达（lexical reachable）：目标会话里有没有**任何一个**查询词元？
//      —— 没有 ⇒ 再好的排序也救不回来（召回/词汇问题）。
//   ② OR 候选（oracle candidate）：用 OR 语义跑 FTS，目标会话在不在候选集？
//      在 ⇒ 索引里有它，只是主路的 AND 约束/排序把它丢了。
//   ③ 实际排名（rank）：产品默认参数下，目标会话排第几？
//      rank1 / rank2-10 / rank11-50 / 未进前 50 / 完全不可达。
//
// 用法：
//   npx tsx scripts/recall-oracle.ts <dbPath> --questions scripts/bench-questions-paraphrase-v2.json --limit 50 --json scripts/bench-out/oracle-305.json
//
// 红线：只读打开数据库；不写 config、不跑 lifecycle、不改任何记忆。
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
const LIMIT = Number(arg('limit', '50'));
const OUT = arg('json', '');

interface Item { arm: string; query: string; target: string; kind?: string }
const q = JSON.parse(fs.readFileSync(QFILE, 'utf8')) as { dbPath?: string; items: Item[] };
const items = q.items ?? [];
const db = new Database(dbPath, { readonly: true });
const PID = (db.prepare('SELECT project_id FROM sessions LIMIT 1').get() as { project_id: string }).project_id;

const q2 = db.prepare('SELECT 1 AS x FROM messages_fts f JOIN messages m ON m.id = f.rowid WHERE messages_fts MATCH ? AND m.session_id = ? LIMIT 1');
const ftsExpr = (query: string): string | null => {
  const { units } = parseQuery(query) as { units: string[][] };
  const toks = units.flat().map((t) => t.trim()).filter(Boolean);
  if (toks.length === 0) return null;
  return toks.map((t) => '"' + t.replace(/"/g, '""') + '"').join(' OR ');
};

const stats: Record<string, { n: number; reachable: number; rank1: number; rank2_10: number; rank11_50: number; past50: number; unreachable: number }> = {};
const rows: Array<Record<string, unknown>> = [];
let done = 0;
for (const it of items) {
  const arm = it.arm || '?';
  const st = (stats[arm] ??= { n: 0, reachable: 0, rank1: 0, rank2_10: 0, rank11_50: 0, past50: 0, unreachable: 0 });
  st.n++;
  // ① 词法可达 / ② OR 候选（同一个 FTS 查询：目标会话里有没有任一查询词元）
  const expr = ftsExpr(it.query);
  let reachable = false;
  try { reachable = expr !== null && !!q2.get(expr, it.target); } catch { reachable = false; }
  // ③ 产品默认排名
  let rank = 0;
  try {
    const ids = searchSessions(db, { project: PID, query: it.query, limit: LIMIT, rewrite: true, lengthNorm: true, coreOnly: true } as never).map((h) => h.sessionId);
    const idx = ids.indexOf(it.target);
    rank = idx >= 0 ? idx + 1 : 0;
  } catch { rank = 0; }
  if (!reachable) { st.unreachable++; }
  else {
    st.reachable++;
    if (rank === 1) st.rank1++;
    else if (rank >= 2 && rank <= 10) st.rank2_10++;
    else if (rank >= 11 && rank <= LIMIT) st.rank11_50++;
    else st.past50++;
  }
  rows.push({ arm, query: it.query, target: it.target, reachable, rank });
  if (++done % 25 === 0) console.log('  ...', done, '/', items.length);
}

const pct = (a: number, b: number) => (b === 0 ? 0 : Math.round((a / b) * 1000) / 10);
const line = (label: string, s: { n: number; reachable: number; rank1: number; rank2_10: number; rank11_50: number; past50: number; unreachable: number }) => {
  console.log(
    label.padEnd(8), 'n=' + String(s.n).padStart(4),
    '| 不可达 ' + String(pct(s.unreachable, s.n)).padStart(5) + '%',
    '| 可达 ' + String(pct(s.reachable, s.n)).padStart(5) + '%',
    '| rank1 ' + String(pct(s.rank1, s.n)).padStart(5) + '%',
    '| rank2-10 ' + String(pct(s.rank2_10, s.n)).padStart(5) + '%',
    '| rank11-' + String(LIMIT) + ' ' + String(pct(s.rank11_50, s.n)).padStart(5) + '%',
    '| >' + String(LIMIT) + ' ' + String(pct(s.past50, s.n)).padStart(5) + '%',
  );
};
const all = { n: 0, reachable: 0, rank1: 0, rank2_10: 0, rank11_50: 0, past50: 0, unreachable: 0 };
for (const s of Object.values(stats)) { for (const k of Object.keys(all) as Array<keyof typeof all>) all[k] += s[k]; }
console.log('== Oracle 分析（库：' + dbPath + '，题：' + QFILE + '，limit=' + LIMIT + '）==');
for (const [arm, s] of Object.entries(stats)) line(arm, s);
line('ALL', all);
if (OUT) { fs.writeFileSync(OUT, JSON.stringify({ qfile: QFILE, dbPath, limit: LIMIT, stats, rows }, null, 1)); console.log('已写', OUT); }
