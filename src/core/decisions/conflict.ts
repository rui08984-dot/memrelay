// 决策冲突检测（task C）：同一主题上，后出现的相反说法可能推翻先前的结论。
//
// ═══ 为什么需要它 ═══
// listDecisions 返回的是"每场会话各自说过的话"，跨会话一合并就会互相打架：
// 3 月说"放弃 SQLite 改用向量检索"，10 月又说"采用 SQLite 作为唯一检索层"。
// 两条都在库里、都被正常返回，简报各引用各的 —— 读者只能靠"记得哪条更新"，
// 而"记得"正是记忆层该替人做的事。本文件只把这一对**指出来**，不改任何数据。
//
// ═══ 判据（字面规则，零模型）═══
// 一对决策算冲突，三条全中：
//   ① 相关性：同一 topic（两边都带 topic 且交集非空）**或**实词重叠达标
//      （subjectTokens 交集 ≥ CONFLICT_MIN_SHARED，且覆盖较短一侧 ≥ CONFLICT_MIN_COVERAGE）；
//   ② 极性相反：一方在"否定/放弃/改用"（判定时**否定优先**），另一方在"采用/保留"；
//   ③ 时间可比且后者确实更晚 —— 只报「后者可能推翻前者」，不自动改数据。
//
// ═══ 三条纪律 ═══
// ① 判据只许一份：词元 = store/global.ts 的 subjectTokens（与经验层"新话压旧话"同一份），
//    否定 = hasNegation（同一份）+ 决策层追加的"放弃/改用"标记（决策文本不说"不要"，
//    说"放弃/改用"；基础否定词表不在这里重抄）。本文件不引分词器、不读库、纯函数 ⇒ 可单测。
// ② **只判不杀**：返回的是"可能冲突"，不删不改不降权任何条目。推翻是人拍板的事
//    （本仓 ADR：不做自动推翻——自动推翻错一次，用户就再也不信这套记忆）。
// ③ **保守**：条件不满足就闭嘴。漏判的代价是人工看一眼；误判的代价是用户不再看告警。
//    所以阈值的词元取"具体词"，"决定/会话/必须"这类泛词凑不满门槛。
//
// ═══ 性能 ═══
// audit 会在**全部可见决策**上跑它（实测项目 400~900 条 ⇒ 最坏约 40 万对）。
// 所以极性/topic/词元集都在候选上预计算一次（词元惰性，走不到重叠路径就不算），
// 逐对重新切词会让一次审计多花好几秒 —— 而 audit 是每天都要跑一次的。
import { hasNegation, subjectTokens } from '../../store/global.js';

/** 冲突判定需要的最小行形状：listDecisions 的结果天然满足（多出来的字段原样带回）。 */
export interface ConflictDecisionRow {
  text: string;
  /** 决策时间（ISO 等可被 Date.parse 解析的串）；排序与"后者"的定义都靠它 */
  at: string;
  sessionId?: string;
  msgId?: string | number;
  /** 可选：条目所属 topic。现有 listDecisions 不产出；调用方按会话 topics 注入后相关性更准 */
  topic?: string | null;
  /** 可选：同上的复数形式 */
  topics?: readonly string[] | null;
}

/** 一对冲突：a = 较早（可能被推翻的一方），b = 较晚（可能推翻的一方）。 */
export interface DecisionConflict<Row> {
  a: Row;
  b: Row;
  /** 人话解释：凭什么是这两条、以及"后者可能推翻前者" */
  reason: string;
}

/**
 * 实词重叠阈值（**唯一一份**：audit 的 criteria 文案也引用这两个常量）。
 * 为什么是 3 而不是 1：subjectTokens 里"决定/定向"这类二元组几乎每条决策都有，
 * 只重叠 1~2 个就判冲突，实测会退化成"所有决策互相冲突"，告警随即被无视。
 * 与经验层冲突消解（store/global.ts findSupersedeConflicts）同阈值：同一类误判教训。
 */
export const CONFLICT_MIN_SHARED = 3;

/** 重叠系数下限（共享词数 / 较短一侧词数）。Jaccard 会在长短悬殊时被稀释，故用重叠系数。 */
export const CONFLICT_MIN_COVERAGE = 0.25;

