// 审计契约（task-11）：六项**只读**健康检查，P0/P1 分级，各给条数 + 前 5 条样例 id。
//
// ═══ 为什么要有它 ═══
// 本仓的失败模式一直是「静默失效」：数据在降级，而每条命令都只说自己那一点，没人看全貌。
// doctor 查的是**环境**（Node/jieba/源目录/服务）；audit 查的是**库里的内容契约**：
// 决策有没有出处锚点、碎片有没有混进来、经验有没有卡在草稿、归档会话的未决是不是已经指空、
// 地图节点有没有证据声明、FTS 索引与内容表还对不对得上。
//
// ═══ 三条纪律 ═══
// ① **判据只许一份**：能复用的一律 import——决策可见集 = listDecisions（去重/workflow/隔离口径
//    全在那一处）、未决 = listUnresolved、碎片 = vagueDecisionObject、年龄 = decisionAgeDays、
//    经验可见性 = visibleWhere、地图 = listPages/readPageIfExists。本文件**不复制**任何判据，
//    否则 audit 会变成"第三套口径"，报出来的数跟 brief/status 各说各话（本项目头号故障）。
// ② **只读**：全部检查走只读句柄，不建表、不迁移、不写一个字节。
//    ⚠️ 这一条直接决定了 FTS 检查怎么写：SQLite 官方的
//    `INSERT INTO fts(fts) VALUES('integrity-check')` 会**写库**（实测在 readonly 句柄上抛
//    "attempt to write a readonly database"）⇒ 不能用。改用 FTS5 影子表 messages_fts_docsize
//    与内容表做**双向差集**（幽灵行 / 漏索引行），语义等价于 integrity-check 的核心断言
//    「索引里的每一行都在内容表里，内容表的每一行都在索引里」，且纯 SELECT。
// ③ **容错不许静默**：读不到就 status='skipped' 并写清 note（原因），绝不当 0 报。
//    「没有地图」是正常状态（还没建图），「地图读坏了」是错误 —— 两种都不许变成 0 条。
//
// ═══ 退出码 ═══
//   0 = 六项全过（或跳过项不影响结论）
//   1 = 只有 P1 命中（质量债，可修）
//   2 = 有 P0 命中（不可逆的数据缺失 / 检索静默损坏）

import { existsSync } from 'node:fs';
import { dbFile, globalDbFile } from '../../shared/paths.js';
import { listDecisions, listUnresolved, type DB } from '../../store/db.js';
import { decisionAgeDays } from '../../store/decision-validity.js';
import { vagueDecisionObject } from '../extract/extract.js';
import { visibleWhere } from '../../store/global.js';
import { listPages, readPageIfExists } from '../../map/index.js';

export type AuditSeverity = 'P0' | 'P1';
export type AuditCheckId =
  | 'decision-missing-msgid'
  | 'decision-fragment'
  | 'lesson-draft-stale'
  | 'archived-unresolved'
  | 'map-node-no-sources'
  | 'fts-integrity';

/** 报告的三种结论。skipped 必须带 note —— 见文件头纪律 ③。 */
export type AuditStatus = 'ok' | 'fail' | 'skipped';

export interface AuditFinding {
  id: AuditCheckId;
  severity: AuditSeverity;
  /** 人话判据（含阈值），跟数字一起显示；不许出现"这个数怎么算的"说不清的情况 */
  criteria: string;
  status: AuditStatus;
  /** 命中的条数；skipped 时为 0（**但不是"没有"**，看 note） */
  count: number;
  /** 前 5 条样例 id（≤5）。口径见 SAMPLE_LIMIT */
  samples: string[];
  /** 补充说明：skipped 的原因，或命中里值得单独说的子集（如 done 且无证据的节点数） */
  note?: string;
}

export interface AuditReport {
  projectId: string;
  root: string | null;
  generatedAt: string;
  checks: AuditFinding[];
  /** 命中项数按级别分开数——这是"要不要停工"的唯一依据 */
  totals: { p0: number; p1: number; failed: number; skipped: number };
  exitCode: 0 | 1 | 2;
}

