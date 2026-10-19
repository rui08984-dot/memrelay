import { describe, it, expect } from 'vitest';
import { composeBriefWithCards, compactCardLine, utf8Bytes, BRIEF_CARD_MIN_SLACK, BRIEF_BUDGET_RATIO, type BriefCardBlock } from '../../src/cli/brief-cards.js';
import type { SessionCard } from '../../src/core/cards/session-card.js';

// [10-19] 预算下限：真实 brief 基线只有 ~256B，×1.2 = 308B，而最短单行卡 99B
// ⇒ 不加下限时卡片**永远 0 张**（功能等于没接）。这里钉住「至少一张卡」与「仍不超上限」。

const card = (over: Partial<SessionCard> = {}): SessionCard => ({
  title: '测试会话', decisions: [{ text: '决定改用独立表', kind: 'decision', evidence: { msgId: 'm1', seq: 1, quote: '决定改用独立表' } }],
  unresolved: [], topics: [], files: [], span: { from: '2026-10-01', to: '2026-10-02', days: 1 }, messageCount: 10,
  evidence: [{ msgId: 'm1', seq: 1, quote: '决定改用独立表' }], summary: '测试会话', ...over,
});

const block = (over: Partial<SessionCard> = {}, lines?: string[]): BriefCardBlock => ({
  sessionId: 's1', card: card(over),
  cardLines: lines ?? ['● 测试会话  10-01 → 10-02 · 10 条消息', '  决策：决定改用独立表', '  未决：无', '  证据：msgId=m1 seq=1'],
  lines: (lines ?? ['● 测试会话  10-01 → 10-02 · 10 条消息', '  决策：决定改用独立表', '  未决：无', '  证据：msgId=m1 seq=1']).map((l) => '  ' + l),
});

describe('简报卡片预算（brief-cards）', () => {
  it('短基线也至少落一张卡（预算下限）', () => {
    const head = ['决策 2 条 · 未决 0 条 · 最近在动 3 个'];
    const out = composeBriefWithCards(head, [block()], []);
    expect(out.fullCards + out.compactCards).toBeGreaterThanOrEqual(1);
  });

  it('总字节 ≤ max(基线×1.2, 基线+320)，且实际使用 ≤ 预算', () => {
    const head = ['决策 2 条', '  🗂 db.ts（20 场）'];
    const tail = ['  经验 1 条'];
    const out = composeBriefWithCards(head, [block(), block({ title: '第二场' })], tail);
    const base = utf8Bytes(head) + utf8Bytes(tail);
    const cap = Math.max(Math.ceil(base * BRIEF_BUDGET_RATIO), base + BRIEF_CARD_MIN_SLACK);
    expect(out.budgetBytes).toBe(cap);
    expect(out.usedBytes).toBeLessThanOrEqual(cap);
  });

  it('卡太大时降级/省略，并**说出来**（不静默）', () => {
    const big = Array.from({ length: 40 }, (_, i) => '  决策 ' + i + '：' + '很长的说明'.repeat(20));
    const out = composeBriefWithCards(['决策 1 条'], [block({}, big), block({ title: '第二场' }, big)], []);
    expect(out.omittedCards + out.compactCards).toBeGreaterThan(0);
    expect(out.notice).toBeTruthy();
    expect(['stdout', 'stderr']).toContain(out.noticeTo);
  });

  it('单行降级仍保留证据（msgId/seq），不丢可溯源性', () => {
    const line = compactCardLine(block());
    expect(line).toContain('msgId');
    expect(line).toContain('seq');
  });
});
