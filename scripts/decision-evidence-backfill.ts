// scripts/decision-evidence-backfill.ts —— 决策出处（evidence）回填：**默认 dry-run，--apply 才写库**。
//
// 要回答的问题（task-12）：653 条决策里多少缺 msgId？按 (session_id, seq) 反查 messages.id 的成功率
//   是多少？缺的那些，是「能补」「补不了」还是「说不清」？
//
// 纪律（为什么这样写，而不是在脚本里再写一遍 SQL/判据）：
//   ① **判据只许一份**：能不能定位由 store/db.ts 的 `resolveMessageRef` 说了算 —— 它正是三条读路径
//      （cli/meta.ts · mcp/server.ts · relay/export.ts）共用的那个收口函数。脚本自己写一份 SQL，
//      迟早会出现「脚本报能回填、读端说查不到」两套口径各说各话（那正是 v22 的 msgId 覆盖率 0% 的病根形态）。
//   ② 覆盖率数字用 `msgIdCoverage`（唯一口径），不在脚本里重复 parse decisions 去数总数。
//   ③ 只读打开用 `openReadonly`（绝不迁移/建表/写字节）；只有 --apply 才用 `openExisting`。
//   ④ **宁缺勿假**：只有「(session_id, seq) 命中 + 决策时间戳 == 消息 created_at + 消息正文含该决策句首」
//      三条全过的才写。写错一个 msgId 的代价是读端回跳到**别人的正文** —— 比没有 msgId 更糟
//      （同族判断见 capture/rebuild.ts:59：映射不到就删字段，不留假 id）。
//   ⑤ decisions 只在「加 msgId」时改写，正文一个字不动 ⇒ meta_text（title+topics+决策前 30 字+tags）
//      不受影响，故不重算 —— 但这条前提变了（比如顺手改 text）就必须补 `recomputeSessionMetaText`。
//
// 用法：
//   npx tsx scripts/decision-evidence-backfill.ts [<db>]            # dry-run：统计 + 10 条样例
//   npx tsx scripts/decision-evidence-backfill.ts [<db>] --apply    # 写回「能回填」那 0..N 条
//   选项：--db <path>  --samples <n>
//   库默认 <cwd>/.sessionrelay/relay.sqlite。
//
// ⚠️ --apply 时若有守护（watch）在跑，请先停：两边会写同一条 sessions.decisions。
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  openReadonly, openExisting, resolveMessageRef, getMessageById, countMessages, msgIdCoverage,
  type DB,
} from '../src/store/db.js';
import { normalize } from '../src/core/tokenize/tokenizer.js';

// ───────────────────────── 证据核对的两个判据（导出以便单测钉死） ─────────────────────────

/** 用于「正文里找得到这句」的探针长度（去空白后的字符数）。 */
export const EVIDENCE_PROBE_CHARS = 12;
/** 探针短于此长度就没有区分度 —— 不猜，直接判「说不清」。 */
export const EVIDENCE_MIN_PROBE = 6;

/** 去空白归一：复用 tokenizer 的 normalize（NFC + 全角转半角 + 小写 + 空白折叠），再去掉空白。 */
function squash(s: unknown): string {
  return normalize(String(s ?? '')).replace(/\s+/g, '');
}

/**
 * 决策时间戳与消息 created_at 是否同一时刻。
 * unknown = 任一侧解析不了（**不算一致**：没有证据就不许写）。
 */
export function timestampAgrees(at: unknown, createdAt: string | null | undefined): 'ok' | 'mismatch' | 'unknown' {
  const a = typeof at === 'string' && at.trim() !== '' ? Date.parse(at) : NaN;
  const b = typeof createdAt === 'string' && createdAt.trim() !== '' ? Date.parse(createdAt) : NaN;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 'unknown';
  return a === b ? 'ok' : 'mismatch';
}

/** 决策句首是否出现在消息正文里（去空白比对，抵挡抽取期的换行/空格差异）。 */
export function textCorroborates(decisionText: unknown, messageContent: unknown): 'ok' | 'mismatch' | 'too-short' {
  const probe = squash(decisionText).slice(0, EVIDENCE_PROBE_CHARS);
  if (probe.length < EVIDENCE_MIN_PROBE) return 'too-short';
  return squash(messageContent).includes(probe) ? 'ok' : 'mismatch';
}

// ───────────────────────── 分类 ─────────────────────────

