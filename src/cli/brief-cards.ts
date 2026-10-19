// brief-cards.ts —— 把**会话卡**接进 `srelay brief`（task-13）。
//
// ═══ 为什么单独一个文件 ═══
// 卡片的**内容**与**行格式**都已经有唯一实现，且必须继续只有一份：
//   · 内容：core/cards/session-card.ts 的 buildSessionCardFromStored（库里已抽取的条目，
//     归档会话正文已蒸发也照样出卡）；
//   · 行格式：core/cards/card-text.ts 的 renderCardLines（HANDOFF 导出用的是同一个渲染器）。
// 本文件只做**第三件事**：决定「给哪几场出卡」以及「放不放得下」。所以这里
//   —— 没有任何抽取判据、没有任何正则（判据在 extract.ts，一行都不复制）；
//   —— 没有另写一套卡片行格式（renderCardLines 输出什么就是什么）；
//   —— 体积比 1.2 也不在这里定义，直接 import relay/handoff-md.ts 的 CARD_BUDGET_RATIO
//      （导出侧与本命令的"预算"是同一个概念，各写一份迟早一个改了一个没改）。
//
// ═══ 体积硬预算（任务书）═══
// 整条人话简报的总字节数 ≤ **不加卡时**的 ×1.2。基线不是估的：调用方把现有那几行
// 原样传进来（briefHumanSections），所以"旧值"随时算得出。
// 放不下时逐场降级：整卡 → 单行 → 不展开；只要有降级就把话说出来（notice），
// **绝不静默截断**（stdout 连这一行都塞不下时改走 stderr —— 也不能闷着不说）。
import { getSessionFull, type DB } from '../store/db.js';
import { buildSessionCardFromStored, type SessionCard } from '../core/cards/session-card.js';
import { renderCardLines } from '../core/cards/card-text.js';
import { CARD_BUDGET_RATIO } from '../relay/handoff-md.js';

/**
 * 简报的体积预算比：与 HANDOFF 导出**同一个 1.2**（import 自 handoff-md，不另写一份）。
 * 导出给测试与调用方核对。
 */
export const BRIEF_BUDGET_RATIO = CARD_BUDGET_RATIO;

/**
 * 一条简报最多出几张卡。
 *
 * 为什么是 3：人话简报的决策行只有 5 条、未决行 1 条，被点名的会话本来就只有几场；
 * 卡片的体积是「每场 3~4 行」，再多就会把决策/未决本身挤掉——简报是 prompt 的一部分，
 * 卡片是**导航**不是正文。
 */
export const BRIEF_CARD_MAX = 3;

/** 一张卡的渲染参数：更窄的宽度是有意的——卡片要跟决策行挤在同一屏里 */
export const BRIEF_CARD_TEXT_OPTIONS = { maxDecisions: 2, maxUnresolved: 1, maxTitle: 32, maxItem: 36 } as const;

/** 卡段的小标题（只在真的有卡时出现；空段一行都不占） */
const SECTION_HEAD = (n: number): string => '  会话卡 ' + n + ' 张（每条结论都能按 msgId/seq 回跳）：';

/**
 * ANSI 颜色转义：预算按**可见字符**算，不按控制序列。
 * 为什么：picocolors 在非 TTY / NO_COLOR 下根本不输出它们，把 \u001b[2m 这类 4~5 字节
 * 计进"简报体积"会让同一份内容在不同终端里算出两个预算值 —— 那是没法复核的账。
 */