/** 样例上限。5 是"一眼能看完"与"够定位一批"的折中：再多就不是样例而是全量了。 */
export const SAMPLE_LIMIT = 5;

/** 经验草稿的未升格阈值（天）。判据只在这一个常量上出现，测试与 CLI 共用。 */
export const LESSON_DRAFT_STALE_DAYS = 30;

export interface AuditCheckMeta {
  id: AuditCheckId;
  severity: AuditSeverity;
  title: string;
  criteria: string;
}

/**
 * 六项检查的**唯一清单**（顺序即输出顺序，与任务清单一致）。
 * severity 为什么这么分：
 *   P0 = 修不回来或正在静默骗人 —— 归档会话的未决（正文已蒸发，出处永久指空）、
 *        FTS 与内容表不一致（检索双路都查不到，而界面上只表现为"搜不到"）。
 *   P1 = 看得见、可修的质量债 —— 出处可回落 seq、碎片可 recompute 清、草稿可人工升格、
 *        地图节点可补 sources。
 */
export const AUDIT_CHECKS: readonly AuditCheckMeta[] = [
  {
    id: 'decision-missing-msgid',
    severity: 'P1',
    title: '决策缺 msgId（出处回跳只能回落 seq）',
    criteria: '可见决策（listDecisions 口径）里 msgId 缺失的条数。seq 是位置索引，消息被裁剪/重建后会指到**错的那条**；补法是 srelay recompute（只覆盖还有正文的会话）',
  },
  {
    id: 'decision-fragment',
    severity: 'P1',
    title: '决策碎片（宾语只有指代/所属）',
    criteria: '可见决策里 vagueDecisionObject(text)=true 的条数——「换成我们的了」「决定这样」这类离开上下文不成立的碎片；判据与抽取端/清理端同一份（core/extract/extract.ts）',
  },
  {
    id: 'lesson-draft-stale',
    severity: 'P1',
    title: '经验草稿超 ' + String(LESSON_DRAFT_STALE_DAYS) + ' 天未升格',
    criteria: '全局经验库里 status=draft 且创建超过 ' + String(LESSON_DRAFT_STALE_DAYS) + ' 天的条数（可见范围 = visibleWhere 口径：global + 本项目 + 本项目领域）。草稿永远进不了注入层，放着等于白采集',
  },
  {
    id: 'archived-unresolved',
    severity: 'P0',
    title: '已归档会话仍有未决',
    criteria: '未决（listUnresolved 口径）落在 cleanup_at 非空的会话上的条数。这些会话正文已蒸发 ⇒ 未决的出处 msgId/seq 永久指空，回跳只会报"原文已归档"',
  },
  {
    id: 'map-node-no-sources',
    severity: 'P1',
    title: '地图节点无 sources（没有证据声明）',
    criteria: '地图页里 sources 为空/缺省的节点数。sources 是证据声明：没有它 map check 覆盖不到该节点（无基线 ⇒ unknown，永远不会红），done 节点没有 sources 就是假绿',
  },
  {
    id: 'fts-integrity',
    severity: 'P0',
    title: 'FTS 索引与内容表不一致',
    criteria: 'messages_fts/sessions_fts 的幽灵行（索引里有、内容表没有）+ 漏索引行（内容表有、索引里没有）。只读等价实现：与 FTS5 影子表 *_fts_docsize 做双向差集，不用会写库的 integrity-check 命令（见文件头纪律 ②）',
  },
];

export function metaOf(id: AuditCheckId): AuditCheckMeta {
  const m = AUDIT_CHECKS.find((x) => x.id === id);
  // 清单是常量、id 是联合类型 ⇒ 这里不可能走到；抛错而不是返回假值，免得契约破了还装作没事
  if (m === undefined) throw new Error('未定义的审计项：' + String(id));
  return m;
}

function finding(id: AuditCheckId, count: number, samples: string[], note?: string): AuditFinding {
  const m = metaOf(id);
  return {
    id,
    severity: m.severity,
    criteria: m.criteria,
    status: count > 0 ? 'fail' : 'ok',
    count,
    samples: samples.slice(0, SAMPLE_LIMIT),
    ...(note ? { note } : {}),
  };
}

