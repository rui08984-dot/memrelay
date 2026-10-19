import fs from 'node:fs';
import { createRequire } from 'node:module';
const require2 = createRequire(import.meta.url);
const Database = require2('better-sqlite3');
const db = new Database('D:/agent1super/.sessionrelay/relay.sqlite', { readonly: true });
const j = JSON.parse(fs.readFileSync('scripts/bench-questions-paraphrase-v2.json','utf8'));
const xs = j.items.filter(i=>i.arm==='X');
const tgts = xs.map(i=>i.target);
const ph = tgts.map(()=>'?').join(',');
const rows = db.prepare('SELECT s.id, s.message_count, COUNT(m.id) n, SUM(LENGTH(m.content)) len, MAX(LENGTH(m.content)) mx FROM sessions s LEFT JOIN messages m ON m.session_id=s.id WHERE s.id IN ('+ph+') GROUP BY s.id').all(...tgts);
let tot=0, totLen=0, maxN=0, maxLen=0;
for(const r of rows){ tot+=r.n; totLen+=r.len||0; if(r.n>maxN)maxN=r.n; if((r.mx||0)>maxLen)maxLen=r.mx; }
console.log('targets',tgts.length,'sessions found',rows.length,'total msgs',tot,'total chars',totLen,'max msgs in one',maxN,'max single msg len',maxLen);
const lens = db.prepare('SELECT AVG(LENGTH(content)) a, MAX(LENGTH(content)) mx FROM messages').get();
console.log('corpus avg msg len',lens);
console.log('dup targets', tgts.length - new Set(tgts).size);
