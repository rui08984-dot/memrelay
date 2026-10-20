import { describe, it, expect } from 'vitest';
import {
  DEFAULTS,
  DEFAULT_MIN_OPENS,
  KNOB_ORDER,
  knobDistance,
  knobsEqual,
  parseGridSpec,
  gridCombos,
  metricsFromBench,
  feedbackGate,
  pickWinner,
} from '../../scripts/calibrate-weights.js';
import type { KnobSet, BenchMetrics, CandidateInput, FeedbackEvidence } from '../../scripts/calibrate-weights.js';

/**
 * 权重自校准的**判据**（不是实现）。
 *
 * 为什么值得单独测：pickWinner 决定「这套旋钮该不该上线」。它错了不会崩、不会报错，
 *   只会安静地把噪声读成「提升」，然后我们拿着一句「显著更好」去改所有项目的排序。
 *   这是本仓最贵的一种错 —— 错的是结论，不是代码。
 * 所以这里钉四件事：
 *   ① 反馈样本不足 ⇒ 保持默认（理由含「样本不足」）；
 *   ② hit@10 下降的组合**一定**判输（哪怕 hit@1 涨了）；
 *   ③ 并列时选离默认最近的（反过拟合）；
 *   ④ 网格/指标解析是纯函数，可单测（测试里绝不 spawn 真基准：那要几分钟）。
 */

const K = (patch: Partial<KnobSet> = {}): KnobSet => ({ ...DEFAULTS, ...patch });

/** 造一份基准指标（n 只是样本量，不参与判据，但会被原样报出来） */
const M = (hit1: number, hit10: number, mrr: number, n = 198): BenchMetrics => ({ n, hit1, hit10, mrr });

/** 够用的反馈证据：120 次 open，平均名次 2.0 */
const ENOUGH: FeedbackEvidence = { total: 120, avgPosition: 2, positions: [{ position: 1, opens: 60 }, { position: 2, opens: 60 }] };

const row = (knobs: KnobSet, bench: BenchMetrics | null): CandidateInput => ({ knobs, bench });

describe('判据 ① · 反馈样本不足时不许出建议', () => {
  it('只有 3 次 open（阈值 30）⇒ 保持默认，理由含「样本不足」', () => {
    const rows = [row(K(), M(0.41, 0.67, 0.48)), row(K({ titleBoost: 2 }), M(0.52, 0.74, 0.57))];
    const d = pickWinner(rows, DEFAULTS, {
      feedback: { total: 3, avgPosition: 2.5, positions: [{ position: 3, opens: 3 }] },
      minOpens: 30,
    });
    expect(d.action).toBe('keep-default');
    expect(d.reason).toContain('样本不足');
    expect(d.insufficientFeedback).toBe(true);
    expect(knobsEqual(d.knobs, DEFAULTS)).toBe(true);
    // 就算基准上那个组合明显更好，也不许出建议
    expect(d.rows.find((r) => knobsEqual(r.knobs, K({ titleBoost: 2 })))?.verdict).toBe('win');
  });

  it('完全没有反馈证据（feedback 未提供）同样保持默认 —— 不许只拿基准说话', () => {
    const rows = [row(K(), M(0.41, 0.67, 0.48)), row(K({ titleBoost: 2 }), M(0.52, 0.74, 0.57))];
    const d = pickWinner(rows, DEFAULTS);
    expect(d.action).toBe('keep-default');
    expect(d.reason).toContain('样本不足');
    expect(d.insufficientFeedback).toBe(true);
  });

  it('样本量刚好等于阈值时算够（边界不倒退）', () => {
    const rows = [row(K(), M(0.41, 0.67, 0.48)), row(K({ titleBoost: 2 }), M(0.52, 0.74, 0.57))];
    const d = pickWinner(rows, DEFAULTS, {
      feedback: { total: DEFAULT_MIN_OPENS, avgPosition: 2, positions: [] },
      minOpens: DEFAULT_MIN_OPENS,
    });
    expect(d.insufficientFeedback).toBe(false);
    expect(d.action).toBe('change');
  });

  it('有事件但 avgPosition 缺失也算样本不足（不拿 null 当 0）', () => {
    expect(feedbackGate({ total: 100, avgPosition: null, positions: [] }, 30).ok).toBe(false);
  });
});

