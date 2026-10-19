// HANDOFF.md / timeline.md 生成（方针 §10.6：由 summary_rule 免费组装，零 LLM；页脚署名 T19）
//
// [1021 会话卡接简报] 「📖 会话摘要」段不再逐条打印「标题 + summary_rule 前四行」，
// 改为每条会话一张**会话卡**（session-card.ts，零模型、带出处 msgId/seq）。
// 为什么：旧摘要把决策塞成一整行编号列表，agent 读到的是一段散文；卡片把
// 「定了什么 / 还欠什么 / 去哪回跳」拆成稳定的三行，且**每条都带稳定主键**。
//
// 三条纪律：
//   ① 判据不在这里 —— 卡片内容全部来自 buildSessionCardFromStored（复用库里的抽取结果，
//      不再从正文抽第二遍：归档会话正文已蒸发，抽取会得到空卡）；
//   ② 体积有硬预算 —— 本段总字符数 ≤ 旧版渲染 × 1.2（见 CARD_BUDGET_RATIO）；
//      卡片行数本身有上界，超预算时降级为单行（不是静默截断：单行仍给决策/未决条数）；
//   ③ 多会话组只列一次 —— 组内非代表会话不再各占一张卡，统一挂在代表卡的「↳ 同组」行
//      （分组判据来自 search-svc/session-groups.ts 的 groupSessions，本文件不另写）。
import { buildSessionCardFromStored, type SessionCard } from '../core/cards/session-card.js';
import { renderCardLines } from '../core/cards/card-text.js';
import type { HopSessionFile } from './hop.js';

export interface HandoffDecision { at: string; source: string; sessionId: string; title: string | null; text: string; seq: number }

/**
 * 多会话组（由调用方用 groupSessions 算好传进来）。
 * 形状与 search-svc/session-groups.ts 的 SessionGroup 对齐，但少一个 score ——
 * 导出侧不关心排序分数，只要"谁代表、还有谁"。
 */
export interface HandoffSessionGroup {
  lead: string;
  sessionIds: string[];
  sharedTopics: string[];
  sharedFiles: string[];
}

const d = (iso: string) => iso.slice(5, 10);

/** 体积预算：卡片段总字符数不得超过旧版渲染的 120%（任务书硬约束） */
export const CARD_BUDGET_RATIO = 1.2;

/** 字符计数口径：每行 + 1（换行）。与最终 join('\n') 的长度同口径（末尾换行不计） */
const charsOf = (lines: string[]): number => lines.reduce((a, l) => a + l.length + 1, 0);

/**
 * 旧版逐会话块（**只用于预算基线**，不参与输出）。
 * 保留它的意义：+20% 这句话必须能被算出旧值，否则"不超预算"就是自我声明。
 * 与 1015 版逐字一致：`### 标题（MM-DD，source）` + summary_rule 前四行。
 */
function legacySessionBlock(s: HopSessionFile): string[] {
  return [
    `### ${s.title ?? s.id}（${d(s.created_at)}，${s.source}）`,
    s.summary_rule ? s.summary_rule.split('\n').slice(0, 4).join('  \n') : `_${s.messages.length} 条消息（无规则摘要）_`,
    '',
  ];
}

/** 旧版「会话摘要」段的字符数（预算基线；导出给测试与调用方核对） */
export function legacySessionSummaryChars(sessions: HopSessionFile[]): number {
  return sessions.reduce((a, s) => a + charsOf(legacySessionBlock(s)), 0);
}

/** 会话 → 卡片。条数优先用 message_count（归档会话 messages 为空，不能用它的长度） */
function cardOf(s: HopSessionFile): SessionCard {
  return buildSessionCardFromStored(
    { decisions: s.decisions, questions: s.questions, topics: s.topics, files: s.files },
    {
      title: s.title,
      messageCount: typeof s.message_count === 'number' && Number.isFinite(s.message_count) ? s.message_count : s.messages.length,
      source: s.source,
      firstAt: s.created_at,
      lastAt: s.last_event_at,
    },
  );
}

/** 单行降级（预算吃紧时用）：仍然是卡，只是不带逐条内容 */
function compactCardLine(s: HopSessionFile): string {
  const card = cardOf(s);
  const span = card.span.from ? `${d(card.span.from)} → ${d(card.span.to ?? card.span.from)}` : '';
  const head = [span, `${card.messageCount} 条消息`].filter(Boolean).join(' · ');
  return '● ' + card.title + '  ' + head + `（决策 ${card.decisions.length} / 未决 ${card.unresolved.length}）`;
}

/** 组内其余会话（代表卡下面那一行） */
function groupLine(g: HandoffSessionGroup, byId: Map<string, HopSessionFile>): string {
  const others = g.sessionIds
    .filter((id) => id !== g.lead)
    .map((id) => {
      const s = byId.get(id);
      return s ? `${s.title ?? id}（${d(s.created_at)}，${s.source}）` : id;
    });
  if (others.length === 0) return '';
  const sig = [...g.sharedTopics.slice(0, 2), ...g.sharedFiles.slice(0, 1)].join('、');
  return '  ↳ 同组（共 ' + String(g.sessionIds.length) + ' 场）：' + others.join(' / ') + (sig ? ' · 共享 ' + sig : '');
}

