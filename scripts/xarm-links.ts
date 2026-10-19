// xarm-links.ts —— 自动会话链接生成器（零模型原型）
//
// 背景：库里 session_links 是**空的**（0 行）。xarm-experiment.ts 的 A 策略（链接扩展）
// 实测 hit@1 9→9 纹丝不动 —— 不是策略无效，是**根本没有边可用**。这个脚本回答「边从哪来」。
//
// 只读库（readonly=true, fileMustExist），不写 relay.sqlite；输出 JSON 到 scripts/bench-out/。
//
// ── 链接定义（四个信号，全部来自已有派生列；零模型、零 embedding、零随机）──
//   topic  会话抽取的 topics[]                α=3.0
//   file   files_mentioned[] 的 basename      α=1.5
//   title  标题分词词元（tokenizer.segment）  α=1.0
//   tag    人打的 user_tags[]                 α=1.0（--tagalpha 0 可关）
// 信号内部：idf 加权 + 余弦式归一
//   df(x)=同 project 内含 x 的会话数；df/N > cap_s ⇒ 停用项（丢弃，不计分也不进分母）
//     cap: topic/file/title = dfcap(默认 0.10)，tag = tagcap(默认 0.03)
//     tag 单独更严的理由：14 个 tag 里 6 个 df≥34（selftest/review/1021/decision…），
//     它们描述的是「这批会话都来自同一次批处理」，不是「同一件事」。
//   idf(x)=ln(1+N/df(x))；df<2 的项 idf=0（只出现一次，无法共享）
//   O_s = Σ_{共享非停用项} idf / sqrt(Σ_a idf · Σ_b idf)，W = Σ_s α_s·O_s
// 同一对会话的 W 是确定值：无随机、无采样、无模型。
//
// ── 重复/样板会话护栏 ──
//   标题归一相同，或标题词元 Jaccard ≥ --dupjac ⇒ kind='dup'，不进扩展图。
//
// ── 三种用法（本脚本都测）──
//   A-count  与 xarm-experiment.ts 逐字同口径：邻居计数 × (1+λ·min(2,n))
//   A-prop   单步传播：只从**已命中的高分邻居**传分，与度数无关
//   C-expand 召回扩展：把 top-10 命中的邻居拉进候选池再重排
//
// 用法：
//   npx tsx scripts/xarm-links.ts <db> [--questions ...] [--json out.json] [--sweep] [--diag]
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require2 = createRequire(import.meta.url);
const Database = require2('better-sqlite3');
const { searchSessions } = await import('../src/search-svc/engine.js');
const { segment } = await import('../src/core/tokenize/tokenizer.js');

const argv = process.argv.slice(2);
const dbPath = argv.find((a) => !a.startsWith('--'));
if (!dbPath) { console.error('用法: npx tsx scripts/xarm-links.ts <db> [--questions f] [--json out] [--sweep] [--diag]'); process.exit(2); }
const arg = (n: string, d: string) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const has = (n: string) => argv.includes('--' + n);
const QFILE = arg('questions', 'scripts/bench-questions-paraphrase-v2.json');
const OUT = arg('json', 'scripts/bench-out/xarm-links.json');
const DFCAP = Number(arg('dfcap', '0.10'));
const TAGEAP = Number(arg('tagcap', '0.03'));
const TIER = Number(arg('tier', '0.40'));
const TOPK = Number(arg('topk', '5'));
const LINKW = Number(arg('linkweight', '0.5'));
const LIMIT = Number(arg('limit', '50'));
const EXAMPLES = Number(arg('examples', '10'));
const DUPJAC = Number(arg('dupjac', '0.85'));
const TAGALPHA = Number(arg('tagalpha', '1'));
const DIAGN = Number(arg('diagn', '40'));   // 一致率抽样的边数（每条边 2 次检索，别开太大）

const db = new Database(dbPath, { readonly: true, fileMustExist: true });
const PID = (db.prepare('SELECT project_id FROM sessions LIMIT 1').get() as { project_id: string }).project_id;
const dbStat = fs.statSync(dbPath);
const nSessions = (db.prepare('SELECT COUNT(*) c FROM sessions WHERE project_id = ?').get(PID) as { c: number }).c;
const nLinks = (db.prepare('SELECT COUNT(*) c FROM session_links').get() as { c: number }).c;

