// scripts/archived-unresolved-report.ts —— P0 清理分析：**归档会话的未决**（只读）。
//
// 要回答的问题（task P1-2）：audit 报的那 32 条"落在已归档会话上的未决"到底是什么、
//   属于哪些会话、能不能补、该怎么处理？
//
// 纪律：
//   ① 判据只许一份：归档口径与未决口径全部走 core/audit/audit.ts 的 scanArchivedUnresolved
//      （它内部复用 listUnresolved）。脚本**不写**任何 SQL 判据。
//   ② 只读：openReadonly 打开（fileMustExist + busy_timeout）。本脚本没有 --apply，
//      永远不写库；唯一的输出是 research/ 下的报告文件。
//   ③ 不删：报告只给"标记 lost / 从简报隐藏 / 迁移到全局经验库"三条路与逐条建议，
//      删除不在选项里 —— 归档会话的正文已经没了，再删条目就什么都不剩。
//   ④ 不许静默失败：库打不开 → 退出码 2；单个项目扫描失败 → 报告里列出错误，
//      不当成"0 条"（0 条与没测到是两件事）。
//
// 用法：
//   npx tsx scripts/archived-unresolved-report.ts [<db>] [--out research/p0-archived-unresolved.md] [--json]
//   库默认 <cwd>/.sessionrelay/relay.sqlite。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { openReadonly, type DB } from '../src/store/db.js';
import { scanArchivedUnresolved, type ArchivedUnresolvedDetail } from '../src/core/audit/audit.js';

/** 逐条建议动作。**没有 delete** —— 三条路都保留条目。 */
export type P0Action = 'mark-lost' | 'hide-from-brief';

export interface P0Item extends ArchivedUnresolvedDetail {
  /** 该会话在 messages 表里还剩几条正文（归档后应为 0；>0 说明"归档"只是标记，正文还在） */
  messagesInDb: number;
  action: P0Action;
  reason: string;
}

export interface P0Project {
  projectId: string;
  archivedSessions: number;
  items: P0Item[];
  /** 本项目扫描失败的原因（null = 正常） */
  error: string | null;
}

export interface P0Report {
  dbPath: string;
  generatedAt: string;
  projects: P0Project[];
  total: number;
  archivedSessions: number;
  /** 扫描失败的项目数（>0 时报告里的"共 N 条"是不完整的，必须显式说明） */
  failedProjects: number;
}

/**
 * 逐条建议（**结构化规则，不做文本语义判断**）：
 *   · 有 msgId ⇒ mark-lost：它曾有稳定锚点，而正文已归档 ⇒ 回跳永久指空；
 *     留着不标，简报/检索会一直把它当"待办欠条"。
 *   · 没有 msgId ⇒ hide-from-brief：连锚点都没有，无法证明原文存在过；
 *     先从简报隐藏，条目保留，等人工核对后再决定。
 * 两条都**不删**：归档会话的正文已经没了，条目是最后的记录。
 */
export function suggestAction(it: ArchivedUnresolvedDetail): { action: P0Action; reason: string } {
  const hasMsgId = it.msgId !== undefined && it.msgId !== null && String(it.msgId).trim() !== '';
  return hasMsgId
    ? {
      action: 'mark-lost',
      reason: '曾有 msgId 锚点，但所在会话正文已归档 ⇒ 回跳永久指空；保留条目并标 lost，不再当未决欠条',
    }
    : {
      action: 'hide-from-brief',
      reason: '没有 msgId 锚点，无法证明原文存在过；先从简报隐藏，条目保留待人工核对',
    };
}

