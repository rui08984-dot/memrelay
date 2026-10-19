import { createRequire } from 'node:module';
import fs from 'node:fs';
const require2 = createRequire(import.meta.url);
const Database = require2('better-sqlite3');
const db = new Database('D:/agent1super/.sessionrelay/relay.sqlite', { readonly: true });
const out=[];
const q = JSON.parse(fs.readFileSync('scripts/bench-questions-paraphrase-v2.json','utf8')).items.filter(i=>i.arm==='X');
const get = db.prepare('SELECT id,title,message_count,state,source,topics,files_mentioned,user_tags FROM sessions WHERE id=?');
let withMsg=0, withTopics=0;
for (const it of q){ const r=get.get(it.target); if(!r){out.push('MISSING '+it.target);continue;} if(r.message_count>0)withMsg++; if(r.topics && r.topics!=='[]')withTopics++; }
out.push('X targets with message_count>0: '+withMsg+'/'+q.length+'  with topics '+withTopics);
const t1 = get.get(q[0].target);
out.push('target0 '+JSON.stringify(t1).slice(0,800));
// duplicate titles?
out.push('dup titles '+JSON.stringify(db.prepare('SELECT title,COUNT(*) c FROM sessions GROUP BY title HAVING c>1 ORDER BY c DESC LIMIT 10').all()));
fs.writeFileSync('scripts/_probe.txt', out.join('\n'));
