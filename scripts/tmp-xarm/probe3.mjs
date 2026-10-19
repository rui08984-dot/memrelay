import { createRequire } from 'node:module';
const require2 = createRequire(import.meta.url);
const Database = require2('better-sqlite3');
const db = new Database('D:/agent1super/.sessionrelay/relay.sqlite', { readonly: true });
console.log('messages total', db.prepare('SELECT COUNT(*) c, MIN(id) mn, MAX(id) mx FROM messages').get());
console.log('seq range', db.prepare('SELECT MIN(seq_num) mn, MAX(seq_num) mx FROM messages').get());
console.log('per-session seq sample', db.prepare("SELECT session_id, MIN(seq_num) mn, MAX(seq_num) mx, COUNT(*) c FROM messages WHERE session_id IN ('061b3409dd467317','ee28bbcac74d7410') GROUP BY session_id").all());
console.log('msg 7558 owners', db.prepare('SELECT id, session_id, seq_num FROM messages WHERE seq_num=7558').all().slice(0,5));
console.log('rows for those sessions', db.prepare("SELECT id, session_id, seq_num FROM messages WHERE session_id='ee28bbcac74d7410' ORDER BY seq_num DESC LIMIT 3").all());