/** 只读分析：逐项目扫描归档未决。不写一个字节。 */
export function analyzeArchivedUnresolved(db: DB, opts: { dbPath?: string; now?: number } = {}): P0Report {
  const projectIds = (db.prepare('SELECT DISTINCT project_id AS p FROM sessions ORDER BY 1').all() as Array<{ p: string }>)
    .map((r) => r.p);
  const projects: P0Project[] = [];
  let total = 0;
  let archivedSessions = 0;
  let failedProjects = 0;

  for (const projectId of projectIds) {
    try {
      const scan = scanArchivedUnresolved(db, projectId);
      // 正文剩余条数：归档后应为 0。>0 是重要信号（说明"归档"只是打了标记，正文还能回跳）
      const countMsgs = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?');
      const items = scan.items.map((it) => ({
        ...it,
        messagesInDb: Number((countMsgs.get(it.sessionId) as { n?: number } | undefined)?.n ?? 0),
        ...suggestAction(it),
      }));
      projects.push({ projectId, archivedSessions: scan.archivedSessions, items, error: null });
      total += items.length;
      archivedSessions += scan.archivedSessions;
    } catch (e) {
      failedProjects++;
      projects.push({ projectId, archivedSessions: 0, items: [], error: e instanceof Error ? e.message : String(e) });
    }
  }

  return {
    dbPath: opts.dbPath ?? '',
    generatedAt: new Date(opts.now ?? Date.now()).toISOString(),
    projects,
    total,
    archivedSessions,
    failedProjects,
  };
}

const oneLine = (s: unknown, n = 300): string => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim().replace(/\|/g, '/');
  return t.length <= n ? t : t.slice(0, n - 1) + '…';
};
const day = (iso: string | null | undefined): string => (iso ? String(iso).slice(0, 10) : '—');