function skipped(id: AuditCheckId, note: string): AuditFinding {
  const m = metaOf(id);
  return { id, severity: m.severity, criteria: m.criteria, status: 'skipped', count: 0, samples: [], note };
}

// ───────────────────────── 1) 决策缺 msgId ─────────────────────────

/** 样例 id 的口径：sessionId#seq——决策条目自己没有主键，这两个字段合起来唯一定位一条。 */
export function decisionSampleId(d: { sessionId: string; seq: number }): string {
  return d.sessionId + '#' + String(d.seq);
}

export function auditDecisionMsgIds(db: DB, projectId: string): AuditFinding {
  const rows = listDecisions(db, projectId);
  const missing = rows.filter((d) => d.msgId === undefined || d.msgId === null || String(d.msgId).trim() === '');
  return finding('decision-missing-msgid', missing.length, missing.map(decisionSampleId),
    rows.length ? '覆盖 ' + String(rows.length - missing.length) + '/' + String(rows.length) + ' 条' : undefined);
}

// ───────────────────────── 2) 决策碎片 ─────────────────────────

export function auditDecisionFragments(db: DB, projectId: string): AuditFinding {
  const rows = listDecisions(db, projectId);
  const frags = rows.filter((d) => vagueDecisionObject(String(d.text ?? '')));
  return finding('decision-fragment', frags.length, frags.map(decisionSampleId));
}

// ─────────────────── 3) 经验草稿超 30 天未升格 ───────────────────

/** 一条经验草稿算不算"超期未升格"。**唯一判据**：状态是 draft + 年龄 > 阈值。
 *  时间解析不了 → false（宁可漏报一条，也不把"时间坏了"报成"草稿过期"；坏时间另有 doctor 管）。 */
export function isStaleDraft(createdAt: string | null | undefined, now = Date.now(), days = LESSON_DRAFT_STALE_DAYS): boolean {
  const age = decisionAgeDays(createdAt, now);   // 复用同一份"整日向下取整"的年龄算法
  return age !== null && age > days;
}

export interface LessonAuditSel { workspaceId?: string; domain?: string }

export function auditStaleLessonDrafts(global: DB | null | undefined, sel: LessonAuditSel, now = Date.now()): AuditFinding {
  if (!global) return skipped('lesson-draft-stale', '全局经验库打不开/不存在（' + globalDbFile() + '），本项未测量');
  let rows: Array<{ id: number; created_at: string }>;
  try {
    const w = visibleWhere(sel);   // 与 lesson list / 注入层同一份可见性判据
    rows = global.prepare(
      "SELECT id, created_at FROM lessons WHERE " + w.sql + " AND status = 'draft' ORDER BY created_at",
    ).all(...w.params) as Array<{ id: number; created_at: string }>;
  } catch (e) {
    // 老库缺表/缺列：如实说"没测到"，不许当 0 条报（那样看着像"经验层很健康"）
    return skipped('lesson-draft-stale', '读经验表失败：' + errText(e));
  }
  const stale = rows.filter((r) => isStaleDraft(r.created_at, now));
  return finding('lesson-draft-stale', stale.length, stale.map((r) => 'lesson#' + String(r.id)),
    rows.length ? '可见草稿共 ' + String(rows.length) + ' 条' : undefined);
}

// ─────────────── 4) 已归档会话仍有未决 ───────────────

