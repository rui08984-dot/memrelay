// srelay brief —— 一次子进程把开场简报要的数据全给齐（1015 夜新增）
//
// ═══ 为什么加 ═══
// ZCode 侧的开场简报此前要 spawn **两次**子进程（decisions --json / unresolved --json），
// 实测每次 175–203ms ⇒ 每轮固定烧掉约 380ms。合并成一次后 **−190ms**，同时白得
// 「最近在动哪些文件」那一行（DSH 侧早就有，ZCode 侧一直没有）。
//
// ═══ 口径契约（改了会让两侧简报分叉）═══
// · decisions / unresolved 的**过滤/折叠/时间窗**逐条复刻 cmdDecisions --json / cmdUnresolved --json；
//   任务 S 唯一改动是「超条数时选谁」：不再 slice(-limit) / slice(0, limit) 按时间一刀切，
//   改由 core/brief/compress.ts 的 selectByBudget 按 pinned > refCount > 新鲜度 选前 N。
//   48h 时间窗、pin 豁免、碎片闸、近重复折叠**一条都没动**。
// · counts 就是上面两个数组的长度（= 老命令 --json 里的 count，ZCode 侧提示句的计数用它）；
//   另加 decisionsCompressed / unresolvedCompressed = 这次按引用次数淘汰掉的条数（0 = 没压缩），
//   渲染末尾说明统一调 compressedNote()，不许客户端各写一种说法。
// · recentFiles 见 listRecentFiles 的注释（与 DSH 插件同规）
//
// 人话输出（不带 --json）只给命令行看着方便，**不参与任何客户端渲染**。

import { loadConfig } from '../shared/config.js';
import { listDecisions, listUnresolved, listRecentFiles } from '../store/db.js';
import { foldNearDuplicates, lengthRatioGate } from '../core/compact/fold.js';
import type { DB, DecisionRow, UnresolvedRow, RecentFileRow } from '../store/db.js';
import { requireRoot, openRelayDb, pc } from './ui.js';
import { openGlobal, pickForInjection, type LessonRow } from '../store/global.js';
import { resolveDomain, resolveWorkspaceId } from '../shared/workspace.js';
import { passesUnresolvedFilters, passesBriefFilters, UNR_SLOTS } from './brief-filter.js';
// [任务S] 超预算淘汰：判据（pinned > refCount > 新鲜度）与「已按引用次数压缩 N 条」文案
// 只在 core/brief/compress.ts 一份；本文件只负责接线 + 把淘汰条数说出来。
import { selectByBudget, loadRefCounts, compressedNote } from '../core/brief/compress.js';
// [task-14] 存量决策碎片的判据：**只 import，绝不复制**。
//   「换成我们的了」「换成你的问法」这类句子的闸门（vagueDecisionObject）住在抽取端，
//   它只影响**新提取**；1021 之前入库的旧碎片永远不会再被抽取端碰一次，
//   所以它们至今仍在简报里。展示层必须按**同一份**判据再拦一道（见 collectBrief 那段注释）。
//   同一份判据的三个使用者：core/extract（抽取端拒收）、core/audit（只读体检计数）、本文件（展示层隐藏）。
import { vagueDecisionObject } from '../core/extract/extract.js';
import { openGlobalAuditReadonly, scanArchivedUnresolved } from '../core/audit/audit.js';
import { latestAuditAlert } from '../core/lifecycle/audit-stage.js';
import { groupSessions } from '../search-svc/session-groups.js';
import { readPageIfExists } from '../map/index.js';
import { computeHealth } from '../core/health/score.js';
// [task-13] 会话卡接进 brief：装配（buildSessionCardFromStored）与行格式（renderCardLines）
// 全部 import 自 core/cards —— 本文件不写判据、不写第二套卡片格式；
// 这里只决定「给哪几场出卡 + 放不放得下」，实现在 cli/brief-cards.ts。
import { collectBriefCards, composeBriefWithCards, BRIEF_BUDGET_RATIO, type BriefComposeResult, type BriefCardBlock } from './brief-cards.js';

/** 简报「相关会话」段的分组条目（组内 ≥2 场；单场不进这一段——决策/未决列表已经点了名） */
export interface BriefRelatedGroup {
  /** 组代表（组内最近活跃的那场） */
  lead: string;
  /** 组内全部会话 id（含 lead） */
  sessions: string[];
  /** 渲染用：标题 + 最近活动时间（省得调用方再查库） */
  members: Array<{ id: string; title: string | null; at: string | null }>;
  /** 为什么它们在一组（最多各 5 个，来自 groupSessions 的共享信号） */
  sharedTopics?: string[];
  sharedFiles?: string[];
}

/**
 * 「相关会话」段的体积上界：3 组 × groupSessions 自带的 3 场上限。
 * 简报是 prompt 的一部分，这一段是**导航**不是正文 —— 再多就挤掉决策/未决。
 */
export const RELATED_MAX_GROUPS = 3;
/** 参与分组的会话上限（IN (...) 的参数必须有界；60 场已覆盖简报 200 条决策的来源集合） */
export const RELATED_MAX_REFS = 60;

