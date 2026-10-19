// 决策冲突检测（task C）：真冲突 / 同向不算 / 不同主题不算 / 时间序 / 空输入。
//
// 为什么每条都要钉死：这套判据的输出会直接进 audit 的 P1 告警。判松了就是"所有决策互相打架"，
// 告警随即被无视（狼来了）；判紧了则"3 月说放弃、10 月又说采用"永远没人看见。
// 所以这里用**真实形状**的 listDecisions 条目（text/at/sessionId/msgId/seq），不 mock。
import { describe, it, expect } from 'vitest';
import {
  findDecisionConflicts, decisionPolarity, CONFLICT_MIN_SHARED,
  type ConflictDecisionRow,
} from '../../src/core/decisions/conflict.js';
import { auditDecisionConflicts } from '../../src/core/audit/audit.js';
import { createDb, insertSession } from '../../src/store/db.js';

/** 造一条 listDecisions 形状的决策（多出来的字段与真实行一致，不带 topic）。 */
const row = (text: string, at: string, extra: Partial<ConflictDecisionRow> = {}): ConflictDecisionRow =>
  ({ text, at, sessionId: 's-1', msgId: 1, ...extra });

describe('决策冲突检测', () => {
  it('真冲突：同主题 + 极性相反 + 后者更晚 ⇒ 判一对，且 a=早 / b=晚；audit 复用同一判据', () => {
    const older = row('决定放弃 SQLite FTS5，改用向量检索', '2026-03-01T00:00:00Z');
    const newer = row('决定采用 SQLite FTS5 作为唯一检索层', '2026-10-01T00:00:00Z');
    const pairs = findDecisionConflicts([older, newer]);
    expect(pairs.length).toBe(1);
    expect(pairs[0].a).toBe(older);
    expect(pairs[0].b).toBe(newer);
    // 理由必须说清"凭什么"和方向，而不是只给一个布尔
    expect(pairs[0].reason).toContain('后者可能推翻前者');
    expect(pairs[0].reason).toContain('放弃');
    expect(pairs[0].reason).toContain('采用');

    // audit 那一项只数结果、不复制规则：同一批数据必须报出同一对数
    const db = createDb();
    try {
      insertSession(db, { id: 's1', source: 'x', sourceSessionId: 's1', projectId: 'p', createdAt: '2026-03-01T00:00:00Z' });
      db.prepare('UPDATE sessions SET decisions = ? WHERE id = ?').run(JSON.stringify([
        { text: older.text, seq: 1, at: older.at, msgId: 11 },
        { text: newer.text, seq: 2, at: newer.at, msgId: 12 },
      ]), 's1');
      const f = auditDecisionConflicts(db, 'p');
      expect(f.id).toBe('decision-conflict');
      expect(f.severity).toBe('P1');
      expect(f.count).toBe(1);
      expect(f.status).toBe('fail');
    } finally { db.close(); }
  });

  it('同向不算：两条都在采用/保留（或都在放弃），重叠再多也不报', () => {
    const a = row('决定采用 SQLite FTS5 作为唯一检索层', '2026-03-01T00:00:00Z');
    const b = row('确认保留 SQLite FTS5，继续走这一层', '2026-10-01T00:00:00Z');
    expect(findDecisionConflicts([a, b])).toEqual([]);

    const c = row('决定放弃向量检索，改用词元重叠', '2026-03-01T00:00:00Z');
    const d = row('不再使用向量检索，换成词元重叠', '2026-10-01T00:00:00Z');
    expect(findDecisionConflicts([c, d])).toEqual([]);

    // 极性助手本身也要对：这是"谁在否"的唯一判据
    expect(decisionPolarity('改用 pg 向量')).toBe('negative');
    expect(decisionPolarity('保留 SQLite')).toBe('positive');
    expect(decisionPolarity('把函数挪到 confirm 里')).toBe('none');
  });

  it('不同主题不算：极性相反但实词重叠不到阈值 ⇒ 闭嘴（宁漏不误）', () => {
    const a = row('决定放弃 Redis 缓存方案', '2026-03-01T00:00:00Z');
    const b = row('决定采用 CSS grid 重写面板布局', '2026-10-01T00:00:00Z');
    expect(findDecisionConflicts([a, b])).toEqual([]);
    // 门槛是常量、可解释，不是魔法数
    expect(CONFLICT_MIN_SHARED).toBeGreaterThan(1);
  });

  it('时间序：输入倒序也认得出谁先谁后；同一时刻不臆造"后者"', () => {
    const later = row('决定采用 SQLite FTS5 作为唯一检索层', '2026-10-01T00:00:00Z');
    const earlier = row('决定放弃 SQLite FTS5，改用向量检索', '2026-03-01T00:00:00Z');
    const pairs = findDecisionConflicts([later, earlier]);   // 故意倒序传入
    expect(pairs.length).toBe(1);
    expect(pairs[0].a).toBe(earlier);
    expect(pairs[0].b).toBe(later);
    expect(pairs[0].reason).toContain(String(earlier.at));
    expect(pairs[0].reason).toContain(String(later.at));

    // 同一时刻：分不出"后者"，不报（不按输入顺序假装看懂时间）
    const same = row('决定采用 SQLite FTS5 作为唯一检索层', '2026-03-01T00:00:00Z');
    expect(findDecisionConflicts([earlier, same])).toEqual([]);
  });

  it('空输入：空数组 → 空结果（不抛错、不返回 undefined）', () => {
    expect(findDecisionConflicts([])).toEqual([]);
    // 单条也构成不了"双方"——这不是"健康"，审计侧另有"比对了几条"的 note
    expect(findDecisionConflicts([row('决定采用 SQLite FTS5', '2026-03-01T00:00:00Z')])).toEqual([]);
  });
});
