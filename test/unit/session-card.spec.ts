import { describe, it, expect } from 'vitest';
import { buildSessionCard } from '../../src/core/cards/session-card.js';
import type { Msg } from '../../src/core/extract/extract.js';

const info = (title: string | null = '测试会话', n = 2) => ({
  title, messageCount: n, source: 'test', firstAt: '2026-10-01T00:00:00Z', lastAt: '2026-10-02T00:00:00Z',
});
const msg = (role: 'user' | 'assistant', content: string, seq: number): Msg =>
  ({ role, content, seqNum: seq, id: 'm' + seq, createdAt: '2026-10-01T00:00:00Z' });

describe('会话卡（session-card）', () => {
  it('空会话：不崩、字段齐全', () => {
    const c = buildSessionCard([], info(null, 0));
    expect(c.decisions).toEqual([]);
    expect(c.unresolved).toEqual([]);
    expect(c.title).toBe('（无标题）');
    expect(c.messageCount).toBe(0);
  });

  it('只有决策：带 evidence（msgId/seq/quote）', () => {
    const c = buildSessionCard([
      msg('user', '我们最终决定改用独立表，不占用源 seq 空间。', 1),
      msg('assistant', '好的，按这个方案执行。', 2),
    ], info());
    expect(c.decisions.length).toBeGreaterThanOrEqual(1);
    const d = c.decisions[0];
    expect(d.evidence.seq).toBe(1);
    expect(d.evidence.msgId).toBe('m1');
    expect(d.evidence.quote.length).toBeLessThanOrEqual(121);
  });

  it('未决问题进 unresolved', () => {
    const c = buildSessionCard([
      msg('user', '这个迁移方案还没定，后续要不要现在做？', 1),
      msg('assistant', '还没定，等等看。', 2),
    ], info());
    expect(c.unresolved.length).toBeGreaterThanOrEqual(1);
  });

  it('长文本截断到 120 字以内', () => {
    const long = '决定改用方案B，' + '说明'.repeat(200);
    const c = buildSessionCard([msg('user', long, 1)], info());
    for (const d of c.decisions) expect(d.evidence.quote.length).toBeLessThanOrEqual(121);
  });

  it('文件去重且不重复', () => {
    const c = buildSessionCard([
      msg('user', '改一下 src/a.ts 和 src/a.ts，还有 src/b.ts', 1),
    ], info());
    expect(new Set(c.files).size).toBe(c.files.length);
  });

  it('确定性：同输入两次结果完全一致', () => {
    const msgs = [msg('user', '决定采用 PostgreSQL 作为主库。', 1)];
    expect(JSON.stringify(buildSessionCard(msgs, info()))).toBe(JSON.stringify(buildSessionCard(msgs, info())));
  });
});
