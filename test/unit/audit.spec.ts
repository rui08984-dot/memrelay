import { describe, it, expect } from 'vitest';
import { createDb, insertSession, insertMessage } from '../../src/store/db.js';
import {
  auditDecisionMsgIds, auditDecisionFragments, auditArchivedUnresolved,
  auditMapNodesWithoutSources, exitCodeOf, runAudit, isStaleDraft,
  type AuditFinding,
} from '../../src/core/audit/audit.js';

const finding = (over: Partial<AuditFinding>): AuditFinding => ({
  id: 'decision-missing-msgid', severity: 'P1', status: 'ok', count: 0, samples: [], note: '',
  ...over,
});

describe('审计契约（audit）', () => {
  it('退出码：全过=0 / 只有 P1=1 / 有 P0=2 / 跳过不影响结论', () => {
    expect(exitCodeOf([finding({ status: 'ok' })])).toBe(0);
    expect(exitCodeOf([finding({ status: 'fail', severity: 'P1', count: 1 })])).toBe(1);
    expect(exitCodeOf([finding({ status: 'fail', severity: 'P0', count: 1 })])).toBe(2);
    expect(exitCodeOf([finding({ status: 'skipped' })])).toBe(0);
    // count=0 的 fail 不算失败（检查跑了但没命中）
    expect(exitCodeOf([finding({ status: 'fail', severity: 'P0', count: 0 })])).toBe(0);
  });

  it('决策缺 msgId：能数出来并给样例', () => {
    const db = createDb();
    insertSession(db, { id: 's1', source: 'x', sourceSessionId: 's1', projectId: 'p', createdAt: '2026-10-01' });
    insertMessage(db, { sessionId: 's1', role: 'user', content: '决定改用独立表', seqNum: 3 });
    // 直接写 decisions 列：insertSession 不接收该字段，这是测试夹具层面的写法，不影响被测判据
    db.prepare('UPDATE sessions SET decisions = ? WHERE id = ?').run(JSON.stringify([{ text: '决定改用独立表', seq: 3 }]), 's1');
    const f = auditDecisionMsgIds(db, 'p');
    expect(f.count).toBe(1);
    expect(f.samples.length).toBeGreaterThan(0);
  });

  it('决策碎片：vagueDecisionObject 命中的才算', () => {
    const db = createDb();
    insertSession(db, { id: 's1', source: 'x', sourceSessionId: 's1', projectId: 'p', createdAt: '2026-10-01' });
    db.prepare('UPDATE sessions SET decisions = ? WHERE id = ?').run(JSON.stringify([
      { text: '换成我们的了', seq: 1, msgId: 'm1' },
      { text: '改用独立表/列，不占用源 seq 空间', seq: 2, msgId: 'm2' },
    ]), 's1');
    insertMessage(db, { sessionId: 's1', role: 'user', content: '换成我们的了', seqNum: 1 });
    insertMessage(db, { sessionId: 's1', role: 'user', content: '改用独立表/列', seqNum: 2 });
    const f = auditDecisionFragments(db, 'p');
    expect(f.count).toBe(1);
  });

  it('已归档会话仍有未决 = P0', () => {
    const db = createDb();
    insertSession(db, { id: 's1', source: 'x', sourceSessionId: 's1', projectId: 'p', createdAt: '2026-10-01' });
    insertMessage(db, { sessionId: 's1', role: 'user', content: '这个迁移要不要现在做？', seqNum: 1 });
    db.prepare("UPDATE sessions SET cleanup_at = '2026-10-02' WHERE id = 's1'").run();
    const f = auditArchivedUnresolved(db, 'p');
    expect(f.severity).toBe('P0');
  });

  it('地图无 sources：没有地图时是 skipped 而不是 0 条', () => {
    const f = auditMapNodesWithoutSources(null);
    expect(f.status).toBe('skipped');
    expect(f.note).toBeTruthy();
  });

  it('经验草稿过期判据：30 天前后分界', () => {
    const old = new Date(Date.now() - 31 * 86400000).toISOString();
    const fresh = new Date(Date.now() - 29 * 86400000).toISOString();
    expect(isStaleDraft(old)).toBe(true);
    expect(isStaleDraft(fresh)).toBe(false);
    expect(isStaleDraft(null)).toBe(false);
  });

  it('runAudit 汇总：每项都有 status 与 note，不静默', () => {
    const rep = runAudit({ projectDb: createDb(), globalDb: null, projectId: 'p', root: null });
    expect(rep.checks.length).toBe(8);
    for (const c of rep.checks) {
      expect(['ok', 'fail', 'skipped']).toContain(c.status);
      if (c.status === 'skipped') expect(String(c.note ?? '').length).toBeGreaterThan(0);
    }
  });
});
