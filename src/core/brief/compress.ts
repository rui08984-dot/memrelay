// core/brief/compress.ts —— 简报的「超预算淘汰」（任务 S）
//
// ═══ 要解决的问题 ═══
// 简报此前按 48h + 条数截断：超出的条目**按时间一刀切**，旧的那个直接消失。
// 可「旧」不等于「不重要」—— 一条 40 小时前的决策如果后来被 search/show 打开过 9 次，
// 它比一小时前没人看过的口水决策更该留在简报里。本模块把「超预算时选谁」改成：
//     pinned > refCount > 新鲜度
// 并且**把淘汰条数交还调用方**（SelectByBudgetResult.evicted / compressedNote）：
// 简报可以变短，但不许静默变短。
//
// ═══ 三条纪律 ═══
// ① refCount 的唯一来源是全局库 search_feedback 的 open 事件（search-svc/feedback.ts）。
//    本模块只**读**：不建表、不写库（brief 是只读命令）。表不存在 = 还没有反馈数据 = 全 0。
// ② **未超预算时原样返回**（连顺序都不动）。任务边界是「只改超条数时选谁」，
//    不是借机重排既有输出 —— brief --json 是与客户端逐字段对拍过的契约。
//    真触发压缩时才启用优先级序，让「被反复引用的那条」排到最前（否则它虽然入选，
//    仍会被渲染层的 slice(0,5) 挡在屏幕外，功能等于没接）。
// ③ 平手裁决用**稳定键**而不是数组下标：同一个库、同一批条目，换个遍历顺序进来
//    也必须选出同一批、同一个顺序（否则同一时刻两次简报会不一样，本项目最忌的漂移）。
import type { Database } from 'better-sqlite3';
import { SEARCH_FEEDBACK_DDL } from '../../search-svc/feedback.js';

/** 参与淘汰的条目需要能被读到的字段（全部可选：决策/未决的行天然带其中几项）。 */
export interface BudgetItem {
  /** 稳定标识；缺省用 sessionId + text 组合（见 defaultKey） */
  id?: string;
  text?: string;
  sessionId?: string;
  /** 条目时间（ISO）；解析不了按 0（最旧）参与新鲜度比较 —— 宁可排后面，也不让它插队 */
  at?: string;
  /** 用户置顶：**最高优先级**，连「被引用次数」都压不过它 */
  pinned?: boolean;
  /** 条目自带的引用次数（没有 refCounts 映射时用它；都没有 = 0） */
  refCount?: number;
}

/** 淘汰时用到的外部信号。全部可选：不传就退化为「pinned > 新鲜度」（与旧行为同序）。 */
export interface SelectByBudgetOptions<T> {
  /**
   * sessionId → 被打开次数（search_feedback 的 open 计数）。
   * 同时接受 Map 与普通对象：CLI 侧是 Map，将来从 JSON 传过来就是普通对象。
   */
  readonly refCounts?: ReadonlyMap<string, number> | Readonly<Record<string, number>>;
  /** 稳定键（平手裁决 + evictedKeys）。缺省见 defaultKey；不规则条目请显式给。 */
  readonly keyOf?: (item: T) => string;
}

export interface SelectByBudgetResult<T> {
  /**
   * 入选条目：**按优先级从高到低**（pinned > refCount > 新鲜度 > 稳定键）。
   * 未超预算时是原数组（顺序不变）—— 见纪律②。
   */
  kept: T[];
  /** 被淘汰条数 = total - kept.length。调用方**必须**把它说出来（compressedNote）。 */
  evicted: number;
  /** 被淘汰条目的稳定键（按优先级从高到低），便于诊断 / 测试 */
  evictedKeys: string[];
  /** 参与选择的候选总数 */
  total: number;
  /** 生效预算；Infinity = 不限（预算不是有限数时按不限处理） */
  budget: number;
  /** 是否真的压缩过（evicted > 0 的便捷读取） */
  compressed: boolean;
}

