// scripts/calibrate-weights.ts —— 零模型、零新依赖的**检索排序权重自校准**。
//
// 要回答的问题只有一句：**这几个排序旋钮到底该不该调？**
//   把它变成一个可复现的统计问题（固定题面 + 固定判据 + 反过拟合裁决），
//   而不是拿几个样本的手感去改一个全局判据 —— 那是本仓最贵的一类错。
//
// 旋钮（数值解析在 src/search-svc/engine.ts，**以代码为准，不以注释/口头为准**）：
//   · SRELAY_TITLE_BOOST     标题/话题重排权重         engine.ts:918-921  默认 1
//   · SRELAY_COVERAGE_BOOST  覆盖度加权系数            engine.ts:900-903  默认 1
//   · SRELAY_META_BOOST      meta 双路命中加分         engine.ts:905-908  默认 0
//        ↑ 任务书里写的是 1，但**代码是 0**（注释原文「默认 0 = 旧行为」）—— 这里按代码走，
//          否则基线一上来就不是用户正在用的那一套，「提升」全是假的。
//   · SRELAY_BEST_EXCERPT    片段是否用覆盖锚点        engine.ts:898      默认 1
//        （只影响片段选取，不影响名次；留在网格里当 A/B 对照，别指望它动指标）
//
// 两条证据链（**缺一条都不许出建议**）：
//   ① 基准：scripts/recall-bench.ts 跑笛卡尔网格，每题复用**同一批固定题面**
//      （--use-questions）。跨轮**必须**复用题面，否则 ORDER BY RANDOM() 会换题面，
//      差异里混着题面差异（recall-bench.ts 文件头登记的 P1 仪器缺陷）。
//   ② 真实反馈：src/search-svc/feedback.ts 的 feedbackStats()（**只调它，不另写 SQL/判据**），
//      给出 open 次数、平均名次与名次直方图。open 次数 < --min-opens（默认 30）
//      ⇒ 只打印「样本不足，保持默认」。
//
// 判据（**唯一一份**，在 pickWinner 里，为什么是这几条写在它上面）：
//   · hit@10 不许下降（硬约束）—— 召回上限掉了，再高的 hit@1 也是拿「更少能命中」换来的；
//   · hit@1 或 MRR **严格**提升才算赢，且另外两项都不许退化（见函数注释）；
//   · 并列（指标在容差内相等）时选**离默认组合最近**的 —— 反对过拟合：
//     指标一样时，越靠近现有产品默认的改动，越可能只是拟合了这批题面；
//   · 反馈样本不足 ⇒ 判决直接是「保持默认」，不是「仅供参考」（这脚本不说话比乱说话好）。
//
// --dry：**只跑「默认组合」这一个点**（忽略 --grid），跑通即停：不出建议、不写任何文件。
//        用途只有一个 —— 证明管线（子进程 → JSON → 指标解析 → 反馈读取 → 表格）是通的。
//        冒烟：npx tsx scripts/calibrate-weights.ts --n 20 --grid titleBoost=1 --dry
//
// 纪律：
//   · 只读：本脚本**绝不**写配置、不改 config.json、不改库。写配置是人的动作（输出末行再说一遍）。
//   · 中间产物只落系统临时目录（os.tmpdir()），结束即删，不在仓库里留文件。
//   · 任何一步失败（题面缺、库打不开、基准跑挂、反馈读不出）都打印原因并**非 0 退出**，
//     绝不静默返回一个空结论。
//   · 退出码：0 正常；2 用法/输入错误；3 运行期失败（基准或反馈库）。
//
// 用法：
//   npx tsx scripts/calibrate-weights.ts --n 60 --grid "titleBoost=0.5,1,2;coverageBoost=0,1,3"
//   npx tsx scripts/calibrate-weights.ts --db <库> --questions scripts/bench-questions-agent1super.json --json out.json
//   npx tsx scripts/calibrate-weights.ts --help
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
// 反馈判据**只此一份**：这里只调用 feedbackStats()，不重写 SQL、不另立「什么算有效反馈」。
import { feedbackStats, MIN_OPENS_FOR_CALIBRATION } from '../src/search-svc/feedback.js';

/** 仓库根（本文件在 scripts/ 下）。子进程 cwd 与默认题面路径都以它为准。 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ══════════════════════════ 1. 旋钮与产品默认（唯一一份） ══════════════════════════

export const KNOB_ORDER = ['titleBoost', 'coverageBoost', 'metaBoost', 'bestExcerpt'] as const;
export type KnobName = (typeof KNOB_ORDER)[number];

/** 一个旋钮组合。数值含义与 engine.ts 的解析一致：一律非负有限数；bestExcerpt 只取 0/1。 */
export interface KnobSet {
  titleBoost: number;
  coverageBoost: number;
  metaBoost: number;
  bestExcerpt: number;
}

/** 旋钮 → 环境变量名（engine.ts 在模块加载时读一次，所以每个组合必须**独立子进程**）。 */
export const KNOB_ENV: Record<KnobName, string> = {
  titleBoost: 'SRELAY_TITLE_BOOST',
  coverageBoost: 'SRELAY_COVERAGE_BOOST',
  metaBoost: 'SRELAY_META_BOOST',
  bestExcerpt: 'SRELAY_BEST_EXCERPT',
};

/**
 * **产品默认**（= 线上用户当前吃到的那一套）。
 *
 * 刻意不从 engine.ts import：DEFAULT_TITLE_BOOST 等常量在模块加载时就把
 * 环境变量吸进去了 —— 父进程里只要有一个 SRELAY_TITLE_BOOST=2，
 * 我们就会把 2 当成「默认」，于是基线错、整套结论错。
 * 这里是**字面量**，改动必须同步 engine.ts（两处都有注释指向对方）。
 */
export const DEFAULTS: KnobSet = Object.freeze({
  titleBoost: 1,
  coverageBoost: 1,
  metaBoost: 0,
  bestExcerpt: 1,
});

/** 默认网格：2 个旋钮 3×3 = 9 个点（3 个旋钮会到 27 点，跑起来太贵，按需 --grid 覆盖）。 */
export const DEFAULT_GRID_SPEC = 'titleBoost=0.5,1,2;coverageBoost=0,1,3';

/** 用法/输入错误（与「运行期失败」分开：前者不该浪费一次基准的钱）。 */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export function formatKnobs(k: KnobSet): string {
  return KNOB_ORDER.map((n) => n + '=' + String(k[n])).join(', ');
}

