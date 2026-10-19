// 记忆体检分（task-H）：把散在 audit 里的四条判据汇成**一个** 0-100 的分数 + A/B/C/D 等级。
//
// ═══ 为什么要有它 ═══
// audit 逐项报「几条」，但它不回答「这套记忆整体还健康吗、比上周好了还是差了」——
// 一句话说不清的健康度，人不会看第二次。分数是仪表盘，判据仍是 audit 那些；
// 本文件只做加权，**不发明任何新判据**（来源见每块实现与文件末的"判据来源"）。
//
// ═══ 权重（写死；改这里必须同时改 test/unit/health-score.spec.ts 的 100 分断言）═══
//   证据覆盖 evidenceCoverage  40   —— 决策能不能回跳到原文；缺 msgId 只剩位置索引 seq，消息重建后指错人
//   新鲜度   freshness         25   —— 记忆还在不在被使用（长期不动的库是化石，检索得到也没人信）
//   碎片率   fragmentRate      15   —— 「换成我们的了」这类离开上下文不成立的条目（**越低越好**）
//   审计 P0  auditP0           20   —— **可修复**的 P0（FTS 索引不一致）；归档未决属已接受历史债，只记录不扣分
//   ─────────────────────────────────
//   合计 100
//
// ═══ 每项 0..1 怎么算（口径）═══
//   evidenceCoverage = 1 - 缺 msgId 条数 / 可见决策条数            （listDecisions 口径，缺的条数取自 audit 同一函数）
//   freshness        = 距今 ≤ freshnessDays 的会话数 / 会话总数     （取 COALESCE(last_event_at, created_at)）
//   fragmentRate     = vagueDecisionObject 命中条数 / 可见决策条数   （**越低越好**；计分时取 1 - fragmentRate）
//   auditP0          = FTS 不一致 0 行 → 1；≥1 行 → 0                （**不按条数摊薄**；归档未决不参与计分，见下）
//   统一归一：全部 clamp 到 [0,1] 再乘权重，避免脏数据算出 107 分或 -3 分。
//
// ═══ 没有数据时（**不许静默**；每一条都同时写进 notes）═══
//   · 可见决策 0 条 → evidenceCoverage / fragmentRate = 0.5（"无从判断"：既不是满分，也不是零分）
//   · 会话 0 场     → freshness = 0.5
//   · FTS 检查不可用（旧库缺影子表）→ 0.5 + notes 写清「未测到」
//   · 读失败（旧库缺表/JSON 坏）→ 该项 0.5 + notes 写清原因（"未测量"绝不折算成"健康"）
//   三处 0.5 的后果：空库落在 60 分（C）——「无据可评」，而不是空库直接满分（那会骗人）。
//
// ═══ 等级 ═══
//   A ≥ 90 · B ≥ 75 · C ≥ 60 · D < 60
//   为什么 90 才 A：证据覆盖权重 40，缺 1/4 就丢 10 分；A 必须四块都基本干净。
//
// ═══ 只读 ═══
//   本模块只 SELECT（listDecisions / scanArchivedUnresolved 都是纯读），不建表、不迁移、不写一个字节；
//   CLI 用 openReadonly 打开，且**不** ensureDaemon（体检不该顺手拉起一个写进程，与 audit 同规）。
//
// ═══ 判据来源（"判据只许一份"）═══
//   证据覆盖 = core/audit/audit.ts:auditDecisionMsgIds（listDecisions + 缺 msgId 谓词，都在那一处）
//   碎片     = core/audit/audit.ts:auditDecisionFragments（→ vagueDecisionObject，抽取端同一份）
//   P0       = core/audit/audit.ts:auditFtsIntegrity（计分） + scanArchivedUnresolved（只记录，不计分）
//   新鲜度   = sessions.last_event_at（本文件唯一一条新 SQL，只按 project_id 圈定会话）
//   ⚠️ 本文件**不复制**上面任何谓词。代价是决策表被读三次（listDecisions × 3），
//      这是有意为之：宁可多扫两次，也不要出现"audit 报 32、score 报 30"的第三套口径。