// ── 1. 元数据 ──
interface Meta { id: string; title: string | null; topics: string[]; tags: string[]; files: string[]; toks: string[]; tnorm: string }
const jarr = (v: unknown): string[] => { try { return v == null ? [] : (JSON.parse(String(v)) as string[]); } catch { return []; } };
const norm1 = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
const baseName = (p: string) => norm1(String(p).split(/[\\/]/).pop() ?? '');
const titleToks = (t: string | null) => [...new Set(segment(t ?? '').map(norm1).filter((x) => x.length >= 2 && /[a-z0-9\u4e00-\u9fff]/.test(x)))];

const rows = db.prepare('SELECT id, title, topics, user_tags, files_mentioned FROM sessions WHERE project_id = ? ORDER BY id').all(PID) as Array<{ id: string; title: string | null; topics: string | null; user_tags: string | null; files_mentioned: string | null }>;
const metas: Meta[] = rows.map((r) => ({
  id: r.id, title: r.title, tnorm: norm1(r.title ?? ''),
  topics: [...new Set(jarr(r.topics).map(norm1).filter((x) => x.length >= 2))],
  tags: [...new Set(jarr(r.user_tags).map(norm1))],
  files: [...new Set(jarr(r.files_mentioned).map(baseName).filter((x) => x.length >= 3))],
  toks: titleToks(r.title),
}));
const byId = new Map(metas.map((m) => [m.id, m]));

type Sig = 'topic' | 'file' | 'title' | 'tag';
const SIGS: Sig[] = ['topic', 'file', 'title', 'tag'];
const itemsOf = (m: Meta, s: Sig): string[] => (s === 'topic' ? m.topics : s === 'tag' ? m.tags : s === 'file' ? m.files : m.toks);

interface Edge { a: string; b: string; w: number; parts: Record<Sig, number>; shared: Record<Sig, string[]>; nsig: number; dup: boolean }
const EMPTY_PARTS = (): Record<Sig, number> => ({ topic: 0, file: 0, title: 0, tag: 0 });
const EMPTY_SH = (): Record<Sig, string[]> => ({ topic: [], file: [], title: [], tag: [] });

function buildEdges(alpha: Record<Sig, number>, dfcap: number, tagcap: number) {
  const capOf = (s: Sig) => Math.max(2, Math.floor(nSessions * (s === 'tag' ? tagcap : dfcap)));
  const df = new Map<Sig, Map<string, number>>(SIGS.map((s) => [s, new Map<string, number>()]));
  for (const m of metas) for (const s of SIGS) { const d = df.get(s)!; for (const x of itemsOf(m, s)) d.set(x, (d.get(x) ?? 0) + 1); }
  const idfOf = (s: Sig, x: string): number => { const n = df.get(s)!.get(x) ?? 0; return n < 2 || n > capOf(s) ? 0 : Math.log(1 + nSessions / n); };
  const mass = new Map<string, Record<Sig, number>>();
  for (const m of metas) { const rec = EMPTY_PARTS(); for (const s of SIGS) for (const x of itemsOf(m, s)) rec[s] += idfOf(s, x); mass.set(m.id, rec); }
  const edges: Edge[] = [];
  for (let i = 0; i < metas.length; i++) {
    const A = metas[i], ma = mass.get(A.id)!;
    for (let j = i + 1; j < metas.length; j++) {
      const B = metas[j], mb = mass.get(B.id)!;
      const parts = EMPTY_PARTS(); const shared = EMPTY_SH();
      let w = 0, nsig = 0;
      for (const s of SIGS) {
        if (alpha[s] <= 0 || ma[s] <= 0 || mb[s] <= 0) continue;
        const bs = new Set(itemsOf(B, s));
        let acc = 0; const sh: string[] = [];
        for (const x of itemsOf(A, s)) { if (!bs.has(x)) continue; const v = idfOf(s, x); if (v <= 0) continue; acc += v; sh.push(x); }
        if (acc <= 0) continue;
        parts[s] = acc / Math.sqrt(ma[s] * mb[s]); shared[s] = sh; nsig++; w += alpha[s] * parts[s];
      }
      if (w <= 0) continue;
      const nShared = SIGS.reduce((n, s) => n + shared[s].length, 0);
      const strong = (['topic', 'file'] as Sig[]).some((s) => shared[s].some((x) => idfOf(s, x) >= 4));
      if (nShared < 2 && !strong) continue;
      let dup = A.tnorm.length > 0 && A.tnorm === B.tnorm;
      if (!dup && A.toks.length >= 3 && B.toks.length >= 3) {
        const bs = new Set(B.toks); const inter = A.toks.filter((t) => bs.has(t)).length;
        const uni = A.toks.length + B.toks.length - inter;
        if (uni > 0 && inter / uni >= DUPJAC) dup = true;
      }
      edges.push({ a: A.id, b: B.id, w, parts, shared, nsig, dup });
    }
  }
  edges.sort((x, y) => (y.w - x.w) || (x.a + x.b < y.a + y.b ? -1 : 1));
  return { edges, caps: Object.fromEntries(SIGS.map((s) => [s, capOf(s)])) as Record<Sig, number> };
}