export function knobsEqual(a: KnobSet, b: KnobSet): boolean {
  return KNOB_ORDER.every((n) => Number(a[n]) === Number(b[n]));
}

/**
 * 离默认组合的**相对**距离（0 = 就是默认）。
 *
 * 为什么相对：titleBoost 的 0.5 与 coverageBoost 的 0.5 不该同权 —— 它们量级不同。
 * 分母取 max(1, |默认值|)：默认 1 的旋钮按相对差算，默认 0 的旋钮（metaBoost）
 * 自然退化为绝对差（否则除零）。
 * 为什么需要它：并列裁决要用它（见 pickWinner 的反过拟合规则）。
 */
export function knobDistance(a: KnobSet, b: KnobSet): number {
  let sum = 0;
  for (const n of KNOB_ORDER) {
    const dv = Math.abs(Number(a[n]) - Number(b[n]));
    const scale = Math.max(1, Math.abs(Number(b[n])));
    sum += dv / scale;
  }
  return sum;
}

/** 组合 → 子进程环境变量（四个旋钮全显式给，避免父进程残留值串进来）。 */
export function knobEnv(k: KnobSet): Record<string, string> {
  return {
    SRELAY_TITLE_BOOST: String(k.titleBoost),
    SRELAY_COVERAGE_BOOST: String(k.coverageBoost),
    SRELAY_META_BOOST: String(k.metaBoost),
    SRELAY_BEST_EXCERPT: String(k.bestExcerpt),
  };
}

function parseKnobValue(knob: KnobName, text: string): number {
  const v = Number(text);
  if (!Number.isFinite(v)) throw new UsageError('旋钮 ' + knob + ' 的值不是有限数字：' + text);
  if (v < 0) throw new UsageError('旋钮 ' + knob + ' 不能是负数：' + text + '（engine.ts 会把非法值回落到默认，静默改变基线）');
  if (knob === 'bestExcerpt' && v !== 0 && v !== 1) throw new UsageError('bestExcerpt 只能是 0 或 1：' + text);
  return v;
}

// ══════════════════════════ 2. 网格（纯函数，可测） ══════════════════════════

export interface GridDim {
  knob: KnobName;
  values: number[];
}

/**
 * 解析 --grid：旋钮=v1,v2;旋钮2=v3,v4（维度分隔符 ; 或 |，值分隔符 ,）。
 * 可以给多次 --grid（同一旋钮的值会合并去重）。
 * 非法输入直接抛 UsageError —— 绝不把 NaN/负数悄悄传给子进程（engine.ts 会回落成默认，
 * 于是你以为在测 0.5，其实在测 1，整轮结论作废）。
 */
export function parseGridSpec(specs: readonly string[]): GridDim[] {
  const order: KnobName[] = [];
  const byKnob = new Map<KnobName, number[]>();
  for (const raw of specs) {
    const text = String(raw ?? '').trim();
    if (!text) continue;
    for (const part of text.split(/[;|]/)) {
      const seg = part.trim();
      if (!seg) continue;
      const eq = seg.indexOf('=');
      if (eq <= 0) throw new UsageError('网格项写法不对：' + seg + '（应为 旋钮=v1,v2）');
      const knobText = seg.slice(0, eq).trim();
      const valuesText = seg.slice(eq + 1).trim();
      if (!KNOB_ORDER.includes(knobText as KnobName)) {
        throw new UsageError('不知道这个旋钮：' + knobText + '（可用：' + KNOB_ORDER.join(' / ') + '）');
      }
      const knob = knobText as KnobName;
      const values = valuesText.split(',').map((s) => s.trim()).filter((s) => s !== '');
      if (values.length === 0) throw new UsageError('旋钮 ' + knob + ' 没给值');
      let list = byKnob.get(knob);
      if (!list) { list = []; byKnob.set(knob, list); order.push(knob); }
      for (const v of values) {
        const n = parseKnobValue(knob, v);
        if (!list.includes(n)) list.push(n);
      }
    }
  }
  if (order.length === 0) throw new UsageError('网格是空的（--grid 至少要给一个 旋钮=值）');
  return order.map((knob) => ({ knob, values: byKnob.get(knob) as number[] }));
}

/**
 * 笛卡尔积展开，并保证**默认组合在第一位**（它是基线；裁决不许缺基线）。
 * 网格里没给默认组合时自动补上 —— 否则「hit@10 不许下降」这条硬约束没有对照，整段判据失效。
 */
export function gridCombos(dims: readonly GridDim[], defaults: KnobSet): KnobSet[] {
  const out: KnobSet[] = [];
  const seen = new Set<string>();
  const push = (k: KnobSet) => {
    const key = formatKnobs(k);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(k);
  };
  const rec = (i: number, acc: KnobSet) => {
    if (i >= dims.length) { push({ ...acc }); return; }
    const d = dims[i];
    for (const v of d.values) rec(i + 1, { ...acc, [d.knob]: v });
  };
  rec(0, { ...defaults });
  const defKey = formatKnobs(defaults);
  const idx = out.findIndex((k) => formatKnobs(k) === defKey);
  if (idx < 0) out.unshift({ ...defaults });
  else if (idx > 0) { const [d] = out.splice(idx, 1); out.unshift(d); }
  return out;
}

// ══════════════════════════ 3. 指标（从基准 JSON 里读，口径与 recall-bench 一致） ══════════════════════════

export interface BenchMetrics {
  /** 样本题数（三臂合计） */
  n: number;
  hit1: number;
  hit10: number;
  mrr: number;
}

export interface BenchJsonLike {
  acc?: Record<string, { n?: number; h1?: number; h3?: number; h10?: number }>;
  rows?: Array<{ lex?: number }>;
}

/**
 * 从 recall-bench.ts --json 的产物算 hit@1 / hit@10 / MRR。
 *
 * 口径**照抄** recall-bench 自己的定义（同一份判据，不另立一套）：
 *   · hit@k = 每条题的命中条数 / 题数，按臂（K/S/M）汇总 —— 只取词法三臂，
 *     因为本脚本不开语义臂（--semantic 0），Ks/Ss/Ms 恒为 0；
 *   · MRR   = 每题 lex >= 0 ? 1/(lex+1) : 0 的均值（lex 是 0 起的名次）——
 *     与它分桶报告里的 mrrv 完全同式。基准 JSON 没有汇总 MRR，只能从 rows 算。
 *
 * 三条硬校验（宁可抛错也不出假数）：
 *   ① acc 里没有任何样本 ⇒ 抛；
 *   ② 缺 rows ⇒ 抛（MRR 无从计算，静默填 0 会假装「排序很差」）；
 *   ③ rows 条数 != acc 样本数 ⇒ 抛（仪器口径冲突，说明 JSON 不是这一轮跑出来的）。
 */
