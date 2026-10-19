// xarm-evidence.ts —— 用「多会话证据覆盖」而不是「目标会话 hit@1」来量 X 臂。
//
// 为什么：X 臂题目问的是「在哪几次会话里……」，答案本来是一组会话；
// 基准只认「某一个特定会话排第一」，于是 91.6% 的证据已被返回的题被判成失败。
// 本脚本按新判据重测，不改产品代码、只读库。
//
// 用法：npx tsx scripts/xarm-evidence.ts <db> --questions scripts/bench-questions-paraphrase-v2.json
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
const TOP = Number(arg('top', '10'));
const items = (JSON.parse(fs.readFileSync(QFILE, 'utf8')) as { items: Array<{ arm: string; query: string; target: string }> }).items.filter((x) => x.arm === 'X');
const db = new Database(dbPath, { readonly: true });
const PID = (db.prepare('SELECT project_id FROM sessions LIMIT 1').get() as { project_id: string }).project_id;
const msgStmt = db.prepare('SELECT content FROM messages WHERE session_id = ? ORDER BY seq_num');
const textOf = (sid: string): string => (msgStmt.all(sid) as Array<{ content: string }>).map((m) => m.content).join('\n');

let full = 0, partial = 0, none = 0, n = 0;
const examples: string[] = [];
for (const it of items) {
  const toks = (parseQuery(it.query) as { units: string[][] }).units.flat().filter((t) => t.length >= 2);
  if (toks.length === 0) continue;
  // 目标会话里命中词元最多的一条 = 证据句
  const msgs = (msgStmt.all(it.target) as Array<{ content: string }>).map((m) => m.content);
  let best = '';
  let bestHit = 0;
  for (const m of msgs) { const h = toks.filter((t) => m.includes(t)).length; if (h > bestHit) { bestHit = h; best = m; } }
  n++;
  if (best === '') { none++; continue; }
  const bestToks = toks.filter((t) => best.includes(t));
  let hits: Array<{ sessionId: string }> = [];
  try { hits = searchSessions(db, { project: PID, query: it.query, limit: TOP, rewrite: true, lengthNorm: true, coreOnly: true } as never); } catch { hits = []; }
  const retText = hits.map((h) => textOf(h.sessionId)).join('\n');
  const covered = bestToks.filter((t) => retText.includes(t)).length;
  const ratio = bestToks.length ? covered / bestToks.length : 0;
  if (ratio >= 0.8) full++; else if (ratio > 0) partial++; else none++;
  if (examples.length < 5) examples.push(it.query.slice(0, 36) + ' | 证据词元 ' + covered + '/' + bestToks.length);
}
const pct = (x: number) => (n === 0 ? '0.0' : ((x / n) * 100).toFixed(1));
console.log('X 臂多会话证据覆盖（n=' + n + '，top=' + TOP + '）');
console.log('证据句 >=80% 被覆盖:', full, pct(full) + '%');
console.log('部分覆盖:', partial, pct(partial) + '%');
console.log('完全没覆盖:', none, pct(none) + '%');
for (const e of examples) console.log('  ' + e);