describe('判据 ② · hit@10 硬约束：下降一定判输（哪怕 hit@1 涨）', () => {
  it('hit@1 +9pt、hit@10 -10pt 的组合判输，整体仍保持默认', () => {
    const rows = [
      row(K(), M(0.70, 0.80, 0.60)),
      row(K({ titleBoost: 2 }), M(0.79, 0.70, 0.65)),   // hit@1 涨、hit@10 掉
    ];
    const d = pickWinner(rows, DEFAULTS, { feedback: ENOUGH });
    const bad = d.rows.find((r) => knobsEqual(r.knobs, K({ titleBoost: 2 })));
    expect(bad?.verdict).toBe('lose');
    expect(bad?.reason).toContain('hit@10');
    // 唯一候选被判输 ⇒ 不许改
    expect(d.action).toBe('keep-default');
    expect(knobsEqual(d.knobs, DEFAULTS)).toBe(true);
  });

  it('即使同时有别的组合「持平」，掉 hit@10 的那个也进不了候选', () => {
    const rows = [
      row(K(), M(0.70, 0.80, 0.60)),
      row(K({ titleBoost: 2 }), M(0.86, 0.71, 0.70)),
      row(K({ coverageBoost: 3 }), M(0.70, 0.80, 0.60)),
    ];
    const d = pickWinner(rows, DEFAULTS, { feedback: ENOUGH });
    expect(d.action).toBe('keep-default');
    expect(d.rows.filter((r) => r.verdict === 'win')).toHaveLength(0);
    expect(d.rows.find((r) => knobsEqual(r.knobs, K({ coverageBoost: 3 })))?.verdict).toBe('tie');
  });

  it('hit@10 没降但 MRR 退化 ⇒ 也不算赢（不许拿一项换一项）', () => {
    const rows = [
      row(K(), M(0.70, 0.80, 0.60)),
      row(K({ titleBoost: 2 }), M(0.80, 0.82, 0.55)),
    ];
    const d = pickWinner(rows, DEFAULTS, { feedback: ENOUGH });
    const r = d.rows.find((x) => knobsEqual(x.knobs, K({ titleBoost: 2 })));
    expect(r?.verdict).toBe('lose');
    expect(r?.reason).toContain('MRR');
    expect(d.action).toBe('keep-default');
  });

  it('轻微超出容差的 hit@10 下降也判输（容差是 1e-9，不是「目测差不多」）', () => {
    const rows = [
      row(K(), M(0.70, 0.8000, 0.60)),
      row(K({ titleBoost: 2 }), M(0.72, 0.7999, 0.61)),
    ];
    const d = pickWinner(rows, DEFAULTS, { feedback: ENOUGH });
    expect(d.rows.find((r) => knobsEqual(r.knobs, K({ titleBoost: 2 })))?.verdict).toBe('lose');
  });
});