/** 报告（markdown）。所有数字都来自 analyzeArchivedUnresolved，格式化阶段不再判一次。 */
export function formatReport(rep: P0Report): string {
  const L: string[] = [];
  L.push('# P0 清理分析：归档会话的未决');
  L.push('');
  L.push('> **只读分析**（`openReadonly`，未写库）· 生成于 ' + rep.generatedAt);
  if (rep.dbPath) L.push('> 库：`' + rep.dbPath + '`');
  L.push('');
  L.push('## 结论');
  L.push('');
  if (rep.projects.length === 0) {
    L.push('库里没有任何项目（`sessions` 为空）——没有可分析的归档会话。');
  } else if (rep.total === 0) {
    L.push('**0 条**未决落在已归档会话上（已归档会话共 ' + rep.archivedSessions + ' 场）。');
    L.push('');
    L.push('> 注意：这是"真的没有"，不是"没测到"——' + (rep.failedProjects === 0
      ? '所有项目都扫描成功。'
      : '但有 ' + rep.failedProjects + ' 个项目扫描失败（见下表），结论不完整。'));
  } else {
    L.push('共 **' + rep.total + ' 条**未决落在 **' + rep.archivedSessions + ' 场**已归档会话上'
      + '（涉及 ' + rep.projects.filter((p) => p.items.length > 0).length + ' 个项目）。');
    L.push('');
    L.push('这些未决的出处（msgId / seq）**永久指空**：归档会话的正文已蒸发，`srelay show` 只会报"原文已归档"。');
    if (rep.failedProjects > 0) L.push('');
    if (rep.failedProjects > 0) L.push('> ⚠ 有 ' + rep.failedProjects + ' 个项目扫描失败（原因见下表），上面的总数**不完整**。');
  }
  L.push('');
  L.push('## 为什么这是 P0（而不是"可修的质量债"）');
  L.push('');
  L.push('未决是"欠条"：它存在的意义是**以后能回到原文把话补全**。归档会话的正文已经删了，');
  L.push('这条欠条永远兑现不了；而它还会继续占着简报/检索的未决名额，让"真正还能解决的未决"被挤掉。');
  L.push('所以处理方向不是"补证据"（补不了），而是**让它停止冒充可兑现的欠条**。');
  L.push('');
  L.push('## 全貌');
  L.push('');
  L.push('| 项目 | 已归档会话 | 归档未决条数 | 扫描 |');
  L.push('|------|-----------:|-------------:|------|');
  for (const p of rep.projects) {
    L.push('| `' + p.projectId + '` | ' + p.archivedSessions + ' | ' + p.items.length + ' | ' + (p.error ? '❌ ' + oneLine(p.error, 80) : '✓') + ' |');
  }
  L.push('| **合计** | **' + rep.archivedSessions + '** | **' + rep.total + '** | ' + (rep.failedProjects > 0 ? rep.failedProjects + ' 个项目失败' : '全部成功') + ' |');
  L.push('');

  let idx = 0;
  for (const p of rep.projects) {
    if (p.items.length === 0) continue;
    L.push('## 项目 `' + p.projectId + '`');
    L.push('');
    // 按会话分组：同一场会话的未决放在一起，便于一次决策（整场标 lost 还是逐条看）
    const bySession = new Map<string, P0Item[]>();
    for (const it of p.items) {
      const arr = bySession.get(it.sessionId) ?? [];
      arr.push(it);
      bySession.set(it.sessionId, arr);
    }
    for (const [sessionId, items] of bySession) {
      idx++;
      const s = items[0];
      L.push('### ' + idx + '. ' + oneLine(s.title ?? '（无标题）', 80));
      L.push('');
      L.push('- 会话：`' + sessionId + '`（' + s.source + '）');
      L.push('- 时间：创建 ' + day(s.sessionCreatedAt) + ' · 最后活动 ' + day(s.lastEventAt) + ' · 归档于 ' + day(s.archivedAt));
      // 归档会把 message_count 清零（正文已删，原条数不可知）—— 别把它当成"这场会话本来就没有消息"
      const countNote = s.messageCount === 0 ? '0（归档时清零，原条数已不可知）' : String(s.messageCount);
      L.push('- 原始消息数：' + countNote + ' · messages 表剩余：**' + s.messagesInDb + ' 条**'
        + (s.messagesInDb === 0 ? '（正文确实已蒸发）' : '（⚠ 正文还在，"归档"只是标记）'));
      L.push('- 未决：' + items.length + ' 条');
      L.push('');
      L.push('| # | 未决原文 | 提出时间 | msgId | 建议 |');
      L.push('|---|----------|----------|-------|------|');
      items.forEach((it, i) => {
        const mid = it.msgId === undefined || it.msgId === null || String(it.msgId).trim() === '' ? '—' : String(it.msgId);
        L.push('| ' + String(i + 1) + ' | ' + oneLine(it.q) + ' | ' + day(it.at) + ' | `' + mid + '` | ' + (it.action === 'mark-lost' ? '标记 lost' : '从简报隐藏') + ' |');
      });
      L.push('');
    }
  }

  const markLost = rep.projects.flatMap((p) => p.items).filter((it) => it.action === 'mark-lost');
  const hidden = rep.projects.flatMap((p) => p.items).filter((it) => it.action === 'hide-from-brief');
  L.push('## 处理建议（三条路，均**不删除**）');
  L.push('');
  L.push('### A. 标记为 `lost` —— 建议 ' + markLost.length + ' 条（有 msgId 的）');
  L.push('');
  L.push('保留条目与原文，给 `key_questions[]` 的条目加 `lost: true`（或旁表 `lost_at`）。');
  L.push('读端（简报/检索/audit）据此把"lost"从"未决欠条"里分出：**仍然可见、可检索、可引用**，');
  L.push('但不再计入"待解决"，audit 的 `archived-unresolved` 也随之归零。');
  L.push('');
  L.push('为什么它是首选：msgId 证明这条未决**确实来自某条真实消息**，只是消息没了；');
  L.push('它不是噪声，不该被藏起来，但它也永远兑现不了。`lost` 是对这个事实最准确的表达。');
  L.push('');
  L.push('### B. 从简报隐藏 —— 建议 ' + hidden.length + ' 条（无 msgId 的）');
  L.push('');
  L.push('没有稳定锚点的条目，**无法证明原文存在过**（可能是抽取期从注入块/转述里误抓的）。');
  L.push('先让简报的未决段跳过它们（判据：session 已归档 ⇒ 不进简报），条目留在库里等人工核对；');
  L.push('核对后如果是真结论，再走 C；确认是噪声，再单独决定是否清掉（那是另一个需要你签字的任务）。');
  L.push('');
  L.push('### C. 迁移到全局经验库 —— 0 条自动判定，需人工');
  L.push('');
  L.push('如果某条"未决"其实是一条**结论**（抽取期把陈述句误判成问句），它值得进全局经验库当草稿；');
  L.push('但这需要逐条读原文判断，脚本**不做文本语义猜测**（零模型约束，也不该由一个正则决定）。');
  L.push('报告里保留全文，就是给这一步用的。');
  L.push('');
  L.push('### 人工复核提示');
  L.push('');
  L.push('逐条扫一遍上表：若多数是「你想做什么？」「为什么会这样子？」这类**助手反问 / UI 提问**，');
  L.push('说明它们是抽取噪声而不是真欠条 —— B 方案（隐藏）就是对的，不必迁就它们去改判据；');
  L.push('若出现明确的技术待办（"X 还没验证"、"要不要改 Y"），单独挑出来走 C，别跟着一起隐藏。');
  L.push('');
  L.push('## 落地步骤（等你确认后再动）');
  L.push('');
  L.push('1. 确认 A/B 的划分（尤其 B 里有没有你认得的真问题）。');
  L.push('2. 另起任务实现：`lost` 状态写入 + 读端过滤 + audit 口径同步；');
  L.push('   三条读路径（`listUnresolved` / 简报 / audit）必须同改，否则又是两套口径。');
  L.push('3. 回滚预案：只加字段、不改原文 ⇒ 把字段去掉即可回到今天的状态；**不删任何条目**。');
  L.push('');
  L.push('## 复现');
  L.push('');
  L.push('```bash');
  L.push('npx tsx scripts/archived-unresolved-report.ts "' + (rep.dbPath || '<db>') + '"');
  L.push('```');
  L.push('');
  return L.join('\n');
}

