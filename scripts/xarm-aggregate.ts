// xarm-aggregate.ts —— X 臂（跨会话）「多会话证据聚合」原型（只读库，不改 src/）。
//
// 背景：X 臂 95 题 hit@1 只有 8.4%，但题面本身是「……在哪些会话里处理过」——
//   考的是**多会话证据**，而现有基准只认「某个目标会话排第几」（指标与任务错配，
//   见 research/xarm-diagnosis.md：92.6% 是 B 类真跨会话题）。
//
// 本脚本回答两件事，全部零模型、确定性、可复跑：
//   ① hit@10（目标会话是否在产品默认 top-10）—— **基线，聚合本身不改变它**
//   ② 证据覆盖率：目标会话的**关键证据句**是否真的落进了拼出来的「证据包」
//      （这才是「能不能答」的口径；hit@10 只说明「会话在不在列表里」）
//   另加零模型增强：top-10 按 topic/tag 聚类成「跨会话证据组」，
//      并量「组签名扩展」能否把 rank 11–50 的目标会话补回来。
//
// 三条证据包（同一批 top-10，只换「取哪条片段」= 单变量）：
//   P0 base      产品自带 snippet（excerpt：围绕**第一个查询单元**取 120 字）
//   P1 best@120  同预算（120 字），改取**该会话内锚点覆盖最高的那条消息**
//                → 与 P0 的差别**只**来自「选哪条消息」，不来自「给多少字」
//   P2 best@320  产品 snippet + 最佳消息 200 字窗口（≈4 倍预算）
//                → 「上下文更宽」的上限；用来区分「选错消息」与「给字太少」
//
// 用法：
//   npx tsx scripts/xarm-aggregate.ts <dbPath> \
//     [--questions scripts/bench-questions-paraphrase-v2.json] [--limit 10] [--deep 50] \
//     [--jaccard 0.34] [--expand 5] [--examples 5] [--json scripts/bench-out/xarm-aggregate.json]
//
// 红线：只读打开数据库（readonly + fileMustExist）；不写 config、不跑 lifecycle/recompute。
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require2 = createRequire(import.meta.url);
const Database = require2('better-sqlite3');
const { searchSessions } = await import('../src/search-svc/engine.js');
const { parseQuery } = await import('../src/core/tokenize/tokenizer.js');
const { pickScaffold } = await import('../src/core/tokenize/rewrite.js');

const argv = process.argv.slice(2);
const dbPath = argv[0];
if (!dbPath) {
  console.error('用法：npx tsx scripts/xarm-aggregate.ts <dbPath> [--questions <q.json>] [--json <out.json>]');
  process.exit(2);
}
const arg = (n: string, d: string) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const QFILE = arg('questions', 'scripts/bench-questions-paraphrase-v2.json');
const OUT = arg('json', '');
const LIMIT = Number(arg('limit', '10'));
const DEEP = Number(arg('deep', '50'));
const JACCARD = Number(arg('jaccard', '0.34'));
const EXPAND = Number(arg('expand', '5'));
const NEX = Number(arg('examples', '5'));

const db = new Database(dbPath, { readonly: true, fileMustExist: true });
const PID = (db.prepare('SELECT project_id FROM sessions LIMIT 1').get() as { project_id: string }).project_id;
const NMSG = (db.prepare('SELECT COUNT(*) AS c FROM messages').get() as { c: number }).c;
// 库指纹：这个库在跑的时候**还在被写**（同一台机器上的守护进程），
// 所以「可复现」必须绑一个指纹 —— 否则别人复跑拿到的是另一个快照。
const NSESS = (db.prepare('SELECT COUNT(*) AS c FROM sessions').get() as { c: number }).c;
const MAXMID = (db.prepare('SELECT MAX(id) AS m FROM messages').get() as { m: number }).m;
let dbStat = { size: 0, mtime: '' };
try { const st = fs.statSync(dbPath); dbStat = { size: st.size, mtime: st.mtime.toISOString() }; } catch { /* 取不到就算了 */ }
const FINGERPRINT = 'sessions=' + NSESS + ' messages=' + NMSG + ' maxMsgId=' + MAXMID + ' bytes=' + dbStat.size + ' mtime=' + dbStat.mtime;

// ── 文本工具（确定性，无模型）───────────────────────────────────────────────
const norm = (s: string) => s.replace(/\s+/g, '').toLowerCase();
const SENT_SPLIT = /[。！？!?；;\n\r]+/;
const sentencesOf = (text: string) => text.split(SENT_SPLIT).map((s) => s.trim()).filter((s) => s.length >= 8);