export function auditArchivedUnresolved(db: DB, projectId: string): AuditFinding {
  // 归档口径 = cleanup_at 非空（与 panel 的 archived 卡片同一定义：正文已蒸发、结论仍在）
  const archived = new Set(
    (db.prepare('SELECT id FROM sessions WHERE project_id = ? AND cleanup_at IS NOT NULL').all(projectId) as Array<{ id: string }>)
      .map((r) => r.id),
  );
  if (archived.size === 0) return finding('archived-unresolved', 0, []);
  // 未决口径 = listUnresolved（去重 / workflow 排除 / 隔离排除都只有那一份）；
  // 上限给足以免被默认 20 截断成假 0（截断过就永远看不见这条 P0）
  const rows = listUnresolved(db, projectId, Number.MAX_SAFE_INTEGER);
  const hit = rows.filter((r) => archived.has(r.sessionId));
  const hitSessions = new Set(hit.map((r) => r.sessionId)).size;
  // 样例 id：sessionId#msgId；没有 msgId 的写 sessionId#-（**不写 seq**：UnresolvedRow 里没有 seq，
  // 编一个出来就等于在报告里伪造定位键——本仓最嫌恶的那类"看起来能点开、点开是错的"）
  return finding('archived-unresolved', hit.length,
    hit.map((r) => r.sessionId + '#' + (r.msgId === undefined || r.msgId === null ? '-' : String(r.msgId))),
    '已归档会话 ' + String(archived.size) + ' 场，其中仍有未决的 ' + String(hitSessions) + ' 场');
}

// ─────────────── 5) 地图节点无 sources ───────────────

export function auditMapNodesWithoutSources(root: string | null | undefined): AuditFinding {
  if (!root) return skipped('map-node-no-sources', '没有项目根，无法定位 .sessionrelay/map');
  const pages = listPages(root);
  if (!pages.ok) return skipped('map-node-no-sources', '地图目录读不了：' + pages.error.message);
  if (pages.value.length === 0) return skipped('map-node-no-sources', '还没有地图页（未建图 ≠ 有债）');
  const plain: string[] = [];
  const doneSamples: string[] = [];
  const notes: string[] = [];
  let count = 0;
  let doneCount = 0;
  for (const p of pages.value) {
    const read = readPageIfExists(root, p.id);
    if (!read.ok) { notes.push('页 ' + p.id + ' 读不了：' + read.error.message); continue; }
    if (read.value === undefined) continue;
    for (const node of read.value.page.nodes) {
      if ((node.sources?.length ?? 0) > 0) continue;
      count++;
      const id = p.id + '/' + node.id;
      if (node.status === 'done') { doneCount++; doneSamples.push(id); } else plain.push(id);
    }
  }
  if (count === 0 && notes.length > 0) return skipped('map-node-no-sources', notes.join('；'));
  // done 的排在前面：同样缺证据，"已完成却没证据"比"待办还没写证据"更值得先看
  const ordered = [...doneSamples, ...plain];
  const tail = [doneCount > 0 ? '其中 status=done 的 ' + String(doneCount) + ' 个（done 无证据 = 假绿）' : '', ...notes].filter(Boolean).join('；');
  return finding('map-node-no-sources', count, ordered, tail || undefined);
}

// ─────────────── 6) FTS 索引与内容表一致性 ───────────────

interface ShadowProbe { table: string; content: string; key: string }

/** 两张外部内容 FTS 表 + 它们各自的影子表与内容主键（content_rowid 见 store/db.ts 的 DDL）。 */
const SHADOWS: readonly ShadowProbe[] = [
  { table: 'messages_fts', content: 'messages', key: 'id' },
  { table: 'sessions_fts', content: 'sessions', key: 'rowid' },
];

function tableExists(db: DB, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE name = ? AND type IN ('table','view')").get(name) !== undefined;
}