const ALPHA: Record<Sig, number> = { topic: 3.0, file: 1.5, title: 1.0, tag: TAGALPHA };
const built = buildEdges(ALPHA, DFCAP, TAGEAP);
const edges = built.edges;
const live = edges.filter((e) => !e.dup);

function graphOf(minW: number, topK: number) {
  const per = new Map<string, Array<{ id: string; w: number }>>();
  const wmap = new Map<string, number>();
  let kept = 0;
  for (const e of live) {
    if (e.w < minW) break;
    kept++;
    if (!per.has(e.a)) per.set(e.a, []); if (!per.has(e.b)) per.set(e.b, []);
    per.get(e.a)!.push({ id: e.b, w: e.w }); per.get(e.b)!.push({ id: e.a, w: e.w });
    wmap.set(e.a + '|' + e.b, e.w); wmap.set(e.b + '|' + e.a, e.w);
  }
  const adj = new Map<string, Set<string>>();
  for (const [k, list] of per) { list.sort((x, y) => y.w - x.w || (x.id < y.id ? -1 : 1)); adj.set(k, new Set(list.slice(0, topK).map((x) => x.id))); }
  const degs = [...adj.values()].map((s) => s.size).sort((a, b) => a - b);
  return { adj, wmap, kept, nodes: adj.size, degP50: degs[Math.floor(degs.length / 2)] ?? 0, degMax: degs[degs.length - 1] ?? 0, degMean: degs.length ? degs.reduce((a, b) => a + b, 0) / degs.length : 0 };
}

// ── 2. 检索（一次，全变体共用）──
const allQ = (JSON.parse(fs.readFileSync(QFILE, 'utf8')) as { items: Array<{ arm: string; query: string; target: string; kind?: string }> }).items;
const items = allQ.filter((x) => x.arm === 'X');
const retrieved: Array<Array<{ id: string; score: number }>> = [];
for (const it of items) {
  let hits: Array<{ sessionId: string; score: number }> = [];
  try { hits = searchSessions(db, { project: PID, query: it.query, limit: LIMIT, rewrite: true, lengthNorm: true, coreOnly: true } as never); } catch { hits = []; }
  retrieved.push(hits.map((h) => ({ id: h.sessionId, score: h.score })));
}
const inTop50 = items.map((it, i) => retrieved[i].some((r) => r.id === it.target));

interface Acc { n: number; h1: number; h10: number; mrr: number }
const mkAcc = (): Acc => ({ n: 0, h1: 0, h10: 0, mrr: 0 });
const add = (a: Acc, r: number) => { a.n++; if (r === 1) a.h1++; if (r >= 1 && r <= 10) a.h10++; if (r > 0) a.mrr += 1 / r; };
const pct = (x: number, n: number) => (n === 0 ? 0 : Math.round((x / n) * 1000) / 10);

const rankBase = (): number[] => items.map((it, i) => { const k = retrieved[i].findIndex((r) => r.id === it.target); return k >= 0 ? k + 1 : 0; });