/**
 * [task-14] 简报末尾那行说明的**唯一写法**（判据/口径都只有一份，文案也只有一份）。
 *
 * 为什么要打印：过滤是**静默**的 —— 用户看到决策从 8 条变成 6 条，却没有任何解释，
 * 第一反应会是"记忆丢了"。说明行把"少掉的"变成看得见的事实：**已隐藏 N 条疑似碎片（旧数据）**，
 * 括号里的「旧数据」是在说清口径 —— 这些条目是抽取端闸门上线**之前**入库的，
 * 所以它们不会自己消失；想核对/清理请用 `srelay decisions`（全量仍可见），本命令不动库。
 *
 * @returns N ≤ 0 时返回 null —— 没有碎片就**一个字都不打**（每天多一行「已隐藏 0 条」是噪音，
 *          而且会让读者以为简报一直在藏东西）。
 */
export function hiddenFragmentsNote(n: number): string | null {
  const v = Number.isFinite(n) ? Math.floor(n) : 0;
  return v > 0 ? `已隐藏 ${v} 条疑似碎片（旧数据）` : null;
}

export interface BriefPayload {
  /**
   * 审计告警（**简报第一行**）：生命周期 audit 阶段最近一次对本项目的结论为 P0 时非空，
   * 形如 `⚠ 审计 P0：32 条归档会话仍有未决`；无 P0 / 没跑过 → null（静默）。
   * 为什么放在 payload 最前：P0 是"不可逆的数据缺失"，它比"最近定了什么"更该先看到。
   */
  auditAlert: string | null;
  /**
   * 🗺 地图给的「下一步」（`.sessionrelay/map/map.json` 的 context.next）。
   * null = 没有地图 / 地图没写 next（正常状态，整行不渲染）。
   * 为什么放进简报：交接包里「现在该干什么」不该靠 agent 去翻地图文件。
   */
  nextStep: { next: string | null; doing: string[] } | null;
  decisions: DecisionRow[];
  unresolved: UnresolvedRow[];
  counts: {
    decisions: number;
    /**
     * 过完 48h 窗 / 简报过滤器 / 碎片闸之后、**折叠与预算选择之前**的决策候选条数。
     * [任务S] 注意：它现在可能大于 limit —— 选择前不再先 slice(-limit)，
     * 否则"被引用多但稍旧"的条目连候选都进不了（压缩就成了摆设）。
     */
    decisionsRaw?: number;
    folded?: number;
    /**
     * [任务S] 超条数时按引用次数淘汰掉的**决策**条数（0 = 没压缩）。
     * 与 counts.decisions 互补：折叠后过完过滤的条数 = decisions + decisionsCompressed。
     * 它们仍在库里、检索/导出/面板一条不少 —— 这个数只是"这一次少显示了几条"。
     * 渲染末尾说明请调 compressedNote()（core/brief/compress.ts），别在客户端另写一种说法。
     */
    decisionsCompressed?: number;
    unresolved: number;
    /** [任务S] 超条数时按引用次数淘汰掉的**未决**条数（0 = 没压缩；口径同上） */
    unresolvedCompressed?: number;
    /**
     * [task-14] 展示层按 vagueDecisionObject 拦下的**存量碎片**条数（0 = 没有）。
     * 它们仍完整躺在库里、检索/导出/面板一条不少 —— 这个数只是"这一次少显示了几条"，
     * 与 counts.decisions 互补（decisions + fragmentsHidden ≈ 过完既有过滤后的条数）。
     * 渲染末尾说明行请调 hiddenFragmentsNote()，别在客户端另写一种说法。
     */
    fragmentsHidden: number;
    /** 归档会话的未决被隐藏的条数（正文已删、出处永久指空） */
    archivedUnresolvedHidden: number;
  };
  recentFiles: RecentFileRow[];
  /**
   * 「相关会话」段：简报里被点名的会话中，**同一主题的多条会话**合成一组（最多 3 组）。
   * 空数组 = 没有多会话组（整段不渲染）——单场会话不在这里重复点名，决策/未决行已经带了标题。
   * 分组判据复用 search-svc/session-groups.ts 的 groupSessions（与 srelay_search 的 groups 同源）。
   */
  relatedSessions: BriefRelatedGroup[];
  /**
   * 🌍 全局经验（**两道闸 + 预算**后；没命中就是空数组，客户端应整段不渲染）
   *
   * ⚠️ [1021 后端红队 N1] 这里原来写「两道闸」，而**实际只过了一道**：
   *   `pickForInjection` 的相关性闸需要 `query`，本仓调用时**没传**。
   *   实测后果（同一时刻同一库）：ZCode（走 CLI）注入 3 条、DSH（传了 lastUserMessage）注入 2 条，
   *   **两组内容零交集**，而两侧注释都声称已过两道闸。
   *
   * 语义上这不是错：ZCode 的钩子是 SessionStart，此刻**还没有用户输入**，没有 query 只能按分数取。
   * 错的是注释把「有条件」说成「无条件」。现在：① 注释改实话；
   * ② `collectBrief` 接受 `query`，让**有上下文**的调用方真能把闸 2 打开。
   */
  experiences: Array<{ text: string; scope: string; grade: string }>;
}

