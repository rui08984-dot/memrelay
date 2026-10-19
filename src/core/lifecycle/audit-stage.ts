// audit-stage.ts —— 生命周期第 12 阶段：把 `srelay audit` 的六项**只读**检查挂进每日流水线。
//
// ═══ 为什么需要它 ═══
// audit 之前只能手动跑：六项检查写得再好，也等于"体检报告放在抽屉里"。归档会话的未决（P0）
// 会一直躺在库里，而每天跑的所有阶段都不看它一眼 —— 这就是本仓最嫌恶的「绿着的坏」。
// 挂进生命周期后：每天一次，有 P0 就写 health_events（warn）+ 进简报顶部。
//
// ═══ 三条纪律 ═══
// ① 判据只许一份：六项检查全部走 core/audit/audit.ts 的 runAudit。本文件只做
//    「逐项目开只读句柄 → 汇总 → 生成告警文案」，**不复制任何检查逻辑**。
// ② 只读：项目库用 openReadonly（fileMustExist），全局库用 openGlobalAuditReadonly。
//    本文件不写任何库；运行记录（lifecycle / health_events）由 runner 拿到报告后写。
// ③ 不许静默失败：打不开的库进 items 且 status='skipped' + note（原因），
//    unreadable 计数随汇总一路报到阶段 note 与健康记录里，绝不当成"0 条 = 很健康"。
import { existsSync } from 'node:fs';
import { openReadonly, type DB } from '../../store/db.js';
import { dbFile, projectIdOf } from '../../shared/paths.js';
import { loadConfig } from '../../shared/config.js';
import { resolveDomain, resolveWorkspaceId } from '../../shared/workspace.js';
import {
  runAudit, metaOf, openGlobalAuditReadonly, type AuditCheckId, type AuditFinding,
} from '../audit/audit.js';

/**
 * P0 项在告警行里的**文案**（不是判据：分级与条数全来自 audit.ts 的 AuditFinding）。
 * 只覆盖当前两个 P0 检查；将来新增 P0 项没填这里会自动退回 title，不会漏报。
 * 单位写在文案里而不是统一拼"条"：FTS 不一致是"行"，归档未决是"条"，混用会读成病句。
 */
const P0_PHRASE: Partial<Record<AuditCheckId, (n: number) => string>> = {
  'archived-unresolved': (n) => `${n} 条归档会话仍有未决`,
  'fts-integrity': (n) => `FTS 索引不一致 ${n} 行`,
};

/** 告警行（简报顶部那一行）的唯一拼法：`⚠ 审计 P0：32 条归档会话仍有未决` */
export function auditAlertLine(fails: readonly AuditFinding[]): string {
  const p0 = fails.filter((f) => f.severity === 'P0' && f.status === 'fail' && f.count > 0);
  if (p0.length === 0) return '';
  return '⚠ 审计 P0：' + p0
    .map((f) => (P0_PHRASE[f.id] ? P0_PHRASE[f.id]!(f.count) : `${f.count} 条${metaOf(f.id).title}`))
    .join(' · ');
}

export interface AuditStageProject {
  root: string;
  status: 'ok' | 'fail' | 'skipped';
  /** P0 命中**项**数（与 audit 的 totals.p0 同义：项，不是条） */
  p0: number;
  p1: number;
  /** 跳过的检查项数（例如没有地图 / 全局库被占用） */
  skipped: number;
  /** 命中摘要（含条数），只列 fail 的项 */
  hits: string[];
  /** 仅 p0>0 时非空：一行告警 */
  alert: string | null;
  /** skipped 原因或补充说明 */
  note?: string;
}

export interface AuditStageReport {
  projects: number;
  p0: number;
  p1: number;
  skipped: number;
  /** 打不开的项目库数（没测到 ≠ 健康） */
  unreadable: number;
  items: AuditStageProject[];
  /** 第一个有 P0 的项目的告警（runner 打印用；简报按项目各自读 health_events） */
  alert: string | null;
  /** 写进 lifecycle.stages[audit].note 的一句话 */
  note: string;
}

export interface AuditStageOptions {
  roots: string[];
  now?: number;
  /** 测试注入：打开项目库（默认 openReadonly —— 只读是纪律，不是可选项） */
  openProjectDb?: (file: string) => DB;
  /** 测试注入：打开全局库（默认 openGlobalAuditReadonly；返回 null = 没测到） */
  openGlobalDb?: () => { db: DB | null; reason?: string | null };
}