const ANSI = /\u001b\[[0-9;]*m/g;

/** 一段文字的**可见 UTF-8 字节数**（中文 3 字节，不含 ANSI 转义） */
export function visibleBytes(s: unknown): number {
  return Buffer.byteLength(String(s ?? '').replace(ANSI, ''), 'utf8');
}

/** 若干行文字的字节数；行尾换行各算 1 —— 与 join('\\n') 输出到终端的字节同口径 */
export function utf8Bytes(lines: string[]): number {
  let n = 0;
  for (const l of lines) n += visibleBytes(l) + 1;
  return n;
}

/** 一份可渲染的卡：会话 id + 卡片 + 放宽后的三行/四行文本 */
export interface BriefCardBlock {
  sessionId: string;
  card: SessionCard;
  /** renderCardLines 的原始输出（未缩进） */
  cardLines: string[];
  /** 缩进后的完整块（= 简报里真正要落的那几行） */
  lines: string[];
}

/**
 * 把一场会话做成卡（**唯一装配路径**：buildSessionCardFromStored + renderCardLines）。
 *
 * 为什么用 message_count 而不是 messages.length：归档会话正文已裁空，
 * 用 body 长度会把「183 条消息」显示成「0 条消息」——那是最招人恨的"看起来精确、其实错"。
 */
function cardBlockOf(db: DB, sessionId: string): BriefCardBlock | null {
  const full = getSessionFull(db, sessionId);
  if (!full) return null; // 会话行不在（被合并/清除）：没有卡可出，也不编一张
  const card = buildSessionCardFromStored(
    { decisions: full.decisions, questions: full.questions, topics: full.topics, files: full.files },
    {
      title: full.title,
      messageCount: Number.isFinite(full.messageCount) ? full.messageCount : 0,
      source: full.source,
      firstAt: full.createdAt,
      lastAt: full.lastEventAt,
    },
  );
  const cardLines = renderCardLines(card, BRIEF_CARD_TEXT_OPTIONS);
  return { sessionId, card, cardLines, lines: cardLines.map((l) => '  ' + l) };
}

/**
 * 单行降级（预算吃紧时用）：仍然是卡，只是不带逐条内容 —— 但**证据留着**，
 * 否则降级之后这张卡就再也回跳不到原文了（那等于把可溯源性悄悄丢掉）。
 */
export function compactCardLine(block: BriefCardBlock): string {
  const c = block.card;
  const span = c.span.from
    ? (c.span.to && c.span.to !== c.span.from ? c.span.from.slice(5, 10) + ' → ' + c.span.to.slice(5, 10) : c.span.from.slice(5, 10))
    : '';
  const head = [span, c.messageCount + ' 条消息'].filter(Boolean).join(' · ');
  const first = c.evidence[0];
  const ev = first ? (first.msgId ? 'msgId=' + first.msgId + ' seq=' + first.seq : 'seq=' + first.seq) : '';
  const counts = '决策 ' + c.decisions.length + ' / 未决 ' + c.unresolved.length;
  return '  ● ' + String(c.title).slice(0, 40) + '  ' + head + '（' + counts + (ev ? ' · ' + ev : '') + '）';
}

/**
 * 简报会点名哪些会话 → 出哪几张卡。
 *
 * 顺序 = 在简报里出现的顺序（决策行在前、未决行在后），去重后取前 BRIEF_CARD_MAX 场。
 * 只接受**调用方已经决定要显示**的那些会话 id —— 本函数不自己挑会话（挑选判据属于简报）。
 */
export function collectBriefCards(db: DB, sessionIds: string[]): BriefCardBlock[] {
  const seen = new Set<string>();
  const out: BriefCardBlock[] = [];
  for (const id of sessionIds) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    if (out.length >= BRIEF_CARD_MAX) break;
    const block = cardBlockOf(db, id);
    if (!block) continue; // 会话行不在（被合并/清除）—— 没有卡可出，也不编一张
    // 一条证据都没有的卡是纯噪音：标题上方那行决策/未决已经点过名，卡片存在的意义是
    // "展开 + 回跳"，两者都没有就不该占预算。（归档会话**有**库里结论 ⇒ 照常出卡。）
    if (block.card.evidence.length === 0) continue;
    out.push(block);
  }
  return out;
}