/** 纯取数（不碰 CLI / 不开库）——便于单测与组件复用 */
export function collectBrief(
  db: DB,
  projectId: string,
  opts: { limit?: number; days?: number; top?: number; query?: string; refCounts?: ReadonlyMap<string, number> } = {},
  root?: string,
): BriefPayload {
  const limit = opts.limit ?? 200;
  // [任务S] 引用次数：sessionId → search_feedback 的 open 次数（缺省空表 = 全部 0）。
  // 由调用方注入（collectBrief 的契约是「纯取数、不额外开库」）；cmdBrief 从全局库只读读入。
  const refCounts = opts.refCounts ?? new Map<string, number>();
  // 呈现层折叠（ADR-003 D3）：近重复只折叠"这一次显示"，存储一条不动 —— 简报里 5 个名额
  // 应该给 5 件不同的事，而不是同一件事说 3 遍。判据复用核心 isNearDuplicate（含长度比门，
  // 修掉生产前缀键误杀「采用 Vite 作为前端构建工具」那个 bug）。
  // [1021 修一个我自己引入的崩溃] 这两个常量原来声明在**决策过滤之后**（原第 73 行），
  //   而决策那条 48h 过滤（第 60 行左右）要用 `cutoff` ⇒ **TDZ：ReferenceError: Cannot access 'cutoff' before initialization**。
  //   是 graph-recall 在跑真实 CLI 时炸出来的（`node --check`/编译器都不报，因为它是运行期 TDZ，不是语法错）。
  //   教训：`const` 的 TDZ 只在**执行到那一行之前**才炸，静态检查抓不到 —— 这类只能靠「真的跑一遍」。
  const BRIEF_FRESH_MS = 48 * 3600_000;
  const cutoff = Date.now() - BRIEF_FRESH_MS;
  // [任务S] 候选集**先不按条数截断**：超预算时由 selectByBudget 决定选谁。
  //   原先的 slice(-limit) 发生在过滤**之前** —— 那等于"旧条目连候选都进不了"，
  //   被引用多的老条目永远没机会赢，压缩就成了摆设。时间窗/过滤/折叠一律不动。
  const rawDecisions = listDecisions(db, projectId, {}).reverse()
    // ── 1020 · P1：压缩卡片机制（压缩不掉召回）──
    //   L3 压缩写回后：原始条目带 `compressed_into: <卡片id>`，同时追加了一条卡片。
    //   **简报跳过带标记的**（否则同一件事显示两遍：一次原文一次卡片）；
    //   **检索路径绝不跳**（cli/search.ts 走的是 messages/decisions 全量，不经这里）
    //   ⇒ 简报变短，搜索一条不少。这正是 memcore 那套「结算卡片 + source_id 回读」的落地形式。
    .filter((d) => !(d as { compressed_into?: string }).compressed_into)
    // ── 1020 修三路分叉：CLI 简报此前**完全没过 passesBriefFilters** ──
    //   实测后果：`srelay brief` 把人话输出里 6 条中的 3~4 条垃圾全显示出来
    //   （「决定要不要另下 Launcher ← 问句，不是决策2. 决定已归档记忆 ← 碎片」这种串行污染），
    //   而 DSH / ZCode 两侧的简报是**过滤过的** ⇒ 用户拿 CLI 核对「简报会说什么」会看错。
    //   判据与两侧同源（`cli/brief-filter.ts`，check-brief-filters §⑥ 有行为对拍）。
    .filter((d) => passesBriefFilters(String((d as { text?: string }).text ?? '')))
    // [1021 红队 R4] 时间窗 + pin 豁免，与 DSH/ZCode 同规：
    //   · 48h 内的决策才进简报（简报说的是「最近在动什么」）
    //   · **pin 过的不受时间窗限制** —— 用户亲手置顶的东西不该被时间挤掉
    //     （这条与 DSH 曾经的 bug 同源：那边一度写成 `key === 'decisions' && pinned`，
    //      导致 30 天前 pin 的未决一边被砍一边留着。判据只许有一份。）
    .filter((d) => {
      const dd = d as { pinned?: boolean; at?: string };
      if (dd.pinned === true) return true;
      const t = Date.parse(String(dd.at ?? ''));
      return !Number.isFinite(t) || t >= cutoff;   // 时间不可解析时宁可保留（容错不静默丢）
    });
  // ── [task-14] 存量决策碎片：**展示层**再拦一道（判据 import 自 core/extract，不复制正则）──
  //   病历：简报里仍然出现『换成我们的了』『换成你的问法』这类句子。原因不是判据坏了，是
  //   **时机**：vagueDecisionObject 是**抽取端**闸门（extract.ts 的 plausibleDecision 里那道），
  //   只拦得住"此后新提取的"；旧数据早已入库，抽取端这辈子不会再碰它们一次 ⇒ 永远显示。
  //   处置口径（与全仓一致）：**只影响这一次显示** —— 库一个字节不动、不删数据，
  //   检索 / 导出 / 面板 / srelay decisions 仍全量可见。
  //   ⚠️ 为什么放在 fold **之前**：近重复折叠的代表是"组内最新那条"。若碎片先当上代表，
  //      折叠会把同组里那句**正常**决策并进碎片，随后碎片被本条拦掉 ⇒ 好的一条也跟着消失。
  //      先滤碎片再折叠，名额给的是真事。
  //   ⚠️ 置顶豁免：与同函数里的时间窗、未决段过滤同规（用户显式 pin 过的东西要尊重）。
  //      要改成"pin 也照拦"，删下面那一个条件即可 —— 别在别处再写第三种说法。
  let fragmentsHidden = 0;
  const keptDecisions = rawDecisions.filter((d) => {
    const dd = d as { text?: string; pinned?: boolean };
    if (dd.pinned === true) return true;
    if (!vagueDecisionObject(String(dd.text ?? ''))) return true;
    fragmentsHidden++;
    return false;
  });
  const foldedDecisions = foldNearDuplicates<DecisionRow>(keptDecisions, 0.8, lengthRatioGate);
  const folded = foldedDecisions.folded;
  // [任务S] 超条数时选谁：pinned > 引用次数 > 新鲜度（判据只在 core/brief/compress.ts）。
  //   未超预算时 selectByBudget **原样返回**（顺序也不动）—— 既有输出不因这次改动漂移；
  //   真压缩时按优先级排，让"被反复引用的那条"排到最前，否则它仍会被渲染层 slice(0,5) 挡住。
  const decisionBudget = selectByBudget<DecisionRow>(foldedDecisions.rows, limit, {
    refCounts,
    keyOf: (d) => d.sessionId + '\u0000' + d.text,
  });
  const decisions = decisionBudget.kept;
  // [1021 红队 R4 修复] **三路分叉**：这里原来是「决策无时间窗 + 未决 14 天」，
  //   而 DSH（plugins/dsh/index.js:81 `FRESH_MS = 48 * 3600_000`）与
  //   ZCode（integrations/zcode/brief-shared.mjs:25 同值）**两者都是 48 小时**。
  //   后果：拿 `srelay brief` 核对「简报会说什么」会看到**完全不同的内容**（177 条 vs 十几个）。
  //   本项目的判据铁律是「只许有一份」——这里对齐到 48h，与两侧同值。
  //   ⚠️ 若将来觉得未决问题该放长（未决是欠条，欠越久越该被看见），**要三处一起改**，不能只改这里。
  //   （声明已上移到本函数开头 —— 原来在这里会用时未定义，见上方注释）
  // [1017 夜 U-A] 渲染侧过滤：以前这里**一条判据都没有**，于是 `srelay brief` 显示的内容
  // 与用户真正看到的简报（DSH/ZCode 两侧都过滤）不一致 —— 拿它核对"简报会说什么"会看错。
  // 判据与 DSH/ZCode 同源（见 cli/brief-filter.ts 的说明与 check-brief-filters §⑥ 的行为对拍）。
  // [1021 红队 R12 修复] 原来是 `listUnresolved(db, projectId, 100)` **先截断再过滤**。
  //   问题：取证 100 条 → 按 14 天保质期滤掉一批 → 再按判据滤掉一批 → 最后才 slice(limit)。
  //   如果最新那 100 条里有大量过期/被过滤的，**名额就白白空了**，而库里明明还有够格的问题。
  //   修法：先多取（4× 上限），过滤完再截。取多了只是多读几行 JSON，代价远小于简报缺条目。
  //   不直接无上限取：库大时 listUnresolved 会把全部未决读进内存，那是另一个极端。
  const UNR_FETCH = Math.max(100, limit * 4);
  // [10-19 用户拍板] 归档会话的未决**从简报隐藏**（不标 lost、不迁移）：
  //   这些会话正文已被 runArchive 删除，未决的出处 msgId/seq 永久指空，回跳只会报「原文已归档」。
  //   判据复用 audit 的 scanArchivedUnresolved（同一份），不另写 SQL；
  //   隐藏数量落进 counts 并由渲染层明说（不静默）。
  const archivedSessionsWithUnresolved = (() => {
    try { return new Set(scanArchivedUnresolved(db, projectId).items.map((i) => i.sessionId)); }
    catch { return new Set<string>(); }
  })();
  const unresolvedBeforeArchiveFilter = listUnresolved(db, projectId, UNR_FETCH)
    .filter((r) => new Date(r.at).getTime() >= cutoff)
    .filter((r) => passesUnresolvedFilters(r.q));
  const unresolvedCandidates = unresolvedBeforeArchiveFilter
    .filter((r) => !archivedSessionsWithUnresolved.has(r.sessionId));
  // [任务S] 未决同理：超条数时按引用次数选（未超预算时原样返回，顺序不变）。
  const unresolvedBudget = selectByBudget<UnresolvedRow>(unresolvedCandidates, limit, {
    refCounts,
    keyOf: (u) => u.sessionId + '\u0000' + u.q,
  });
  const unresolved = unresolvedBudget.kept;
  // 归档隐藏数只算「归档」那一段；压缩掉的另记 —— 两个原因不许混成一个数
  //    （否则用户看到「已隐藏 N 条」会以为都是归档，实际是预算淘汰）。
  const archivedUnresolvedHidden = unresolvedBeforeArchiveFilter.length - unresolvedCandidates.length;
  const recentFiles = listRecentFiles(db, { days: opts.days ?? 7, top: opts.top ?? 3 });
  const relatedSessions = collectRelatedGroups(db, [
    ...decisions.map((d) => ({ sessionId: d.sessionId, at: d.at })),
    ...unresolved.map((u) => ({ sessionId: u.sessionId, at: u.at })),
  ]);
  const experiences = collectExperiences(root ?? process.cwd(), opts);
  return { auditAlert: collectAuditAlert(root), nextStep: collectNextStep(root), relatedSessions, experiences, decisions, unresolved, recentFiles,
    counts: {
      decisions: decisions.length,
      decisionsRaw: rawDecisions.length,
      folded,
      decisionsCompressed: decisionBudget.evicted,
      unresolved: unresolved.length,
      unresolvedCompressed: unresolvedBudget.evicted,
      fragmentsHidden,
      archivedUnresolvedHidden,
    } };
}