describe('判据 ③ · 并列时选离默认最近的（反过拟合）', () => {
  it('两个组合指标完全相同 ⇒ 取距离默认更小的那个', () => {
    const near = K({ titleBoost: 0.5 });  // 距离 0.5
    const far = K({ titleBoost: 2 });     // 距离 1.0
    const rows = [
      row(K(), M(0.70, 0.80, 0.60)),
      row(far, M(0.76, 0.84, 0.66)),
      row(near, M(0.76, 0.84, 0.66)),
    ];
    const d = pickWinner(rows, DEFAULTS, { feedback: ENOUGH });
    expect(d.action).toBe('change');
    expect(knobsEqual(d.knobs, near)).toBe(true);
    expect(d.tieBreak).toBe(true);
    expect(knobDistance(near, DEFAULTS)).toBeLessThan(knobDistance(far, DEFAULTS));
  });

  it('不并列时「更强」优先于「更近默认」', () => {
    const near = K({ titleBoost: 0.5 });
    const far = K({ titleBoost: 2 });
    const rows = [
      row(K(), M(0.70, 0.70, 0.60)),
      row(near, M(0.73, 0.71, 0.62)),  // 小胜，但更近
      row(far, M(0.85, 0.90, 0.75)),   // 大胜
    ];
    const d = pickWinner(rows, DEFAULTS, { feedback: ENOUGH });
    expect(d.action).toBe('change');
    expect(knobsEqual(d.knobs, far)).toBe(true);
    expect(d.tieBreak).toBe(false);
  });

  it('距离相同（两个方向的等距改动）时结果确定，不会自相矛盾', () => {
    const a = K({ titleBoost: 0.5 });
    const b = K({ titleBoost: 1.5 });
    const rows = [row(K(), M(0.70, 0.80, 0.60)), row(b, M(0.76, 0.84, 0.66)), row(a, M(0.76, 0.84, 0.66))];
    const d1 = pickWinner(rows, DEFAULTS, { feedback: ENOUGH });
    const d2 = pickWinner([...rows].reverse(), DEFAULTS, { feedback: ENOUGH });
    expect(knobsEqual(d1.knobs, d2.knobs)).toBe(true);
  });
});

describe('判据 ⑤ · 跑挂的组合永远不会被选中', () => {
  it('唯一可能是赢的那个组合跑挂 ⇒ 保持默认，并记成 failed', () => {
    const rows: CandidateInput[] = [
      row(K(), M(0.70, 0.80, 0.60)),
      { knobs: K({ titleBoost: 2 }), bench: null, error: '基准退出码 1' },
    ];
    const d = pickWinner(rows, DEFAULTS, { feedback: ENOUGH });
    const dead = d.rows.find((r) => knobsEqual(r.knobs, K({ titleBoost: 2 })));
    expect(dead?.verdict).toBe('failed');
    expect(dead?.reason).toContain('基准');
    expect(d.action).toBe('keep-default');
    expect(d.reason).toContain('跑挂');
  });

  it('基线缺失直接抛错（不许悄悄拿别的组合当对照）', () => {
    expect(() => pickWinner([row(K({ titleBoost: 2 }), M(0.8, 0.9, 0.7))], DEFAULTS, { feedback: ENOUGH })).toThrow();
  });
});

describe('网格生成 · 纯函数', () => {
  it('两个旋钮 3×3 = 9 个组合，默认组合永远排第一（它是基线）', () => {
    const dims = parseGridSpec(['titleBoost=0.5,1,2;coverageBoost=0,1,3']);
    expect(dims.map((d) => d.knob)).toEqual(['titleBoost', 'coverageBoost']);
    expect(dims[0].values).toEqual([0.5, 1, 2]);
    const combos = gridCombos(dims, DEFAULTS);
    expect(combos).toHaveLength(9);
    expect(knobsEqual(combos[0], DEFAULTS)).toBe(true);
    expect(combos.every((c) => KNOB_ORDER.every((n) => Number.isFinite(c[n])))).toBe(true);
  });

  it('--grid 只给一个值就是一个点（冒烟命令的用法）', () => {
    const combos = gridCombos(parseGridSpec(['titleBoost=1']), DEFAULTS);
    expect(combos).toHaveLength(1);
    expect(knobsEqual(combos[0], DEFAULTS)).toBe(true);
  });

  it('网格里漏掉默认组合时自动补上并放第一位（硬约束不能没有对照）', () => {
    const combos = gridCombos(parseGridSpec(['titleBoost=2']), DEFAULTS);
    expect(combos).toHaveLength(2);
    expect(knobsEqual(combos[0], DEFAULTS)).toBe(true);
    expect(knobsEqual(combos[1], K({ titleBoost: 2 }))).toBe(true);
  });

  it('多个 --grid 合并，同一旋钮重复值去重（别把同一个点跑两遍）', () => {
    const combos = gridCombos(parseGridSpec(['titleBoost=1,1,0.5', 'coverageBoost=1']), DEFAULTS);
    expect(combos).toHaveLength(2);
  });

  it('非法值直接抛（绝不把 NaN/负数悄悄传给子进程，那会让 engine 回落成默认）', () => {
    expect(() => parseGridSpec(['titleBoost=abc'])).toThrow();
    expect(() => parseGridSpec(['titleBoost=-1'])).toThrow();
    expect(() => parseGridSpec(['nosuchknob=1'])).toThrow();
    expect(() => parseGridSpec(['bestExcerpt=0.5'])).toThrow();
    expect(() => parseGridSpec(['titleBoost'])).toThrow();
    expect(() => parseGridSpec([])).toThrow();
  });
});

