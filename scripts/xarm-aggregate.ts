// xarm-aggregate.ts —— X 臂（跨会话）「多会话证据聚合」原型（只读库，不改 src/）。
//
// 要解决的问题：X 臂 95 题里 hit@1 只有 8.4%、hit@10 28.4%，但题面本身是
// 「……在哪些会话里处理过」——考的是**多会话证据**，而现有基准只认「某个目标会话排第几」。
// 指标与任务错配（见 research/xarm-diagnosis.md：92.6% 是 B 类真跨会话题）。
//
// 本脚本量两件事，全部零模型、确定性：
//   ① hit@10（= 目标会话是否在产品默认 top-10）—— **基线，聚合不改变它**
//   ② 证据覆盖率：目标会话的**关键证据句**是否真的出现在拼出来的「证据包」里
//      （这才是「能不能答」的口径；hit@10 只说明「会话在不在列表里」）
//   另加一个零模型增强：把 top-10 按 topic/tag 聚类成「跨会话证据组」，
//      并量它能否把 rank 11–50 的目标会话按「组签名」补回来。
//
// 三条包（同一批 top-10，只换「取哪条片段」，单变量）：
//   P0 base      产品自带的 snippet（excerpt 120 字符，围绕**第一个查询单元**）
//   P1 best@120  同预算（120 字符），但改取**该会话内锚点覆盖最高的那条消息**
//                → 与 P0 的差别**只**来自「选哪条消息」，不来自「给多少字」
//   P2 best@320  产品 snippet + 最佳消息 200 字符窗口（约 2.7 倍预算）
//                → 代表「上下文更宽」的上限，代价单列
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

// ── 文本工具（全部确定性，无模型）────────────────────────────────────────────
const norm = (s: string) => s.replace(/\s+/g, '').toLowerCase();
const SENT_SPLIT = /[。！？!?；;\n\r]+/;
const sentencesOf = (text: string) => text.split(SENT_SPLIT).map((s) => s.trim()).filter((s) => s.length >= 8);

/** 查询锚点：parseQuery 的词元，去掉 <2 字与问句外壳词（pickScaffold 是产品里同一张表） */
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

/** 在消息里取一个围绕锚点的定长窗口（与产品 excerpt 同构，只是长度可调、锚点可指定） */
function windowAround(content: string, anchor: string, max: number): string {
  const i = content.toLowerCase().indexOf(anchor.toLowerCase());
  const start = Math.max(0, (i === -1 ? 0 : i) - Math.floor(max / 3));
  return content.slice(start, start + max).replace(/\s+/g, ' ').trim();
}

// ── 标签（聚类用）：topics ∪ user_tags ∪ 图谱标签（按 weight 取前 10）──────────
const tagCache = new Map<string, string[]>();
const tagStmt = db.prepare('SELECT g.name, g.df, gs.weight FROM graph_tag_sessions gs JOIN graph_tags g ON g.id = gs.tag_id WHERE gs.session_id = ? ORDER BY gs.weight DESC LIMIT 10');
const metaStmt = db.prepare('SELECT id, title, topics, user_tags, message_count FROM sessions WHERE id = ?');
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

// ── 消息读取（批量，按会话分组）──────────────────────────────────────────────
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