import { listDecisions, type DB } from '../../store/db.js';
import {
  auditDecisionMsgIds, auditDecisionFragments, auditFtsIntegrity, scanArchivedUnresolved,
} from '../audit/audit.js';

/** 四项权重。写死在文件头；这是**唯一**一份，测试与 CLI 都 import 它。 */
export const HEALTH_WEIGHTS = {
  evidenceCoverage: 40,
  freshness: 25,
  fragmentRate: 15,
  auditP0: 20,
} as const;

/** 新鲜度窗口（天）。为什么是 30：简报的"最近在动"是 7 天（短窗看动向），
 *  体检问的是"这套记忆还有没有人在碰"——一个月是"还在用"与"已停用"的分界。 */
export const FRESHNESS_WINDOW_DAYS = 30;

/** 没有数据时的中性分量（0.5）。见文件头：既不是满分，也不是零分。 */
export const UNKNOWN_COMPONENT = 0.5;

/** 等级分界（含本数）。A ≥ 90 / B ≥ 75 / C ≥ 60 / D < 60。 */
export const GRADE_THRESHOLDS = { a: 90, b: 75, c: 60 } as const;

export type HealthGrade = 'A' | 'B' | 'C' | 'D';

export interface HealthComponents {
  /** 0..1，越高越好：可见决策里带 msgId（可回跳原文）的占比。 */
  evidenceCoverage: number;
  /** 0..1，越高越好：窗口内动过的会话占比。 */
  freshness: number;
  /** 0..1，**越低越好**：碎片占比。计分时取 1 - fragmentRate。 */
  fragmentRate: number;
  /** 0..1，越高越好：0 条 P0 = 1，有 P0 = 0，未测 = 0.5。 */
  auditP0: number;
}

export interface HealthReport {
  /** 0..100 的整数（四舍五入后的加权和）。 */
  score: number;
  grade: HealthGrade;
  components: HealthComponents;
  /** 每块的口径/计数/无数据或未测量的原因。**空数组是不可能的**：四块至少各有一条。 */
  notes: string[];
}

export interface HealthOptions {
  /** 「现在」的毫秒时间；确定性测试用。默认 Date.now()。 */
  now?: number;
  /** 新鲜度窗口（天）；默认 FRESHNESS_WINDOW_DAYS。 */
  freshnessDays?: number;
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return UNKNOWN_COMPONENT;
  return Math.min(1, Math.max(0, x));
}

function pct(x: number): string {
  return String(Math.round(clamp01(x) * 100)) + '%';
}

function errText(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.length > 160 ? m.slice(0, 160) + '…' : m;
}

/** 等级判据的唯一实现（CLI 与测试共用）。 */
export function gradeFor(score: number): HealthGrade {
  const s = Math.min(100, Math.max(0, Number(score) || 0));
  if (s >= GRADE_THRESHOLDS.a) return 'A';
  if (s >= GRADE_THRESHOLDS.b) return 'B';
  if (s >= GRADE_THRESHOLDS.c) return 'C';
  return 'D';
}

interface DecisionStats {
  total: number;
  missingMsgId: number;
  fragments: number;
}

/**
 * 决策侧的三条数。
 *
 * 三个数分别来自 audit 的两个检查函数 + listDecisions 本身 —— 见文件头"判据来源"：
 * 本项目宁可贵三次扫描，也不要第三套谓词（"audit 报 32、score 报 30"是本仓头号故障）。
 * clamp 到 total：两次读之间若守护正好写入（WAL 下快照不同），也不许出现 108% 的覆盖率。
 */
function measureDecisions(db: DB, projectId: string): DecisionStats {
  const total = listDecisions(db, projectId).length;
  const missingMsgId = Math.min(total, auditDecisionMsgIds(db, projectId).count);
  const fragments = Math.min(total, auditDecisionFragments(db, projectId).count);
  return { total, missingMsgId, fragments };
}

interface FreshnessStats {
  total: number;
  fresh: number;
  /** 时间解析不了的会话数：按"不新鲜"计，但必须说出来（不许静默当成新鲜）。 */
  unparsable: number;
}