function rankCount(g: ReturnType<typeof graphOf> | null, lam: number): number[] {
  return items.map((it, i) => {
    const rows2 = retrieved[i]; const ids = new Set(rows2.map((r) => r.id));
    const scored = rows2.map((r) => {
      let n = 0; const nb = g?.adj.get(r.id); if (nb) for (const x of nb) if (ids.has(x)) n++;
      return { id: r.id, s: r.score * (1 + lam * Math.min(2, n)) };
    }).sort((a, b) => b.s - a.s || (a.id < b.id ? -1 : 1));
    const k = scored.findIndex((x) => x.id === it.target); return k >= 0 ? k + 1 : 0;
  });
}

/** 单步传播强度 best(0..1)：邻居权重归一 + 来源相对分 */
function propOf(g: ReturnType<typeof graphOf>, id: string, scoreOf: Map<string, number>, maxS: number): number {
  let best = 0; const nb = g.adj.get(id);
  if (nb) for (const x of nb) {
    const sx = scoreOf.get(x); if (sx == null) continue;
    const w = g.wmap.get(id + '|' + x) ?? 0;
    const v = (w / (1 + w)) * (sx / maxS);
    if (v > best) best = v;
  }
  return best;
}

function rankProp(g: ReturnType<typeof graphOf>, lam: number): number[] {
  return items.map((it, i) => {
    const rows2 = retrieved[i]; if (rows2.length === 0) return 0;
    const scoreOf = new Map(rows2.map((r) => [r.id, r.score]));
    const maxS = Math.max(...rows2.map((r) => r.score)) || 1;
    const scored = rows2.map((r) => ({ id: r.id, s: r.score * (1 + lam * propOf(g, r.id, scoreOf, maxS)) }))
      .sort((a, b) => b.s - a.s || (a.id < b.id ? -1 : 1));
    const k = scored.findIndex((x) => x.id === it.target); return k >= 0 ? k + 1 : 0;
  });
}

function rankExpand(g: ReturnType<typeof graphOf>, lam: number, seedN: number): { ranks: number[]; added: number } {
  const ranks: number[] = []; let addedTotal = 0;
  for (let i = 0; i < items.length; i++) {
    const rows2 = retrieved[i];
    const pool = new Map<string, number>(rows2.map((r) => [r.id, r.score]));
    const seeds = rows2.slice(0, seedN);
    for (const s of seeds) {
      const nb = g.adj.get(s.id); if (!nb) continue;
      for (const x of nb) {
        if (pool.has(x)) continue;
        const w = g.wmap.get(s.id + '|' + x) ?? 0;
        const v = lam * s.score * (w / (1 + w));
        if (v > (pool.get(x) ?? 0)) { pool.set(x, v); addedTotal++; }
      }
    }
    const scored = [...pool.entries()].map(([id, s]) => ({ id, s })).sort((a, b) => b.s - a.s || (a.id < b.id ? -1 : 1));
    const k = scored.findIndex((x) => x.id === items[i].target);
    ranks.push(k >= 0 ? k + 1 : 0);
  }
  return { ranks, added: addedTotal };
}

const h32 = (s: string): number => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
function controlGraph(nEdges: number, topK: number) {
  const ids = metas.map((m) => m.id);
  const pairs: Array<{ a: string; b: string; k: number }> = [];
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) pairs.push({ a: ids[i], b: ids[j], k: h32(ids[i] + '|' + ids[j]) });
  pairs.sort((x, y) => x.k - y.k);
  const per = new Map<string, Array<{ id: string; w: number }>>(); const wmap = new Map<string, number>();
  for (const p of pairs.slice(0, nEdges)) {
    if (!per.has(p.a)) per.set(p.a, []); if (!per.has(p.b)) per.set(p.b, []);
    per.get(p.a)!.push({ id: p.b, w: 1 }); per.get(p.b)!.push({ id: p.a, w: 1 });
    wmap.set(p.a + '|' + p.b, 1); wmap.set(p.b + '|' + p.a, 1);
  }
  const adj = new Map<string, Set<string>>();
  for (const [k, list] of per) { list.sort((x, y) => (x.id < y.id ? -1 : 1)); const cut = list.slice(0, topK); adj.set(k, new Set(cut.map((x) => x.id))); for (const c of cut) wmap.set(k + '|' + c.id, 1); }
  const degs = [...adj.values()].map((s) => s.size).sort((a, b) => a - b);
  return { adj, wmap, kept: nEdges, nodes: adj.size, degP50: degs[Math.floor(degs.length / 2)] ?? 0, degMax: degs[degs.length - 1] ?? 0, degMean: degs.length ? degs.reduce((a, b) => a + b, 0) / degs.length : 0 };
}

