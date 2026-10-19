// session-card.ts —— 会话卡：把一个会话压成一张**结构化**卡片（零模型、纯规则）。
//
// 为什么需要它：简报里现在每条会话只有标题，agent 看到标题也不知道"这场到底干了什么、定了什么、还欠什么"。
// 会话卡把已有的四类提取结果（决策/未决/话题/文件）组装成一张卡，每条都带原文出处。
//
// 纪律（与全仓同源）：
//   · 判据只许一份 —— 这里全部 import 自 core/extract/extract.ts，绝不复制正则；
//   · 零模型 —— 不调任何模型，纯字符串与打分；
//   · 可溯源 —— 每条决策/未决带 msgId + seq + 原句片段；
//   · 确定性 —— 同输入必得同输出（无随机、无时间依赖）。
import {
  extractDecisions, extractQuestions, extractFiles, extractTopics, summaryRule,
  type Msg, type ExtractedMeta,
} from '../extract/extract.js';

export interface CardEvidence {
  /** 稳定主键（优先）；老数据可能只有 seq */
  msgId?: string;
  seq: number;
  /** 原句片段（≤120 字），用于"点回去看原话" */
  quote: string;
}

export interface SessionCard {
  title: string;
  /** 决策（含 negative = 被否掉的路） */
  decisions: Array<{ text: string; kind: 'decision' | 'negative'; evidence: CardEvidence }>;
  /** 未解决的问题 */
  unresolved: Array<{ q: string; evidence: CardEvidence }>;
  topics: string[];
  files: string[];
  /** 时间跨度（只有日期；没有就 null） */
  span: { from: string | null; to: string | null };
  messageCount: number;
  /** 一句话规则摘要（复用 summaryRule，保证与简报同源） */
  summary: string;
}

const QUOTE_MAX = 120;

const clip = (s: string, n = QUOTE_MAX): string => {
  const one = String(s ?? '').replace(/\s+/g, ' ').trim();
  return one.length <= n ? one : one.slice(0, n) + '…';
};

/** 从消息里取"含该片段的原句"作为证据（找不到就退回整条消息开头） */
function quoteOf(msgs: Msg[], seq: number, needle: string): string {
  const hit = msgs.find((m) => m.seqNum === seq);
  if (!hit) return clip(needle);
  const text = hit.content;
  const at = text.indexOf(needle.slice(0, 20));
  if (at < 0) return clip(text);
  const start = Math.max(0, at - 30);
  return clip(text.slice(start, start + QUOTE_MAX));
}

export interface CardInfo {
  title: string | null;
  messageCount: number;
  source: string;
  firstAt: string;
  lastAt: string | null;
}

/**
 * 生成会话卡。msgs 应为**已清洗**的消息（调用方已剥注入/归档）；
 * 本函数不做 I/O、不读库，纯计算。
 */
export function buildSessionCard(msgs: Msg[], info: CardInfo): SessionCard {
  const decisions = extractDecisions(msgs);
  const questions = extractQuestions(msgs);
  const files = extractFiles(msgs.map((m) => m.content));
  const topics = extractTopics(msgs);
  // 复用 summaryRule 需要 ExtractedMeta 形状；只填它用到的四类
  const meta: ExtractedMeta = {
    files, topics,
    decisions: decisions.map((d) => ({ text: d.text, seq: d.seq, msgId: d.msgId, at: d.at, kind: d.kind })),
    questions: questions.map((q) => ({ q: q.q, seq: q.seq, msgId: q.msgId, at: q.at, unresolved: q.unresolved, gate: q.gate })),
    codeBlockCount: 0,
    keyExchanges: [],
  };
  return {
    title: info.title ?? '（无标题）',
    decisions: decisions.map((d) => ({
      text: d.text,
      kind: d.kind ?? 'decision',
      evidence: { ...(d.msgId ? { msgId: d.msgId } : {}), seq: d.seq, quote: quoteOf(msgs, d.seq, d.text) },
    })),
    unresolved: questions.filter((q) => q.unresolved).map((q) => ({
      q: q.q,
      evidence: { ...(q.msgId ? { msgId: q.msgId } : {}), seq: q.seq, quote: quoteOf(msgs, q.seq, q.q) },
    })),
    topics,
    files,
    span: { from: info.firstAt ? info.firstAt.slice(0, 10) : null, to: info.lastAt ? info.lastAt.slice(0, 10) : null },
    messageCount: info.messageCount,
    summary: summaryRule(info.title, meta, { messageCount: info.messageCount, source: info.source, firstAt: info.firstAt, lastAt: info.lastAt }),
  };
}