export function metricsFromBench(json: unknown): BenchMetrics {
  const j = (json ?? {}) as BenchJsonLike;
  const acc = j.acc;
  if (!acc || typeof acc !== 'object') throw new Error('基准 JSON 缺 acc 字段');
  let n = 0;
  let h1 = 0;
  let h10 = 0;
  for (const arm of ['K', 'S', 'M'] as const) {
    const row = acc[arm];
    if (!row) continue;
    const rn = Number(row.n ?? 0);
    if (!(rn > 0)) continue;
    n += rn;
    h1 += Number(row.h1 ?? 0);
    h10 += Number(row.h10 ?? 0);
  }
  if (n <= 0) throw new Error('基准 JSON 的 acc 里 K/S/M 全是 0 样本（这一轮没跑出题？）');
  const rows = Array.isArray(j.rows) ? j.rows : null;
  if (!rows) throw new Error('基准 JSON 缺 rows 字段（MRR 算不出来）');
  if (rows.length !== n) throw new Error('基准 JSON 口径冲突：rows=' + rows.length + ' 但 acc 样本=' + n);
  let mrrSum = 0;
  for (const r of rows) {
    const lex = Number((r as { lex?: number })?.lex ?? -1);
    if (Number.isFinite(lex) && lex >= 0) mrrSum += 1 / (lex + 1);
  }
  return { n, hit1: h1 / n, hit10: h10 / n, mrr: mrrSum / n };
}

// ══════════════════════════ 4. 裁决（**唯一一份判据**，纯函数） ══════════════════════════

/** 真实反馈证据（feedbackStats 的子集：只带本脚本用得上的三项）。 */
export interface FeedbackEvidence {
  /** open 事件总数 */
  total: number;
  /** 平均名次（没有事件时为 null，不是 0） */
  avgPosition: number | null;
  /** 名次直方图（按名次升序） */
  positions: Array<{ position: number; opens: number }>;
}

/** 一个候选组合的输入：旋钮 + 这一轮的基准结果（null = 跑挂）。 */
export interface CandidateInput {
  knobs: KnobSet;
  bench: BenchMetrics | null;
  /** bench 为 null 时的失败原因 */
  error?: string;
}

export type Verdict = 'baseline' | 'win' | 'lose' | 'tie' | 'failed';

export interface ScoredRow {
  knobs: KnobSet;
  bench: BenchMetrics | null;
  /** 相对基线的差值（小数，0.01 = 1pt）；跑挂时为 null */
  delta: { hit1: number; hit10: number; mrr: number } | null;
  /** 离默认组合的相对距离（0 = 就是默认） */
  distance: number;
  isDefault: boolean;
  verdict: Verdict;
  /** 一句话说清这一行为什么这样判（表格里直接给人看） */
  reason: string;
}

export type DecisionAction = 'keep-default' | 'change';

export interface CalibrationDecision {
  action: DecisionAction;
  /** 建议采用的组合（keep-default 时 = 默认组合） */
  knobs: KnobSet;
  reason: string;
  baseline: BenchMetrics;
  rows: ScoredRow[];
  /** 反馈样本不足（此时 action 必为 keep-default） */
  insufficientFeedback: boolean;
  feedback: FeedbackEvidence | null;
  /** 是否走了「并列时选离默认最近」这条规则 */
  tieBreak: boolean;
}

/** 反馈样本量门槛：open 次数少于此值 ⇒ 不许出任何建议。
 *  **不在这里写死 30**：判据住在 src/search-svc/feedback.ts（CLI 的 srelay feedback 也读它），
 *  两处各写一个数就是"屏幕上一个门槛、脚本里另一个门槛"——本仓最贵的一类分叉。 */
export const DEFAULT_MIN_OPENS = MIN_OPENS_FOR_CALIBRATION;

export interface PickOptions {
  /** 真实反馈证据；不给 = 没有证据（同样不许出建议） */
  feedback?: FeedbackEvidence | null;
  minOpens?: number;
  /** 判「持平 / 提升 / 退化」的容差（默认 1e-9，即严格大小比较） */
  tolerance?: number;
}

/**
 * 判决。
 *
 * 判据（**整个仓库里只此一份**，改了这里就等于改了「什么算赢」）：
 *
 * ① 反馈样本门（先于一切）：feedbackStats() 的 open 次数 < minOpens（默认 30）
 *    ⇒ 判决固定为「保持默认」，理由里带「样本不足」。
 *    为什么放在最前：基准是**合成题面**，反馈是**真实回看**；只用基准改全局权重，
 *    等于拿 200 道自动出的题面去赌所有项目的排序。样本不够就不许出建议 ——
 *    这是任务 D 原本就定下的纪律（feedback.ts 文件头第 ③ 条）。
 *
 * ② hit@10 硬约束（**不降**）：候选的 hit@10 比基线低（超出容差）⇒ 直接判输，
 *    哪怕 hit@1 涨了 9pt 也不算赢。为什么：hit@10 是「用户还能不能找到」的上限，
 *    hit@1 是「第一屏好不好看」。用上限换第一屏，是拿召回换观感 —— 不做。
 *
 * ③ 赢 = 至少一项严格提升，且三项**都不退化**：
 *    hit@10 不降 且 hit@1 不降 且 MRR 不降 且（hit@1 或 MRR 严格提升）。
 *    为什么额外要求「都不退化」：hit@1 涨、MRR 跌 这类交易在很多题面上毫无意义
 *    （只是把第 1 名的问题挪到第 4 名），而且 200 题的噪声约 ±3pt，
 *    允许互相抵消只会让噪声更容易被读成「提升」。
 *
 * ④ 并列 → 选**离默认最近**：指标在容差内相等的候选里，取 knobDistance 最小者；
 *    距离也相等时按组合字符串排序（确定性，别让同一次输入出两个结论）。
 *    为什么：反过拟合。指标一样时，「更靠近现有默认」的改动更可能只是拟合了这批题面。
 *    注意默认组合自己按 ②③ 是 baseline 而不是 win，所以 ④ 只有在真有候选赢的时候才生效。
 *
 * ⑤ 一格没说清就判输：跑挂的组合永远不会被选中（verdict=failed），
 *    并且调用方（CLI）会以非 0 退出 —— 不许「少一个点也照出建议」。
 */