export async function cmdBrief(opts: { limit?: number; days?: number; top?: number; json?: boolean }): Promise<void> {
  const root = requireRoot();
  const cfg = loadConfig(root);
  const db = openRelayDb(root);
  try {
    const projectId = cfg.identity.project_id ?? root;
    // [任务S] 引用次数来自全局库 search_feedback（只读）。读不到就退化为按新鲜度选，
    //   但必须留痕（见 briefRefCounts）—— 不许让「压缩没生效」看起来像「本来就没超预算」。
    const pay = collectBrief(db, projectId, {
      limit: opts.limit,
      days: opts.days,
      top: opts.top,
      refCounts: briefRefCounts(projectId),
    }, root);
    if (opts.json) { console.log(JSON.stringify(pay)); return; }
    // ── [task-13] 会话卡：**先算基线，再在预算里塞卡** ──
    // 人话输出整体在这里拼完再一次性打印（以前是逐行 console.log）。原因：
    // 体积预算（≤ 不加卡时 ×1.2）只有在"整条都拼好"之后才量得出来，边打边算是没法回退的。
    //
    // 基线（head + tail）就是**不加卡时的那条简报**，逐行与旧版一致（含颜色）：
    // 卡段插在 head 与 tail 之间 —— 卡片是决策行/未决行的"展开"，离它们越近越有用。
    //
    // ⚠️ 只动**人话输出**。`--json` 上面已经 return 了：payload 是客户端契约
    // （三条老命令逐字段对拍 + 插件 selftest §12 拿真库对拍）。
    // 契约只能**新增**字段、不许改旧字段语义：任务S 的 decisionsCompressed / unresolvedCompressed
    // 就是纯新增（旧字段一个没动）；别的改动请照这个规矩来。
    const head: string[] = [];
    // 审计 P0 永远排第一行（红字）：它是"不可逆的数据缺失"，比"最近定了什么"更急。
    // 无 P0 时 auditAlert 为 null —— 这里不打印任何"审计正常"，静默就是正常。
    if (pay.auditAlert) head.push(pc.red(pay.auditAlert));
    // 🩺 体检分：每天第一眼就知道记忆整体健康度（不打开面板、不敲 score 也能看到）。
    //   计算失败**不许静默**：打印原因（否则用户会以为一直是满分）。
    //   单一判据仍是 core/health/score.ts，这里只渲染一行。
    try {
      const h = computeHealth(db, cfg.identity.project_id ?? root);
      const color = h.grade === 'A' ? pc.green : h.grade === 'B' ? pc.cyan : h.grade === 'C' ? pc.yellow : pc.red;
      head.push(color('🩺 记忆体检 ' + h.score + ' 分 · ' + h.grade) + pc.dim('（证据覆盖 ' + Math.round(h.components.evidenceCoverage * 100) + '% · 新鲜度 ' + Math.round(h.components.freshness * 100) + '%）'));
    } catch (e) {
      head.push(pc.dim('🩺 记忆体检不可用：' + (e instanceof Error ? e.message : String(e)).slice(0, 80)));
    }
    // 🗺 下一步排在计数行**之前**：交接包里「现在该干什么」比「定了什么」更该先看到。
    // 没有地图 / 地图没写 next 时整行不出现（不占位、不写「无」）。
    if (pay.nextStep?.next) head.push(pc.cyan('🗺 下一步：') + pay.nextStep.next.slice(0, 120));
    if (pay.nextStep?.doing?.length) head.push(pc.dim('  ↳ 进行中：' + pay.nextStep.doing.join(' / ')));
    head.push(`决策 ${pay.counts.decisions} 条 · 未决 ${pay.counts.unresolved} 条 · 最近在动 ${pay.recentFiles.length} 个`);
    for (const r of pay.recentFiles) head.push(pc.dim(`  🗂 ${r.file}（${r.sessions} 场）`));
    for (const d of pay.decisions.slice(0, 5)) head.push(`  ${pc.dim(d.at?.slice(0, 10) ?? '')} ${d.kind === 'negative' ? pc.red('✗') : pc.green('✓')} ${d.text.slice(0, 60)}`);
    for (const u of pay.unresolved.slice(0, UNR_SLOTS)) head.push(`  ${pc.yellow('◻')} ${u.q.slice(0, 60)}`);

    const tail: string[] = [];
    // ── [1021 P1-1] 「相关会话」段：多会话组按组显示，不再逐条平铺 ──
    // 只在真的分出组时才打印；单场会话不进这一段（决策/未决行已经点了名）。
    if (pay.relatedSessions.length > 0) {
      tail.push(pc.dim(`  相关会话 ${pay.relatedSessions.length} 组（同一主题的多条会话）：`));
      for (const g of pay.relatedSessions) {
        const lead = g.members.find((m) => m.id === g.lead);
        const sig = [...(g.sharedTopics ?? []).slice(0, 2), ...(g.sharedFiles ?? []).slice(0, 1)].join(' / ');
        tail.push(pc.dim('  · ') + String(lead?.title ?? g.lead).slice(0, 40)
          + pc.dim('  [' + g.sessions.length + ' 场' + (sig ? ' · 共享 ' + sig : '') + ']'));
        const others = g.members.filter((m) => m.id !== g.lead).map((m) => m.title ?? m.id).filter(Boolean);
        if (others.length > 0) tail.push(pc.dim('      ↳ ' + others.join(' · ').slice(0, 80)));
      }
    }
    // ── [1021 修「面板说可注入 10 条，但 srelay brief 一条经验都不显示」] ──
    //   `collectExperiences()` 一直是**取到了的**（`--json` 里实测 3 条），
    //   但人话输出**从来没有渲染过这一段** —— 于是用户敲 `srelay brief` 看到的是「没有经验」，
    //   而面板同一时刻显示「可注入: 10 条」。两个面各说一套，最容易被判成「功能坏了」。
    //   这里补上：只在**真取到**时打印（空就不占行，别每天多一行「经验 0 条」的噪音）。
    if (pay.experiences.length > 0) {
      tail.push(pc.dim('  经验 ' + pay.experiences.length + ' 条（会自动注入新对话）：'));
      for (const e of pay.experiences) tail.push(pc.dim('  · ' + String(e.text).slice(0, 72)));
    }
    // ── [task-14] 末尾说明行：**过滤必须说出来** ──
    //   「已隐藏 N 条疑似碎片（旧数据）」。没有碎片时 hiddenFragmentsNote 返回 null ⇒ 不打。
    {
      const note = hiddenFragmentsNote(pay.counts.fragmentsHidden);
      if (note) tail.push(pc.dim('  ' + note));
    }
    // [10-19 用户拍板] 归档未决隐藏也要**说出来**：正文已删、出处永久指空，
    //   用户看到未决少了 N 条必须知道为什么（否则会以为记忆丢了）。
    if (pay.counts.archivedUnresolvedHidden > 0) {
      tail.push(pc.dim('  已隐藏 ' + String(pay.counts.archivedUnresolvedHidden) + ' 条归档会话的未决（正文已归档、出处无法回跳；不是丢失）'));
    }
    // [任务S] 超预算淘汰必须说出来（与碎片/归档说明同规）：
    //   「变短」有两种原因 —— 过滤（已隐藏）与压缩（命中预算）。混在一起就说不清，
    //   用户看到少了几条会第一反应"记忆丢了"。两条各自成行，口径与 counts 一一对应。
    {
      const compressed = (pay.counts.decisionsCompressed ?? 0) + (pay.counts.unresolvedCompressed ?? 0);
      const note = compressedNote(compressed);
      if (note) tail.push(pc.dim('  ' + note));
    }

    // 出卡的会话 = 简报里**被点名**的那些（决策行在前、未决行在后），去重后前 BRIEF_CARD_MAX 场。
    // 挑选判据只有这份 list（"简报点了名"）；卡片里放什么、长什么样全在 core/cards。
    const blocks = collectBriefCards(db, [
      ...pay.decisions.slice(0, 5).map((d) => d.sessionId),
      ...pay.unresolved.slice(0, UNR_SLOTS).map((u) => u.sessionId),
    ]);
    const out = composeBriefWithCards(head, blocks, tail);
    for (const line of out.lines) console.log(line);
    // 降级/省略必须**说出来**：预算连一行提示都塞不下时改走 stderr（也不许闷着）。
    if (out.noticeTo === 'stderr' && out.notice) {
      try { process.stderr.write('[brief] 预算已用满：' + out.notice.slice(1, -1) + '\n'); } catch { /* 连 stderr 都写不了就别管了 */ }
    }
  } finally {
    db.close();
  }
}