/** 单项目：六项检查 → 命中摘要 + 告警。只读；失败不抛给调用方（打包成 skipped）。 */
function auditOne(root: string, opts: AuditStageOptions, global: DB | null): AuditStageProject {
  const file = dbFile(root);
  if (!existsSync(file)) {
    return { root, status: 'skipped', p0: 0, p1: 0, skipped: 0, hits: [], alert: null, note: '项目库不存在（尚未初始化）：' + file };
  }
  let db: DB | null = null;
  try {
    db = (opts.openProjectDb ?? openReadonly)(file);
  } catch (e) {
    return { root, status: 'skipped', p0: 0, p1: 0, skipped: 0, hits: [], alert: null, note: '项目库打不开：' + (e instanceof Error ? e.message : String(e)) };
  }
  try {
    // project_id 必须走 config 优先（与 capture/listDecisions 同源）；配置坏了用路径推导兜底。
    // 绝不能退回 root —— 库里存的是 project_id，退回 root 会让六项全部报 0（假绿）。
    let projectId = projectIdOf(root);
    try { projectId = loadConfig(root).identity?.project_id ?? projectId; } catch { /* 配置坏了不阻塞审计 */ }
    const report = runAudit({
      db,
      projectId,
      global,
      root,
      lessonSel: { workspaceId: resolveWorkspaceId(root), domain: resolveDomain(root) },
      now: opts.now,
    });
    const fails = report.checks.filter((c) => c.status === 'fail' && c.count > 0);
    const alert = auditAlertLine(fails);
    const hits = fails.map((c) => `${metaOf(c.id).title}：${String(c.count)} 条`);
    return {
      root,
      status: report.totals.p0 > 0 ? 'fail' : 'ok',
      p0: report.totals.p0,
      p1: report.totals.p1,
      skipped: report.totals.skipped,
      hits,
      alert: alert || null,
      ...(hits.length === 0 && report.totals.skipped > 0 ? { note: '六项中 ' + String(report.totals.skipped) + ' 项没测到（原因见 health_events）' } : {}),
    };
  } finally {
    try { db.close(); } catch { /* 已关 */ }
  }
}

/**
 * 跑一轮审计（**零写入**）。roots 由 runner 的 registry 给；测试直接传临时项目根。
 *
 * 全局库整轮只开一次（不是每项目一次）：六项里只有"经验草稿超期"读全局库，
 * 而 N 个项目各开一个只读句柄再忘关，是典型的句柄泄漏 —— 守护每天跑一轮，
 * 几天后就是几十个悬挂句柄。
 */
export function runAuditStage(opts: AuditStageOptions): AuditStageReport {
  const roots = Array.isArray(opts.roots) ? [...new Set(opts.roots)] : [];
  const owned = opts.openGlobalDb === undefined;   // 默认打开器由本函数负责关闭；注入的交给测试
  const g = (opts.openGlobalDb ?? openGlobalAuditReadonly)();
  let items: AuditStageProject[];
  try {
    items = roots.map((r) => auditOne(r, opts, g.db ?? null));
  } finally {
    if (owned) { try { g.db?.close(); } catch { /* 已关 */ } }
  }
  const p0 = items.reduce((a, x) => a + x.p0, 0);
  const p1 = items.reduce((a, x) => a + x.p1, 0);
  const skipped = items.reduce((a, x) => a + x.skipped, 0);
  const unreadable = items.filter((x) => x.status === 'skipped').length;
  const firstAlert = items.find((x) => x.alert !== null)?.alert ?? null;
  const bits = [
    roots.length === 0 ? '没有登记的项目（registry 为空）' : `审计 ${roots.length} 个项目`,
    `P0 ${p0} 项`, `P1 ${p1} 项`, `跳过 ${skipped} 项`,
  ];
  if (unreadable > 0) bits.push(`${unreadable} 个项目没测到（原因见日志/health_events）`);
  return { projects: roots.length, p0, p1, skipped, unreadable, items, alert: firstAlert, note: bits.join(' · ') };
}

/** 告警有效期：超过这么久还没有新结论，就不再拿旧结论吓人（生命周期状态页仍能看到最后运行时间） */
export const AUDIT_ALERT_MAX_AGE_MS = 7 * 86_400_000;

const normRoot = (p: string): string => String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/**
 * 读"最近一次审计对**这个项目**的结论"，供简报顶部使用。
 *
 * 语义刻意是**最新一条**、不是"最近一条 warn"：修完 P0 之后下一次审计写 info，
 * 旧 warn 必须立刻失效 —— 否则红字会一直挂到修好之后（狼来了，比没有告警更糟）。
 * 返回 string = 有 P0；null = 无 P0 / 没跑过 / 结论过期 / 全局库读不到（读不到的原因由调用方留痕）。
 */
export function latestAuditAlert(
  global: DB | null | undefined,
  root: string,
  opts: { now?: number; maxAgeMs?: number } = {},
): string | null {
  if (!global) return null;
  const now = opts.now ?? Date.now();
  const maxAge = opts.maxAgeMs ?? AUDIT_ALERT_MAX_AGE_MS;
  let rows: Array<{ at: string; level: string; detail: string | null }>;
  try {
    rows = global.prepare("SELECT at, level, detail FROM health_events WHERE stage = 'audit' ORDER BY id DESC LIMIT 200")
      .all() as Array<{ at: string; level: string; detail: string | null }>;
  } catch {
    return null;   // 老库没有 health_events 表 = 还没跑过生命周期，属正常状态
  }
  const want = normRoot(root);
  for (const r of rows) {
    let d: { root?: string; alert?: string | null } = {};
    try { d = JSON.parse(String(r.detail ?? '{}')) as { root?: string; alert?: string | null }; } catch { continue; }
    if (normRoot(d.root ?? '') !== want) continue;
    const t = Date.parse(r.at);
    if (!Number.isFinite(t) || now - t > maxAge) return null;   // 最新一条已过期 ⇒ 不再当现状
    return r.level === 'warn' && d.alert ? String(d.alert) : null;
  }
  return null;
}