/** 次数清洗：负数/NaN/Infinity 一律当 0（坏数据不许抢名额）。 */
function cleanCount(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** 从 Map 或普通对象里取 sessionId 的次数；没有这个键返回 undefined。 */
function lookupRefCount(
  map: SelectByBudgetOptions<unknown>['refCounts'],
  sessionId: string,
): number | undefined {
  if (!map || !sessionId) return undefined;
  const asMap = map as ReadonlyMap<string, number>;
  if (typeof asMap.get === 'function') {
    const v = asMap.get(sessionId);
    return v === undefined ? undefined : cleanCount(v);
  }
  const rec = map as Readonly<Record<string, number>>;
  return Object.prototype.hasOwnProperty.call(rec, sessionId) ? cleanCount(rec[sessionId]) : undefined;
}

/** 稳定键：id → sessionId + 正文 → 下标兜底（只在条目什么标识都没有时才会用到）。 */
function defaultKey(item: unknown, idx: number): string {
  const it = item as BudgetItem | null | undefined;
  const id = String(it?.id ?? '').trim();
  if (id) return id;
  const sid = String(it?.sessionId ?? '');
  const text = String(it?.text ?? '');
  if (sid || text) return sid + '\u0000' + text;
  return '\u0000#' + String(idx);
}

/**
 * 超预算时按 pinned > refCount > 新鲜度 选前 N 条。
 *
 * @param items 候选（调用方负责先做完时间窗/业务过滤；本函数不看 48h）
 * @param budget 预算（保留条数上限）。非有限数 = 不限；负数按 0（全淘汰）
 * @param opts refCounts / keyOf（见上）
 */
export function selectByBudget<T extends object>(
  items: readonly T[],
  budget: number,
  opts: SelectByBudgetOptions<T> = {},
): SelectByBudgetResult<T> {
  const all: T[] = Array.isArray(items) ? items.slice() : [];
  const total = all.length;
  const cap = Number.isFinite(budget) ? Math.max(0, Math.floor(budget)) : Number.POSITIVE_INFINITY;

  // 纪律②：没超预算 → 原样返回。连顺序都不动，既有输出契约不受影响。
  if (total <= cap) {
    return { kept: all, evicted: 0, evictedKeys: [], total, budget: cap, compressed: false };
  }

  const keys: string[] = all.map((item, idx) => {
    try {
      const custom = opts.keyOf ? String(opts.keyOf(item) ?? '') : '';
      if (custom) return custom;
    } catch { /* 键函数抛错不能让简报崩：退回默认键 */ }
    return defaultKey(item, idx);
  });

  const score = (item: T, idx: number): { pinned: number; refCount: number; recency: number } => {
    const it = item as BudgetItem;
    const sid = String(it?.sessionId ?? '').trim();
    const fromMap = lookupRefCount(opts.refCounts, sid);
    const t = Date.parse(String(it?.at ?? ''));
    return {
      pinned: it?.pinned === true ? 1 : 0,
      // 映射里有这个会话就用映射（权威来源），否则用条目自带字段；都没有 = 0
      refCount: fromMap !== undefined ? fromMap : cleanCount(it?.refCount),
      recency: Number.isFinite(t) ? t : 0,
    };
  };

  const ranked = all.map((item, idx) => ({ idx, key: keys[idx], ...score(item, idx) }));
  ranked.sort((a, b) =>
    b.pinned - a.pinned
    || b.refCount - a.refCount
    || b.recency - a.recency
    // 稳定键是**平手裁决**，不是第二套排序：分数全同也必须选出同一批（纪律③）
    || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
    || a.idx - b.idx);

  const wins = ranked.slice(0, cap);
  return {
    kept: wins.map((r) => all[r.idx]),
    evicted: total - wins.length,
    evictedKeys: ranked.slice(cap).map((r) => r.key),
    total,
    budget: cap,
    compressed: total - wins.length > 0,
  };
}

/**
 * 反馈表名。**唯一真相是 search-svc/feedback.ts 的 SEARCH_FEEDBACK_DDL** ——
 * 这里从 DDL 里取名字，而不是再手写一份字符串（将来改表名时读路径自动跟上）。
 */
const FEEDBACK_TABLE = /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+([A-Za-z_][\w]*)/i.exec(SEARCH_FEEDBACK_DDL)?.[1] ?? 'search_feedback';

export interface LoadRefCountsOptions {
  /** 只统计该项目的 open 事件（brief 的口径：cfg.identity.project_id ?? root）。缺省 = 全部项目。 */
  readonly project?: string;
}

/**
 * 从全局库读「每个会话被打开过几次」。
 *
 * 只读（不建表、不迁移）：brief 读路径不许写库。
 *   · 表不存在 ⇒ 返回空 Map —— 还没跑过 feedback，**正常状态**，全部按 0 处理；
 *   · 库不可读（锁/损坏）⇒ **抛** —— 读接口不假装"没有数据"，由调用方留痕并降级。
 */
export function loadRefCounts(
  db: Database | null | undefined,
  opts: LoadRefCountsOptions = {},
): Map<string, number> {
  const out = new Map<string, number>();
  if (!db) return out;
  const exists = db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(FEEDBACK_TABLE) as { ok?: number } | undefined;
  if (!exists) return out;
  const sql = 'SELECT session_id AS sessionId, COUNT(*) AS opens FROM ' + FEEDBACK_TABLE
    + (opts.project ? ' WHERE project = ?' : '') + ' GROUP BY session_id';
  const rows = (
    opts.project ? db.prepare(sql).all(String(opts.project)) : db.prepare(sql).all()
  ) as Array<{ sessionId?: unknown; opens?: unknown }>;
  for (const r of rows) {
    const sid = String(r?.sessionId ?? '').trim();
    const n = cleanCount(r?.opens);
    if (sid && n > 0) out.set(sid, n);
  }
  return out;
}

/**
 * 「压缩必须说出来」的**唯一文案**（与 hiddenFragmentsNote 同规：文案也只有一份）。
 *
 * @returns N ≤ 0 时返回 null —— 没有压缩就**一个字都不打**（每天多一行「已压缩 0 条」是噪音，
 *          也会让人以为简报一直在丢东西）。
 */
export function compressedNote(n: number): string | null {
  const v = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
  return v > 0 ? `已按引用次数压缩 ${v} 条` : null;
}
