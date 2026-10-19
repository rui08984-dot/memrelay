// srelay market —— 跨项目经验市场的命令行入口。
//
// 核心判据只有一份：src/core/lessons/market.ts（本文件只做「取当前项目上下文 + 呈现」）。
// 取上下文的两条纪律：
//   · 工作区/领域一律走 resolveWorkspaceId / resolveDomain（写读同源，不另算一份）；
//   · 项目库**只读**打开（openReadonly）：推荐命令不许顺手迁移/写库/抢锁。
import fs from 'node:fs';
import { pc } from './ui.js';
import { globalDbFile, liveImportance } from '../store/global.js';
import { openReadonly } from '../store/db.js';
import { MARKET_DEFAULT_LIMIT, recommendLessons } from '../core/lessons/market.js';
import { resolveDomain, resolveWorkspaceId } from '../shared/workspace.js';
import { dbFile, findRelayRoot } from '../shared/paths.js';

export interface MarketFlags { limit?: string; json?: boolean }

/** 汇总最近多少个会话的话题 */
const RECENT_SESSIONS = 20;
/** 话题总上限：巨型项目的话题能到几百个，全塞进查询等于没有重点 */
const MAX_TOPICS = 40;

/**
 * 本项目最近话题：最近会话的 sessions.topics 汇总（去重、保序）。
 *
 * 读不到（未初始化 / 旧库没这列 / 被占用）返回空数组 —— 由调用方给可操作提示，
 * 不在这里猜、也不退化成「拿全部历史话题硬凑」。
 */
export function recentTopicsFromProject(root: string | null | undefined): string[] {
  if (!root) return [];
  const file = dbFile(root);
  if (!fs.existsSync(file)) return [];
  let db: ReturnType<typeof openReadonly> | undefined;
  try {
    db = openReadonly(file);
    const rows = db.prepare(
      "SELECT topics FROM sessions WHERE topics IS NOT NULL AND topics <> '' "
      + 'ORDER BY COALESCE(last_event_at, created_at) DESC LIMIT ?'
    ).all(RECENT_SESSIONS) as Array<{ topics?: string | null }>;
    const out: string[] = [];
    const seen = new Set<string>();
    for (const r of rows) {
      let arr: unknown;
      try { arr = JSON.parse(String(r.topics ?? '[]')); } catch { continue; }
      if (!Array.isArray(arr)) continue;
      for (const t of arr) {
        const s = String(t ?? '').trim();
        if (!s || seen.has(s)) continue;
        seen.add(s);
        out.push(s);
        if (out.length >= MAX_TOPICS) return out;
      }
    }
    return out;
  } catch {
    return [];
  } finally {
    try { db?.close(); } catch { /* 已关闭 */ }
  }
}

/**
 * srelay market [topics...]
 *
 * 不传话题 ⇒ 用本项目最近会话的话题；传了 ⇒ 用你给的词（临时查某个方向时有用）。
 * 输出「经验 + 为什么推荐」；--json 输出 recommendLessons 的原始数组。
 */
export async function cmdMarket(topicArgs: string[], f: MarketFlags): Promise<void> {
  const ws = resolveWorkspaceId(process.cwd());
  const domain = resolveDomain(ws);

  let limit = MARKET_DEFAULT_LIMIT;
  if (f.limit !== undefined) {
    const n = Number(f.limit);
    if (!Number.isFinite(n) || n < 1) { console.error(pc.red('✗ --limit 需要正整数')); process.exit(2); }
    limit = Math.floor(n);
  }

  const explicit = topicArgs.length > 0;
  const topics = explicit ? topicArgs : recentTopicsFromProject(findRelayRoot(process.cwd()));
  if (topics.length === 0) {
    if (f.json) { console.log(JSON.stringify([])); return; }
    console.log(pc.dim(explicit
      ? '（话题为空）'
      : '（本项目还没有可用话题：先跑 srelay sync，或直接 srelay market <关键词...> 指定话题）'));
    return;
  }

  // 全局库也**只读**打开：市场是推荐命令，不许顺手建表/迁移/抢写锁
  const file = globalDbFile();
  if (!fs.existsSync(file)) {
    if (f.json) { console.log(JSON.stringify([])); return; }
    console.log(pc.dim('（全局经验库还没有内容：先 srelay lesson add 或 lesson harvest 攒几条）'));
    return;
  }
  let db: ReturnType<typeof openReadonly>;
  try {
    db = openReadonly(file);
  } catch (e) {
    console.error(pc.red('✗ 打不开全局经验库（只读）：' + (e as Error).message));
    process.exitCode = 1;
    return;
  }
  try {
    const items = recommendLessons(db, { workspaceId: ws, domain, topics, limit });
    if (f.json) { console.log(JSON.stringify(items)); return; }

    console.log(pc.dim('经验市场 · 工作区 ' + ws + (domain ? ' · 领域 ' + domain : '')
      + ' · 话题 ' + topics.slice(0, 8).join('/')));
    if (items.length === 0) {
      console.log(pc.dim('（没有可推荐的经验：上架先过注入闸；这些话题没有命中任何已验证经验）'));
      return;
    }
    for (const it of items) {
      const l = it.lesson;
      console.log('  ' + pc.bold(it.score.toFixed(2)) + ' '
        + pc.dim('[' + l.scope + '|' + l.grade + '|' + Number(liveImportance(l)).toFixed(1) + ']')
        + ' ' + l.text);
      console.log(pc.dim('      为什么：' + it.reason));
    }
    console.log(pc.dim('\n共 ' + items.length + ' 条 · 只读推荐；能不能进上下文仍由可见性（visibleWhere）+ 注入闸（isInjectable）共同决定'));
  } finally {
    db.close();
  }
}
