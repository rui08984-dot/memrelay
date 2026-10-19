import fs from 'node:fs';
import { createRequire } from 'node:module';
const require2 = createRequire(import.meta.url);
const Database = require2('better-sqlite3');
const { searchSessions } = await import('../../src/search-svc/engine.js');
const db = new Database('D:/agent1super/.sessionrelay/relay.sqlite', { readonly: true, fileMustExist: true });
const PID = (db.prepare('SELECT project_id FROM sessions LIMIT 1').get() as any).project_id;
const items = (JSON.parse(fs.readFileSync('scripts/bench-questions-paraphrase-v2.json','utf8')).items as any[]).filter(x=>x.arm==='X');
const run = (q: string, limit: number, o: any) => searchSessions(db, { project: PID, query: q, limit, ...o } as never).map(h=>h.sessionId);
const variants: Array<[string, any]> = [
  ['tb1 rewrite1 core1 (产品默认)', { rewrite: true, lengthNorm: true, coreOnly: true }],
  ['tb0 rewrite1 core1', { rewrite: true, lengthNorm: true, coreOnly: true, titleBoost: 0 }],
  ['tb1 rewrite0', { rewrite: false, lengthNorm: true, titleBoost: 1 }],
  ['tb0 rewrite0', { rewrite: false, lengthNorm: true, titleBoost: 0 }],
];
for (const [label, o] of variants) {
  let d = 0, d5 = 0;
  for (const it of items) {
    const a = run(it.query, 10, o), b = run(it.query, 50, o);
    if (a.join(',') !== b.slice(0,10).join(',')) d++;
    const c = run(it.query, 11, o);
    if (a.join(',') !== c.slice(0,10).join(',')) d5++;
  }
  console.log(label.padEnd(34), '| limit10 vs limit50 top10 不同:', String(d).padStart(2), '/95', ' | limit10 vs limit11:', String(d5).padStart(2), '/95');
}
