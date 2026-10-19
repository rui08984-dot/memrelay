// 记忆体检分（task-H）：五条钉子——满分 / 低分 / 无数据 / 权重和=100 / 确定性。
//
// 纪律：夹具只造数据，判据一律由 computeHealth 自己算。断言里的 40/25/15/20 不是"再抄一份权重"，
// 而是任务书写死的契约（改权重必须同时改这里，否则这条会红——这正是它存在的意义）。
import { describe, it, expect, afterEach } from 'vitest';
import { createDb, insertSession, insertMessage, type DB } from '../../src/store/db.js';
import { computeHealth, gradeFor, HEALTH_WEIGHTS } from '../../src/core/health/score.js';

/** 固定「现在」：体检分只依赖传入的 now，绝不依赖墙钟（否则同一库早晚算两个分）。 */
const NOW = Date.parse('2026-10-19T12:00:00.000Z');
const iso = (daysAgo: number): string => new Date(NOW - daysAgo * 86_400_000).toISOString();

let dbs: DB[] = [];
afterEach(() => {
  for (const db of dbs) { try { db.close(); } catch { /* 已关 */ } }
  dbs = [];
});

function makeDb(): DB {
  const db = createDb();
  dbs.push(db);
  return db;
}

/** 会话夹具：insertSession 不接收 last_event_at / cleanup_at，故建完再 UPDATE（与 audit.spec 同法）。 */
function seedSession(db: DB, id: string, o: { ageDays: number; lastEventDays?: number; archived?: boolean }): void {
  insertSession(db, {
    id, source: 'zcode', sourceSessionId: id, projectId: 'p',
    title: id, createdAt: iso(o.ageDays),
  });
  db.prepare('UPDATE sessions SET last_event_at = ? WHERE id = ?').run(iso(o.lastEventDays ?? o.ageDays), id);
  if (o.archived === true) db.prepare('UPDATE sessions SET cleanup_at = ? WHERE id = ?').run(iso(1), id);
}

/** 决策夹具：直接写 decisions 列（insertSession 不接收；判据读的就是这个 JSON）。 */
function setDecisions(db: DB, id: string, list: Array<{ text: string; seq: number; msgId?: string }>): void {
  db.prepare('UPDATE sessions SET decisions = ? WHERE id = ?').run(JSON.stringify(list), id);
}

