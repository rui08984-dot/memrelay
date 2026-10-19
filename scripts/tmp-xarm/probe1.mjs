import fs from 'node:fs';
import { createRequire } from 'node:module';
const require2 = createRequire(import.meta.url);
const Database = require2('better-sqlite3');
const db = new Database('D:/agent1super/.sessionrelay/relay.sqlite', { readonly: true });
const j = JSON.parse(fs.readFileSync('scripts/bench-questions-paraphrase-v2.json','utf8'));
const xs = j.items.filter(i=>i.arm==='X');
const stmt = db.prepare('SELECT id,title,message_count,topics FROM sessions WHERE id=?');
let miss=0, zero=0, have=0;
for (const it of xs){ const r=stmt.get(it.target); if(!r){miss++;continue;} if(Number(r.message_count)===0) zero++; else have++; }
console.log('X n=',xs.length,'missing target=',miss,'msg0=',zero,'with msgs=',have);
console.log('projects:', db.prepare('SELECT project_id, COUNT(*) c FROM sessions GROUP BY project_id').all());
console.log('total sessions', db.prepare('SELECT COUNT(*) c FROM sessions').get());