/**
 * 每条决策的处置类别。
 *   ok            已经有 msgId 且语料里查得到（无需任何动作）
 *   danglingMsgId 有 msgId 但 messages 里没有（原文已归档）—— 读端已按 via='none' 如实报告；**不动**
 *   backfillable  没有 msgId，但 seq 命中 + 时间一致 + 正文含该句 ⇒ 可安全回填
 *   ambiguous     seq 命中，但证据对不上（时间/正文/与同会话已知 msgId 冲突）⇒ 不猜
 *   unrecoverable 没有 msgId 且 seq 也查不到（原文已归档 / 该 seq 已无消息）⇒ 补不了
 */
export type EvidenceStatus = 'ok' | 'danglingMsgId' | 'backfillable' | 'ambiguous' | 'unrecoverable';

export interface EvidenceItem {
  sessionId: string;
  seq: number | null;
  text: string;
  status: EvidenceStatus;
  /** 现有 msgId（仅 ok / danglingMsgId 有） */
  msgId?: string | number;
  /** 反查到的目标消息（backfillable / ok 有） */
  targetMsgId?: string | number;
  targetSeq?: number | null;
  role?: string;
  /** 分类依据（ambiguous / unrecoverable 必填，便于报告里解释为什么不动） */
  reason?: string;
}

export interface CoverageTotals {
  decisions: { total: number; withMsgId: number };
  questions: { total: number; withMsgId: number };
  unresolved: { total: number; withMsgId: number };
}

export interface EvidenceReport {
  dryRun: boolean;
  sessions: number;
  decisions: number;
  /** 缺 msgId 的决策条数 */
  missingMsgId: number;
  coverage: CoverageTotals;
  counts: Record<EvidenceStatus, number>;
  /** 失败原因分布（reason → 条数） */
  reasons: Record<string, number>;
  /** 按 (session_id, seq) 反查 messages.id 的成功率 */
  reverseLookup: { attempted: number; resolved: number; missingAttempted: number; missingResolved: number };
  /** msgId 命中但 seq_num ≠ 条目记的 seq（= 序号漂移的真实证据） */
  seqDrift: number;
  samples: EvidenceItem[];
  items: EvidenceItem[];
  written: { sessions: number; decisions: number; skipped: number };
}

function parseArray(raw: unknown): Array<Record<string, unknown>> {
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? (v as Array<Record<string, unknown>>) : [];
  } catch { return []; }
}

function toIntSeq(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 条目里的 msgId → 可用的键（数字或非空字符串）；其余一律当「没有」。 */
function msgIdOf(v: unknown): string | number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') return v.trim();
  return null;
}

function hasMsgId(v: unknown): boolean {
  return msgIdOf(v) !== null;
}

export interface AnalyzeOptions {
  /** 报告里带出多少条样例（默认 10；0 = 不带） */
  sampleLimit?: number;
}