/**
 * [任务S] 简报用的 refCount：全局库 search_feedback 里**本项目**的 open 次数（sessionId → 次数）。
 *
 * 复用 openGlobalAuditReadonly —— 「全局库怎么只读打开」只有那一份实现
 * （不存在 / 被占用两种状态它都区分好了），这里不另写 existsSync + openReadonly。
 *
 * 三种「没有引用次数」必须区分开（否则「压缩没生效」会被误读成「没有可压缩的」）：
 *   · 全局库不存在（全新用户还没跑过 lifecycle / feedback）→ 正常，空表，静默；
 *   · 库打不开（锁 / 损坏）→ **stderr 留痕**：压缩退化为按新鲜度选，但用户得知道为什么；
 *   · 表不存在（还没记过任何 open）→ loadRefCounts 返回空表，正常（全部按 0）。
 */
function briefRefCounts(projectId: string): Map<string, number> {
  const g = openGlobalAuditReadonly();
  if (g.db === null) {
    if (g.reason && !/不存在/.test(g.reason)) {
      try { process.stderr.write('[brief] 引用次数读取失败（压缩退化为按新鲜度）：' + g.reason.slice(0, 160) + '\n'); } catch { /* 连 stderr 都写不了就别管了 */ }
    }
    return new Map();
  }
  try {
    return loadRefCounts(g.db, { project: projectId });
  } catch (e) {
    // 读接口不假装"没有数据"：留痕，然后降级（简报其余部分不受影响）
    try { process.stderr.write('[brief] 引用次数读取失败（压缩退化为按新鲜度）：' + String((e as Error)?.message ?? e).slice(0, 160) + '\n'); } catch { /* 连 stderr 都写不了就别管了 */ }
    return new Map();
  } finally {
    try { g.db.close(); } catch { /* 已关 */ }
  }
}