// ── 关键证据句：目标会话里锚点覆盖最高的句子（零模型；平手按 seq 早 → 句短）──
function goldSentenceOf(msgs: Msg[], anchors: string[]): { text: string; seq: number; hits: number } | null {
  let best: { text: string; seq: number; hits: number; len: number } | null = null;
  for (const m of msgs) {
    const low = m.content.toLowerCase();
    if (countIn(low, anchors) === 0) continue;
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

/** 会话内锚点覆盖最高的消息（同平手规则）；返回该消息 + 命中锚点数 */
function bestMsgOf(msgs: Msg[], anchors: string[]): { msg: Msg; hits: number } | null {
  let best: { msg: Msg; hits: number } | null = null;
  for (const m of msgs) {
    const hits = countIn(m.content.toLowerCase(), anchors);
    if (hits === 0) continue;
    if (!best || hits > best.hits) best = { msg: m, hits };
    if (hits === anchors.length) break; // 已满覆盖，seq 升序遍历 ⇒ 天然取最早
  }
  return best;
}

// ── 证据覆盖率 ───────────────────────────────────────────────────────────────
interface Cov { strict: boolean; span: number }
function coverageOf(pack: string[], goldText: string, goldAnchors: string[]): Cov {
  const windows = pack.map(norm).filter((w) => w.length > 0);
  const joined = windows.join('\u0000'); // 分隔符防止跨片段拼接造成假命中
  const strict = joined.includes(norm(goldText));
  let span = 0;
  for (const w of windows) {
    let n = 0; for (const a of goldAnchors) if (w.includes(a.toLowerCase())) n++;
    const r = n / goldAnchors.length;
    if (r > span) span = r;
  }
  return { strict, span };
}

// ── 统计工具 ─────────────────────────────────────────────────────────────────
const pct = (a: number, b: number) => (b === 0 ? 0 : Math.round((a / b) * 1000) / 10);
function mcnemarExact(b: number, c: number): number {
  const n = b + c;
  if (n === 0) return 1;
  const k = Math.min(b, c);
  let tail = 0;
  let logC = 0; // log C(n,0)
  for (let i = 0; i <= k; i++) {
    if (i > 0) logC += Math.log((n - i + 1) / i);
    tail += Math.exp(logC - n * Math.LN2);
  }
  return Math.min(1, 2 * tail);
}

// ── 主循环 ───────────────────────────────────────────────────────────────────
interface Item { arm: string; query: string; target: string; kind?: string }
const q = JSON.parse(fs.readFileSync(QFILE, 'utf8')) as { items: Item[] };
const items = (q.items ?? []).filter((x) => x.arm === 'X');

interface Row {
  query: string; target: string; kind: string;
  rank10: number; rankDeep: number;        // 0 = 不在该深度内
  nAnchors: number; goldHits: number; goldLen: number;
  base: Cov; p1: Cov; p2: Cov;
  chars0: number; chars1: number; chars2: number;
  clusters: number; groupSize: number;     // 目标所在组大小（不在 top-10 记 0）
  recovered: boolean | null;               // 仅对 rank∈[11,DEEP] 有意义
  extras: number; extrasTagged: number;
  packTitles: string[];
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

  // 目标会话的关键证据句
  const gold = goldSentenceOf(msgs.get(it.target) ?? [], anchors);
  const goldAnchors = gold ? anchors.filter((a) => gold.text.toLowerCase().includes(a.toLowerCase())) : [];

  // 三条证据包
  const pack0: string[] = [];
  const pack1: string[] = [];
  const pack2: string[] = [];
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
  const base: Cov = empty ? { strict: false, span: 0 } : coverageOf(pack0, gold!.text, goldAnchors);
  const p1: Cov = empty ? { strict: false, span: 0 } : coverageOf(pack1, gold!.text, goldAnchors);
  const p2: Cov = empty ? { strict: false, span: 0 } : coverageOf(pack2, gold!.text, goldAnchors);

  // ── 聚类：top-10 单链接，按名次顺序（确定性）──
  const sets = sids.map((s) => new Set(tagSetOf(s)));
  const clusters: number[][] = [];
  const clusterOf: number[] = [];
  for (let i = 0; i < sids.length; i++) {
    let found = -1;
    for (let c = 0; c < clusters.length; c++) {
      if (clusters[c].some((j) => jaccard(sets[i], sets[j]) >= JACCARD)) { found = c; break; }
    }
    if (found === -1) { clusters.push([i]); found = clusters.length - 1; }
    else clusters[found].push(i);
    clusterOf[i] = found;
  }
  const ti = sids.indexOf(it.target);
  const groupSize = ti >= 0 ? clusters[clusterOf[ti]].length : 0;

  // ── 组签名扩展：只在「目标不在 top-10 但在 DEEP 内」时有意义 ──
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
        const expr = '"' + t.replace(/"/g, '""') + '"';
        const rs = db.prepare('SELECT s.id AS sid FROM sessions_fts JOIN sessions s ON s.rowid = sessions_fts.rowid WHERE sessions_fts MATCH ? AND s.project_id = ? LIMIT 200').all(expr, PID) as Array<{ sid: string }>;
        const w = 1 / (1 + Math.log(1 + dfOf.get(t)!));
        for (const r of rs) { if (sids.includes(r.sid)) continue; score.set(r.sid, (score.get(r.sid) ?? 0) + w); }
      } catch { /* 词太怪就跳过 */ }
    }
    const ranked = [...score.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, EXPAND);
    extras = ranked.length;
    for (const [sid] of ranked) { if (jaccard(sets[0] ?? new Set(), new Set(tagSetOf(sid))) > 0) extrasTagged++; }
    recovered = ranked.some(([sid]) => sid === it.target);
  }

  const titles: string[] = [];
  for (const h of hits10) {
    const m = metaStmt.get(h.sessionId) as { title: string | null } | undefined;
    titles.push((m?.title ?? '(无标题)').slice(0, 40));
  }

  rows.push({
    query: it.query, target: it.target, kind: it.kind ?? '', rank10, rankDeep,
    nAnchors: anchors.length, goldHits: gold?.hits ?? 0, goldLen: gold?.text.length ?? 0,
    base, p1, p2,
    chars0: pack0.join('').length, chars1: pack1.join('').length, chars2: pack2.join('').length,
    clusters: clusters.length, groupSize, recovered, extras, extrasTagged,
    packTitles: titles,
  });
  if (++done % 10 === 0) console.log('  ...', done, '/', items.length);
}