/** 只读分析：分类全部决策 + 统计反查成功率。**不写一个字节。** */
export function analyzeDecisionEvidence(db: DB, opts: AnalyzeOptions = {}): EvidenceReport {
  const sampleLimit = Math.max(0, opts.sampleLimit ?? 10);
  const projectIds = (db.prepare('SELECT DISTINCT project_id AS p FROM sessions ORDER BY 1').all() as Array<{ p: string }>).map((r) => r.p);
  const coverage: CoverageTotals = { decisions: { total: 0, withMsgId: 0 }, questions: { total: 0, withMsgId: 0 }, unresolved: { total: 0, withMsgId: 0 } };
  for (const p of projectIds) {
    const c = msgIdCoverage(db, p);
    coverage.decisions.total += c.decisions.total; coverage.decisions.withMsgId += c.decisions.withMsgId;
    coverage.questions.total += c.questions.total; coverage.questions.withMsgId += c.questions.withMsgId;
    coverage.unresolved.total += c.unresolved.total; coverage.unresolved.withMsgId += c.unresolved.withMsgId;
  }

  const rows = db.prepare("SELECT id AS sid, decisions FROM sessions WHERE decisions IS NOT NULL AND decisions != '[]'").all() as Array<{ sid: string; decisions: string }>;
  const counts: Record<EvidenceStatus, number> = { ok: 0, danglingMsgId: 0, backfillable: 0, ambiguous: 0, unrecoverable: 0 };
  const reasons = new Map<string, number>();
  const bumpReason = (r: string): void => { reasons.set(r, (reasons.get(r) ?? 0) + 1); };
  const items: EvidenceItem[] = [];
  let sessionsWithDecisions = 0;
  let decisions = 0;
  let missingMsgId = 0;
  let reverseAttempted = 0;
  let reverseResolved = 0;
  let missingAttempted = 0;
  let missingResolved = 0;
  let seqDrift = 0;

  for (const row of rows) {
    const decs = parseArray(row.decisions);
    if (decs.length === 0) continue;
    sessionsWithDecisions++;
    // 同会话内 seq → 已知 msgId 集合：用来发现「seq 指向的消息」与「别处记的 msgId」互相矛盾
    const known = new Map<number, Set<string>>();
    for (const d of decs) {
      const s = toIntSeq(d.seq);
      const mid = msgIdOf(d.msgId);
      if (s === null || mid === null) continue;
      const set = known.get(s) ?? new Set<string>();
      set.add(String(mid));
      known.set(s, set);
    }
    for (const d of decs) {
      decisions++;
      const seq = toIntSeq(d.seq);
      const text = String(d.text ?? '');
      // 反查（对每条决策都试一次 seq 那条路 —— 这就是任务要的成功率）
      reverseAttempted++;
      const seqRef = seq === null ? null : resolveMessageRef(db, row.sid, { seq });
      const seqHit = seqRef !== null && seqRef.via === 'seq' && seqRef.message !== undefined;
      if (seqHit) reverseResolved++;

      let item: EvidenceItem;
      const mid = msgIdOf(d.msgId);
      if (mid !== null) {
        // 有 msgId：按稳定主键判（读端同款：查不到就是 none，**刻意不回落 seq**）
        const ref = resolveMessageRef(db, row.sid, { msgId: mid });
        if (ref.via === 'msgId' && ref.message) {
          if (seq !== null && Number(ref.message.seq_num) !== seq) seqDrift++;
          item = {
            sessionId: row.sid, seq, text, status: 'ok', msgId: mid,
            targetMsgId: ref.message.id, targetSeq: ref.message.seq_num, role: ref.message.role,
          };
        } else {
          item = { sessionId: row.sid, seq, text, status: 'danglingMsgId', msgId: mid, reason: 'msgId 在 messages 里查不到（原文已归档）' };
        }
      } else {
        missingMsgId++;
        missingAttempted++;
        if (seq === null) {
          item = { sessionId: row.sid, seq, text, status: 'unrecoverable', reason: 'no-seq：条目没记 seq' };
        } else if (!seqHit || !seqRef?.message) {
          const msgs = countMessages(db, row.sid);
          item = {
            sessionId: row.sid, seq, text, status: 'unrecoverable',
            reason: msgs === 0 ? 'archived：该会话正文已归档（messages 为空）' : 'seq-absent：该 seq 已无消息（裁剪/漂移）',
          };
        } else {
          missingResolved++;
          const m = getMessageById(db, row.sid, seqRef.message.id);
          if (!m) {
            item = { sessionId: row.sid, seq, text, status: 'ambiguous', reason: 'seq 命中但取不到正文' };
          } else {
            const sib = known.get(seq);
            const conflict = sib !== undefined && [...sib].some((x) => Number(x) !== Number(m.id));
            const ts = timestampAgrees(d.at, m.created_at);
            const txt = textCorroborates(d.text, m.content);
            if (conflict) {
              item = { sessionId: row.sid, seq, text, status: 'ambiguous', targetMsgId: m.id, targetSeq: m.seq_num, reason: 'seq-msgId-conflict：同会话同 seq 已记的 msgId 指向别的消息' };
            } else if (ts === 'ok' && txt === 'ok') {
              item = { sessionId: row.sid, seq, text, status: 'backfillable', targetMsgId: m.id, targetSeq: m.seq_num, role: m.role };
            } else {
              item = {
                sessionId: row.sid, seq, text, status: 'ambiguous', targetMsgId: m.id, targetSeq: m.seq_num,
                reason: 'ts-' + ts + ' / text-' + txt,
              };
            }
          }
        }
      }
      counts[item.status]++;
      if (item.reason) bumpReason(item.reason);
      items.push(item);
    }
  }

  // 样例：按「最能说明问题」的顺序轮转取，缺哪类就先给哪类
  const order: EvidenceStatus[] = ['backfillable', 'ambiguous', 'unrecoverable', 'danglingMsgId', 'ok'];
  const buckets = new Map<EvidenceStatus, EvidenceItem[]>();
  for (const it of items) {
    const b = buckets.get(it.status) ?? [];
    if (b.length < sampleLimit) b.push(it);
    buckets.set(it.status, b);
  }
  const samples: EvidenceItem[] = [];
  let round = 0;
  while (samples.length < sampleLimit && round < sampleLimit) {
    for (const st of order) {
      if (samples.length >= sampleLimit) break;
      const b = buckets.get(st);
      if (b && b[round]) samples.push(b[round]);
    }
    round++;
  }

  return {
    dryRun: true,
    sessions: sessionsWithDecisions,
    decisions,
    missingMsgId,
    coverage,
    counts,
    reasons: Object.fromEntries([...reasons.entries()].sort((a, b) => b[1] - a[1])),
    reverseLookup: { attempted: reverseAttempted, resolved: reverseResolved, missingAttempted, missingResolved },
    seqDrift,
    samples,
    items,
    written: { sessions: 0, decisions: 0, skipped: 0 },
  };
}