/** 供测试与调用方核对预算账本：跑一遍**同一个** cmdBrief 取数 → 拼装路径，返回账本 */
export function briefComposeForTest(db: DB, pay: BriefPayload): BriefComposeResult {
  const head: string[] = [];
  if (pay.nextStep?.next) head.push('🗺 下一步：' + pay.nextStep.next.slice(0, 120));
  if (pay.nextStep?.doing?.length) head.push('  ↳ 进行中：' + pay.nextStep.doing.join(' / '));
  head.push(`决策 ${pay.counts.decisions} 条 · 未决 ${pay.counts.unresolved} 条 · 最近在动 ${pay.recentFiles.length} 个`);
  for (const r of pay.recentFiles) head.push(`  🗂 ${r.file}（${r.sessions} 场）`);
  for (const d of pay.decisions.slice(0, 5)) head.push(`  ${d.at?.slice(0, 10) ?? ''} ${d.kind === 'negative' ? '✗' : '✓'} ${d.text.slice(0, 60)}`);
  for (const u of pay.unresolved.slice(0, UNR_SLOTS)) head.push(`  ◻ ${u.q.slice(0, 60)}`);
  const blocks: BriefCardBlock[] = collectBriefCards(db, [
    ...pay.decisions.slice(0, 5).map((d) => d.sessionId),
    ...pay.unresolved.slice(0, UNR_SLOTS).map((u) => u.sessionId),
  ]);
  return composeBriefWithCards(head, blocks, []);
}