/**
 * 会话新鲜度。
 *
 * 口径：本项目**全部**捕获会话（含探针/施工会话）——这里刻意不套 listDecisions 的
 * workflow/quarantine 可见性过滤：那条判据住在 store/db.ts，抄到这里就是第三份，漂移只是时间问题。
 * 时间取 COALESCE(last_event_at, created_at)（与 brief/status 的"最近"同字段）。
 * 在 JS 里解析而不是字符串比大小：created_at 有 date-only 与本地 ISO 混用的存量，
 * 词法比较会在窗口边界上偏差一天，而"某天算不算新鲜"正是这个分唯一在意的事。
 */
function measureFreshness(db: DB, projectId: string, now: number, days: number): FreshnessStats {
  const rows = db.prepare('SELECT COALESCE(last_event_at, created_at) AS at FROM sessions WHERE project_id = ?')
    .all(projectId) as Array<{ at: string | null }>;
  const cutoff = now - days * 86_400_000;
  let fresh = 0;
  let unparsable = 0;
  for (const r of rows) {
    const ms = Date.parse(String(r.at ?? ''));
    if (Number.isNaN(ms)) { unparsable++; continue; }
    if (ms >= cutoff) fresh++;
  }
  return { total: rows.length, fresh, unparsable };
}

interface AuditDebt {
  /** 可修复的 P0：FTS 索引不一致行数（计分项） */
  ftsCount: number;
  /** FTS 检查是否没测成（旧库缺影子表等）⇒ 未知，不是 0 */
  ftsSkipped: boolean;
  /** 已接受的历史债：归档会话上仍有未决（**不计分**，只记录） */
  archivedUnresolved: number;
  archivedSessions: number;
  hitSessions: number;
}

/**
 * 两块 P0 分开量，因为**处置方式不同**：
 *   · FTS 不一致可修复（重建索引即可）⇒ 进分数；
 *   · 归档未决不可逆（正文已删），且用户 10-19 已拍板「隐藏、不标 lost」⇒ 只记录不计分。
 * 判据仍然只 import audit（auditFtsIntegrity / scanArchivedUnresolved），不复制。
 */
function measureAuditDebt(db: DB, projectId: string): AuditDebt {
  const fts = auditFtsIntegrity(db);
  const scan = scanArchivedUnresolved(db, projectId);
  return {
    ftsCount: fts.status === 'skipped' ? 0 : fts.count,
    ftsSkipped: fts.status === 'skipped',
    archivedUnresolved: scan.items.length,
    archivedSessions: scan.archivedSessions,
    hitSessions: new Set(scan.items.map((i) => i.sessionId)).size,
  };
}

/**
 * 记忆体检分。
 *
 * 四块各自独立测量：某一项读失败只把那一项降级为 0.5（未测），**不拖垮**另外三项；
 * 失败原因一定进 notes —— "没测到"与"全干净"在输出里必须一眼能分开。
 */