/**
 * 决策层追加的"放弃/改写"标记。
 * 基础否定词（不要/不能/不再/取消/废弃/移除…）已经在 hasNegation 里，**不在这里重抄**；
 * 这里只补决策特有的"换一条路"语义：决策文本更常说"放弃 A，改用 B"而不是"不要 A"。
 */
export const DECISION_ABANDON_MARKERS: readonly string[] = [
  '放弃', '改用', '改为', '换成', '替换', '转用', '切到', '切换到', '转向', '砍掉', '去掉',
];

/** 肯定/保留标记：另一方必须真的在"留/用"，只是没否定不算（否则"没表态"会被当成"支持"）。 */
export const DECISION_KEEP_MARKERS: readonly string[] = [
  '采用', '保留', '沿用', '继续', '坚持', '保持', '确认', '锁定', '统一', '依赖', '选定', '选中', '选用', '使用',
];

export type ConflictPolarity = 'negative' | 'positive' | 'none';

/**
 * 一条决策的极性。
 * **否定优先**：同一句里既有"保留 A"又有"不再用 B"时，保守地按"它在否掉一条路"处理——
 * 这种句子本身就是"改主意"的形状，归类成否定只会多提示一次，归类成肯定则可能漏掉真冲突。
 */
export function decisionPolarity(text: string): ConflictPolarity {
  const s = String(text ?? '');
  if (hasNegation(s) || DECISION_ABANDON_MARKERS.some((m) => s.includes(m))) return 'negative';
  if (DECISION_KEEP_MARKERS.some((m) => s.includes(m))) return 'positive';
  return 'none';
}

/** 命中标记的展示名（reason 里"前者含「放弃」，后者含「采用」"）；基础否定词说"否定词"。 */
function markerLabel(text: string, p: ConflictPolarity): string {
  const s = String(text ?? '');
  if (p === 'positive') return DECISION_KEEP_MARKERS.find((m) => s.includes(m)) ?? '肯定词';
  return DECISION_ABANDON_MARKERS.find((m) => s.includes(m)) ?? '否定词';
}

function topicsOf(row: ConflictDecisionRow): string[] {
  const out: string[] = [];
  const one = row.topic;
  if (typeof one === 'string' && one.trim()) out.push(one.trim().toLowerCase());
  for (const t of row.topics ?? []) if (typeof t === 'string' && t.trim()) out.push(t.trim().toLowerCase());
  return out;
}

/** 候选的**预计算**：极性判一次、topic 拆一次、词元集按需算一次（见文件头「性能」）。 */
interface Candidate<Row> {
  row: Row;
  /** 在输入里的下标：时间不可比时用它退回列表顺序 */
  idx: number;
  polar: ConflictPolarity;
  topics: string[];
  /** 惰性：只有走到"实词重叠"路径才算（topic 命中的对根本不需要） */
  tokens: Set<string> | null;
}

function candidateOf<Row extends ConflictDecisionRow>(row: Row, idx: number): Candidate<Row> {
  return { row, idx, polar: decisionPolarity(String(row?.text ?? '')), topics: topicsOf(row), tokens: null };
}

interface Relation {
  /** 命中的共同 topic；没有则为 null（此时靠实词重叠） */
  sameTopic: string | null;
  /** 共享实词（只在走重叠路径时非空，用于 reason 与样例） */
  shared: string[];
}

/** 相关性判据（唯一一份）：同一 topic 或实词重叠达标。 */
function relate<Row extends ConflictDecisionRow>(a: Candidate<Row>, b: Candidate<Row>): Relation | null {
  const sameTopic = a.topics.find((t) => b.topics.includes(t)) ?? null;
  if (sameTopic !== null) return { sameTopic, shared: [] };
  if (a.tokens === null) a.tokens = subjectTokens(String(a.row.text ?? ''));
  if (b.tokens === null) b.tokens = subjectTokens(String(b.row.text ?? ''));
  const ta = a.tokens, tb = b.tokens;
  const shared = [...ta].filter((t) => tb.has(t));
  if (shared.length < CONFLICT_MIN_SHARED) return null;
  const shorter = Math.min(ta.size, tb.size) || 1;
  if (shared.length / shorter < CONFLICT_MIN_COVERAGE) return null;
  return { sameTopic: null, shared };
}