// ── 汇总 ─────────────────────────────────────────────────────────────────────
const n = rows.length;
const evid = rows.filter((r) => r.goldHits > 0);
const ne = evid.length;
const h10 = rows.filter((r) => r.rank10 >= 1 && r.rank10 <= 10).length;
const rank1 = rows.filter((r) => r.rank10 === 1).length;
const b11 = rows.filter((r) => r.rank10 === 0 && r.rankDeep >= 1).length;
const unreach = rows.filter((r) => r.rankDeep === 0).length;
const disagree = rows.filter((r) => (r.rank10 >= 1) !== (r.rankDeep >= 1)).length;

const packStat = (pick: (r: Row) => Cov) => {
  const arr = evid.map(pick);
  const strict = arr.filter((c) => c.strict).length;
  const full = arr.filter((c) => c.span >= 1).length;
  const ge80 = arr.filter((c) => c.span >= 0.8).length;
  const mean = arr.reduce((a, c) => a + c.span, 0) / (ne || 1);
  return { strict, full, ge80, mean };
};
const S0 = packStat((r) => r.base), S1 = packStat((r) => r.p1), S2 = packStat((r) => r.p2);
const b01 = evid.filter((r) => r.base.strict && !r.p1.strict).length;
const c01 = evid.filter((r) => !r.base.strict && r.p1.strict).length;
const b02 = evid.filter((r) => r.base.strict && !r.p2.strict).length;
const c02 = evid.filter((r) => !r.base.strict && r.p2.strict).length;
const bS1 = evid.filter((r) => r.base.span >= 1 && r.p1.span < 1).length;
const cS1 = evid.filter((r) => r.base.span < 1 && r.p1.span >= 1).length;