describe('指标解析 · 与 recall-bench 同口径', () => {
  it('从 acc + rows 算 hit@1 / hit@10 / MRR，并忽略 Proxy 带出的 toJSON 假臂', () => {
    const bench = {
      acc: {
        K: { n: 2, h1: 1, h3: 1, h10: 2 },
        S: { n: 2, h1: 0, h3: 1, h10: 1 },
        M: { n: 0, h1: 0, h3: 0, h10: 0 },
        toJSON: { n: 9, h1: 9, h3: 9, h10: 9 },
      },
      rows: [{ lex: 0 }, { lex: 1 }, { lex: 3 }, { lex: -1 }],
    };
    const m = metricsFromBench(bench);
    expect(m.n).toBe(4);
    expect(m.hit1).toBeCloseTo(1 / 4, 12);
    expect(m.hit10).toBeCloseTo(3 / 4, 12);
    // MRR = (1/1 + 1/2 + 1/4 + 0) / 4，与 recall-bench 的 mrrv 同式
    expect(m.mrr).toBeCloseTo((1 + 1 / 2 + 1 / 4) / 4, 12);
  });

  it('rows 条数与 acc 样本数不一致 ⇒ 抛（仪器口径冲突不许静默）', () => {
    expect(() => metricsFromBench({ acc: { K: { n: 3, h1: 1, h10: 3 } }, rows: [{ lex: 0 }] })).toThrow();
  });

  it('没有样本 / 没有 rows ⇒ 抛（静默填 0 会假装「排序很差」）', () => {
    expect(() => metricsFromBench({ acc: { K: { n: 0, h1: 0, h10: 0 } }, rows: [] })).toThrow();
    expect(() => metricsFromBench({ acc: { K: { n: 1, h1: 1, h10: 1 } } })).toThrow();
    expect(() => metricsFromBench({})).toThrow();
  });
});

describe('距离函数 · 相对距离（并列裁决的尺子）', () => {
  it('默认组合距离 = 0，越远越大', () => {
    expect(knobDistance(DEFAULTS, DEFAULTS)).toBe(0);
    expect(knobDistance(K({ titleBoost: 0.5 }), DEFAULTS)).toBeCloseTo(0.5, 12);
    expect(knobDistance(K({ titleBoost: 2 }), DEFAULTS)).toBeCloseTo(1, 12);
    expect(knobDistance(K({ coverageBoost: 3 }), DEFAULTS)).toBeCloseTo(2, 12);
  });

  it('默认 0 的旋钮（metaBoost）退化为绝对距离，不会除零', () => {
    const d = knobDistance(K({ metaBoost: 0.5 }), DEFAULTS);
    expect(Number.isFinite(d)).toBe(true);
    expect(d).toBeCloseTo(0.5, 12);
  });
});