function timeOf(at: unknown): number | null {
  const ms = Date.parse(String(at ?? ''));
  return Number.isFinite(ms) ? ms : null;
}

interface Ordered<Row> {
  earlier: Candidate<Row>;
  later: Candidate<Row>;
  /** 两边时间都可解析且不相等 → true；时间不可比时退回列表顺序，reason 必须说清 */
  timeKnown: boolean;
}

/** 排定"谁在前"。同一时刻 → null（分不出后者，就不臆造一个）。 */
function orderPair<Row extends ConflictDecisionRow>(x: Candidate<Row>, y: Candidate<Row>): Ordered<Row> | null {
  const mx = timeOf(x.row.at), my = timeOf(y.row.at);
  if (mx !== null && my !== null) {
    if (mx === my) return null;
    return mx < my
      ? { earlier: x, later: y, timeKnown: true }
      : { earlier: y, later: x, timeKnown: true };
  }
  // 时间不可比（缺失/坏格式）：退回输入顺序。listDecisions 本身按 at 升序返回，
  // 这条回退不会把"新"当"旧"，但 reason 里必须写明是列表顺序而非时间（不许假装看懂了时间）。
  return x.idx < y.idx
    ? { earlier: x, later: y, timeKnown: false }
    : { earlier: y, later: x, timeKnown: false };
}

function clip(s: unknown, n = 40): string {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

function explain<Row extends ConflictDecisionRow>(ord: Ordered<Row>, rel: Relation): string {
  const why = rel.sameTopic !== null
    ? '同一 topic「' + rel.sameTopic + '」'
    : '实词重叠 ' + String(rel.shared.length) + ' 个（' + rel.shared.slice(0, 4).join('/') + '）';
  const when = ord.timeKnown
    ? '后者 ' + String(ord.later.row.at) + ' 晚于前者 ' + String(ord.earlier.row.at)
    : '两者时间不可比（按列表顺序）';
  return '「' + clip(ord.earlier.row.text) + '」→「' + clip(ord.later.row.text) + '」：' + why
    + '；前者含「' + markerLabel(ord.earlier.row.text, ord.earlier.polar) + '」，后者含「' + markerLabel(ord.later.row.text, ord.later.polar) + '」，'
    + when + ' —— 后者可能推翻前者';
}

/**
 * 找出"后者可能推翻前者"的决策对。
 *
 * 输入就是 listDecisions 的返回值（只读、不排序、不修改）。输出按输入顺序两两扫描，
 * 每对只报一次；a 恒为较早、b 恒为较晚（与输入顺序无关，靠 at 判定）。
 * 空输入 / 单条 → []（没有可以打架的双方，这不是"健康"，审计侧另有"比对了几条"的 note）。
 */
export function findDecisionConflicts<Row extends ConflictDecisionRow>(rows: readonly Row[]): Array<DecisionConflict<Row>> {
  const list: readonly Row[] = Array.isArray(rows) ? rows : [];
  const out: Array<DecisionConflict<Row>> = [];
  if (list.length < 2) return out;
  // 没表态（polarity=none）的条目构不成任何一对：先收缩候选，配对量立刻少一大截
  const cand: Array<Candidate<Row>> = [];
  for (let i = 0; i < list.length; i++) {
    const c = candidateOf(list[i], i);
    if (c.polar !== 'none') cand.push(c);
  }
  for (let i = 0; i < cand.length; i++) {
    for (let j = i + 1; j < cand.length; j++) {
      const a = cand[i], b = cand[j];
      if (a.polar === b.polar) continue;              // 同向不算冲突
      const rel = relate(a, b);
      if (rel === null) continue;                     // 不同主题不算
      const ord = orderPair(a, b);
      if (ord === null) continue;                     // 同一时刻：分不出后者
      out.push({ a: ord.earlier.row, b: ord.later.row, reason: explain(ord, rel) });
    }
  }
  return out;
}
