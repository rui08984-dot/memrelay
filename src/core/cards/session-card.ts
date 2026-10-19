// session-card.ts —— 会话卡：把一个会话压成一张**结构化**卡片（零模型、纯规则）。
//
// 为什么需要它：简报里现在每条会话只有标题，agent 看到标题也不知道"这场到底干了什么、定了什么、还欠什么"。
// 会话卡把已有的四类提取结果（决策/未决/话题/文件）组装成一张卡，每条都带原文出处。
//
// 纪律（与全仓同源）：
//   · 判据只许一份 —— 这里全部 import 自 core/extract/extract.ts，绝不复制正则；
//   · 零模型 —— 不调任何模型，纯字符串与打分；
//   · 可溯源 —— 每条决策/未决带 msgId + seq + 原句片段（≤120 字）；
//   · 确定性 —— 同输入必得同输出（无随机；唯一的"现在"由 opts.now 注入，见下方说明）。
import {
  extractDecisions, extractQuestions, extractFiles, extractTopics, summaryRule,
  sanitizeMsgs, type Msg, type ExtractedMeta,
} from '../extract/extract.js';

/** 出处引文上限：120 字（任务约定，也是 CardEvidence.quote 的硬上界） */
export const QUOTE_MAX = 120;

export interface CardEvidence {
  /** 稳定主键（优先）；老数据 / 会话被裁剪后可能没有 —— 此时为 null，不编造 */
  msgId: string | null;
  /** 该消息在会话里的序号（位置索引，会随裁剪前移，故只作辅助） */
  seq: number;
  /** 原句片段，长度**严格** ≤ QUOTE_MAX（含末尾省略号，不会溢出到 121） */
  quote: string;
}

export interface SessionCard {
  title: string;
  /** 决策（含 negative = 被否掉的路） */
  decisions: Array<{ text: string; kind: 'decision' | 'negative'; evidence: CardEvidence }>;
  /** 未解决的问题（判据全在 extractQuestions，这里只挑 unresolved=true 的） */
  unresolved: Array<{ q: string; evidence: CardEvidence }>;
  topics: string[];
  files: string[];
  /** 时间跨度（只有日期；没有就 null）。days 供"这一场聊了几天"直接显示 */
  span: { from: string | null; to: string | null; days: number | null };
  messageCount: number;
  /**
   * 全部出处的平铺：先决策、后未决，顺序稳定。
   * 单列一份是为了让渲染层"一键列出所有可点回原文的锚点"时不必自己拼两段
   * （拼法一旦分叉，面板与简报的顺序就会不一致）。
   */
  evidence: CardEvidence[];
  /** 一句话规则摘要（复用 summaryRule，保证与简报/库里 summary_rule 列同源） */
  summary: string;
}

export interface CardInfo {
  title: string | null;
  messageCount: number;
  source: string;
  firstAt: string;
  lastAt: string | null;
}

export interface CardOptions {
  /**
   * 判定"现在"的时刻，透传给 extractQuestions 的 7 天观察期闸（单测注入 = 同输入同输出）。
   * 不传则与生产一致：用真实时间——观察期是**抽取期**判据（见 extract.ts 方案 B），
   * 卡片只能如实调用，不能为了"看起来确定"把它关掉。要复现请显式传 now。
   */
  now?: Date;
  /** 引文上限（默认 120；只在测试里收窄用） */
  maxQuote?: number;
}

/**
 * 裁剪到 ≤ n 字（末尾以 … 收尾时也计入 n，保证不会出现 121 字）。
 * 这不是判据，只决定"显示多长"，不影响收不收这条。
 */
const clip = (s: string, n = QUOTE_MAX): string => {
  const one = String(s ?? '').replace(/\s+/g, ' ').trim();
  const lim = Math.max(1, Math.floor(n));
  if (one.length <= lim) return one;
  // 先切到 lim-1 再补省略号；顺手剥掉紧跟切口的空白/标点，避免"…,"这种断头
  return one.slice(0, lim - 1).replace(/[\s，,、；;：:]+$/u, '') + '…';
};

/**
 * 从**已清洗**的消息里取"含该片段的原句"作为证据。
 * 带一点前文（≤30 字）是为了让引文自己说得出上下文；仍然严格 ≤ QUOTE_MAX。
 * 找不到原句就退回抽取文本本身 —— 宁可短，不可编造。
 *
 * ⚠️ 截断必须**说出来**：早期版本先 slice 再 clip，切掉尾巴后字符串正好等于上限，
 * clip 便以为"没超长"而不加省略号 —— 于是引文看起来是完整的原句，实际被腰斩。
 * 这种"看起来是原文、其实是半句"的引文比没有引文更糟（用户会照着它引用）。
 * 故这里直接按原文算：左侧被切 → 前置 …；右侧被切 → 后置 …（两端都算进 max）。
 */
