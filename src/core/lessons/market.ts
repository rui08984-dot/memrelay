// 跨项目经验市场（Task M）—— 零模型、只读、确定性。
//
// 市场回答一个问题：**这个项目眼下最该借鉴哪些别处踩过的坑？**
//
// 纪律：本文件不新增「判据」——
//   注入闸 / 词元 / 工作区比较键 / 相关性打分全部 import 现有唯一实现；
//   这里只有**排序权重**（把已有信号按固定系数相加），系数是常量、顺序是固定的。
//
// 四层判据（全部确定性，无随机）：
//   ① 亲和度：同 domain 优先（+AFFINITY_DOMAIN），其次同 workspace（+AFFINITY_WORKSPACE）
//   ② 话题重合：与当前项目最近 topics 的词元重叠；不重叠（gate2Score 不 pass）就不上架
//   ③ 证据权重：lesson.uses / hits 抬高排序 —— 复用 liveImportance 的唯一加成口径
//   ④ 已在本项目用过：本项目自己的 project 级条目降权（-OWN_PROJECT_PENALTY）
//
// 「本项目用过」为什么用**归属**做代理：lessons 表的 uses/hits 是**全库计数**，
//   没有按项目记录的使用计数器；而 scope=project + workspace 相同，恰恰表示
//   「这条经验本来就住在本项目里」——市场再把它当新发现推销一次没有增量。
//   （任务要求只读、不改表结构，所以不新增 lesson_uses 表。）
//
// ⚠️ 市场是**只读发现面**，不是第二个注入面：
//   · 上架先过 isInjectable —— 与 lesson list 的 ●/○、pickForInjection 是同一个函数；
//   · 这里返回什么不会改变 visibleWhere 的可见性，也不会自动注入任何上下文；
//   · 真正进 prompt 的仍只有 pickForInjection 那条路。
import type Database from 'better-sqlite3';
import { isInjectable, liveImportance, type LessonRow } from '../../store/lesson-gate.js';
import { gate2Score, gate2Tokens } from '../../store/global.js';
import { normalize } from '../tokenize/tokenizer.js';
import { workspaceKey } from '../../shared/workspace.js';

/** 默认返回条数（CLI 侧同源使用，避免两边各写一个 5） */
export const MARKET_DEFAULT_LIMIT = 5;
/** 上限：市场是给人看的清单，不是全库导出 */
export const MARKET_MAX_LIMIT = 50;

/** ① 同领域加成：领域是**人显式分的组**，同组经验最贴题（与 visibleWhere 的口径一致：精确相等） */
export const AFFINITY_DOMAIN = 2;
/** ① 同工作区加成：domain/global 级条目也会记来源 workspace，本项目自己采的略优先 */
export const AFFINITY_WORKSPACE = 1;
/** ③ 证据权重系数：把「入库分 + uses/hits 加成」折算进排序 */
export const EVIDENCE_WEIGHT = 0.5;
/** ④ 已在本项目用过（本项目自己的 project 级条目）的降权 */
export const OWN_PROJECT_PENALTY = 3;

export interface MarketOptions {
  /** 当前工作区（调用方用 resolveWorkspaceId(项目根) 取，写读同源） */
  workspaceId: string;
  /** 当前项目领域标签（resolveDomain 的结果；没有就不加分也不扣分） */
  domain?: string;
  /** 当前项目最近的话题（由调用方从项目库 sessions.topics 汇总；市场本身不碰项目库） */
  topics: string[];
  /** 返回条数，默认 5；<=0 返回空，上限 MARKET_MAX_LIMIT */
  limit?: number;
}

export interface MarketHit {
  /** 原样返回的库行（**不重算时间相关字段** —— 保证同一输入两次调用逐字节相同） */
  lesson: LessonRow;
  /** 推荐理由（人可读，确定性拼接） */
  reason: string;
  /** 排序分（越大越靠前；只看相对大小，不是概率） */
  score: number;
}

function resolveLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return MARKET_DEFAULT_LIMIT;
  const n = Math.floor(limit);
  if (n <= 0) return 0;
  return Math.min(n, MARKET_MAX_LIMIT);
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function buildReason(input: {
  domain: string;
  sameDomain: boolean;
  sameWorkspace: boolean;
  ownProject: boolean;
  matched: string[];
  uses: number;
  hits: number;
}): string {
  const why: string[] = [];
  if (input.sameDomain) why.push('同领域「' + input.domain + '」');
  if (input.sameWorkspace) why.push('同工作区');
  if (input.matched.length > 0) why.push('命中「' + input.matched.join('」「') + '」');
  const use: string[] = [];
  if (input.uses > 0) use.push('复用 ' + input.uses + ' 次');
  if (input.hits > 0) use.push('反复出现 ' + input.hits + ' 次');
  if (use.length > 0) why.push(use.join(' · '));
  if (input.ownProject) why.push('已在本项目（降权）');
  // pass 的条目理论上至少有一条理由（gate2Score 的 pass 必然有命中单元）；保底不输出空串
  return why.length > 0 ? why.join(' · ') : '话题命中';
}