/** CLI 入口（返回退出码；导出以便单测直接调）。 */
export function main(argv: string[]): number {
  const args = argv.slice(2);
  const valOf = (n: string): string | undefined => {
    const i = args.indexOf('--' + n);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const outPath = valOf('out') ?? path.join('research', 'p0-archived-unresolved.md');
  const consumed = new Set<number>();
  for (const n of ['out']) {
    const i = args.indexOf('--' + n);
    if (i >= 0) consumed.add(i + 1);
  }
  const positional = args.find((a, i) => !a.startsWith('--') && !consumed.has(i));
  const dbPath = valOf('db') ?? positional ?? path.join(process.cwd(), '.sessionrelay', 'relay.sqlite');

  let db: DB;
  try {
    db = openReadonly(dbPath);
  } catch (e) {
    console.error('✗ 打不开库（只读）：' + dbPath + '（' + (e instanceof Error ? e.message : String(e)) + '）');
    console.error('用法：npx tsx scripts/archived-unresolved-report.ts [<db>] [--out research/p0-archived-unresolved.md]');
    return 2;
  }
  try {
    const rep = analyzeArchivedUnresolved(db, { dbPath });
    const md = formatReport(rep);
    const abs = path.resolve(outPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, md, 'utf8');
    if (args.includes('--json')) console.log(JSON.stringify(rep, null, 2));
    else {
      console.log('归档未决分析（只读）：' + rep.total + ' 条 / ' + rep.archivedSessions + ' 场已归档会话 / '
        + rep.projects.length + ' 个项目' + (rep.failedProjects > 0 ? '（' + rep.failedProjects + ' 个项目扫描失败）' : ''));
      console.log('报告：' + abs);
    }
    return 0;
  } finally {
    db.close();
  }
}

const isMain = process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  try {
    process.exitCode = main(process.argv);
  } catch (e) {
    console.error('✗ ' + (e instanceof Error ? e.message : String(e)));
    process.exitCode = 1;
  }
}
