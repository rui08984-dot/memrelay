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
import {
  MARKET_DEFAULT_LIMIT,
  MARKET_MAX_LIMIT,
  recommendLessons,
  type MarketHit,
} from '../core/lessons/market.js';
import { resolveDomain, resolveWorkspaceId } from '../shared/workspace.js';
import { dbFile, findRelayRoot } from '../shared/paths.js';

export interface MarketFlags { limit?: string; json?: boolean }

/**
 * 话题词是否像"工具名/路径/网页/测试噪声"——这类词做检索锚点没有判别力。
 *
 * 病历（1020 实测）：不给话题时市场自动推断，结果推出了
 * `reply / single / word / pong / page / mcp__playwright-mcp__browser_navigate / https`
 * ——全是测试会话与工具名，于是"跨项目经验推荐"等于瞎猜。
 * 判据故意写成**窄规则**（宁可少推，不推垃圾）：工具名 / 路径 URL / 文件名 / 常见测试词。
 */
export function isNoisyTopic(t: string): boolean {
  const s = String(t ?? '').trim();
  if (s.length < 2 || s.length > 40) return true;
  if (/^mcp__/i.test(s)) return true;                       // MCP 工具名
  if (/^[a-z]+(_+[a-z]+)+$/i.test(s)) return true;          // snake_case 标识符
  if (/^https?:\/\//i.test(s) || s.includes('/') || s.includes('\\')) return true;  // URL / 路径
  if (/\.(md|json|js|mjs|ts|tsx|py|ya?ml|toml|sqlite|db|exe|log|txt)$/i.test(s)) return true; // 文件名
  if (/^(reply|single|word|pong|ping|test|ok|yes|no|hello|hi|page|https?)$/i.test(s)) return true; // 测试噪声
  return false;
}

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
    // [1020] 判别力闸：**同一个话题至少出现在 2 场会话里**才留（纯 ASCII 的才查这条；
    //   中文话题本身有语义、一次也留）。理由：一次性的测试/工具名只会出现一场，
    //   拿它当检索锚点等于瞎猜（实测推出过 such / exists / title. 这种）。
    const count = new Map<string, number>();
    const perRow: string[][] = [];
    for (const r of rows) {
      let arr: unknown;
      try { arr = JSON.parse(String(r.topics ?? '[]')); } catch { continue; }
      if (!Array.isArray(arr)) continue;
      const list = arr.map((x) => String(x ?? '').trim()).filter((x) => x && !isNoisyTopic(x));
      perRow.push(list);
      for (const t of new Set(list)) count.set(t, (count.get(t) ?? 0) + 1);
    }
    const hasCjk = (s: string): boolean => /[\u4e00-\u9fff]/.test(s);
    for (const list of perRow) {
      for (const s of list) {
        if (seen.has(s)) continue;
        if (!hasCjk(s) && (count.get(s) ?? 0) < 2) continue;   // 英文一次性词：不要
        if (/\.[a-z]{2,6}$/i.test(s) && !hasCjk(s)) continue;   // 域名 / 带扩展名的串
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

/** --limit / MCP 的 limit 解析（**唯一实现**）：未给 → 默认；非法 → RangeError；超上限 → 截断。 */
export function resolveMarketLimit(limit: number | undefined): number {
  if (limit === undefined || limit === null) return MARKET_DEFAULT_LIMIT;
  const n = Number(limit);
  if (!Number.isFinite(n) || n < 1) throw new RangeError('limit 需要正整数');
  return Math.min(Math.floor(n), MARKET_MAX_LIMIT);
}

export interface MarketReport {
  workspaceId: string;
  domain: string | undefined;
  topics: string[];
  limit: number;
  items: MarketHit[];
  /** 空结果的唯一解释（不让调用方面对「空数组没有理由」） */
  note: string | null;
}

/**
 * 经验市场的**唯一取数 + 排序路径**（CLI 与 MCP 共用）。
 *
 * 只读：项目库与全局库都**只读**打开（openReadonly）；不建表、不迁移、不抢写锁。
 * 话题未显式给出时，用本项目最近会话的 topics（recentTopicsFromProject）。
 * 全局库打不开是**故障**（抛错，让 CLI/MCP 看见），不是「没有推荐」。
 */
export function runMarket(
  root: string | null | undefined,
  topicArgs: string[],
  limitIn?: number,
): MarketReport {
  const ws = resolveWorkspaceId(root ?? process.cwd());
  const domain = resolveDomain(ws);
  const limit = resolveMarketLimit(limitIn);
  const explicit = topicArgs.length > 0;
  const topics = explicit
    ? topicArgs.map((t) => String(t ?? '').trim()).filter(Boolean)
    : recentTopicsFromProject(root);
  const base = { workspaceId: ws, domain, topics, limit };

  if (topics.length === 0) {
    return {
      ...base,
      items: [],
      note: explicit
        ? '话题为空'
        : '本项目还没有可用话题：先跑 srelay sync，或直接 srelay market <关键词...> 指定话题',
    };
  }

  // 全局库也**只读**打开：市场是推荐命令，不许顺手建表/迁移/抢写锁
  const file = globalDbFile();
  if (!fs.existsSync(file)) {
    return {
      ...base,
      items: [],
      note: '全局经验库还没有内容：先 srelay lesson add 或 lesson harvest 攒几条',
    };
  }
  let db: ReturnType<typeof openReadonly>;
  try {
    db = openReadonly(file);
  } catch (e) {
    throw new Error('打不开全局经验库（只读）：' + (e as Error).message);
  }
  try {
    const items = recommendLessons(db, { workspaceId: ws, domain, topics, limit });
    return {
      ...base,
      items,
      note: items.length === 0
        ? '没有可推荐的经验：上架先过注入闸；这些话题没有命中任何已验证经验'
        : null,
    };
  } finally {
    db.close();
  }
}

/**
 * srelay market [topics...]
 *
 * 不传话题 ⇒ 用本项目最近会话的话题；传了 ⇒ 用你给的词（临时查某个方向时有用）。
 * 输出「经验 + 为什么推荐」；--json 输出 recommendLessons 的原始数组。
 */
export async function cmdMarket(topicArgs: string[], f: MarketFlags): Promise<void> {
  let rep: MarketReport;
  try {
    rep = runMarket(findRelayRoot(process.cwd()), topicArgs,
      f.limit === undefined ? undefined : Number(f.limit));
  } catch (e) {
    if (e instanceof RangeError) { console.error(pc.red('✗ --limit 需要正整数')); process.exit(2); }
    console.error(pc.red('✗ ' + (e as Error).message));
    process.exitCode = 1;
    return;
  }
  if (f.json) { console.log(JSON.stringify(rep.items)); return; }
  if (rep.topics.length === 0) { console.log(pc.dim('（' + rep.note + '）')); return; }

  console.log(pc.dim('经验市场 · 工作区 ' + rep.workspaceId + (rep.domain ? ' · 领域 ' + rep.domain : '')
    + ' · 话题 ' + rep.topics.slice(0, 8).join('/')));
  if (rep.items.length === 0) {
    console.log(pc.dim('（' + rep.note + '）'));
    return;
  }
  for (const it of rep.items) {
    const l = it.lesson;
    console.log('  ' + pc.bold(it.score.toFixed(2)) + ' '
      + pc.dim('[' + l.scope + '|' + l.grade + '|' + Number(liveImportance(l)).toFixed(1) + ']')
      + ' ' + l.text);
    console.log(pc.dim('      为什么：' + it.reason));
  }
  console.log(pc.dim('\n共 ' + rep.items.length + ' 条 · 只读推荐；能不能进上下文仍由可见性（visibleWhere）+ 注入闸（isInjectable）共同决定'));
}