function quoteOf(msgs: Msg[], seq: number, needle: string, max: number): string {
  const hit = msgs.find((m) => m.seqNum === seq);
  const raw = hit ? String(hit.content ?? '') : '';
  // 起点：命中位置往前带 30 字上下文；没命中就退回抽取文本（它是这句的压缩形态）
  const at = hit ? raw.indexOf(needle.slice(0, 20)) : -1;
  const source = at < 0 ? String(needle ?? '') : raw;
  const start = at < 0 ? 0 : Math.max(0, at - 30);
  const one = source.slice(start).replace(/\s+/g, ' ').trim();
  if (one.length <= max) {
    // 窗口完整：左侧若被切过仍需前置省略号，告诉读者"上面还有"
    return at < 0 || start === 0 ? one : '…' + one;
  }
  // 需要截断：给两侧省略号各留 1 字预算，保证总长仍 ≤ max
  const lead = at >= 0 && start > 0 ? '…' : '';
  const body = one.slice(0, Math.max(1, max - lead.length - 1)).replace(/[\s，,、；;：:]+$/u, '');
  return lead + body + '…';
}

/**
 * 生成会话卡。
 *
 * @param msgs 会话消息（顺序即抽取器处理顺序；seqNum/id/createdAt 只用于出处）
 * @param info 会话级元信息（标题 / 条数 / 来源 / 时间端点）
 * @param opts "现在"与引文上限（见 CardOptions）
 *
 * ⚠️ msgs 会先过 sanitizeMsgs 再进任何提取器 —— 这是 extract.ts 的铁律
 * （"所有进入提取器的消息都必须先过这个函数"）。不过这一道，客户端注入的
 * <system-reminder> / 技能目录里的"决定…"会被当成用户决策进卡片，
 * 实测已发生（技能说明里的"再决定接受、修订或坚持"曾把简报名额占满）。
 */
export function buildSessionCard(msgs: Msg[], info: CardInfo, opts: CardOptions = {}): SessionCard {
  const max = Math.max(1, Math.floor(opts.maxQuote ?? QUOTE_MAX));
  const clean = sanitizeMsgs(Array.isArray(msgs) ? msgs : []);
  const decisions = extractDecisions(clean);
  const questions = extractQuestions(clean, opts.now ? { now: opts.now } : {});
  const files = extractFiles(clean.map((m) => m.content));
  const topics = extractTopics(clean);
  // 复用 summaryRule 需要 ExtractedMeta 形状；只填它用到的四类（codeBlockCount 未参与摘要）
  const meta: ExtractedMeta = {
    files, topics,
    decisions: decisions.map((d) => ({ text: d.text, seq: d.seq, msgId: d.msgId, at: d.at, kind: d.kind })),
    questions: questions.map((q) => ({ q: q.q, seq: q.seq, msgId: q.msgId, at: q.at, unresolved: q.unresolved, gate: q.gate })),
    codeBlockCount: 0,
    keyExchanges: [],
  };
  const ev = (msgId: string | undefined, seq: number, needle: string): CardEvidence => ({
    msgId: msgId ?? null, seq, quote: quoteOf(clean, seq, needle, max),
  });
  const decisionItems = decisions.map((d) => ({
    text: d.text,
    kind: (d.kind ?? 'decision') as 'decision' | 'negative',
    evidence: ev(d.msgId, d.seq, d.text),
  }));
  const unresolvedItems = questions.filter((q) => q.unresolved).map((q) => ({
    q: q.q,
    evidence: ev(q.msgId, q.seq, q.q),
  }));
  // 跨度：端点优先用 info（meta 模式下正文可能已归档，消息时间不一定覆盖全会话）
  const from = info.firstAt ? info.firstAt.slice(0, 10) : null;
  const to = (info.lastAt ?? info.firstAt) ? (info.lastAt ?? info.firstAt).slice(0, 10) : null;
  const a = from ? Date.parse(from) : NaN;
  const b = to ? Date.parse(to) : NaN;
  const days = Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, Math.round((b - a) / 86400_000)) : null;
  return {
    title: info.title ?? '（无标题）',
    decisions: decisionItems,
    unresolved: unresolvedItems,
    topics,
    files,
    span: { from, to, days },
    messageCount: info.messageCount,
    evidence: [...decisionItems.map((d) => d.evidence), ...unresolvedItems.map((u) => u.evidence)],
    summary: summaryRule(info.title, meta, { messageCount: info.messageCount, source: info.source, firstAt: info.firstAt, lastAt: info.lastAt }),
  };
}
