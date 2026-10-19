import fs from 'node:fs';
import { createRequire } from 'node:module';
const require2 = createRequire(import.meta.url);
const Database = require2('better-sqlite3');
const db = new Database('D:/agent1super/.sessionrelay/relay.sqlite', { readonly: true, fileMustExist: true });
const j = JSON.parse(fs.readFileSync('scripts/bench-out/xarm-aggregate.json','utf8'));
const rows = j.rows;
// 抽查：目标不在 top-10 但 P1 span=1 的题 —— 覆盖是「真证据」还是「锚点泛共现」？
const cand = rows.filter((r)=>r.rank10 === 0 && r.p1.span >= 1 && r.goldHits > 0).slice(0,4);
const msgs = (sid) => db.prepare('SELECT seq_num AS seq, content FROM messages WHERE session_id = ? ORDER BY seq_num').all(sid);
for (const r of cand) {
  console.log('---');
  console.log('Q:', r.query);
  console.log('  目标', r.target, 'rank10=', r.rank10||'—', 'rank50=', r.rankDeep||'—', '锚点', r.nAnchors);
  console.log('  证据句:', r.goldText.slice(0,80));
  // 在 top-10 每个会话里找，哪个会话包含证据句前 20 字
  const head = r.goldText.replace(/\s+/g,'').slice(0,20);
  let who = null;
  for (let i=0;i<r.packTitles.length;i++) {
    const sid = j.rows.find(x=>x===r) ? null : null;
    void sid;
  }
  console.log('  证据句前20字:', head);
  // 全库搜这句话（近似：前 20 字）出现在哪些会话
  const like = db.prepare("SELECT DISTINCT session_id AS sid FROM messages WHERE content LIKE ? LIMIT 5").all('%'+head+'%');
  console.log('  含该片段的会话数(全库,前5):', like.length, like.map(x=>x.sid.slice(0,8)).join(','));
  console.log('  这些会话在 top-10 里吗:', like.map(x=>r.packTitles.findIndex((t,i)=>false)).length ? '?' : '(见下)');
}