export function pickWinner(
  rows: readonly CandidateInput[],
  defaults: KnobSet,
  opts: PickOptions = {},
): CalibrationDecision {
  const tol = opts.tolerance ?? 1e-9;
  const minOpens = Math.max(1, Math.floor(Number(opts.minOpens ?? DEFAULT_MIN_OPENS)));
  const evidence = opts.feedback ?? null;

  // ── 基线：网格生成保证默认组合在列表里；缺了就抛，不许拿别的组合当基线（那会让所有差值失真）
  const baseInput = rows.find((r) => knobsEqual(r.knobs, defaults));
  if (!baseInput) throw new Error('pickWinner: 网格里没有默认组合，无法定基线（gridCombos 必须把默认组合放进来）');
  if (!baseInput.bench) throw new Error('pickWinner: 默认组合这一轮没有基准结果，不能比较');

  const base = baseInput.bench;

  // ── 逐行打分
  const scored: ScoredRow[] = rows.map((r) => {
    const distance = knobDistance(r.knobs, defaults);
    const isDefault = knobsEqual(r.knobs, defaults);
    if (!r.bench) {
      return {
        knobs: r.knobs, bench: null, delta: null, distance, isDefault,
        verdict: 'failed', reason: '基准跑挂：' + (r.error ?? '未给出原因'),
      };
    }
    const delta = { hit1: r.bench.hit1 - base.hit1, hit10: r.bench.hit10 - base.hit10, mrr: r.bench.mrr - base.mrr };
    if (isDefault) {
      return { knobs: r.knobs, bench: r.bench, delta, distance, isDefault, verdict: 'baseline', reason: '默认组合（对照基线）' };
    }
    // ② 硬约束先判：hit@10 掉了一定输，不管别的涨多少
    if (delta.hit10 < -tol) {
      return {
        knobs: r.knobs, bench: r.bench, delta, distance, isDefault, verdict: 'lose',
        reason: 'hit@10 下降 ' + signedPt(delta.hit10) + '（硬约束：召回上限不许降）',
      };
    }
    // ③ 有一点退化就不算赢（哪怕另一点涨了）
    const degraded: string[] = [];
    if (delta.hit1 < -tol) degraded.push('hit@1 ' + signedPt(delta.hit1));
    if (delta.mrr < -tol) degraded.push('MRR ' + signedPt(delta.mrr));
    if (degraded.length > 0) {
      return {
        knobs: r.knobs, bench: r.bench, delta, distance, isDefault, verdict: 'lose',
        reason: 'hit@10 没降，但有指标退化：' + degraded.join('、'),
      };
    }
    if (delta.hit1 > tol || delta.mrr > tol) {
      const gain: string[] = [];
      if (delta.hit1 > tol) gain.push('hit@1 ' + signedPt(delta.hit1));
      if (delta.mrr > tol) gain.push('MRR ' + signedPt(delta.mrr));
      return {
        knobs: r.knobs, bench: r.bench, delta, distance, isDefault, verdict: 'win',
        reason: '胜出：' + gain.join('、') + '（hit@10 ' + signedPt(delta.hit10) + '）',
      };
    }
    return {
      knobs: r.knobs, bench: r.bench, delta, distance, isDefault, verdict: 'tie',
      reason: '与默认持平（无严格提升）',
    };
  });

  // ── ① 反馈样本门：不够就干脆不出建议（不是「仅供参考」）
  const gate = feedbackGate(evidence, minOpens);
  if (!gate.ok) {
    return {
      action: 'keep-default', knobs: { ...defaults }, reason: gate.reason as string,
      baseline: base, rows: scored, insufficientFeedback: true, feedback: evidence, tieBreak: false,
    };
  }

  const wins = scored.filter((r) => r.verdict === 'win' && r.bench !== null);
  if (wins.length === 0) {
    const failed = scored.filter((r) => r.verdict === 'failed').length;
    const reason = failed > 0
      ? failed + ' 个组合跑挂，其余没有严格优于默认 —— 保持默认'
      : '没有任何组合严格优于默认（hit@10 不降 + hit@1/MRR 至少一项严格提升）—— 保持默认（反对过拟合）';
    return {
      action: 'keep-default', knobs: { ...defaults }, reason,
      baseline: base, rows: scored, insufficientFeedback: false, feedback: evidence, tieBreak: false,
    };
  }

  // ── ④ 并列裁决：先按 (hit@1, MRR) 取最优，再把与最优并列的挑出来，选离默认最近的
  const sorted = [...wins].sort((a, b) => {
    const d1 = b.bench!.hit1 - a.bench!.hit1;
    if (Math.abs(d1) > tol) return d1;
    const d2 = b.bench!.mrr - a.bench!.mrr;
    if (Math.abs(d2) > tol) return d2;
    return a.distance - b.distance;
  });
  const best = sorted[0];
  const ties = sorted.filter((r) => Math.abs(r.bench!.hit1 - best.bench!.hit1) <= tol && Math.abs(r.bench!.mrr - best.bench!.mrr) <= tol);
  let picked = ties[0];
  for (const r of ties.slice(1)) {
    if (r.distance < picked.distance) picked = r;
    else if (r.distance === picked.distance && formatKnobs(r.knobs) < formatKnobs(picked.knobs)) picked = r;
  }
  const tieBreak = ties.length > 1;

  return {
    action: 'change',
    knobs: { ...picked.knobs },
    reason: '胜出组合：' + picked.reason
      + '；hit@10 ' + signedPt(picked.delta!.hit10)
      + '；反馈 avgPosition ' + fmtPos(evidence?.avgPosition ?? null)
      + '（' + (evidence?.total ?? 0) + ' 次 open）'
      + (tieBreak ? '；并列最优 ' + ties.length + ' 个，按「离默认最近」取 distance=' + picked.distance.toFixed(2) : ''),
    baseline: base,
    rows: scored,
    insufficientFeedback: false,
    feedback: evidence,
    tieBreak,
  };
}