export function computeHealth(db: DB, projectId: string, opts: HealthOptions = {}): HealthReport {
  const now = Number.isFinite(opts.now) ? Number(opts.now) : Date.now();
  const days = Number.isFinite(opts.freshnessDays) && Number(opts.freshnessDays) > 0
    ? Number(opts.freshnessDays)
    : FRESHNESS_WINDOW_DAYS;
  const notes: string[] = [];

  // ── ① 证据覆盖（40）+ ③ 碎片率（15）：同一次 listDecisions 口径 ──
  let evidenceCoverage = UNKNOWN_COMPONENT;
  let fragmentRate = UNKNOWN_COMPONENT;
  try {
    const d = measureDecisions(db, projectId);
    if (d.total === 0) {
      notes.push('证据覆盖无数据：本项目还没有可见决策 → 按 0.5（无从判断，不是满分）');
      notes.push('碎片率无数据：同上（0 条决策里没有碎片，也不等于干净）→ 按 0.5');
    } else {
      evidenceCoverage = clamp01(1 - d.missingMsgId / d.total);
      fragmentRate = clamp01(d.fragments / d.total);
      notes.push('证据覆盖 ' + pct(evidenceCoverage) + '：可见决策 ' + String(d.total)
        + ' 条，缺 msgId ' + String(d.missingMsgId) + ' 条（与 audit 同一判据；缺了只能回落 seq，重建后指错人）');
      notes.push('碎片率 ' + pct(fragmentRate) + '：' + String(d.fragments) + '/' + String(d.total)
        + ' 条是离开上下文不成立的碎片（vagueDecisionObject 判据，与抽取端同一份）');
    }
  } catch (e) {
    notes.push('证据覆盖/碎片率未测量：读决策失败（' + errText(e) + '）→ 两项按 0.5（不是"很干净"）');
  }

  // ── ② 新鲜度（25）──────────────────────────────────────────────
  let freshness = UNKNOWN_COMPONENT;
  try {
    const f = measureFreshness(db, projectId, now, days);
    if (f.total === 0) {
      notes.push('新鲜度无数据：本项目还没有会话 → 按 0.5（无从判断，不是"很旧"也不是"很新"）');
    } else {
      freshness = clamp01(f.fresh / f.total);
      notes.push('新鲜度 ' + pct(freshness) + '：' + String(f.fresh) + '/' + String(f.total)
        + ' 场会话在 ' + String(Math.round(days)) + ' 天内动过'
        + (f.unparsable > 0 ? '（另有 ' + String(f.unparsable) + ' 场时间解析不了，按不新鲜计）' : ''));
    }
  } catch (e) {
    notes.push('新鲜度未测量：读会话失败（' + errText(e) + '）→ 按 0.5');
  }

  // ── ④ 审计 P0（20）────────────────────────────────────────────
  // 为什么不按条数摊薄（如 1 - n/5）：audit 对 P0 的口径是"停工"（退出码 2），
  // 因为那是**不可逆**的——归档会话正文已蒸发，未决的出处永久指空。
  // 摊薄会让 1 条 P0 只扣 4 分（96 分仍评 A），与 audit 的严重性自相矛盾；
  // 条数明细仍然给：notes 里有条数与涉及会话数，不会因为二值化而丢失信息。
  let auditP0 = UNKNOWN_COMPONENT;
  try {
    const debt = measureAuditDebt(db, projectId);
    if (debt.ftsSkipped) {
      auditP0 = UNKNOWN_COMPONENT;
      notes.push('审计 P0 未测量：FTS 影子表缺失（旧库）→ 按 0.5（不是"没有 P0"）');
    } else if (debt.ftsCount > 0) {
      auditP0 = 0;
      notes.push('审计 P0 ' + String(debt.ftsCount) + ' 行：FTS 索引与正文不一致（可 `srelay audit` 查看样例，重建索引即修）→ 本项 0 分');
    } else {
      auditP0 = 1;
      notes.push('审计 P0 0 行：FTS 索引与正文一致（可修复项全干净）');
    }
    if (debt.archivedUnresolved > 0) {
      notes.push('归档未决 ' + String(debt.archivedUnresolved) + ' 条（' + String(debt.hitSessions) + ' 场会话）：正文已删、出处永久指空，**按 10-19 决定已从简报隐藏，属已接受历史债，不计入分数**（audit 仍记录）');
    }
  } catch (e) {
    notes.push('审计 P0 未测量：读审计判据失败（' + errText(e) + '）→ 按 0.5（不是"没有 P0"）');
  }

  const weighted =
    HEALTH_WEIGHTS.evidenceCoverage * evidenceCoverage
    + HEALTH_WEIGHTS.freshness * freshness
    + HEALTH_WEIGHTS.fragmentRate * (1 - fragmentRate)   // 碎片率是坏指标：越低越健康
    + HEALTH_WEIGHTS.auditP0 * auditP0;
  const score = Math.max(0, Math.min(100, Math.round(weighted)));

  return {
    score,
    grade: gradeFor(score),
    components: { evidenceCoverage, freshness, fragmentRate, auditP0 },
    notes,
  };
}
