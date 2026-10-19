// probe-limit.ts —— §5.1 隔离实验：top-10 为什么会随 limit 变？
// 假设：searchSessions 里 titleBoost 的 over-fetch 深度 = min(200, max(limit*4,40))，
//       而 rewrite 补充路的触发判据依赖这个池子的内容 ⇒ 池子大小随 limit 变 ⇒ 重排结果变。
// 判据：关掉 rewrite 后，top-10 应当与 limit 完全无关。
// 用法：npx tsx scripts/tmp-xarm/probe-limit.ts <dbPath>
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require2 = createRequire(import.meta.url);
const Database = require2('better-sqlite3');
const { searchSessions } = await import('../../src/search-svc/engine.js');
const dbPath = process.argv[2] || 'scripts/tmp-xarm/snapshot.sqlite';
const db = new Database(dbPath, { readonly: true, fileMustExist: true });
const PID = (db.prepare('SELECT project_id FROM sessions LIMIT 1').get() as { project_id: string }).project_id;
const items = (JSON.parse(fs.readFileSync('scripts/bench-questions-paraphrase-v2.json', 'utf8')).items as Array<{ arm: string; query: string }>).filter((x) => x.arm === 'X');
const run = (q: string, limit: number, o: Record<string, unknown>) =>
  searchSessions(db, { project: PID, query: q, limit, ...o } as never).map((h) => h.sessionId);
const variants: Array<[string, Record<string, unknown>]> = [
  ['tb1 rewrite1 core1 (产品默认)', { rewrite: true, lengthNorm: true, coreOnly: true }],
  ['tb0 rewrite1 core1', { rewrite: true, lengthNorm: true, coreOnly: true, titleBoost: 0 }],
  ['tb1 rewrite0', { rewrite: false, lengthNorm: true, titleBoost: 1 }],
  ['tb0 rewrite0', { rewrite: false, lengthNorm: true, titleBoost: 0 }],
];
for (const [label, o] of variants) {
  let d = 0, d11 = 0;
  for (const it of items) {
    const a = run(it.query, 10, o), b = run(it.query, 50, o), c = run(it.query, 11, o);
    if (a.join(',') !== b.slice(0, 10).join(',')) d++;
    if (a.join(',') !== c.slice(0, 10).join(',')) d11++;
  }
  console.log(label.padEnd(34), '| limit10 vs limit50 top10 不同:', String(d).padStart(2), '/95', ' | limit10 vs limit11:', String(d11).padStart(2), '/95');
}