/** 组合结果：落地的整条简报 + 预算账本（账本要能让调用方/测试核对，而不是"我说没超就没超"） */
export interface BriefComposeResult {
  /** 最终要打印的整条简报（含卡段与可能的说明行） */
  lines: string[];
  /** 基线字节数（不加卡时的整条人话简报） */
  baseBytes: number;
  /** 预算 = ceil(baseBytes × BRIEF_BUDGET_RATIO) */
  budgetBytes: number;
  /** 实际字节数（≤ budgetBytes；正常情况恒成立，测试钉住） */
  usedBytes: number;
  /** 完整展开的卡数 */
  fullCards: number;
  /** 降级成单行的卡数 */
  compactCards: number;
  /** 完全没展开的场数（预算实在不够） */
  omittedCards: number;
  /** 需要额外说的一句话（降级/省略时**必有**；正常时为 null） */
  notice: string | null;
  /** 这句话落在哪里：'stdout' = 已追加进 lines；'stderr' = 连一行都塞不进预算 */
  noticeTo: 'stdout' | 'stderr' | null;
}

/**
 * 拼出最终输出：**先算基线，再在 1.2 倍预算里塞卡**。
 *
 * @param head 卡片段**之前**的行（审计告警 / 计数 / 最近在动 / 决策 / 未决）
 * @param blocks collectBriefCards 的结果
 * @param tail 卡片段**之后**的行（相关会话组 / 经验）—— 卡段插在两者之间，
 *             而不是粗暴追加到末尾：卡片是决策/未决的"展开"，离它们越近越有用
 */
export function composeBriefWithCards(head: string[], blocks: BriefCardBlock[], tail: string[] = []): BriefComposeResult {
  const baseBytes = utf8Bytes(head) + utf8Bytes(tail);
  const budgetBytes = Math.ceil(baseBytes * BRIEF_BUDGET_RATIO);
  const lines = [...head];
  // used = 已落地的行（不含 tail）的字节数；tail 是基线的一部分，任何时刻都要给它留位
  let used = utf8Bytes(head);
  const tailCost = utf8Bytes(tail);
  const fits = (extra: number): boolean => used + extra + tailCost <= budgetBytes;

  let fullCards = 0;
  let compactCards = 0;
  let omittedCards = 0;
  let notice: string | null = null;
  let noticeTo: BriefComposeResult['noticeTo'] = null;
  let headPushed = false;

  for (const b of blocks) {
    // 第一张卡前加小标题（只加一次；没有卡就不占行）
    const headBlock = headPushed ? [] : [SECTION_HEAD(blocks.length)];
    const fullCost = utf8Bytes([...headBlock, ...b.lines]);
    if (fits(fullCost)) {
      lines.push(...headBlock, ...b.lines);
      used += fullCost;
      headPushed = true;
      fullCards++;
      continue;
    }
    // 降级①：单行卡（仍带证据 msgId/seq —— 降级不等于丢掉可溯源性）
    const compact = compactCardLine(b);
    const compactCost = utf8Bytes([...headBlock, compact]);
    if (fits(compactCost)) {
      lines.push(...headBlock, compact);
      used += compactCost;
      headPushed = true;
      compactCards++;
      continue;
    }
    // 降级②：放不下就不展开（记数，最后统一说出来）
    omittedCards++;
  }

  lines.push(...tail);
  used += tailCost;

  if (compactCards > 0 || omittedCards > 0) {
    // ⚠️ 降级必须**说出来**："看起来完整、其实被砍"是本项目最嫌恶的失效。
    notice = '（简报预算已用满：' + compactCards + ' 张卡降级为单行'
      + (omittedCards > 0 ? '，另有 ' + omittedCards + ' 场未展开（srelay show <id> 看全文）' : '')
      + '；决策/未决/经验一条未删）';
    const noticeCost = utf8Bytes([notice]);
    if (used + noticeCost <= budgetBytes) { lines.push(notice); used += noticeCost; noticeTo = 'stdout'; }
    else { noticeTo = 'stderr'; } // 连一行说明都塞不进预算 —— 也不能闷着不说
  }

  return { lines, baseBytes, budgetBytes, usedBytes: used, fullCards, compactCards, omittedCards, notice, noticeTo };
}