export interface BackfillOptions extends AnalyzeOptions {
  /** 不传 / false = dry-run（只统计不写库）。 */
  apply?: boolean;
}

/**
 * 分析 + （可选）写回。**只写 status='backfillable' 那一类**，其余一律不动。
 * 写回时逐会话**重读一次** decisions 再改：只给「同 seq 同 text 且仍没有 msgId」的条目补 id，
 * 期间被别人改过/合并过的条目自然匹配不上 ⇒ 计入 skipped 而不是盲写。
 */
export function backfillDecisionEvidence(db: DB, opts: BackfillOptions = {}): EvidenceReport {
  const report = analyzeDecisionEvidence(db, { sampleLimit: opts.sampleLimit });
  if (opts.apply !== true) return report;
  report.dryRun = false;

  const plans = new Map<string, EvidenceItem[]>();
  for (const it of report.items) {
    if (it.status !== 'backfillable' || it.targetMsgId === undefined) continue;
    const list = plans.get(it.sessionId) ?? [];
    list.push(it);
    plans.set(it.sessionId, list);
  }
  if (plans.size === 0) return report;

  const upd = db.prepare('UPDATE sessions SET decisions = ? WHERE id = ?');
  const read = db.prepare('SELECT decisions FROM sessions WHERE id = ?');
  db.transaction(() => {
    for (const [sid, list] of plans) {
      const row = read.get(sid) as { decisions?: string } | undefined;
      if (!row) { report.written.skipped += list.length; continue; }
      const cur = parseArray(row.decisions);
      let changed = 0;
      for (const it of list) {
        const target = cur.find((d) => !hasMsgId(d.msgId) && toIntSeq(d.seq) === it.seq && String(d.text ?? '') === it.text);
        if (!target) { report.written.skipped++; continue; }
        // 与重算写路径同形：msgId 归一成字符串（messages.id 是 INTEGER，两路形态保持一致）
        target.msgId = String(it.targetMsgId);
        changed++;
      }
      if (changed > 0) {
        upd.run(JSON.stringify(cur), sid);
        report.written.sessions++;
        report.written.decisions += changed;
      }
    }
  })();
  return report;
}

// ───────────────────────── 输出 ─────────────────────────

const pct = (a: number, b: number): string => (b === 0 ? '0.0' : ((a / b) * 100).toFixed(1));