/**
 * 「相关会话」段取数：把简报点名过的会话交给 groupSessions（**唯一分组判据**），
 * 只保留**多会话组**（≥2 场）。单场不在这里重复列 —— 决策/未决行已经带了标题。
 *
 * 体积：组数 ≤ RELATED_MAX_GROUPS，参与会话 ≤ RELATED_MAX_REFS；两者都是硬上限，
 * 保证这一段不会因为"库里会话很多"而把简报撑爆。
 * score 用会话在简报里最后一次出现的时间：组代表 = 组内最近动过的那场。
 */
function collectRelatedGroups(db: DB, refs: Array<{ sessionId: string; at: string }>): BriefRelatedGroup[] {
  const score = new Map<string, number>();
  for (const r of refs) {
    if (!r.sessionId) continue;
    score.set(r.sessionId, Math.max(score.get(r.sessionId) ?? 0, Date.parse(r.at) || 0));
  }
  // 先按"最近出现"取前 N 场：IN (...) 的参数个数必须有界（大库上不能无上限展开）
  const ids = [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, RELATED_MAX_REFS).map(([id]) => id);
  if (ids.length < 2) return [];
  let groups;
  try {
    groups = groupSessions(db, ids.map((id) => ({ sessionId: id, score: score.get(id) ?? 0 })));
  } catch {
    // 分组是**呈现增强**：SQL 失败时退回"不分组"，不让简报整段崩（也不假装分过组）
    return [];
  }
  const multi = groups.filter((g) => g.sessionIds.length >= 2).slice(0, RELATED_MAX_GROUPS);
  if (multi.length === 0) return [];
  const meta = new Map<string, { id: string; title: string | null; at: string | null }>();
  try {
    const ph = ids.map(() => '?').join(',');
    const rows = db.prepare('SELECT id, title, COALESCE(last_event_at, created_at) AS at FROM sessions WHERE id IN (' + ph + ')')
      .all(...ids) as Array<{ id: string; title: string | null; at: string | null }>;
    for (const r of rows) meta.set(r.id, r);
  } catch { /* 标题取不到就用 id：分组本身仍然有信息量 */ }
  return multi.map((g) => ({
    lead: g.lead,
    sessions: g.sessionIds,
    members: g.sessionIds.map((id) => {
      const m = meta.get(id);
      return { id, title: m?.title ?? null, at: m?.at ?? null };
    }),
    ...(g.sharedTopics.length > 0 ? { sharedTopics: g.sharedTopics } : {}),
    ...(g.sharedFiles.length > 0 ? { sharedFiles: g.sharedFiles } : {}),
  }));
}