/**
 * 反馈样本门（**唯一一份**）。
 * 三种不足都判不足：没证据 / open 次数不够 / 有事件但 avgPosition 缺失。
 * 理由里一律带「样本不足」四个字 —— 这是给人一眼看懂的信号，测试也钉它。
 */
export function feedbackGate(
  evidence: FeedbackEvidence | null | undefined,
  minOpens: number,
): { ok: boolean; reason?: string } {
  if (!evidence) {
    return { ok: false, reason: '样本不足：没有 search_feedback 证据（feedbackStats 未提供）—— 不许出建议，保持默认' };
  }
  if (!(Number(evidence.total) >= minOpens)) {
    return { ok: false, reason: '样本不足：search_feedback 只有 ' + Number(evidence.total ?? 0) + ' 次 open（阈值 ' + minOpens + '）—— 不许出建议，保持默认' };
  }
  if (evidence.avgPosition === null || evidence.avgPosition === undefined) {
    return { ok: false, reason: '样本不足：有 ' + evidence.total + ' 条 open 但 avgPosition 缺失 —— 不许出建议，保持默认' };
  }
  return { ok: true };
}

function signedPt(v: number): string {
  const x = v * 100;
  return (x >= 0 ? '+' : '') + x.toFixed(1) + 'pt';
}

function fmtPos(v: number | null): string {
  return v === null || v === undefined ? '—' : Number(v).toFixed(2);
}

// ══════════════════════════ 5. 基准子进程 ══════════════════════════

interface BenchRunOk { ok: true; metrics: BenchMetrics; ms: number }
interface BenchRunFail { ok: false; error: string; ms: number }
export type BenchRun = BenchRunOk | BenchRunFail;

/** tsx 的 CLI 入口：优先直接用仓库里那份（不走 npx，避免 .cmd 与含空格路径的引号地狱）。 */
function tsxCli(repoRoot: string): string | null {
  const p = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  return fs.existsSync(p) ? p : null;
}

function benchArgs(o: { db: string; questions: string; limit: number; n?: number; out: string }): string[] {
  const args = [
    path.join(REPO_ROOT, 'scripts', 'recall-bench.ts'),
    o.db,
    '--limit', String(o.limit),
    '--use-questions', o.questions,
    // 融合探针每题多跑 2 次检索，只影响日志不影响指标 —— 扫描时纯属浪费。
    '--noprobe', '1',
    '--json', o.out,
  ];
  // --n 只在「从库里出题」时生效；配合固定题面时靠 --max-items 截断（必须 3 的倍数，保证 K/S/M 成对）
  if (o.n !== undefined) args.push('--n', String(o.n), '--max-items', String(o.n * 3));
  return args;
}

const TAIL = 4000;
const tail = (s: string): string => (s.length <= TAIL ? s : '…' + s.slice(-TAIL));
const tailTrim = (s: string): string => s.trim().split('\n').slice(-8).join('\n');

function runBench(o: {
  db: string;
  questions: string;
  limit: number;
  n?: number;
  timeoutMs: number;
  knobs: KnobSet;
  outFile: string;
}): Promise<BenchRun> {
  const started = Date.now();
  const cli = tsxCli(REPO_ROOT);
  const tsxArgs = benchArgs({ db: o.db, questions: o.questions, limit: o.limit, n: o.n, out: o.outFile });
  const cmd = cli ? process.execPath : (process.platform === 'win32' ? 'npx.cmd' : 'npx');
  const argv = cli ? [cli, ...tsxArgs] : ['tsx', ...tsxArgs];
  const env = { ...process.env, ...knobEnv(o.knobs) };

  return new Promise<BenchRun>((resolve) => {
    let out = '';
    let err = '';
    let timedOut = false;
    let settled = false;
    const child = spawn(cmd, argv, { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch { /* 已经退出就别管 */ }
    }, Math.max(1000, o.timeoutMs));

    child.stdout?.on('data', (d: Buffer) => { out = tail(out + d.toString('utf8')); });
    child.stderr?.on('data', (d: Buffer) => { err = tail(err + d.toString('utf8')); });

    const finish = (r: BenchRun) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r); } };

    child.on('error', (e: Error) => {
      finish({ ok: false, error: '子进程启动失败：' + e.message, ms: Date.now() - started });
    });
    child.on('close', (code: number | null) => {
      const ms = Date.now() - started;
      if (timedOut) {
        finish({ ok: false, error: '基准超时（>' + o.timeoutMs + 'ms）已终止' + (err ? '｜stderr：' + tailTrim(err) : ''), ms });
        return;
      }
      if (code !== 0) {
        const detail = tailTrim(err) || tailTrim(out) || '（无输出）';
        finish({ ok: false, error: '基准退出码 ' + code + '｜' + detail, ms });
        return;
      }
      let json: unknown;
      try {
        if (!fs.existsSync(o.outFile)) throw new Error('没写出 --json 文件：' + o.outFile);
        json = JSON.parse(fs.readFileSync(o.outFile, 'utf8'));
      } catch (e) {
        finish({ ok: false, error: '基准 JSON 读不出：' + (e as Error).message, ms });
        return;
      }
      try {
        finish({ ok: true, metrics: metricsFromBench(json), ms });
      } catch (e) {
        finish({ ok: false, error: '指标解析失败：' + (e as Error).message, ms });
      }
    });
  });
}

// ══════════════════════════ 6. 真实反馈（只调 feedbackStats） ══════════════════════════

interface FeedbackRead {
  ok: boolean;
  evidence?: FeedbackEvidence;
  error?: string;
  buckets?: Array<{ bucket: string; opens: number; avgPosition: number | null }>;
}

function readFeedback(opts: { project?: string; sinceDays?: number }): FeedbackRead {
  try {
    const s = feedbackStats({
      project: opts.project,
      sinceDays: opts.sinceDays,
    });
    return {
      ok: true,
      evidence: { total: Number(s.total ?? 0), avgPosition: s.avgPosition ?? null, positions: s.positions ?? [] },
      buckets: s.buckets ?? [],
    };
  } catch (e) {
    // 读接口出错要让人看见（feedback.ts 的契约）：不当成「没有数据」
    return { ok: false, error: (e as Error).message };
  }
}

// ══════════════════════════ 7. CLI ══════════════════════════