/** 查询锚点：parseQuery 词元，去掉 <2 字与问句外壳词（pickScaffold 是产品里同一张表） */
function anchorsOf(query: string): string[] {
  const units = (parseQuery(query) as { units: string[][] }).units.flat();
  const scaffold = new Set(pickScaffold(units));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of units) {
    const s = t.trim();
    if (s.length < 2 || scaffold.has(s)) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k); out.push(s);
  }
  return out;
}
const countIn = (textLower: string, anchors: string[]) => anchors.reduce((n, a) => n + (textLower.includes(a.toLowerCase()) ? 1 : 0), 0);

/** 锚点 df（出现该词的消息条数，FTS 计数，带缓存）→ idf 权重 */
const dfCache = new Map<string, number>();
const dfStmt = db.prepare('SELECT COUNT(*) AS c FROM messages_fts WHERE messages_fts MATCH ?');
function idfOf(anchor: string): number {
  const k = anchor.toLowerCase();
  const hit = dfCache.get(k);
  if (hit !== undefined) return hit;
  let df = 1;
  try { df = Number((dfStmt.get('"' + anchor.replace(/"/g, '""') + '"') as { c: number }).c) || 1; } catch { df = 1; }
  const w = Math.log(1 + NMSG / Math.max(1, df));
  dfCache.set(k, w);
  return w;
}

/** 在消息里取围绕锚点的定长窗口（与产品 excerpt 同构，只是长度可调、锚点可指定） */
function windowAround(content: string, anchor: string, max: number): string {
  const i = content.toLowerCase().indexOf(anchor.toLowerCase());
  const start = Math.max(0, (i === -1 ? 0 : i) - Math.floor(max / 3));
  return content.slice(start, start + max).replace(/\s+/g, ' ').trim();
}

// ── 标签（聚类用）：topics ∪ user_tags ∪ 图谱标签（按 weight 前 10）──────────
const tagCache = new Map<string, string[]>();
const tagStmt = db.prepare('SELECT g.name FROM graph_tag_sessions gs JOIN graph_tags g ON g.id = gs.tag_id WHERE gs.session_id = ? ORDER BY gs.weight DESC LIMIT 10');
const metaStmt = db.prepare('SELECT id, title, topics, user_tags FROM sessions WHERE id = ?');
function tagSetOf(sid: string): string[] {
  const hit = tagCache.get(sid);
  if (hit) return hit;
  const out: string[] = [];
  try {
    const m = metaStmt.get(sid) as { topics: string | null; user_tags: string | null } | undefined;
    for (const raw of [m?.topics, m?.user_tags]) {
      if (!raw) continue;
      try { const arr = JSON.parse(raw) as unknown; if (Array.isArray(arr)) for (const x of arr) if (typeof x === 'string' && x.trim()) out.push(x.trim()); } catch { /* 坏 JSON 忽略 */ }
    }
    for (const r of tagStmt.all(sid) as Array<{ name: string }>) out.push(r.name);
  } catch { /* 取不到就空集 */ }
  const uniq = [...new Set(out)];
  tagCache.set(sid, uniq);
  return uniq;
}
const jaccard = (a: Set<string>, b: Set<string>) => {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0; for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
};

// ── 消息读取 ────────────────────────────────────────────────────────────────
interface Msg { seq: number; content: string }
const msgsOfSessions = (sids: string[]): Map<string, Msg[]> => {
  const out = new Map<string, Msg[]>();
  if (sids.length === 0) return out;
  const ph = sids.map(() => '?').join(',');
  const rows = db.prepare('SELECT session_id AS sid, seq_num AS seq, content FROM messages WHERE session_id IN (' + ph + ') ORDER BY session_id, seq_num').all(...sids) as Array<{ sid: string; seq: number; content: string }>;
  for (const r of rows) {
    let arr = out.get(r.sid);
    if (!arr) { arr = []; out.set(r.sid, arr); }
    arr.push({ seq: Number(r.seq), content: r.content ?? '' });
  }
  return out;
};

/** 关键证据句：目标会话里**锚点覆盖最高**的句子（零模型；平手按 seq 早 → 句短） */
function goldSentenceOf(msgs: Msg[], anchors: string[]): { text: string; seq: number; hits: number } | null {
  let best: { text: string; seq: number; hits: number; len: number } | null = null;
  for (const m of msgs) {
    if (countIn(m.content.toLowerCase(), anchors) === 0) continue;
    for (const s of sentencesOf(m.content)) {
      const hits = countIn(s.toLowerCase(), anchors);
      if (hits === 0) continue;
      if (!best || hits > best.hits || (hits === best.hits && (m.seq < best.seq || (m.seq === best.seq && s.length < best.len)))) {
        best = { text: s, seq: m.seq, hits, len: s.length };
      }
    }
  }
  return best ? { text: best.text, seq: best.seq, hits: best.hits } : null;
}

/** 会话内锚点覆盖最高的消息（平手取 seq 最早） */
function bestMsgOf(msgs: Msg[], anchors: string[]): { msg: Msg; hits: number } | null {
  let best: { msg: Msg; hits: number } | null = null;
  for (const m of msgs) {
    const hits = countIn(m.content.toLowerCase(), anchors);
    if (hits === 0) continue;
    if (!best || hits > best.hits) best = { msg: m, hits };
    if (hits === anchors.length) break; // 满覆盖且 seq 升序 ⇒ 取最早
  }
  return best;
}

// ── 证据覆盖率 ──────────────────────────────────────────────────────────────
interface Cov { strict: boolean; pref40: boolean; span: number; spanIdf: number }
// 严格整句命中对**窗口边界**极敏感：句子只有 51 字也会因为锚点靠边而被截掉尾巴。
// 所以另给一个稳健口径 pref40 = 证据句前 40 字（去空白）出现在包里 —— 用来把
// 「选错了消息」和「窗口刚好切在句尾」两件事分开。
const PREF = 40;
function coverageOf(pack: string[], goldText: string, goldAnchors: string[]): Cov {
  const windows = pack.map(norm).filter((w) => w.length > 0);
  const joined = windows.join('\u0000'); // 分隔符：防止跨片段拼接造成假命中
  const strict = joined.includes(norm(goldText));
  const pref40 = joined.includes(norm(goldText).slice(0, PREF));
  const wsum = goldAnchors.reduce((a, t) => a + idfOf(t), 0) || 1;
  let span = 0, spanIdf = 0;
  for (const w of windows) {
    let n = 0, wi = 0;
    for (const a of goldAnchors) if (w.includes(a.toLowerCase())) { n++; wi += idfOf(a); }
    if (n / goldAnchors.length > span) span = n / goldAnchors.length;
    if (wi / wsum > spanIdf) spanIdf = wi / wsum;
  }
  return { strict, pref40, span, spanIdf };
}

// ── 统计 ────────────────────────────────────────────────────────────────────
const pct = (a: number, b: number) => (b === 0 ? 0 : Math.round((a / b) * 1000) / 10);
function mcnemarExact(b: number, c: number): number {
  const n = b + c;
  if (n === 0) return 1;
  const k = Math.min(b, c);
  let tail = 0, logC = 0;
  for (let i = 0; i <= k; i++) {
    if (i > 0) logC += Math.log((n - i + 1) / i);
    tail += Math.exp(logC - n * Math.LN2);
  }
  return Math.min(1, 2 * tail);
}


// ── 主循环 ──────────────────────────────────────────────────────────────────
interface Item { arm: string; query: string; target: string; kind?: string }
const q = JSON.parse(fs.readFileSync(QFILE, 'utf8')) as { items: Item[] };
const items = (q.items ?? []).filter((x) => x.arm === 'X');

interface Row {
  query: string; target: string; kind: string;
  rank10: number; rankDeep: number;          // 0 = 不在该深度内
  nAnchors: number; goldHits: number; goldLen: number; goldText: string;
  base: Cov; p1: Cov; p2: Cov; own0: Cov; own1: Cov;
  chars0: number; chars1: number; chars2: number;
  clusters: number; groupSize: number;
  recovered: boolean | null; extras: number; extrasTagged: number;
  packTitles: string[]; packHeads: string[];
}
const SWEEP = [0.2, 0.34, 0.5, 0.7];
const sweep = new Map<number, { groups: number; n: number; multi: number }>(SWEEP.map((t) => [t, { groups: 0, n: 0, multi: 0 }]));
/** 单链接聚类：按名次顺序贪心并入（确定性，无随机） */
function clusterWith(sets: Set<string>[], th: number): { clusters: number[][]; clusterOf: number[] } {
  const clusters: number[][] = [];
  const clusterOf: number[] = [];
  for (let i = 0; i < sets.length; i++) {
    let found = -1;
    for (let c = 0; c < clusters.length; c++) if (clusters[c].some((j) => jaccard(sets[i], sets[j]) >= th)) { found = c; break; }
    if (found === -1) { clusters.push([i]); found = clusters.length - 1; } else clusters[found].push(i);
    clusterOf[i] = found;
  }
  return { clusters, clusterOf };
}

const rows: Row[] = [];
let done = 0;

for (const it of items) {
  const anchors = anchorsOf(it.query);
  const hits10 = searchSessions(db, { project: PID, query: it.query, limit: LIMIT, rewrite: true, lengthNorm: true, coreOnly: true } as never);
  const hitsDeep = DEEP > LIMIT
    ? searchSessions(db, { project: PID, query: it.query, limit: DEEP, rewrite: true, lengthNorm: true, coreOnly: true } as never)
    : hits10;
  const rank10 = hits10.findIndex((h) => h.sessionId === it.target) + 1;
  const rankDeep = hitsDeep.findIndex((h) => h.sessionId === it.target) + 1;

  const sids = hits10.map((h) => h.sessionId);
  const msgs = msgsOfSessions([...new Set([...sids, it.target])]);

  const gold = goldSentenceOf(msgs.get(it.target) ?? [], anchors);
  const goldAnchors = gold ? anchors.filter((a) => gold.text.toLowerCase().includes(a.toLowerCase())) : [];

  const pack0: string[] = [], pack1: string[] = [], pack2: string[] = [];
  for (const h of hits10) {
    const sn = (h.snippet ?? '').trim();
    pack0.push(sn);
    const bm = bestMsgOf(msgs.get(h.sessionId) ?? [], anchors);
    const anchorFor = bm ? (anchors.find((a) => bm.msg.content.toLowerCase().includes(a.toLowerCase())) ?? anchors[0] ?? '') : '';
    const frag120 = bm && anchorFor ? windowAround(bm.msg.content, anchorFor, 120) : sn;
    const frag200 = bm && anchorFor ? windowAround(bm.msg.content, anchorFor, 200) : '';
    pack1.push(frag120);
    pack2.push(sn ? sn + ' ' + frag200 : frag200);
  }

  const empty = gold === null || goldAnchors.length === 0;
  const ZERO: Cov = { strict: false, pref40: false, span: 0, spanIdf: 0 };
  const base: Cov = empty ? ZERO : coverageOf(pack0, gold!.text, goldAnchors);
  const p1: Cov = empty ? ZERO : coverageOf(pack1, gold!.text, goldAnchors);
  const p2: Cov = empty ? ZERO : coverageOf(pack2, gold!.text, goldAnchors);
  // 「自己那条」覆盖：只取**目标会话自己**在包里的那一段 —— 把「片段选得好不好」
  // 与「别的会话凑巧提到同样的词」彻底分开（后者是 span 口径会高估的地方）
  const ti0 = sids.indexOf(it.target);
  const own0: Cov = empty || ti0 < 0 ? ZERO : coverageOf([pack0[ti0]], gold!.text, goldAnchors);
  const own1: Cov = empty || ti0 < 0 ? ZERO : coverageOf([pack1[ti0]], gold!.text, goldAnchors);

  // 聚类：top-10 单链接，按名次顺序（确定性）
  const sets = sids.map((s) => new Set(tagSetOf(s)));
  const { clusters, clusterOf } = clusterWith(sets, JACCARD);
  const ti = sids.indexOf(it.target);
  const groupSize = ti >= 0 ? clusters[clusterOf[ti]].length : 0;
  // 阈值扫描用：各阈值下的组数 / 目标组大小
  for (const th of SWEEP) {
    const c = clusterWith(sets, th);
    const s = sweep.get(th)!;
    s.groups += c.clusters.length;
    if (ti >= 0) { s.n++; if (c.clusters[c.clusterOf[ti]].length >= 2) s.multi++; }
  }

  // 组签名扩展：只对「目标不在 top-10 但在 DEEP 内」的题有意义
  let recovered: boolean | null = null;
  let extras = 0, extrasTagged = 0;
  if (rank10 === 0 && rankDeep > 0) {
    const cnt = new Map<string, number>();
    for (const s of sets) for (const t of s) cnt.set(t, (cnt.get(t) ?? 0) + 1);
    const sig = [...cnt.entries()].filter(([, k]) => k >= 2).map(([t]) => t);
    const dfOf = new Map<string, number>();
    for (const t of sig) {
      const r = db.prepare('SELECT df FROM graph_tags WHERE name = ?').get(t) as { df: number } | undefined;
      dfOf.set(t, Number(r?.df ?? 999));
    }
    sig.sort((a, b) => (dfOf.get(a)! - dfOf.get(b)!) || a.localeCompare(b));
    const use = sig.filter((t) => dfOf.get(t)! <= 60).slice(0, 4);
    const score = new Map<string, number>();
    for (const t of use) {
      try {
        const rs = db.prepare('SELECT s.id AS sid FROM sessions_fts JOIN sessions s ON s.rowid = sessions_fts.rowid WHERE sessions_fts MATCH ? AND s.project_id = ? LIMIT 200').all('"' + t.replace(/"/g, '""') + '"', PID) as Array<{ sid: string }>;
        const w = 1 / (1 + Math.log(1 + dfOf.get(t)!));
        for (const r of rs) { if (sids.includes(r.sid)) continue; score.set(r.sid, (score.get(r.sid) ?? 0) + w); }
      } catch { /* 词太怪就跳过 */ }
    }
    const ranked = [...score.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, EXPAND);
    extras = ranked.length;
    for (const [sid] of ranked) if (jaccard(sets[0] ?? new Set(), new Set(tagSetOf(sid))) > 0) extrasTagged++;
    recovered = ranked.some(([sid]) => sid === it.target);
  }

  const titles: string[] = [], heads: string[] = [];
  for (let i = 0; i < hits10.length; i++) {
    const m = metaStmt.get(hits10[i].sessionId) as { title: string | null } | undefined;
    titles.push((m?.title ?? '(无标题)').replace(/\s+/g, ' ').slice(0, 40));
    heads.push((pack1[i] ?? '').slice(0, 46));
  }

  rows.push({
    query: it.query, target: it.target, kind: it.kind ?? '', rank10, rankDeep,
    nAnchors: anchors.length, goldHits: gold?.hits ?? 0, goldLen: gold?.text.length ?? 0, goldText: gold?.text ?? '',
    base, p1, p2, own0, own1,
    chars0: pack0.join('').length, chars1: pack1.join('').length, chars2: pack2.join('').length,
    clusters: clusters.length, groupSize, recovered, extras, extrasTagged,
    packTitles: titles, packHeads: heads,
  });
  if (++done % 10 === 0) console.log('  ...', done, '/', items.length);
}


// ── 汇总 ────────────────────────────────────────────────────────────────────
const n = rows.length;
const evid = rows.filter((r) => r.goldHits > 0);
const ne = evid.length;
const h10 = rows.filter((r) => r.rank10 >= 1 && r.rank10 <= 10).length;
const rank1 = rows.filter((r) => r.rank10 === 1).length;
const mid = rows.filter((r) => r.rank10 === 0 && r.rankDeep >= 1).length;
const unreach = rows.filter((r) => r.rankDeep === 0).length;
// 名次归属在 limit=10 与 limit=DEEP 两次检索间不一致的题（仪器稳定性）
const unstable = rows.filter((r) => (r.rank10 >= 1) !== (r.rankDeep >= 1)).length;
const h10AtDeep = rows.filter((r) => r.rankDeep >= 1 && r.rankDeep <= 10).length;

const stat = (sub: Row[], pick: (r: Row) => Cov) => {
  const arr = sub.map(pick);
  const strict = arr.filter((c) => c.strict).length;
  const pref40 = arr.filter((c) => c.pref40).length;
  const full = arr.filter((c) => c.span >= 1).length;
  const mean = arr.reduce((a, c) => a + c.span, 0) / (sub.length || 1);
  const meanIdf = arr.reduce((a, c) => a + c.spanIdf, 0) / (sub.length || 1);
  return { n: sub.length, strict, pref40, full, mean, meanIdf };
};
const fmt = (s: { n: number; strict: number; pref40: number; full: number; mean: number; meanIdf: number }) =>
  String(pct(s.strict, s.n)).padStart(5) + '%  '
  + String(pct(s.pref40, s.n)).padStart(5) + '%  '
  + String(pct(s.full, s.n)).padStart(5) + '%  '
  + s.mean.toFixed(3) + '  '
  + s.meanIdf.toFixed(3);

const bucketOf = (r: Row) => (r.rank10 === 1 ? 'rank 1' : r.rank10 >= 2 && r.rank10 <= 10 ? 'rank 2-10'
  : r.rank10 === 0 && r.rankDeep >= 1 ? 'rank ' + (LIMIT + 1) + '-' + DEEP : '>' + DEEP + '/不可达');
const BUCKETS = ['rank 1', 'rank 2-10', 'rank ' + (LIMIT + 1) + '-' + DEEP, '>' + DEEP + '/不可达'];

const S0 = stat(rows, (r) => r.base), S1 = stat(rows, (r) => r.p1), S2 = stat(rows, (r) => r.p2);
// 「自己那条」口径：分母 = 目标进 top-10 的题（只有那时包里才有它自己的一段）
const intop = rows.filter((r) => r.rank10 >= 1);
const O0 = stat(intop, (r) => r.own0), O1 = stat(intop, (r) => r.own1);
const oFull0 = intop.filter((r) => r.own0.span >= 1).length;
const oFull1 = intop.filter((r) => r.own1.span >= 1).length;
const oStrict0 = intop.filter((r) => r.own0.strict).length;
const oStrict1 = intop.filter((r) => r.own1.strict).length;
const S0e = stat(evid, (r) => r.base), S1e = stat(evid, (r) => r.p1);
const b01 = evid.filter((r) => r.base.span >= 1 && r.p1.span < 1).length;
const c01 = evid.filter((r) => r.base.span < 1 && r.p1.span >= 1).length;
const b02 = evid.filter((r) => r.base.span >= 1 && r.p2.span < 1).length;
const c02 = evid.filter((r) => r.base.span < 1 && r.p2.span >= 1).length;
const bP = evid.filter((r) => r.base.pref40 && !r.p1.pref40).length;
const cP = evid.filter((r) => !r.base.pref40 && r.p1.pref40).length;

// 严格整句命中的结构性上限：证据句比窗口还长时，120 字窗口不可能整句装下
const short = evid.filter((r) => r.goldLen <= 120);
const S0s = stat(short, (r) => r.base), S1s = stat(short, (r) => r.p1);
void S0e; void S1e;

const avgChars = (f: (r: Row) => number) => Math.round(rows.reduce((a, r) => a + f(r), 0) / (n || 1));
const avgClusters = rows.reduce((a, r) => a + r.clusters, 0) / (n || 1);
const inTop10 = rows.filter((r) => r.rank10 >= 1);
const multi = inTop10.filter((r) => r.groupSize >= 2).length;
const cond = rows.filter((r) => r.rank10 === 0 && r.rankDeep >= 1);
const rec = cond.filter((r) => r.recovered).length;
const extraTot = cond.reduce((a, r) => a + r.extras, 0);
const extraTagged = cond.reduce((a, r) => a + r.extrasTagged, 0);

console.log('');
console.log('== X 臂多会话证据聚合原型 ==');
console.log('库：' + dbPath + '（只读）');
console.log('指纹：' + FINGERPRINT);
console.log('⚠ 该库在跑题期间仍在被写入（守护进程），复跑前先比对指纹；不一致时数字会漂。');
console.log('题：' + QFILE + '　X 臂 n=' + n + '　limit=' + LIMIT + '　deep=' + DEEP);
console.log('检索口径：searchSessions({rewrite:true, lengthNorm:true, coreOnly:true})，titleBoost 走产品默认 DEFAULT_TITLE_BOOST=1');
console.log('');
console.log('【① 基线：目标会话是否在 top-' + LIMIT + '】（证据聚合不改变它，只作对照）');
console.log('  rank 1          : ' + rank1 + '/' + n + ' = ' + pct(rank1, n) + '%');
console.log('  rank 2-' + String(LIMIT).padEnd(2) + '       : ' + (h10 - rank1) + '/' + n + ' = ' + pct(h10 - rank1, n) + '%');
console.log('  hit@' + LIMIT + '           : ' + h10 + '/' + n + ' = ' + pct(h10, n) + '%');
console.log('  rank ' + (LIMIT + 1) + '-' + DEEP + '       : ' + mid + '/' + n + ' = ' + pct(mid, n) + '%');
console.log('  >' + DEEP + ' / 不可达   : ' + unreach + '/' + n + ' = ' + pct(unreach, n) + '%');
console.log('  ⚠ 仪器稳定性：同一题在 limit=' + LIMIT + ' 与 limit=' + DEEP + ' 两次检索里「是否进前 ' + LIMIT + '」不一致 ' + unstable + '/' + n + ' 题');
console.log('    （按 limit=' + DEEP + ' 的返回序列数前 ' + LIMIT + ' 名，hit@' + LIMIT + ' = ' + pct(h10AtDeep, n) + '%）');
console.log('');
console.log('【② 证据覆盖率】分母 n=' + n + '（' + ne + ' 题有可定位证据句；' + (n - ne) + ' 题目标会话无正文/无锚点句，按「未覆盖」计，与 hit@10 同分母可比）');
console.log('  包          严格整句  句首40字   span=1.0   平均span  平均span(idf)');
const line = (label: string, s: { n: number; strict: number; full: number; mean: number; meanIdf: number }) =>
  console.log('  ' + label.padEnd(11) + ' ' + fmt(s));
line('P0 base', S0);
line('P1 best@120', S1);
line('P2 best@320', S2);
console.log('  ── 「自己那条」口径（分母 = 目标进 top-' + LIMIT + ' 的 ' + intop.length + ' 题；只取目标会话自己在包里那段）──');
console.log('     ' + 'P0 own'.padEnd(11) + ' 严格整句 ' + String(pct(oStrict0, intop.length)).padStart(5) + '%'
  + '　span=1.0 ' + String(pct(oFull0, intop.length)).padStart(5) + '%'
  + '　平均 span ' + O0.mean.toFixed(3));
console.log('     ' + 'P1 own'.padEnd(11) + ' 严格整句 ' + String(pct(oStrict1, intop.length)).padStart(5) + '%'
  + '　span=1.0 ' + String(pct(oFull1, intop.length)).padStart(5) + '%'
  + '　平均 span ' + O1.mean.toFixed(3));
console.log('     配对 own P0→P1：span=1.0 +' + intop.filter((r) => r.own0.span < 1 && r.own1.span >= 1).length
  + ' / -' + intop.filter((r) => r.own0.span >= 1 && r.own1.span < 1).length
  + '　p=' + mcnemarExact(intop.filter((r) => r.own0.span >= 1 && r.own1.span < 1).length, intop.filter((r) => r.own0.span < 1 && r.own1.span >= 1).length).toFixed(4));
console.log('  包长（字/题）：P0 ' + avgChars((r) => r.chars0) + '　P1 ' + avgChars((r) => r.chars1) + '　P2 ' + avgChars((r) => r.chars2)
  + '（P2/P0 = ' + (avgChars((r) => r.chars2) / Math.max(1, avgChars((r) => r.chars0))).toFixed(1) + 'x）');
console.log('  配对 P0→P1（同预算，只换选哪条消息）：span=1.0 +' + c01 + ' / -' + b01 + '　McNemar p=' + mcnemarExact(b01, c01).toFixed(4)
  + '　|　句首40字 +' + cP + ' / -' + bP + '　p=' + mcnemarExact(bP, cP).toFixed(4));
console.log('  配对 P0→P2（预算 x' + (avgChars((r) => r.chars2) / Math.max(1, avgChars((r) => r.chars0))).toFixed(1) + '）：span=1.0 +' + c02 + ' / -' + b02 + '　McNemar p=' + mcnemarExact(b02, c02).toFixed(4));
console.log('  严格整句口径的边界敏感度：证据句 ≤120 字的 ' + short.length + ' 题里，P0 严格 ' + pct(S0s.strict, S0s.n) + '% → P1 ' + pct(S1s.strict, S1s.n) + '%'
  + '（全样本 ' + ne + ' 题中位证据句长 ' + evid.map((r) => r.goldLen).sort((a, b) => a - b)[Math.floor(ne / 2)] + ' 字）');
console.log('');
console.log('【②b 按名次分桶的证据覆盖率】（span=1.0 / 平均 span）');
for (const b of BUCKETS) {
  const sub = evid.filter((r) => bucketOf(r) === b);
  if (sub.length === 0) continue;
  const a = stat(sub, (r) => r.base), c = stat(sub, (r) => r.p1);
  console.log('  ' + b.padEnd(14) + ' n=' + String(sub.length).padStart(2)
    + '　P0 ' + String(pct(a.full, a.n)).padStart(5) + '% / ' + a.mean.toFixed(3)
    + '　P1 ' + String(pct(c.full, c.n)).padStart(5) + '% / ' + c.mean.toFixed(3));
}
console.log('');
console.log('【③ 跨会话证据组】（top-' + LIMIT + ' 单链接聚类，Jaccard >= ' + JACCARD + '，标签=topics∪user_tags∪图谱标签前10）');
console.log('  平均组数 ' + avgClusters.toFixed(2) + ' / ' + LIMIT + '　目标所在组 >=2 的题：' + multi + '/' + inTop10.length + ' = ' + pct(multi, inTop10.length) + '%');
console.log('  阈值扫描（同一批题，只换 Jaccard 阈值）：');
for (const th of SWEEP) {
  const s = sweep.get(th)!;
  console.log('    ≥' + th.toFixed(2) + '　平均组数 ' + (s.groups / (n || 1)).toFixed(2) + '　目标组 ≥2 ' + pct(s.multi, s.n) + '%');
}
console.log('  组签名扩展（只对 rank ' + (LIMIT + 1) + '-' + DEEP + ' 的 ' + cond.length + ' 题）：补回目标 ' + rec + '/' + cond.length + ' = ' + pct(rec, cond.length) + '%');
console.log('  每次新增候选 ' + (cond.length ? (extraTot / cond.length).toFixed(1) : '0') + ' 条，其中与 top-' + LIMIT + ' 有共享标签 ' + (extraTot ? Math.round(extraTagged / extraTot * 1000) / 10 : 0) + '%');
console.log('');


// ── 例子 ────────────────────────────────────────────────────────────────────
const out: Row[] = [];
const push = (r: Row | undefined) => { if (r && !out.includes(r) && out.length < NEX) out.push(r); };
push(evid.find((r) => r.base.span < 1 && r.p1.span >= 1));
push(evid.find((r) => r.base.span >= 1 && r.rank10 === 1));
push(evid.find((r) => r.rank10 === 0 && r.rankDeep >= 1 && r.recovered));
push(evid.find((r) => r.groupSize >= 3));
push(evid.find((r) => r.base.span < 1 && r.p1.span < 1 && r.p2.span < 1));
for (const r of evid) push(r);
console.log('【例子】' + out.length + ' 个');
for (const r of out) {
  console.log('');
  console.log('  Q: ' + r.query);
  console.log('     目标 ' + r.target + '　rank@' + LIMIT + '=' + (r.rank10 || '—') + '　rank@' + DEEP + '=' + (r.rankDeep || '—')
    + '　锚点 ' + r.nAnchors + '　证据句 ' + r.goldLen + ' 字（命中 ' + r.goldHits + ' 锚点）');
  console.log('     证据句：' + r.goldText.slice(0, 60).replace(/\s+/g, ' ') + (r.goldLen > 60 ? '…' : ''));
  console.log('     证据包 top-' + LIMIT + '（会话标题 | 该会话片段前 46 字）：');
  for (let i = 0; i < Math.min(3, r.packTitles.length); i++) console.log('       ' + (i + 1) + '. ' + r.packTitles[i] + ' | ' + r.packHeads[i]);
  if (r.packTitles.length > 3) console.log('       …（共 ' + r.packTitles.length + ' 个会话）');
  console.log('     覆盖率 span P0 ' + r.base.span.toFixed(2) + ' / P1 ' + r.p1.span.toFixed(2) + ' / P2 ' + r.p2.span.toFixed(2)
    + '　句首40字 P0 ' + (r.base.pref40 ? '✓' : '✗') + ' P1 ' + (r.p1.pref40 ? '✓' : '✗')
    + '　组数 ' + r.clusters + '（目标组 ' + (r.groupSize || '—') + '）');
}

if (OUT) {
  const payload = {
    at: new Date().toISOString(), dbPath, fingerprint: FINGERPRINT, qfile: QFILE, limit: LIMIT, deep: DEEP, jaccard: JACCARD, expand: EXPAND,
    summary: {
      n, nEvid: ne, rank1, hit10: h10, mid, unreach, unstableLimit: unstable, hit10AtDeep: h10AtDeep,
      coverage: {
        P0: { ...S0, mean: Number(S0.mean.toFixed(4)), meanIdf: Number(S0.meanIdf.toFixed(4)) },
        P1: { ...S1, mean: Number(S1.mean.toFixed(4)), meanIdf: Number(S1.meanIdf.toFixed(4)) },
        P2: { ...S2, mean: Number(S2.mean.toFixed(4)), meanIdf: Number(S2.meanIdf.toFixed(4)) },
      },
      mcnemar: { p01: mcnemarExact(b01, c01), p02: mcnemarExact(b02, c02), pPref01: mcnemarExact(bP, cP) },
      own: { n: intop.length, P0: { strict: oStrict0, full: oFull0, mean: Number(O0.mean.toFixed(4)) }, P1: { strict: oStrict1, full: oFull1, mean: Number(O1.mean.toFixed(4)) } },
      chars: { p0: avgChars((r) => r.chars0), p1: avgChars((r) => r.chars1), p2: avgChars((r) => r.chars2) },
      clusters: {
        avg: Number(avgClusters.toFixed(3)), multiGroups: multi, inTop10: inTop10.length, recover: { ok: rec, denom: cond.length },
        sweep: SWEEP.map((th) => ({ th, avgGroups: Number((sweep.get(th)!.groups / (n || 1)).toFixed(3)), multiPct: pct(sweep.get(th)!.multi, sweep.get(th)!.n) })),
      },
      byBucket: BUCKETS.map((b) => {
        const sub = evid.filter((r) => bucketOf(r) === b);
        const a = stat(sub, (r) => r.base), c = stat(sub, (r) => r.p1);
        return { bucket: b, n: sub.length, P0: { full: a.full, mean: Number(a.mean.toFixed(3)) }, P1: { full: c.full, mean: Number(c.mean.toFixed(3)) } };
      }),
    },
    rows,
  };
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 1));
  console.log('\n已写 ' + OUT);
}