export function formatReport(rep: EvidenceReport, dbPath = ''): string[] {
  const L: string[] = [];
  const c = rep.counts;
  L.push('决策出处回填分析（' + (rep.dryRun ? 'dry-run · 只读' : 'APPLY · 已写库') + '）');
  if (dbPath) L.push('库：' + dbPath);
  L.push('');
  L.push('决策 ' + rep.decisions + ' 条 / 有决策的会话 ' + rep.sessions + ' 个');
  L.push('已带 msgId ' + rep.coverage.decisions.withMsgId + ' 条（' + pct(rep.coverage.decisions.withMsgId, rep.coverage.decisions.total) + '%）· 缺 msgId ' + rep.missingMsgId + ' 条');
  L.push('按 (session_id, seq) 反查 messages.id：全程 ' + rep.reverseLookup.resolved + '/' + rep.reverseLookup.attempted
    + '（' + pct(rep.reverseLookup.resolved, rep.reverseLookup.attempted) + '%）'
    + ' · 只看缺 msgId 的 ' + rep.reverseLookup.missingResolved + '/' + rep.reverseLookup.missingAttempted
    + '（' + pct(rep.reverseLookup.missingResolved, rep.reverseLookup.missingAttempted) + '%）');
  L.push('');
  L.push('分类：');
  L.push('  能回填   ' + c.backfillable + ' 条（seq 命中 + 时间戳一致 + 正文含该句，三条全过）');
  L.push('  不能回填 ' + c.unrecoverable + ' 条（原文已归档 / 该 seq 已无消息）');
  L.push('  歧义     ' + c.ambiguous + ' 条（seq 命中但证据对不上，不猜）');
  L.push('  已就位   ' + c.ok + ' 条（msgId 可定位，无需动作）');
  L.push('  msgId 悬空 ' + c.danglingMsgId + ' 条（有 msgId 但原文已归档，读端如实报 none，不动）');
  const reasonEntries = Object.entries(rep.reasons);
  if (reasonEntries.length > 0) {
    L.push('');
    L.push('不写库的原因：');
    for (const [r, n] of reasonEntries) L.push('  ' + n + ' × ' + r);
  }
  L.push('');
  L.push('seq 与 msgId 不一致（msgId 命中但 seq_num≠条目 seq）：' + rep.seqDrift + ' 条');
  L.push('另：key_questions ' + rep.coverage.questions.total + ' 条（带 msgId ' + rep.coverage.questions.withMsgId
    + '）· 其中未决 ' + rep.coverage.unresolved.total + ' 条（带 msgId ' + rep.coverage.unresolved.withMsgId + '）');
  if (rep.samples.length > 0) {
    L.push('');
    L.push('样例（' + rep.samples.length + ' 条）：');
    const label: Record<EvidenceStatus, string> = {
      ok: '已就位', danglingMsgId: '悬空', backfillable: '能回填', ambiguous: '歧义', unrecoverable: '不能回填',
    };
    for (const s of rep.samples) {
      const target = s.targetMsgId !== undefined ? ' → msgId=' + String(s.targetMsgId) : '';
      L.push('  [' + label[s.status] + '] ' + s.sessionId.slice(0, 8) + ' seq=' + (s.seq ?? '—') + target
        + (s.reason ? ' · ' + s.reason : '') + ' | ' + s.text.replace(/\s+/g, ' ').slice(0, 40));
    }
  }
  L.push('');
  if (rep.dryRun) {
    L.push('未写库。确认数字后加 --apply 才写（只写「能回填」那一类）。');
  } else {
    L.push('已写回：' + rep.written.sessions + ' 个会话 / ' + rep.written.decisions + ' 条决策（跳过 ' + rep.written.skipped + ' 条：期间被改动或已带 msgId）');
    L.push('decisions 只加了 msgId，正文未动 ⇒ meta_text 不受影响，故未重算。');
  }
  return L;
}

/** CLI 入口（返回退出码；导出以便单测直接调）。 */
export function main(argv: string[]): number {
  const args = argv.slice(2);
  const consumed = new Set<number>();
  for (const name of ['db', 'samples']) {
    const i = args.indexOf('--' + name);
    if (i >= 0) consumed.add(i + 1);
  }
  const valOf = (n: string): string | undefined => {
    const i = args.indexOf('--' + n);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const positional = args.find((a, i) => !a.startsWith('--') && !consumed.has(i));
  const dbPath = valOf('db') ?? positional ?? path.join(process.cwd(), '.sessionrelay', 'relay.sqlite');
  const apply = args.includes('--apply');
  const sampleLimit = Number(valOf('samples') ?? '10');

  let db: DB;
  try {
    db = apply ? openExisting(dbPath) : openReadonly(dbPath);
  } catch (e) {
    console.error('✗ 打不开库：' + dbPath + '（' + ((e as Error)?.message ?? String(e)) + '）');
    console.error('用法：npx tsx scripts/decision-evidence-backfill.ts [<db>] [--apply] [--samples 10]');
    return 2;
  }
  try {
    const rep = backfillDecisionEvidence(db, { apply, sampleLimit: Number.isFinite(sampleLimit) ? sampleLimit : 10 });
    for (const line of formatReport(rep, dbPath)) console.log(line);
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
    console.error('✗ ' + ((e as Error)?.message ?? String(e)));
    process.exitCode = 1;
  }
}