export interface CliOptions {
  db?: string;
  questions: string;
  grid: GridDim[];
  n?: number;
  limit: number;
  dry: boolean;
  minOpens: number;
  sinceDays?: number;
  project?: string;
  timeoutMs: number;
  /** null = 不输出；'-' = stdout；其它 = 文件路径 */
  json: string | null;
  help: boolean;
}

function needInt(name: string, text: string, min: number): number {
  const v = Number(text);
  if (!Number.isFinite(v) || !Number.isInteger(v) || v < min) {
    throw new UsageError('--' + name + ' 需要 >= ' + min + ' 的整数，收到：' + text);
  }
  return v;
}

/** 纯解析（不碰文件系统），便于测试与 --help 快路径。 */
export function parseArgs(argv: readonly string[]): CliOptions {
  const opts: CliOptions = {
    questions: path.join('scripts', 'bench-questions-agent1super.json'),
    grid: [],
    limit: 10,
    dry: false,
    minOpens: DEFAULT_MIN_OPENS,
    timeoutMs: 900_000,
    json: null,
    help: false,
  };
  const gridSpecs: string[] = [];
  const list = [...argv];
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (!a.startsWith('--')) throw new UsageError('多余的位置参数：' + a + '（用法见 --help）');
    const eq = a.indexOf('=');
    const name = eq >= 0 ? a.slice(2, eq) : a.slice(2);
    const inline = eq >= 0 ? a.slice(eq + 1) : undefined;
    const value = (): string => {
      if (inline !== undefined) return inline;
      const v = list[i + 1];
      if (v === undefined || v.startsWith('--')) throw new UsageError('--' + name + ' 需要一个值');
      i++;
      return v;
    };
    switch (name) {
      case 'help': opts.help = true; break;
      case 'dry': opts.dry = true; break;
      case 'db': opts.db = value(); break;
      case 'questions': opts.questions = value(); break;
      case 'grid': gridSpecs.push(value()); break;
      case 'n': opts.n = needInt('n', value(), 1); break;
      case 'limit': opts.limit = needInt('limit', value(), 1); break;
      case 'min-opens': opts.minOpens = needInt('min-opens', value(), 1); break;
      case 'since-days': opts.sinceDays = needInt('since-days', value(), 1); break;
      case 'project': opts.project = value(); break;
      case 'timeout': opts.timeoutMs = needInt('timeout', value(), 1); break;
      case 'json': {
        if (inline !== undefined) { opts.json = inline === '' ? '-' : inline; break; }
        const v = list[i + 1];
        if (v === undefined || v.startsWith('--')) { opts.json = '-'; break; }
        opts.json = v; i++;
        break;
      }
      default: throw new UsageError('未知参数：--' + name + '（用法见 --help）');
    }
  }
  if (opts.help) return opts;
  opts.grid = parseGridSpec(gridSpecs.length > 0 ? gridSpecs : [DEFAULT_GRID_SPEC]);
  return opts;
}

function printHelp(): void {
  console.log([
    '检索排序权重自校准（零模型）',
    '',
    '用法：npx tsx scripts/calibrate-weights.ts [选项]',
    '',
    '  --db <库>            项目库路径；不给时优先用题面文件里的 dbPath，再自动探测 .sessionrelay/relay.sqlite',
    '  --questions <文件>   固定题面 JSON（默认 scripts/bench-questions-agent1super.json）',
    '                       **跨轮比较必须复用同一批题面**，否则题面本身会变',
    '  --grid <规格>        "旋钮=v1,v2;旋钮2=v3,v4"，可多次给；默认 ' + DEFAULT_GRID_SPEC,
    '  --n <题数>           只跑前 n 个会话对应的题（--max-items n*3，三臂成对）；不给 = 用完整题面',
    '  --limit <k>          检索 top-k（默认 10，须与题面里的 limit 一致）',
    '  --min-opens <k>      反馈样本门槛，默认 ' + DEFAULT_MIN_OPENS + '；不足则只打印「样本不足，保持默认」',
    '  --since-days <d>     反馈只看最近 d 天',
    '  --project <id>       反馈只看某个项目',
    '  --timeout <ms>       单个组合的超时（默认 900000）',
    '  --json[=文件]        输出结构化结果；不给值 = 打到 stdout',
    '  --dry                只跑「默认组合」一个点，不出建议（冒烟用）',
    '  --help               这份说明',
    '',
    '旋钮：' + KNOB_ORDER.join(' / ') + '（默认 ' + formatKnobs(DEFAULTS) + '）',
    '本脚本只出建议：绝不写配置、绝不改 config.json。',
  ].join('\n'));
}

// ══════════════════════════ 8. 打印 ══════════════════════════

function pct(v: number): string {
  return (v * 100).toFixed(1) + '%';
}

interface DisplayRow {
  label: string;
  hit1: string;
  hit10: string;
  mrr: string;
  feedback: string;
  verdict: string;
  note: string;
}

/** 终端显示宽度：CJK 算 2 列。表格是对给人看的，列对不齐就等于没排版。 */
function dw(s: string): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    const wide = (c >= 0x1100 && c <= 0x115f)
      || (c >= 0x2e80 && c <= 0xa4cf)
      || (c >= 0xac00 && c <= 0xd7a3)
      || (c >= 0xf900 && c <= 0xfaff)
      || (c >= 0xfe30 && c <= 0xfe6f)
      || (c >= 0xff00 && c <= 0xff60)
      || (c >= 0xffe0 && c <= 0xffe6);
    w += wide ? 2 : 1;
  }
  return w;
}

function padTo(s: string, width: number, align: 'left' | 'right' = 'left'): string {
  const need = Math.max(0, width - dw(s));
  return align === 'left' ? s + ' '.repeat(need) : ' '.repeat(need) + s;
}

function renderTable(rows: readonly DisplayRow[]): string {
  const wLabel = Math.max(6, ...rows.map((r) => dw(r.label)));
  const head = padTo('组合', wLabel) + '  ' + padTo('hit@1', 7, 'right') + '  ' + padTo('hit@10', 7, 'right')
    + '  ' + padTo('MRR', 7, 'right') + '  ' + padTo('反馈名次', 9, 'right') + '  ' + '判定';
  const sep = '─'.repeat(Math.min(150, wLabel + 62));
  const lines = [head, sep];
  for (const r of rows) {
    lines.push(padTo(r.label, wLabel) + '  ' + padTo(r.hit1, 7, 'right') + '  ' + padTo(r.hit10, 7, 'right')
      + '  ' + padTo(r.mrr, 7, 'right') + '  ' + padTo(r.feedback, 9, 'right') + '  ' + r.verdict
      + (r.note ? '  ' + r.note : ''));
  }
  return lines.join('\n');
}