const multi = rows.filter((r) => r.groupSize >= 2).length;
const inTop10 = rows.filter((r) => r.rank10 >= 1).length;
const clusterSizes = rows.map((r) => r.clusters);
const avgClusters = clusterSizes.reduce((a, b) => a + b, 0) / (n || 1);
const cond = rows.filter((r) => r.rank10 === 0 && r.rankDeep >= 1);
const rec = cond.filter((r) => r.recovered).length;
const extraTot = cond.reduce((a, r) => a + r.extras, 0);
const extraTagged = cond.reduce((a, r) => a + r.extrasTagged, 0);

const avgChars = (f: (r: Row) => number) => Math.round(rows.reduce((a, r) => a + f(r), 0) / (n || 1));

console.log('');
console.log('== X 臂多会话证据聚合原型 ==');
console.log('库：' + dbPath + '（只读）　题：' + QFILE + '　X 臂 n=' + n + '　limit=' + LIMIT + '　deep=' + DEEP);
console.log('口径：searchSessions({rewrite:true, lengthNorm:true, coreOnly:true})，titleBoost 走产品默认（DEFAULT_TITLE_BOOST=1）');
console.log('');
console.log('【① 基线：目标会话是否在 top-' + LIMIT + '】（聚合不改变它，只作对照）');
console.log('  rank 1        : ' + rank1 + '/' + n + ' = ' + pct(rank1, n) + '%');
console.log('  rank 2-' + LIMIT + '       : ' + (h10 - rank1) + '/' + n + ' = ' + pct(h10 - rank1, n) + '%');
console.log('  hit@' + LIMIT + '         : ' + h10 + '/' + n + ' = ' + pct(h10, n) + '%');
console.log('  rank ' + (LIMIT + 1) + '-' + DEEP + '      : ' + b11 + '/' + n + ' = ' + pct(b11, n) + '%');
console.log('  >' + DEEP + ' / 不可达 : ' + unreach + '/' + n + ' = ' + pct(unreach, n) + '%');
console.log('  （limit=' + LIMIT + ' 与 limit=' + DEEP + ' 两次检索的名次归属不一致：' + disagree + ' 题）');
console.log('');
console.log('【② 证据覆盖率】n=' + ne + '（' + (n - ne) + ' 题目标会话无正文或无锚点句，不计入）');
const line = (label: string, s: { strict: number; full: number; ge80: number; mean: number }, chars: number) =>
  console.log('  ' + label.padEnd(12) + ' 严格整句命中 ' + String(pct(s.strict, ne)).padStart(5) + '%'
    + '　span=1.0 ' + String(pct(s.full, ne)).padStart(5) + '%'
    + '　span>=0.8 ' + String(pct(s.ge80, ne)).padStart(5) + '%'
    + '　平均 span ' + s.mean.toFixed(3)
    + '　包长 ' + chars + ' 字');
line('P0 base', S0, avgChars((r) => r.chars0));
line('P1 best@120', S1, avgChars((r) => r.chars1));
line('P2 best@320', S2, avgChars((r) => r.chars2));
console.log('  配对（P0->P1，同预算只换选哪条消息）：严格 +' + c01 + ' / -' + b01 + '　McNemar p=' + mcnemarExact(b01, c01).toFixed(4)
  + '　|　span=1.0 +' + cS1 + ' / -' + bS1 + '　p=' + mcnemarExact(bS1, cS1).toFixed(4));
