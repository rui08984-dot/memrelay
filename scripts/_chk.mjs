import { createRequire } from 'node:module';
const require2 = createRequire(import.meta.url);
const Database = require2('better-sqlite3');
const db = new Database('D:/agent1super/.sessionrelay/relay.sqlite', { readonly: true });
console.log('sessions', db.prepare('SELECT COUNT(*) c FROM sessions').get().c);
console.log('messages', db.prepare('SELECT COUNT(*) c FROM messages').get().c);
console.log('links', db.prepare('SELECT COUNT(*) c FROM session_links').get().c);
console.log('max last_event', db.prepare('SELECT MAX(last_event_at) m FROM sessions').get().m);