function feedbackCell(evidence: FeedbackEvidence | null): string {
  return fmtPos(evidence?.avgPosition ?? null) + '*';
}

function displayOf(r: ScoredRow, evidence: FeedbackEvidence | null): DisplayRow {
  const label = formatKnobs(r.knobs);
  const verdictText: Record<Verdict, string> = {
    baseline: '基线', win: '胜出', lose: '判输', tie: '持平', failed: '跑挂',
  };
  return {
    label,
    hit1: r.bench ? pct(r.bench.hit1) : '—',
    hit10: r.bench ? pct(r.bench.hit10) : '—',
    mrr: r.bench ? pct(r.bench.mrr) : '—',
    feedback: feedbackCell(evidence),
    verdict: verdictText[r.verdict],
    note: r.isDefault ? '' : r.reason,
  };
}

// ══════════════════════════ 9. main ══════════════════════════

interface QuestionsFile {
  dbPath?: string;
  limit?: number;
  items?: Array<{ arm?: string; query?: string; target?: string }>;
}

function resolveDb(opts: CliOptions, q: QuestionsFile): { ok: true; db: string; source: string } | { ok: false; error: string } {
  const tried: string[] = [];
  if (opts.db) {
    const p = path.resolve(opts.db);
    if (!fs.existsSync(p)) return { ok: false, error: '--db 指向的库不存在：' + p };
    return { ok: true, db: p, source: '--db' };
  }
  if (typeof q.dbPath === 'string' && q.dbPath.trim() !== '' && !q.dbPath.includes('<')) {
    const p = path.resolve(q.dbPath);
    tried.push(p);
    if (fs.existsSync(p)) return { ok: true, db: p, source: '题面文件 dbPath' };
  }
  const starts = [process.cwd(), REPO_ROOT];
  for (const s of starts) {
    let dir = path.resolve(s);
    for (let i = 0; i < 5; i++) {
      const p = path.join(dir, '.sessionrelay', 'relay.sqlite');
      if (!tried.includes(p)) {
        tried.push(p);
        if (fs.existsSync(p)) return { ok: true, db: p, source: '自动探测' };
      }
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  return { ok: false, error: '没找到库。试过：' + tried.map((t) => '\n    ' + t).join('') + '\n  用 --db <库路径> 指定' };
}

async function main(argv: readonly string[]): Promise<number> {
  let opts: CliOptions;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    console.error('✗ ' + (e instanceof Error ? e.message : String(e)));
    console.error('  用法见 --help');
    return 2;
  }
  if (opts.help) { printHelp(); return 0; }

  // ── 题面（缺了就是仪器没有尺子，直接失败）
  const questionsPath = path.resolve(REPO_ROOT, opts.questions);
  let q: QuestionsFile;
  try {
    if (!fs.existsSync(questionsPath)) throw new Error('题面文件不存在：' + questionsPath);
    q = JSON.parse(fs.readFileSync(questionsPath, 'utf8')) as QuestionsFile;
  } catch (e) {
    console.error('✗ 题面不可用：' + (e as Error).message);
    return 2;
  }
  const items = Array.isArray(q.items) ? q.items : [];
  if (items.length === 0) { console.error('✗ 题面文件里 items 为空：' + questionsPath); return 2; }
  const bad = items.findIndex((it) => typeof it?.query !== 'string' || typeof it?.target !== 'string');
  if (bad >= 0) { console.error('✗ 题面第 ' + bad + ' 条缺 query/target：' + questionsPath); return 2; }
  if (q.limit !== undefined && q.limit !== opts.limit) {
    console.log('⚠️ 题面 limit=' + q.limit + ' 与本次 --limit=' + opts.limit + ' 不同：命中率不可直接比（仍会跑，但别跨 limit 下结论）');
  }

  // ── 库
  const dbRes = resolveDb(opts, q);
  if (!dbRes.ok) { console.error('✗ 库不可用：' + dbRes.error); return 2; }
  if (typeof q.dbPath === 'string' && q.dbPath.trim() !== '' && !q.dbPath.includes('<')
      && path.resolve(q.dbPath) !== dbRes.db) {
    console.log('⚠️ 库与题面文件记录的 dbPath 不同：' + q.dbPath + ' —— 目标会话可能不在这个库里，指标会接近 0');
  }

  // ── 反馈（先读：库打不开就别浪费一次基准的钱）
  const fb = readFeedback({ project: opts.project, sinceDays: opts.sinceDays });
  if (!fb.ok) {
    console.error('✗ 反馈库读不出（feedbackStats 失败）：' + fb.error);
    console.error('  反馈是第二条证据链；读不出就不出建议（也不假装没有数据）');
    return 3;
  }
  const evidence = fb.evidence as FeedbackEvidence;
  const gate = feedbackGate(evidence, opts.minOpens);

  // ── 网格
  const combos = opts.dry ? [{ ...DEFAULTS }] : gridCombos(opts.grid, DEFAULTS);

  console.log('检索排序权重自校准（零模型 · 只出建议，不写配置）');
  console.log('库：' + dbRes.db + '（来源：' + dbRes.source + '）');
  console.log('题面：' + questionsPath + '（' + items.length + ' 条，limit=' + opts.limit
    + (opts.n !== undefined ? '，本次只取前 ' + opts.n + ' 组' : '，本次用完整题面') + '）');
  console.log('默认组合：' + formatKnobs(DEFAULTS));
  console.log('网格：' + combos.length + ' 个组合' + (opts.dry ? '（--dry：只跑默认组合）' : ''));
  console.log('');
  console.log('真实反馈（feedbackStats'
    + (opts.project ? '，project=' + opts.project : '，全部项目')
    + (opts.sinceDays ? '，近 ' + opts.sinceDays + ' 天' : '')
    + '）：');
  console.log('  open 样本：' + evidence.total + ' 次 · 平均名次：' + fmtPos(evidence.avgPosition)
    + ' · 名次直方图：' + (evidence.positions.length ? evidence.positions.map((p) => p.position + '→' + p.opens).join(' ') : '（空）'));
  console.log(gate.ok
    ? '  ⇒ 样本充足（阈值 ' + opts.minOpens + '）：反馈可用作佐证'
    : '  ⇒ 样本不足（阈值 ' + opts.minOpens + '）：本轮只打印「保持默认」，不出建议');
  console.log('');

  // ── 跑网格
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'srelay-calib-'));
  const candidates: CandidateInput[] = [];
  const elapsed: number[] = [];
  let failures = 0;
  try {
    for (let i = 0; i < combos.length; i++) {
      const knobs = combos[i];
      const label = formatKnobs(knobs);
      process.stdout.write('[' + (i + 1) + '/' + combos.length + '] ' + label + ' … ');
      const outFile = path.join(tmpDir, 'bench-' + i + '.json');
      const run = await runBench({
        db: dbRes.db, questions: questionsPath, limit: opts.limit, n: opts.n,
        timeoutMs: opts.timeoutMs, knobs, outFile,
      });
      elapsed.push(run.ms);
      if (!run.ok) {
        failures++;
        console.log('✗ ' + run.error);
        candidates.push({ knobs, bench: null, error: run.error });
        // 基线跑挂 ⇒ 没有对照，后面跑完也没意义：立刻停，别烧钱
        if (i === 0) {
          console.error('✗ 基线组合（默认组合）跑挂，无法建立对照 —— 终止');
          return 3;
        }
        continue;
      }
      const m = run.metrics;
      console.log('hit@1 ' + pct(m.hit1) + ' · hit@10 ' + pct(m.hit10) + ' · MRR ' + pct(m.mrr)
        + '（n=' + m.n + '，' + run.ms + 'ms）');
      candidates.push({ knobs, bench: m });
    }
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 临时目录删不掉不影响结论 */ }
  }

  // ── 裁决（dry 不出建议）
  const decision = opts.dry
    ? null
    : pickWinner(candidates, DEFAULTS, { feedback: evidence, minOpens: opts.minOpens });

  console.log('');
  const displayRows: DisplayRow[] = decision
    ? decision.rows.map((r) => displayOf(r, evidence))
    : candidates.map((c) => ({
      label: formatKnobs(c.knobs),
      hit1: c.bench ? pct(c.bench.hit1) : '—',
      hit10: c.bench ? pct(c.bench.hit10) : '—',
      mrr: c.bench ? pct(c.bench.mrr) : '—',
      feedback: feedbackCell(evidence),
      verdict: c.bench ? '基线' : '跑挂',
      note: '',
    }));
  console.log(renderTable(displayRows));
  console.log('* 反馈名次是**全局聚合**（feedbackStats 读的是默认档在线数据），不随组合变化；');
  console.log('  它只当「样本够不够 / 现在这名次还有多少上行空间」的佐证，不参与组合排序。');
  console.log('');

  let exitCode = 0;
  if (failures > 0) {
    console.log('✗ 有 ' + failures + ' 个组合跑挂（见上表「跑挂」行）：本轮**不出建议**。');
    console.log('  原因已逐条打印在上面；修好仪器再跑，别拿残缺网格当结论。');
    exitCode = 3;
  } else if (decision) {
    if (decision.action === 'keep-default') {
      console.log('建议：保持默认（' + formatKnobs(DEFAULTS) + '）');
      console.log('理由：' + decision.reason);
    } else {
      const row = decision.rows.find((r) => knobsEqual(r.knobs, decision.knobs));
      const b = decision.baseline;
      const m = row?.bench ?? null;
      console.log('建议改为：' + formatKnobs(decision.knobs));
      console.log('  证据（基准 n=' + b.n + '，同一批题面）：hit@1 ' + pct(m?.hit1 ?? 0) + '（' + signedPt((m?.hit1 ?? 0) - b.hit1)
        + '）、hit@10 ' + pct(m?.hit10 ?? 0) + '（' + signedPt((m?.hit10 ?? 0) - b.hit10)
        + '）、MRR ' + pct(m?.mrr ?? 0) + '（' + signedPt((m?.mrr ?? 0) - b.mrr) + '）');
      console.log('  反馈佐证：avgPosition ' + fmtPos(evidence.avgPosition) + '（' + evidence.total + ' 次 open）');
      if (decision.tieBreak) console.log('  并列提示：多个组合指标相同，按「离默认最近」裁决（反过拟合）');
    }
  } else {
    console.log('（--dry：只验证管线跑通，不出建议）');
  }
  console.log('');
  console.log('（本脚本只出建议：不改配置、不写 config.json —— 写配置是人的动作）');

  // ── 结构化输出
  if (opts.json) {
    const payload = {
      version: 1,
      at: new Date().toISOString(),
      db: dbRes.db,
      dbSource: dbRes.source,
      questions: questionsPath,
      questionsCount: items.length,
      limit: opts.limit,
      n: opts.n ?? null,
      dry: opts.dry,
      minOpens: opts.minOpens,
      grid: combos.map((k) => ({ ...k })),
      env: combos.map((k) => knobEnv(k)),
      feedback: {
        total: evidence.total,
        avgPosition: evidence.avgPosition,
        positions: evidence.positions,
        sufficient: gate.ok,
        reason: gate.ok ? null : gate.reason,
        buckets: fb.buckets ?? [],
      },
      rows: candidates.map((c) => ({
        knobs: { ...c.knobs },
        bench: c.bench,
        error: c.bench ? null : (c.error ?? '未知原因'),
      })),
      decision: decision
        ? {
          action: decision.action,
          knobs: { ...decision.knobs },
          reason: decision.reason,
          baseline: decision.baseline,
          insufficientFeedback: decision.insufficientFeedback,
          tieBreak: decision.tieBreak,
          verdicts: decision.rows.map((r) => ({
            knobs: { ...r.knobs }, verdict: r.verdict, delta: r.delta, distance: r.distance, reason: r.reason,
          })),
        }
        : null,
      elapsedMs: elapsed,
    };
    const text = JSON.stringify(payload, null, 2);
    if (opts.json === '-') {
      console.log(text);
    } else {
      try {
        const target = path.resolve(opts.json);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, text + '\n');
        console.log('JSON 已写出：' + target);
      } catch (e) {
        console.error('✗ JSON 写入失败：' + (e as Error).message);
        exitCode = exitCode || 3;
      }
    }
  }
  return exitCode;
}

const isMain = process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  const code = await main(process.argv.slice(2));
  process.exitCode = code;
}