console.log('  配对（P0->P2，预算 x' + (avgChars((r) => r.chars2) / Math.max(1, avgChars((r) => r.chars0))).toFixed(1) + '）：严格 +' + c02 + ' / -' + b02 + '　p=' + mcnemarExact(b02, c02).toFixed(4));
console.log('');
console.log('【③ 跨会话证据组】（top-' + LIMIT + ' 单链接聚类，Jaccard >= ' + JACCARD + '）');
console.log('  平均组数 ' + avgClusters.toFixed(2) + '　目标所在组 >=2 的题：' + multi + '/' + inTop10 + ' = ' + pct(multi, inTop10) + '%（分母=目标进 top-' + LIMIT + ' 的题）');
console.log('  组签名扩展（只对 rank ' + (LIMIT + 1) + '-' + DEEP + ' 的 ' + cond.length + ' 题）：补回目标 ' + rec + '/' + cond.length + ' = ' + pct(rec, cond.length) + '%');
console.log('  每次新增候选 ' + (cond.length ? (extraTot / cond.length).toFixed(1) : '0') + ' 条，其中与 top-' + LIMIT + ' 有共享标签 ' + (extraTot ? Math.round(extraTagged / extraTot * 1000) / 10 : 0) + '%');
console.log('');


// ── 5 个例子 ─────────────────────────────────────────────────────────────────
const pickEx = (): Row[] => {
  const out: Row[] = [];
  const push = (r: Row | undefined) => { if (r && !out.includes(r) && out.length < NEX) out.push(r); };
  push(evid.find((r) => r.base.span < 1 && r.p1.span >= 1));                       // 换消息救回来
  push(evid.find((r) => r.base.strict && r.rank10 === 1));                          // 全对
  push(evid.find((r) => r.rank10 === 0 && r.rankDeep >= 1 && r.recovered));         // 组签名补回
  push(evid.find((r) => r.groupSize >= 3));                                         // 多会话组
  push(evid.find((r) => r.base.strict === false && r.p1.strict === false && r.p2.strict === false)); // 都没覆盖
  for (const r of evid) push(r);
  return out;
};
const exs = pickEx();
console.log('【例子】' + exs.length + ' 个');
for (const r of exs) {
  console.log('');
  console.log('  Q: ' + r.query);
  console.log('     target ' + r.target + '　rank@' + LIMIT + '=' + (r.rank10 || '—') + '　rank@' + DEEP + '=' + (r.rankDeep || '—')
    + '　锚点 ' + r.nAnchors + '　证据句 ' + r.goldLen + ' 字（命中 ' + r.goldHits + ' 锚点）');
  console.log('     证据包（top-' + LIMIT + ' 标题）：' + r.packTitles.slice(0, 4).map((t) => t.slice(0, 18)).join(' | ') + (r.packTitles.length > 4 ? ' …' : ''));
  console.log('     覆盖率 P0 ' + r.base.span.toFixed(2) + '（' + (r.base.strict ? '严格命中' : '否') + '）'
    + '　P1 ' + r.p1.span.toFixed(2) + '（' + (r.p1.strict ? '严格命中' : '否') + '）'
    + '　P2 ' + r.p2.span.toFixed(2) + '（' + (r.p2.strict ? '严格命中' : '否') + '）'
    + '　组数 ' + r.clusters + '（目标组 ' + (r.groupSize || '—') + '）');
}

if (OUT) {
  const payload = {
    at: new Date().toISOString(), dbPath, qfile: QFILE, limit: LIMIT, deep: DEEP, jaccard: JACCARD, expand: EXPAND,
    summary: {
      n, nEvid: ne, rank1, hit10: h10, deep11: b11, unreach, disagree,
      coverage: {
        P0: { ...S0, mean: Number(S0.mean.toFixed(4)) },
        P1: { ...S1, mean: Number(S1.mean.toFixed(4)) },
        P2: { ...S2, mean: Number(S2.mean.toFixed(4)) },
      },
      mcnemar: { strict01: mcnemarExact(b01, c01), span01: mcnemarExact(bS1, cS1), strict02: mcnemarExact(b02, c02) },
      chars: { p0: avgChars((r) => r.chars0), p1: avgChars((r) => r.chars1), p2: avgChars((r) => r.chars2) },
      clusters: { avg: Number(avgClusters.toFixed(3)), multiGroups: multi, inTop10, recover: { ok: rec, denom: cond.length } },
    },
    rows,
  };
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 1));
  console.log('\n已写 ' + OUT);
}