export function auditFtsIntegrity(db: DB): AuditFinding {
  const samples: string[] = [];
  const notes: string[] = [];
  let count = 0;
  let measured = 0;
  for (const s of SHADOWS) {
    if (!tableExists(db, s.content)) { notes.push(s.content + ' 表不存在（旧库？）'); continue; }
    const docsize = s.table + '_docsize';
    if (!tableExists(db, docsize)) { notes.push(docsize + ' 影子表不存在（fts5 版本差异），本表未测量'); continue; }
    measured++;
    const ghostSql = ' FROM ' + docsize + ' d WHERE NOT EXISTS (SELECT 1 FROM ' + s.content + ' c WHERE c.' + s.key + ' = d.id)';
    const missingSql = ' FROM ' + s.content + ' c WHERE NOT EXISTS (SELECT 1 FROM ' + docsize + ' d WHERE d.id = c.' + s.key + ')';
    const n = (sql: string): number => Number((db.prepare('SELECT COUNT(*) AS n' + sql).get() as { n?: number } | undefined)?.n ?? 0);
    const ghosts = n(ghostSql);
    const missing = n(missingSql);
    count += ghosts + missing;
    if (ghosts > 0) {
      for (const r of db.prepare('SELECT d.id AS id' + ghostSql + ' ORDER BY d.id LIMIT ' + String(SAMPLE_LIMIT)).all() as Array<{ id: number | string }>) {
        samples.push(s.table + ':ghost#' + String(r.id));
      }
    }
    if (missing > 0) {
      for (const r of db.prepare('SELECT c.' + s.key + ' AS id' + missingSql + ' ORDER BY c.' + s.key + ' LIMIT ' + String(SAMPLE_LIMIT)).all() as Array<{ id: number | string }>) {
        samples.push(s.table + ':missing#' + String(r.id));
      }
    }
  }
  if (measured === 0) return skipped('fts-integrity', notes.join('；') || '没有可测量的 FTS 表');
  return finding('fts-integrity', count, samples, notes.length ? notes.join('；') : undefined);
}

// ───────────────────────── 汇总 ─────────────────────────

export interface AuditInput {
  db: DB;
  projectId: string;
  /** 全局经验库（只读句柄）；给 null/undefined = 打不开，本项算 skipped */
  global?: DB | null;
  root?: string | null;
  /** 经验可见范围（与 lesson list 同源：resolveWorkspaceId / resolveDomain） */
  lessonSel?: LessonAuditSel;
  now?: number;
}

/** 退出码**唯一实现**：有 P0 命中 → 2；只有 P1 → 1；都没有 → 0。 */
export function exitCodeOf(checks: readonly AuditFinding[]): 0 | 1 | 2 {
  const fail = checks.filter((c) => c.status === 'fail' && c.count > 0);
  if (fail.some((c) => c.severity === 'P0')) return 2;
  if (fail.length > 0) return 1;
  return 0;
}

function errText(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.length > 200 ? m.slice(0, 200) + '…' : m;
}

/** 单项失败不许拖垮整场审计（doctor 同规）：抛错的检查降级为 skipped，原因写进 note。 */
function guard(id: AuditCheckId, run: () => AuditFinding): AuditFinding {
  try { return run(); } catch (e) { return skipped(id, '检查抛错：' + errText(e)); }
}

export function runAudit(input: AuditInput): AuditReport {
  const now = input.now ?? Date.now();
  const sel: LessonAuditSel = input.lessonSel ?? {};
  const root = input.root ?? null;
  const checks: AuditFinding[] = [
    guard('decision-missing-msgid', () => auditDecisionMsgIds(input.db, input.projectId)),
    guard('decision-fragment', () => auditDecisionFragments(input.db, input.projectId)),
    guard('lesson-draft-stale', () => auditStaleLessonDrafts(input.global ?? null, sel, now)),
    guard('archived-unresolved', () => auditArchivedUnresolved(input.db, input.projectId)),
    guard('map-node-no-sources', () => auditMapNodesWithoutSources(root)),
    guard('fts-integrity', () => auditFtsIntegrity(input.db)),
  ];
  const fail = checks.filter((c) => c.status === 'fail' && c.count > 0);
  return {
    projectId: input.projectId,
    root,
    generatedAt: new Date(now).toISOString(),
    checks,
    totals: {
      p0: fail.filter((c) => c.severity === 'P0').length,
      p1: fail.filter((c) => c.severity === 'P1').length,
      failed: fail.length,
      skipped: checks.filter((c) => c.status === 'skipped').length,
    },
    exitCode: exitCodeOf(checks),
  };
}

/** audit 查的是**哪两个库**的唯一说法（CLI 与测试共用；存在性由这里给，不让调用方各判一次）。 */
export function auditDbPaths(root: string): { project: string; global: string; projectExists: boolean; globalExists: boolean } {
  const project = dbFile(root);
  const global = globalDbFile();
  return { project, global, projectExists: existsSync(project), globalExists: existsSync(global) };
}