/**
 * 简报顶部的审计告警：读全局库里**本项目**最近一次审计结论（生命周期 audit 阶段写的）。
 *
 * 三种"没有告警"必须区分开（不看日志也能判断是否可信）：
 *   · 没传 root（纯取数调用）→ 不查，null；
 *   · 全局库不存在 —— 全新用户还没跑过生命周期，正常状态，静默；
 *   · 全局库打不开（被占用/损坏）—— **要留痕**，否则 P0 会静默消失（本项目最嫌恶的失效）。
 */
/**
 * 🗺 地图的「下一步」。只读；没有地图 / 读坏了 → null（简报其余部分不受影响）。
 *
 * 为什么只取 context.next 与 doing/todo 节点：交接包里「现在该干什么」
 * 只能来自**人写的意图**（地图账本），不能由 brief 自己猜。
 */
export function collectNextStep(root: string | undefined): { next: string | null; doing: string[] } | null {
  if (!root) return null;
  try {
    const got = readPageIfExists(root, undefined);
    if (!got.ok || !got.value) return null;
    const page = got.value.page;
    const next = typeof page.context?.next === 'string' && page.context.next.trim() !== '' ? page.context.next.trim() : null;
    const doing = (Array.isArray(page.nodes) ? page.nodes : [])
      .filter((n) => n.status === 'doing' || n.status === 'todo')
      .slice(0, 3)
      .map((n) => String(n.label ?? n.id));
    if (!next && doing.length === 0) return null;
    return { next, doing };
  } catch { return null; }
}

function collectAuditAlert(root: string | undefined): string | null {
  if (!root) return null;
  const g = openGlobalAuditReadonly();
  if (g.db === null) {
    if (g.reason && !/不存在/.test(g.reason)) {
      try { process.stderr.write('[brief] 审计告警读取失败（简报其余部分不受影响）：' + g.reason.slice(0, 160) + '\n'); } catch { /* 连 stderr 都写不了就别管了 */ }
    }
    return null;
  }
  try {
    const alert = latestAuditAlert(g.db, root);
    if (!alert) return null;
    // [10-19 用户拍板] 归档会话的未决已从简报隐藏（不标 lost、不迁移）——
    //   那么顶部就不该再挂着一条⚠让人天天处理它。
    //   **不是**把问题藏掉：audit / health_events / `srelay audit` 里照旧计数，只是简报降噪。
    //   若将来决定处理它们，去掉这一条即可恢复告警。
    if (alert.includes('归档会话仍有未决')) return null;
    return alert;
  } finally { try { g.db.close(); } catch { /* 已关 */ } }
}

/** 经验段的取数：**没命中就返回空数组**，由调用方决定整段渲不渲染 */
function collectExperiences(root: string, opts: { top?: number; maxChars?: number; query?: string }): Array<{ text: string; scope: string; grade: string }> {  try {
    const db = openGlobal();
    try {
      // [1016 收口] 工作区/领域都和别的面走同一份解析（此前写死 process.cwd() ⇒
      // 在子目录里跑 brief 时，project 作用域的经验会静默消失；domain 更是从来没传过）。
      const rows = pickForInjection(db, {
        workspaceId: resolveWorkspaceId(root),
        domain: resolveDomain(root),
        // [1021 红队 N1] 有 query 就传 —— 传了才会开「相关性闸」，与 DSH 侧走同一条路径。
        //   没有（SessionStart 场景）就保持 undefined：那时确实无从判断相关性，
        //   按分数取是唯一诚实的选择。**关键是这个区别现在在类型上看得见了**。
        query: opts.query && opts.query.trim() ? opts.query.trim() : undefined,
        top: opts.top ?? 3,
        maxChars: opts.maxChars ?? 200,
      });
      return rows.map((r: LessonRow) => ({ text: r.text, scope: r.scope, grade: r.grade }));
    } finally { db.close(); }
  } catch (e) {
    // [1021 红队 R11 修复] 原来是 `catch { return [] }` —— **全局库一坏，整段经验凭空消失且零留痕**。
    //   用户看到的是「没有经验」，无法区分「真没有」和「库坏了」。这是本项目最嫌恶的静默失效。
    //   修法：区分两种情形 ——
    //     · 库**不存在**（ENOENT）= 全新用户，真的没有经验 ⇒ 安静返回 []，这是正常状态；
    //     · 其它异常（权限/损坏/锁）⇒ 打到 stderr 一行，让人看得见，但仍返回 [] 不让简报整段崩。
    const code = String((e as { code?: string })?.code ?? '');
    const msg = String((e as Error)?.message ?? e);
    if (code !== 'ENOENT' && !/does not exist|no such table/i.test(msg)) {
      try { process.stderr.write('[brief] 经验段读取失败（简报其余部分不受影响）：' + msg.slice(0, 160) + '\n'); } catch { /* 连 stderr 都写不了就别管了 */ }
    }
    return [];
  }
}