/**
 * 跨项目经验市场：按（workspace, domain, 最近 topics）推荐经验。
 *
 * 纯读、确定性：不写库、不调用模型、不使用随机数；
 * 同一份库 + 同一组参数 ⇒ 同一份结果：排序分只在**入库时刻**算证据，与运行时刻无关；
 * 「能不能上架」由 isInjectable 按**调用时刻**判断（时钟每轮取一次，与 lesson list 同源）。
 */
export function recommendLessons(globalDb: Database.Database, opts: MarketOptions): MarketHit[] {
  const limit = resolveLimit(opts.limit);
  if (limit === 0) return [];

  const wsKey = workspaceKey(String(opts.workspaceId ?? ''));
  const domain = String(opts.domain ?? '').trim();
  const topics = Array.isArray(opts.topics) ? opts.topics : [];
  const topicText = topics.map((t) => String(t ?? '').trim()).filter(Boolean).join(' ');
  // 空输入不硬凑：没有话题就谈不上「与当前项目的重合」，返回空比塞噪声好
  if (!topicText) return [];
  // ② 的词元与 gate2Score 共用同一份查询解析（gate2Tokens）——只用于**写理由**
  const topicTokens = gate2Tokens(topicText);

  // 全库只读一次：市场是跨项目发现面，不按 visibleWhere 收窄（那会退化成 lesson list）；
  // 但它**不改变**任何可见性，也不把内容送进 prompt（见文件头）。
  // 闸门按**调用时刻**取一次 now：同一轮内所有条目用同一个时钟，避免扫描途中翻面。
  const now = Date.now();
  const rows = globalDb.prepare('SELECT * FROM lessons').all() as LessonRow[];
  const ranked: Array<{ hit: MarketHit; raw: number; overlap: number; evidence: number }> = [];

  for (const row of rows) {
    // 闸 1：只摆「真能进注入层」的经验（与显示、注入共用唯一判据）
    if (!isInjectable(row, now)) continue;

    const text = String(row.text ?? '');
    const rel = gate2Score(topicText, text);
    if (!rel.pass) continue;   // ② 无可判据的重合 ⇒ 不上架（哪怕同领域）

    const sameDomain = domain.length > 0 && String(row.domain ?? '') === domain;
    const sameWorkspace = wsKey.length > 0 && !!row.workspace_id && workspaceKey(String(row.workspace_id)) === wsKey;
    const ownProject = String(row.scope) === 'project' && sameWorkspace;

    // ③ 证据权重：直接复用 liveImportance 里**唯一**的 uses/hits 加成公式，
    //    把 now 钉在入库时刻 ⇒ 年龄项为 0，只剩「入库分 + 用法加成」，与运行时刻无关。
    const born = Date.parse(String(row.created_at ?? ''));
    const evidence = Number.isFinite(born) ? liveImportance(row, born) : 0;

    let raw = rel.score + evidence * EVIDENCE_WEIGHT;
    if (sameDomain) raw += AFFINITY_DOMAIN;          // ①
    if (sameWorkspace) raw += AFFINITY_WORKSPACE;    // ①
    if (ownProject) raw -= OWN_PROJECT_PENALTY;      // ④

    const normText = normalize(text);
    const matched = topicTokens.filter((t) => normText.includes(t)).slice(0, 3);
    const uses = Number(row.uses ?? 0);
    const hits = Number(row.hits ?? 0);

    ranked.push({
      hit: {
        lesson: row,
        reason: buildReason({
          domain, sameDomain, sameWorkspace, ownProject, matched, uses, hits,
        }),
        score: round3(raw),
      },
      raw,
      overlap: rel.score,
      evidence,
    });
  }

  // 排序必须**全序**：同分时用重合度、证据、id 依次兜底，保证与行顺序无关的稳定输出
  ranked.sort((a, b) =>
    b.raw - a.raw
    || b.overlap - a.overlap
    || b.evidence - a.evidence
    || a.hit.lesson.id - b.hit.lesson.id);

  return ranked.slice(0, limit).map((x) => x.hit);
}
