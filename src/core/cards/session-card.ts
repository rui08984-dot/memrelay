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

/** 卡片装配的中间形状：两条入口（正文抽取 / 库里已抽取）都先归一到这里 */
interface CardParts {
  decisions: Array<{ text: string; kind: 'decision' | 'negative'; seq: number; msgId?: string | number }>;
  unresolved: Array<{ q: string; seq: number; msgId?: string | number }>;
  topics: string[];
  files: string[];
  summary: string;
}

/**
 * **装配的唯一实现**：evidence 平铺顺序（先决策后未决）、引文上限、时间跨度、消息条数
 * 四件事只在这里写一次。两条入口（`buildSessionCard` / `buildSessionCardFromStored`）
 * 只负责"从哪里拿 decisions/questions"，拿完都汇到这里 —— 否则两个入口迟早各拼一套，
 * 同一个会话在导出与简报里的 evidence 顺序就会不一致（本仓头号故障的典型形态）。
 *
 * @param quoteMsgs 引文来源消息；来自库里的条目（正文可能已归档）传空数组，
 *                  此时 quoteOf 退回抽取文本本身 —— 宁可短，不可编造。
 */
function assembleCard(parts: CardParts, info: CardInfo, max: number, quoteMsgs: Msg[]): SessionCard {
  const ev = (msgId: string | number | undefined, seq: number, needle: string): CardEvidence => ({
    msgId: msgId === undefined || msgId === null ? null : String(msgId),
    seq,
    quote: quoteOf(quoteMsgs, seq, needle, max),
  });
  const decisionItems = parts.decisions.map((d) => ({
    text: d.text,
    kind: d.kind,
    evidence: ev(d.msgId, d.seq, d.text),
  }));
  const unresolvedItems = parts.unresolved.map((q) => ({
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
    topics: parts.topics,
    files: parts.files,
    span: { from, to, days },
    messageCount: info.messageCount,
    evidence: [...decisionItems.map((d) => d.evidence), ...unresolvedItems.map((u) => u.evidence)],
    summary: parts.summary,
  };
}

/**
 * 生成会话卡（**从正文抽取**）。
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
  return assembleCard({
    decisions: decisions.map((d) => ({
      text: d.text, seq: d.seq, msgId: d.msgId, kind: (d.kind ?? 'decision') as 'decision' | 'negative',
    })),
    unresolved: questions.filter((q) => q.unresolved).map((q) => ({ q: q.q, seq: q.seq, msgId: q.msgId })),
    topics, files,
    summary: summaryRule(info.title, meta, { messageCount: info.messageCount, source: info.source, firstAt: info.firstAt, lastAt: info.lastAt }),
  }, info, max, clean);
}

/** 库里已抽取的一条决策（`sessions.decisions` / hop 包 `decisions` 的形状） */
export interface StoredDecision {
  text: string;
  seq?: number;
  at?: string;
  /** 稳定主键。库里可能是 INTEGER（messages.id）——装配时统一归一成字符串（与读端同规） */
  msgId?: string | number;
  kind?: 'decision' | 'negative';
  pinned?: boolean;
}

/** 库里已抽取的一条问题（`sessions.key_questions` / hop 包 `questions` 的形状） */
export interface StoredQuestion {
  q: string;
  seq?: number;
  at?: string;
  msgId?: string | number;
  unresolved?: boolean;
}

export interface StoredCardInput {
  decisions?: StoredDecision[];
  questions?: StoredQuestion[];
  /** 会话行上的派生列（topics / files_mentioned）；不给就是空 */
  topics?: string[];
  files?: string[];
}

/** seq 归一：库里可能是字符串/缺失 —— 缺失按 0（"位置未知"），不编造一个真实序号 */
function seqOf(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return 0;
}

/**
 * 生成会话卡（**从库里已抽取的条目**）。
 *
 * 为什么需要这条入口（而不是让调用方自己拼 Msg[] 再抽一遍）：
 *   · 简报/导出里的会话，决策与未决**已经在库里**（sessions.decisions / key_questions），
 *     且带着抽取期写入的 msgId —— 那才是读端唯一能稳定回跳的锚点；
 *   · 归档会话正文已蒸发（messages 为空），从正文抽取会得到一张空卡，
 *     而库里的结论仍在 —— 卡片必须能只靠库里的条目成立；
 *   · 同一场会话在"简报"与"检索结果"里必须说同一件事：两条入口共用 assembleCard，
 *     evidence 顺序与引文上限不可能分叉。
 *
 * ⚠️ 这里**不再跑** extractDecisions / ambiguous 判据：库里条目已经过抽取守卫与
 * recompute（判据只在 extract.ts 一处）。此处只做形状归一 + 展示裁剪。
 */
export function buildSessionCardFromStored(stored: StoredCardInput, info: CardInfo, opts: CardOptions = {}): SessionCard {
  const max = Math.max(1, Math.floor(opts.maxQuote ?? QUOTE_MAX));
  const decisions = (Array.isArray(stored.decisions) ? stored.decisions : [])
    .filter((d) => String(d?.text ?? '').trim() !== '')
    .map((d) => ({
      text: String(d.text).trim(),
      kind: (d.kind === 'negative' ? 'negative' : 'decision') as 'decision' | 'negative',
      seq: seqOf(d.seq),
      msgId: d.msgId,
    }));
  const unresolved = (Array.isArray(stored.questions) ? stored.questions : [])
    .filter((q) => q?.unresolved === true && String(q.q ?? '').trim() !== '')
    .map((q) => ({ q: String(q.q).trim(), seq: seqOf(q.seq), msgId: q.msgId }));
  const topics = Array.isArray(stored.topics) ? stored.topics.map(String) : [];
  const files = Array.isArray(stored.files) ? stored.files.map(String) : [];
  // 摘要仍由 summaryRule 生成（与库里 summary_rule 列同源），不另写一套拼接
  const meta: ExtractedMeta = {
    files, topics,
    decisions: decisions.map((d) => ({ text: d.text, seq: d.seq, msgId: d.msgId === undefined ? undefined : String(d.msgId), kind: d.kind })),
    questions: unresolved.map((q) => ({ q: q.q, seq: q.seq, msgId: q.msgId === undefined ? undefined : String(q.msgId), unresolved: true })),
    codeBlockCount: 0,
    keyExchanges: [],
  };
  return assembleCard({
    decisions, unresolved, topics, files,
    summary: summaryRule(info.title, meta, { messageCount: info.messageCount, source: info.source, firstAt: info.firstAt, lastAt: info.lastAt }),
  }, info, max, []);
}