// ── 3. 评估 ──
const baseRank = rankBase();
const baseAcc = mkAcc(); for (const r of baseRank) add(baseAcc, r);

function evalGraph(g: ReturnType<typeof graphOf>, label: string) {
  const rc = rankCount(g, LINKW), rp = rankProp(g, LINKW), ex = rankExpand(g, LINKW, 10);
  const ac = mkAcc(); for (const r of rc) add(ac, r);
  const ap = mkAcc(); for (const r of rp) add(ap, r);
  const ae = mkAcc(); for (const r of ex.ranks) add(ae, r);
  let up = 0, down = 0, same = 0, targetLinked = 0, bridge = 0;
  for (let i = 0; i < items.length; i++) {
    if (rc[i] > 0 && baseRank[i] > 0) { if (rc[i] < baseRank[i]) up++; else if (rc[i] > baseRank[i]) down++; else same++; }
    const nb = g.adj.get(items[i].target);
    if (nb && retrieved[i].some((r) => nb.has(r.id))) targetLinked++;
    const top10 = new Set(retrieved[i].slice(0, 10).map((r) => r.id));
    if (nb && [...nb].some((x) => top10.has(x))) bridge++;
  }
  return { label, edges: g.kept, nodes: g.nodes, degP50: g.degP50, degMax: g.degMax, degMean: Number(g.degMean.toFixed(1)),
    count: ac, prop: ap, expand: ae, added: ex.added, up, down, same, targetLinked, bridge };
}
function ser(e: ReturnType<typeof evalGraph>) {
  return { label: e.label, edges: e.edges, nodes: e.nodes, degP50: e.degP50, degMax: e.degMax, degMean: e.degMean,
    count: { hit1: e.count.h1, hit10: e.count.h10, mrr: Number((e.count.mrr / e.count.n * 100).toFixed(1)) },
    prop: { hit1: e.prop.h1, hit10: e.prop.h10, mrr: Number((e.prop.mrr / e.prop.n * 100).toFixed(1)) },
    expand: { hit1: e.expand.h1, hit10: e.expand.h10, mrr: Number((e.expand.mrr / e.expand.n * 100).toFixed(1)), added: e.added },
    up: e.up, down: e.down, same: e.same, targetLinked: e.targetLinked, bridge: e.bridge };
}

const mainG = graphOf(TIER, TOPK);
const main = evalGraph(mainG, 'main');
const ctlG = controlGraph(main.edges, TOPK);
const ctl = evalGraph(ctlG as never, 'control');

// ── 4. 稀疏度网格 ──
const grid: Array<Record<string, unknown>> = [];
const MINS = [0.20, 0.30, 0.40, 0.60, 0.80, 1.00, 1.50, 2.00];
const TOPKS = [3, 5, 8];
if (has('sweep')) {
  for (const mw of MINS) for (const tk of TOPKS) {
    const g = graphOf(mw, tk);
    if (g.kept === 0) continue;
    const rc = rankCount(g, LINKW), rp = rankProp(g, LINKW), ex = rankExpand(g, LINKW, 10);
    const ac = mkAcc(); for (const r of rc) add(ac, r);
    const ap = mkAcc(); for (const r of rp) add(ap, r);
    const ae = mkAcc(); for (const r of ex.ranks) add(ae, r);
    grid.push({ minW: mw, topK: tk, kept: g.kept, nodes: g.nodes, degMean: Number(g.degMean.toFixed(1)), degMax: g.degMax,
      count: [ac.h1, ac.h10], prop: [ap.h1, ap.h10], expand: [ae.h1, ae.h10] });
  }
}