describe('记忆体检分（health score）', () => {
  it('满分：四块都干净（有出处 / 新鲜 / 无碎片 / 无 P0）= 100 分 A', () => {
    const db = makeDb();
    seedSession(db, 's1', { ageDays: 1, lastEventDays: 0 });
    seedSession(db, 's2', { ageDays: 10, lastEventDays: 5 });
    setDecisions(db, 's1', [
      { text: '改用只读句柄做体检，避免体检自己抢写锁', seq: 1, msgId: 'm1' },
    ]);
    setDecisions(db, 's2', [
      { text: '采用 better-sqlite3 的事务批量写入决策', seq: 2, msgId: 'm2' },
    ]);

    const r = computeHealth(db, 'p', { now: NOW });
    expect(r.score).toBe(100);
    expect(r.grade).toBe('A');
    expect(r.components).toEqual({ evidenceCoverage: 1, freshness: 1, fragmentRate: 0, auditP0: 1 });
    // 四块各至少一条口径说明（0 条 notes = 静默，本仓最嫌恶的那种）
    expect(r.notes.length).toBeGreaterThanOrEqual(4);
  });

  it('低分：缺出处 + 长期不动 + 全是碎片 + 有 P0 = 0 分 D', () => {
    const db = makeDb();
    seedSession(db, 's1', { ageDays: 200, lastEventDays: 200 });
    setDecisions(db, 's1', [
      { text: '换成我们的了', seq: 1 },        // vagueDecisionObject 命中
      { text: '决定这样', seq: 2 },            // 同上
    ]);
    // [10-19 拍板] 归档未决**不再扣分**：它只进 notes（已接受历史债）。
    //   这条用例同时钉住「可修复 P0 才算 P0」的新口径：FTS 干净 ⇒ auditP0=1。
    seedSession(db, 's2', { ageDays: 100, lastEventDays: 100, archived: true });
    db.prepare('UPDATE sessions SET key_questions = ? WHERE id = ?').run(JSON.stringify([
      { q: '归档后这条未决怎么办？', seq: 1, unresolved: true },
    ]), 's2');

    const r = computeHealth(db, 'p', { now: NOW });
    // 40*0 + 25*0 + 15*(1-1) + 20*1 = 20
    expect(r.score).toBe(20);
    expect(r.grade).toBe('D');
    expect(r.components.evidenceCoverage).toBe(0);   // 2/2 缺 msgId
    expect(r.components.freshness).toBe(0);          // 0/2 场在窗口内
    expect(r.components.fragmentRate).toBe(1);       // 2/2 是碎片
    expect(r.components.auditP0).toBe(1);            // FTS 干净 ⇒ 可修复项全过
    const notes = r.notes.join('\n');
    expect(notes).toMatch(/归档未决 1 条/);
    expect(notes).toMatch(/不计入分数/);
  });

  it('无数据：决策/会话按 0.5 中性、P0 按 1（确证没有）= 60 分 C，且每处都写进 notes', () => {
    const db = makeDb();
    const r = computeHealth(db, 'p', { now: NOW });

    // 40*0.5 + 25*0.5 + 15*(1-0.5) + 20*1 = 60
    expect(r.score).toBe(60);
    expect(r.grade).toBe('C');
    expect(r.components).toEqual({ evidenceCoverage: 0.5, freshness: 0.5, fragmentRate: 0.5, auditP0: 1 });

    const text = r.notes.join('\n');
    expect(text).toContain('0.5');        // 中性值必须明说，不许静默
    expect(text).toMatch(/没有会话/);
    expect(text).toMatch(/0 条决策|还没有可见决策/);
    expect(text).toMatch(/FTS 索引与正文一致/);   // P0=1 的理由也要写出来
  });

  it('权重和 = 100，且总分就是四块的加权和（碎片率取 1-，权重被悄悄改就红）', () => {
    const w = HEALTH_WEIGHTS;
    expect(w).toEqual({ evidenceCoverage: 40, freshness: 25, fragmentRate: 15, auditP0: 20 });
    expect(w.evidenceCoverage + w.freshness + w.fragmentRate + w.auditP0).toBe(100);

    const db = makeDb();
    seedSession(db, 's1', { ageDays: 1, lastEventDays: 1 });      // 新鲜
    seedSession(db, 's2', { ageDays: 200, lastEventDays: 200 });  // 不新鲜
    setDecisions(db, 's1', [
      { text: '改用只读句柄做体检，避免体检自己抢写锁', seq: 1, msgId: 'm1' },
    ]);
    setDecisions(db, 's2', [
      { text: '采用 better-sqlite3 的事务批量写入决策', seq: 1, msgId: 'm2' },
      { text: '把新鲜度窗口定为 30 天，与简报的 7 天短窗分开', seq: 2, msgId: 'm3' },
      { text: '决定把缺失出处的条目排在审计报告最前面', seq: 3 },   // 唯一缺 msgId 的一条
    ]);

    const r = computeHealth(db, 'p', { now: NOW });
    expect(r.components).toEqual({ evidenceCoverage: 0.75, freshness: 0.5, fragmentRate: 0, auditP0: 1 });
    const expected = Math.round(
      w.evidenceCoverage * r.components.evidenceCoverage
      + w.freshness * r.components.freshness
      + w.fragmentRate * (1 - r.components.fragmentRate)
      + w.auditP0 * r.components.auditP0,
    );
    expect(r.score).toBe(expected);
    expect(r.score).toBe(78);              // 30 + 12.5 + 15 + 20 = 77.5
    expect(r.grade).toBe('B');
    expect(gradeFor(90)).toBe('A');
    expect(gradeFor(75)).toBe('B');
    expect(gradeFor(60)).toBe('C');
    expect(gradeFor(59)).toBe('D');
  });

  it('确定性：同库同 now 连算两次逐字节相等；now 前移后新鲜度跟着降（没漏传 now）', () => {
    const db = makeDb();
    seedSession(db, 's1', { ageDays: 1, lastEventDays: 1 });
    setDecisions(db, 's1', [
      { text: '改用只读句柄做体检，避免体检自己抢写锁', seq: 1, msgId: 'm1' },
    ]);

    const a = computeHealth(db, 'p', { now: NOW });
    const b = computeHealth(db, 'p', { now: NOW });
    expect(b).toEqual(a);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));

    // 同一条 last_event_at，把"现在"推到 90 天后：31 天前就不在 30 天窗口内了。
    // 若实现里偷用了 Date.now()，这里会仍是 1（真实墙钟没动）——这条就是防它的。
    const later = computeHealth(db, 'p', { now: NOW + 90 * 86_400_000 });
    expect(a.components.freshness).toBe(1);
    expect(later.components.freshness).toBe(0);
    expect(later.score).toBeLessThan(a.score);
  });
});
