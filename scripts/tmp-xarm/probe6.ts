import fs from 'node:fs';
import { createRequire } from 'node:module';
const require2 = createRequire(import.meta.url);
const Database = require2('better-sqlite3');
const { searchSessions } = await import('../../src/search-svc/engine.js');
const db = new Database('D:/agent1super/.sessionrelay/relay.sqlite', { readonly: true, fileMustExist: true });
const PID = (db.prepare('SELECT project_id FROM sessions LIMIT 1').get() as any).project_id;
const items = (JSON.parse(fs.readFileSync('scripts/bench-questions-paraphrase-v2.json','utf8')).items as any[]).filter(x=>x.arm==='X').slice(0,20);
const run = (q: string, limit: number, tb?: number) => searchSessions(db, { project: PID, query: q, limit, rewrite: true, lengthNorm: true, coreOnly: true, ...(tb===undefined?{}:{titleBoost:tb}) } as never).map(h=>h.sessionId);
// over-fetch 深度 = min(200, max(limit*4, 40))（engine.ts searchSessions）
// 假设：limit=10 与 limit=11 的候选池是 40 vs 44，池不同 ⇒ 重排结果不同
let same40 = 0, diff40 = 0, same200 = 0, diff200 = 0;
for (const it of items) {
  const t10 = run(it.query, 10);            // 池 40
  const t40 = run(it.query, 40).slice(0,10); // 池 160 -> 不，40*4=160
  const t11 = run(it.query, 11).slice(0,10); // 池 44
  const t50 = run(it.query, 50).slice(0,10); // 池 200
  if (t10.join(',') === t11.join(',')) same40++; else diff40++;
  if (t10.join(',') === t50.join(',')) same200++; else diff200++;
  void t40;
}
console.log('n=20  limit10 vs limit11(池44) 相同', same40, '不同', diff40);
console.log('n=20  limit10 vs limit50(池200) 相同', same200, '不同', diff200);
// 直接测池大小：用同一 limit 不同 overfetch 不可控，改测「池 40 内的顺序是否就是 limit=10 的顺序」
console.log('corpus messages', (db.prepare('SELECT COUNT(*) c FROM messages').get() as any).c);