// ── 5. 诊断：一致率（边精度代理）+ McNemar + 位置诊断 ──
const diag: Record<string, unknown> = {};
if (has('diag')) {
  const byId2 = byId;
  const recallCheck = (pairs: Array<[string, string]>, label: string) => {
    let okA = 0, okB = 0, okAny = 0, n = 0;
    for (const [a, b] of pairs) {
      const ta = byId2.get(a)?.title, tb = byId2.get(b)?.title;
      if (!ta || !tb || ta.length < 6 || tb.length < 6) continue; n++;
      let hA: Array<{ sessionId: string }> = [], hB: Array<{ sessionId: string }> = [];
      try { hA = searchSessions(db, { project: PID, query: ta, limit: 10, rewrite: true, lengthNorm: true, coreOnly: true } as never); } catch { hA = []; }
      try { hB = searchSessions(db, { project: PID, query: tb, limit: 10, rewrite: true, lengthNorm: true, coreOnly: true } as never); } catch { hB = []; }
      const inA = hA.some((x) => x.sessionId === b), inB = hB.some((x) => x.sessionId === a);
      if (inA) okA++; if (inB) okB++; if (inA || inB) okAny++;
    }
    return { label, n, aToB: Number((okA / n * 100).toFixed(1)), bToA: Number((okB / n * 100).toFixed(1)), either: Number((okAny / n * 100).toFixed(1)) };
  };
  const strata: Array<Record<string, unknown>> = [];
  for (const MINW of [0.4, 1.0, 2.0]) {
    const es = live.filter((e) => e.w >= MINW);
    const pick: Array<[string, string]> = []; const step = Math.max(1, Math.floor(es.length / DIAGN));
    for (let i = 0; i < es.length && pick.length < DIAGN; i += step) pick.push([es[i].a, es[i].b]);
    strata.push(recallCheck(pick, 'w>=' + MINW));
  }
  const rnd: Array<[string, string]> = []; let sd = 12345;
  const nx = () => { sd = (sd * 1103515245 + 12345) & 0x7fffffff; return sd; };
  for (let i = 0; i < DIAGN; i++) { const a = metas[nx() % metas.length].id, b = metas[nx() % metas.length].id; if (a !== b) rnd.push([a, b]); }
  const randomCtl = recallCheck(rnd, '随机对');
  // McNemar：base vs A-count（主配置）
  const disc = baseRank.map((b, i) => [b === 1, main.count.h1 >= 0 && rankCount(mainG, LINKW)[i] === 1]);
  const b10 = disc.filter(([x, y]) => x && !y).length, b01 = disc.filter(([x, y]) => !x && y).length;
  const chi = (Math.abs(b01 - b10) - 1) ** 2 / (b01 + b10 || 1);
  // 位置诊断：目标的命中邻居排得比目标前还是后
  let nbAbove = 0, nbBelow = 0, nbNone = 0;
  for (let i = 0; i < items.length; i++) {
    const ti = retrieved[i].findIndex((x) => x.id === items[i].target);
    const nb = mainG.adj.get(items[i].target);
    if (ti < 0 || !nb || nb.size === 0) { nbNone++; continue; }
    const pos = [...nb].map((x) => retrieved[i].findIndex((y) => y.id === x)).filter((p) => p >= 0);
    if (pos.length === 0) { nbNone++; continue; }
    if (Math.min(...pos) < ti) nbAbove++; else nbBelow++;
  }
  // 子集：base rank 在 2..10 的题（理论上「有空间升到 top1」的题）
  const subIdx = baseRank.map((r, i) => (r >= 2 && r <= 10 ? i : -1)).filter((i) => i >= 0);
  const rc = rankCount(mainG, LINKW), rp = rankProp(mainG, LINKW);
  diag.strata = strata; diag.random = randomCtl;
  diag.mcnemar = { b10, b01, chi2: Number(chi.toFixed(2)), p: chi > 3.84 ? '<0.05' : '>=0.05' };
  diag.position = { nbAbove, nbBelow, nbNone };
  diag.subset_base2to10 = { n: subIdx.length, baseHit1: baseRank.filter((r) => r === 1).length, countHit1: rc.filter((r) => r === 1).length, propHit1: rp.filter((r) => r === 1).length,
    countHit10: rc.filter((r) => r > 0 && r <= 10).length, propHit10: rp.filter((r) => r > 0 && r <= 10).length,
    baseHit10: baseRank.filter((r) => r > 0 && r <= 10).length };
}