/**
 * 渲染「会话摘要」段（行数组，不含标题行）。
 *
 * 预算：`ceil(旧版字符数 × 1.2)`。卡片通常比旧版短（旧版一条决策行就能到 300+ 字），
 * 超预算时逐条降级为单行；连单行都放不下才省略，并在末尾明说还剩几场 ——
 * 宁可少展开，也不许"看起来完整、其实被砍"。
 */
export function renderSessionSummary(sessions: HopSessionFile[], groups: HandoffSessionGroup[] = []): string[] {
  const budget = Math.ceil(legacySessionSummaryChars(sessions) * CARD_BUDGET_RATIO);
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const leadOf = new Map<string, HandoffSessionGroup>();
  const inGroup = new Set<string>();
  for (const g of groups) {
    if (!g || !Array.isArray(g.sessionIds) || g.sessionIds.length < 2) continue;
    const lead = g.lead && g.sessionIds.includes(g.lead) ? g.lead : g.sessionIds[0];
    leadOf.set(lead, { ...g, lead });
    for (const id of g.sessionIds) inGroup.add(id);
  }

  const out: string[] = [];
  let used = 0;
  let omitted = 0;
  for (const s of sessions) {
    const g = leadOf.get(s.id);
    // 组内非代表会话：已在代表卡的「↳ 同组」行里点名，不再单独占一张卡
    if (inGroup.has(s.id) && g === undefined) continue;
    const block = renderCardLines(cardOf(s));
    if (g !== undefined) {
      const extra = groupLine(g, byId);
      if (extra) block.push(extra);
    }
    let text = block.join('\n') + '\n';
    if (used + text.length > budget) {
      const compact = compactCardLine(s) + '\n';
      if (used + compact.length > budget) { omitted++; continue; }
      text = compact;
    }
    out.push(...text.replace(/\n$/, '').split('\n'));
    used += text.length;
  }
  if (omitted > 0) out.push(`（简报预算已满，另有 ${omitted} 场会话未展开：srelay list 查看）`);
  return out;
}

export function buildHandoff(projectName: string, sessions: HopSessionFile[], decisions: HandoffDecision[], footer: string, opts?: { summaryOnly?: boolean; groups?: HandoffSessionGroup[] }): string {
  const lines: string[] = [];
  lines.push(`# 项目交接文档 · ${projectName}`);
  lines.push(`> 自动生成于 ${new Date().toISOString().slice(0, 10)} · ${sessions.length} 个会话 · 来源 ${[...new Set(sessions.map((s) => s.source))].join(', ')}`);
  lines.push('');

  lines.push('## 📋 关键决策');
  if (decisions.length === 0) lines.push('_（无已确认决策）_');
  else {
    lines.push('| 日期 | 决策 | 来源 |');
    lines.push('|------|------|------|');
    for (const dec of decisions.slice(0, 30)) {
      lines.push(`| ${d(dec.at)} | ${dec.text.replace(/\|/g, '/').slice(0, 80)} | ${dec.source} |`);
    }
  }
  lines.push('');

  lines.push('## 📁 涉及文件');
  const fileCount = new Map<string, number>();
  for (const s of sessions) for (const f of s.files) fileCount.set(f, (fileCount.get(f) ?? 0) + 1);
  const topFiles = [...fileCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
  if (topFiles.length === 0) lines.push('_（无）_');
  for (const [f, n] of topFiles) lines.push(`- \`${f}\`（讨论 ${n} 次）`);
  lines.push('');

  lines.push('## ❓ 未解决的问题');
  const unresolved = sessions.flatMap((s) => s.questions.filter((q) => q.unresolved).map((q) => ({ ...q, s })));
  if (unresolved.length === 0) lines.push('_（无）_');
  for (const q of unresolved.slice(0, 15)) lines.push(`- [ ] ${q.q}（${d(q.at ?? q.s.created_at)}，${q.s.source}）`);
  lines.push('');

  if (!opts?.summaryOnly) {
    lines.push('## 📖 会话摘要');
    lines.push(...renderSessionSummary(sessions, opts?.groups ?? []));
    lines.push('');
  }

  lines.push('---');
  lines.push(`> ${footer}`);
  return lines.join('\n') + '\n';
}

export function buildTimeline(sessions: HopSessionFile[]): string {
  const lines = ['# 时间线', ''];
  for (const s of sessions) {
    lines.push(`- ${s.created_at.slice(0, 16).replace('T', ' ')} [${s.source}] ${s.title ?? s.id}（${s.messages.length || s.state === 'confirmed' ? 'confirmed' : 'active'}）`);
  }
  return lines.join('\n') + '\n';
}
