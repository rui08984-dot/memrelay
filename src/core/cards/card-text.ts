// card-text.ts —— 会话卡的**紧凑文本**渲染（给 agent 读的简报部分）。
//
// 分工（刻意划死）：
//   · session-card.ts 决定"卡片里有什么"（判据、出处、来源）；
//   · 本文件只决定"显示成几行、每行多长"——不改一条内容的取舍。
// 为什么单列：导出（HANDOFF.md）与简报（srelay brief）必须说同一件事。
// 渲染一旦各写一份，同一个会话在两个面里会长得不一样（本仓反复吃过的亏）。
import type { CardEvidence, SessionCard } from './session-card.js';

export interface CardTextOptions {
  /** 决策行最多列几条（默认 3；剩余以 … 表示） */
  maxDecisions?: number;
  /** 未决行最多列几条（默认 2；剩余以 … 表示） */
  maxUnresolved?: number;
  /** 标题截断长度（默认 48） */
  maxTitle?: number;
  /** 单条决策/未决展示长度（默认 40） */
  maxItem?: number;
  /** 是否带「证据」行（默认 true；测试收窄时关掉） */
  evidence?: boolean;
}

const positive = (v: number | undefined, fallback: number): number =>
  (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : fallback);

/** 单行压缩：折叠空白 + 截断（截断时末尾一个 …，计入上限） */
export function clipLine(s: unknown, n: number): string {
  const one = String(s ?? '').replace(/\s+/g, ' ').trim();
  const lim = Math.max(1, Math.floor(n));
  if (one.length <= lim) return one;
  return one.slice(0, lim - 1).replace(/[\s，,、；;：:]+$/u, '') + '…';
}

/** ISO → MM-DD；解析不了就原样给前 10 位（不编日期） */
const md = (iso: string | null): string => (iso ? iso.slice(5, 10) : '');

/** 证据行的文本：优先稳定主键；没有 msgId 就只报 seq（不伪造一个主键） */
export function evidenceText(ev: CardEvidence): string {
  return ev.msgId ? `msgId=${ev.msgId} seq=${ev.seq}` : `seq=${ev.seq}`;
}

/**
 * 渲染一张卡（行数组，不带前后空行）。格式与任务书一致：
 *
 * ```
 * ● 交接文档（唯一入口）  10-07 → 10-18 · 183 条消息
 *   决策：改为一行一条 / 决定计划 / …
 *   未决：无
 *   证据：msgId=473821 seq=3324
 * ```
 *
 * 行数是**有上界**的（标题 1 + 决策 1 + 未决 1 + 证据 1），因此简报的体积
 * 只随会话数线性增长，不会因为某场会话决策很多而爆掉。
 */
export function renderCardLines(card: SessionCard, opts: CardTextOptions = {}): string[] {
  const maxD = positive(opts.maxDecisions, 3);
  const maxU = positive(opts.maxUnresolved, 2);
  const maxTitle = Math.max(4, positive(opts.maxTitle, 48));
  const maxItem = Math.max(4, positive(opts.maxItem, 40));
  const lines: string[] = [];

  const span = card.span.from
    ? (card.span.to && card.span.to !== card.span.from ? `${md(card.span.from)} → ${md(card.span.to)}` : md(card.span.from))
    : '';
  const head = [span, `${card.messageCount} 条消息`].filter(Boolean).join(' · ');
  lines.push('● ' + clipLine(card.title, maxTitle) + '  ' + head);

  const decs = card.decisions.slice(0, maxD).map((d) => clipLine(d.text, maxItem));
  if (card.decisions.length > maxD) decs.push('…');
  lines.push('  决策：' + (decs.length > 0 ? decs.join(' / ') : '无'));

  const unr = card.unresolved.slice(0, maxU).map((u) => clipLine(u.q, maxItem));
  if (card.unresolved.length > maxU) unr.push('…');
  lines.push('  未决：' + (unr.length > 0 ? unr.join(' / ') : '无'));

  if (opts.evidence !== false) {
    const first = card.evidence[0];
    if (first !== undefined) {
      const more = card.evidence.length > 1 ? `（+${card.evidence.length - 1} 条出处）` : '';
      lines.push('  证据：' + evidenceText(first) + more);
    }
  }
  return lines;
}