// ── 6. 分层 + 样例 ──
const buckets = [0, 0.1, 0.2, 0.3, 0.4, 0.6, 0.8, 1.0, 1.5, 2.0, Infinity];
const hist = buckets.slice(0, -1).map((lo, i) => ({ lo, hi: buckets[i + 1], n: live.filter((e) => e.w >= lo && e.w < buckets[i + 1]).length }));
const wsLive = live.map((e) => e.w).sort((a, b) => a - b);
const qnt = (p: number) => (wsLive.length === 0 ? 0 : wsLive[Math.min(wsLive.length - 1, Math.max(0, Math.floor(p * (wsLive.length - 1))))]);

const sampleIdx = EXAMPLES <= 1 ? [0] : Array.from({ length: EXAMPLES }, (_, i) => Math.floor((i / (EXAMPLES - 1)) * (live.length - 1)));
const examples = sampleIdx.map((i) => {
  const e = live[i]; const A = byId.get(e.a)!, B = byId.get(e.b)!;
  return { rank: i + 1, weight: Number(e.w.toFixed(4)), nsig: e.nsig,
    parts: Object.fromEntries(SIGS.map((s) => [s, Number(e.parts[s].toFixed(4))])),
    a: { id: e.a, title: (A.title ?? '(无标题)').slice(0, 70) }, b: { id: e.b, title: (B.title ?? '(无标题)').slice(0, 70) },
    shared: { topic: e.shared.topic.slice(0, 5), tag: e.shared.tag.slice(0, 5), file: e.shared.file.slice(0, 4), title: e.shared.title.slice(0, 5) } };
});
const dupExamples = edges.filter((e) => e.dup).slice(0, 5).map((e) => ({ weight: Number(e.w.toFixed(4)), a: (byId.get(e.a)!.title ?? '(无标题)').slice(0, 55), b: (byId.get(e.b)!.title ?? '(无标题)').slice(0, 55) }));

const out = {
  at: new Date().toISOString(),
  cmd: 'npx tsx scripts/xarm-links.ts ' + argv.join(' '),
  db: { path: path.resolve(dbPath), bytes: dbStat.size, mtime: dbStat.mtime.toISOString(), opened: 'readonly' },
  params: { project: PID, alpha: ALPHA, dfcap: DFCAP, tagcap: TAGEAP, caps: built.caps, tier: TIER, topk: TOPK, linkweight: LINKW, limit: LIMIT, dupjac: DUPJAC },
  facts: { sessions: nSessions, session_links_rows: nLinks, x_items: items.length, x_target_in_top50: inTop50.filter(Boolean).length },
  edges: { total: edges.length, dup: edges.length - live.length, live: live.length, multi_signal: live.filter((e) => e.nsig >= 2).length,
    hist, quantiles: { p50: qnt(0.5), p90: qnt(0.9), p99: qnt(0.99), max: wsLive[wsLive.length - 1] ?? 0 },
    above: Object.fromEntries([0.20, 0.30, 0.40, 0.60, 0.80, 1.00, 1.50, 2.00].map((t) => [String(t), live.filter((e) => e.w >= t).length])) },
  eval: { n: items.length, base: { hit1: baseAcc.h1, hit10: baseAcc.h10, mrr: Number((baseAcc.mrr / baseAcc.n * 100).toFixed(1)) }, main: ser(main), control: ser(ctl), grid },
  diag,
  examples, dup_examples: dupExamples,
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 1));

