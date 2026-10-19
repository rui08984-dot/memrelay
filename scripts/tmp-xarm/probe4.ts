import fs from 'node:fs';
import { createRequire } from 'node:module';
const require2 = createRequire(import.meta.url);
const Database = require2('better-sqlite3');
const { searchSessions } = await import('../../src/search-svc/engine.js');
const db = new Database('D:/agent1super/.sessionrelay/relay.sqlite', { readonly: true, fileMustExist: true });
const PID = (db.prepare('SELECT project_id FROM sessions LIMIT 1').get() as any).project_id;
const items = (JSON.parse(fs.readFileSync('scripts/bench-questions-paraphrase-v2.json','utf8')).items as any[]).filter(x=>x.arm==='X');
const run = (q: string, limit: number, tb?: number) => searchSessions(db, { project: PID, query: q, limit, rewrite: true, lengthNorm: true, coreOnly: true, ...(tb===undefined?{}:{titleBoost:tb}) } as never).map(h=>h.sessionId);
let dTB1 = 0, dTB0 = 0, n = 0;
for (const it of items) {
  const a = run(it.query, 10), b = run(it.query, 50);
  const a0 = run(it.query, 10, 0), b0 = run(it.query, 50, 0);
  if (a.join(',') !== b.slice(0,10).join(',')) dTB1++;
  if (a0.join(',') !== b0.slice(0,10).join(',')) dTB0++;
  n++;
}
console.log('n', n, '| top10(limit=10) vs top10(limit=50) 不同题数: titleBoost=1 ->', dTB1, ' titleBoost=0 ->', dTB0);
const q0 = items[0].query;
for (const L of [10, 11, 20, 40, 50]) console.log('limit', L, run(q0, L).slice(0,10).join(',') === run(q0,10).join(',') ? 'same' : 'DIFF');