const n = items.length;
console.log('== 事实 ==');
console.log('  会话 ' + nSessions + ' · session_links ' + nLinks + ' 行 · X 题 ' + n + '（目标在 top' + LIMIT + ' 内 ' + inTop50.filter(Boolean).length + ' ⇒ 其余 ' + (n - inTop50.filter(Boolean).length) + ' 题重排不可能救）');
console.log('== 候选边 == 总 ' + edges.length + '（dup ' + (edges.length - live.length) + ' 剔除 → live ' + live.length + '，多信号 ' + live.filter((e) => e.nsig >= 2).length + '）');
console.log('  分层 ' + Object.entries(out.edges.above).map(([k, v]) => 'w>=' + k + ':' + v).join('  '));
console.log('  分位 p50=' + qnt(0.5).toFixed(3) + ' p90=' + qnt(0.9).toFixed(3) + ' p99=' + qnt(0.99).toFixed(3) + ' max=' + (wsLive[wsLive.length - 1] ?? 0).toFixed(3));
console.log('  直方图 ' + hist.map((h) => '[' + h.lo + ',' + (h.hi === Infinity ? '∞' : h.hi) + ')=' + h.n).join(' '));
console.log('== 主配置 tier=' + TIER + ' topK=' + TOPK + ' λ=' + LINKW + ' ==');
console.log('  边 ' + main.edges + ' · 节点 ' + main.nodes + ' · 平均度 ' + main.degMean.toFixed(1) + ' · 最大度 ' + main.degMax);
const line = (lab: string, a: Acc) => lab.padEnd(22) + ' hit@1 ' + String(pct(a.h1, a.n)).padStart(5) + '%  hit@10 ' + String(pct(a.h10, a.n)).padStart(5) + '%  MRR ' + (a.mrr / a.n * 100).toFixed(1) + '%';
console.log(line('base(无链接)', baseAcc));
console.log(line('A-count', main.count));
console.log(line('A-prop', main.prop));
console.log(line('C-expand', main.expand) + '  (池内新增 ' + main.added + ')');
console.log(line('控制组 A-count', ctl.count));
console.log(line('控制组 A-prop', ctl.prop));
console.log(line('控制组 C-expand', ctl.expand));
console.log('  A-count 升/降/平 ' + main.up + '/' + main.down + '/' + main.same + ' · 目标有邻居 ' + main.targetLinked + ' · 目标与 top10 有边(桥可达) ' + main.bridge);
if (grid.length) {
  console.log('== 稀疏度网格（hit@1/hit@10 计数，n=' + n + '）==');
  console.log('  minW  topK  边数  节点 均度 最大度   count    prop     expand');
  for (const g of grid) {
    console.log('  ' + String(g.minW).padEnd(5) + String(g.topK).padEnd(5) + String(g.kept).padStart(6) + String(g.nodes).padStart(6) + String(g.degMean).padStart(5) + String(g.degMax).padStart(6) + '   ' + String((g.count as number[])[0] + '/' + (g.count as number[])[1]).padEnd(8) + ' ' + String((g.prop as number[])[0] + '/' + (g.prop as number[])[1]).padEnd(8) + ' ' + String((g.expand as number[])[0] + '/' + (g.expand as number[])[1]));
  }
}
if (Object.keys(diag).length) {
  console.log('== 诊断 ==');
  for (const s of diag.strata as Array<Record<string, unknown>>) console.log('  一致率 ' + s.label + ' n=' + s.n + ' A→B ' + s.aToB + '% B→A ' + s.bToA + '% 任一 ' + s.either + '%');
  console.log('  一致率 随机对 n=' + (diag.random as Record<string, unknown>).n + ' 任一 ' + (diag.random as Record<string, unknown>).either + '%');
  const m = diag.mcnemar as Record<string, unknown>;
  console.log('  McNemar hit@1: 变差 ' + m.b10 + ' / 变好 ' + m.b01 + ' · chi2=' + m.chi2 + ' p' + m.p);
  const p2 = diag.position as Record<string, unknown>;
  console.log('  位置：邻居排在目标前 ' + p2.nbAbove + ' · 后 ' + p2.nbBelow + ' · 无 ' + p2.nbNone);
  const sb = diag.subset_base2to10 as Record<string, unknown>;
  console.log('  子集(base rank 2-10) n=' + sb.n + ' base h1=' + sb.baseHit1 + ' count h1=' + sb.countHit1 + ' prop h1=' + sb.propHit1);
}
console.log('已写 ' + OUT);
