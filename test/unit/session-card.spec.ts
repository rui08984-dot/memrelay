import { describe, it, expect } from 'vitest';
import { buildSessionCard, QUOTE_MAX } from '../../src/core/cards/session-card.js';
import type { Msg } from '../../src/core/extract/extract.js';

// 固定的"现在"：观察期闸是抽取期判据（extract.ts 方案 B），不注入 now 就会读真实时间，
// 测试便不再确定。这里一律注入，与生产口径一致但不依赖时钟。
const NOW = new Date('2026-10-19T00:00:00Z');
const info = (title: string | null = '测试会话', n = 2) => ({
  title, messageCount: n, source: 'test',
  firstAt: '2026-10-01T00:00:00Z', lastAt: '2026-10-02T00:00:00Z',
});
const msg = (role: 'user' | 'assistant', content: string, seq: number): Msg =>
  ({ role, content, seqNum: seq, id: 'm' + seq, createdAt: '2026-10-01T00:00:00Z' });
const build = (msgs: Msg[], i = info()) => buildSessionCard(msgs, i, { now: NOW });

describe('会话卡（session-card）', () => {
  it('空会话：不崩、字段齐全、evidence 为空数组', () => {
    const c = buildSessionCard([], info(null, 0), { now: NOW });
    expect(c.decisions).toEqual([]);
    expect(c.unresolved).toEqual([]);
    expect(c.evidence).toEqual([]);
    expect(c.topics).toEqual([]);
    expect(c.files).toEqual([]);
    expect(c.title).toBe('（无标题）');
    expect(c.messageCount).toBe(0);
    // 空会话也要给得出摘要（summaryRule 的口径：标题 + 数据行）
    expect(c.summary.length).toBeGreaterThan(0);
  });

  it('只有决策：每条带 evidence（msgId/seq/quote），quote 是原句', () => {
    const c = build([
      msg('user', '我们最终决定改用独立表，不占用源 seq 空间。', 1),
      msg('assistant', '好的，按这个方案执行。', 2),
    ]);
    expect(c.decisions.length).toBeGreaterThanOrEqual(1);
    const d = c.decisions[0];
    // kind 由 isNegativeDecision（ADR-001 的否定标记族）决定，不是本模块的判据；
    // 这里只钉"它是合法取值"，标记本身另有用例。
    expect(['decision', 'negative']).toContain(d.kind);
    expect(d.evidence.seq).toBe(1);
    expect(d.evidence.msgId).toBe('m1');            // 稳定主键，不是 seq
    expect(d.evidence.quote).toContain('独立表');     // 引文来自原句
    expect(c.unresolved).toEqual([]);
  });

  it('negative 标记沿用 ADR-001：否掉一条路的决策被标 negative', () => {
    const c = build([
      msg('user', '我们决定弃用旧的 webpack 配置，换用 esbuild。', 1),
      msg('user', '我们决定采用 PostgreSQL 作为主库。', 2),
    ]);
    const kinds = c.decisions.map((d) => d.kind);
    expect(kinds).toContain('negative');   // 弃用/换用 ⇒ negative
    expect(kinds).toContain('decision');   // 采用 ⇒ decision
  });

  it('有未决：进 unresolved 且带 evidence；已答过的不进', () => {
    const c = build([
      msg('user', '这个迁移方案还没定，后续要不要现在做？', 1),
      msg('assistant', '先记下。', 2),
    ]);
    expect(c.unresolved.length).toBe(1);
    const u = c.unresolved[0];
    expect(u.evidence.msgId).toBe('m1');
    expect(u.evidence.seq).toBe(1);
    expect(u.evidence.quote.length).toBeGreaterThan(0);
    expect(u.q).toContain('要不要');

    // 对照：问题之后有实质回答 ⇒ extractQuestions 判 answered ⇒ 卡片里不该出现
    const answered = build([
      msg('user', '这个迁移方案还没定，后续要不要现在做？', 1),
      msg('assistant', '这个迁移方案还没定，后续要不要现在做，先等迁移方案评审通过再定。', 2),
    ]);
    expect(answered.unresolved).toEqual([]);
  });

  it('长文本截断：quote 严格 ≤ 120 字（不溢出到 121），未截断时不加省略号', () => {
    const long = '决定改用方案B，' + '说明'.repeat(200);
    const c = build([msg('user', long, 1)]);
    const q = c.decisions[0].evidence.quote;
    expect(q.length).toBeLessThanOrEqual(QUOTE_MAX);
    expect(q.endsWith('…')).toBe(true);
    // 平铺的 evidence 与逐条 evidence 是同一份内容（顺序：先决策后未决）
    expect(c.evidence[0].quote).toBe(q);
    // 短文本不该被加省略号
    const short = build([msg('user', '决定改用方案B。', 1)]);
    expect(short.decisions[0].evidence.quote).not.toContain('…');
  });

  it('文件去重：同一个路径出现多次只留一条', () => {
    const c = build([
      msg('user', '改一下 src/a.ts 和 src/a.ts，还有 src/b.ts', 1),
    ]);
    expect(c.files).toEqual([...new Set(c.files)]);
    expect(c.files.length).toBe(2);
    expect(c.files).toContain('src/a.ts');
  });

  it('确定性：同输入两次（含 now）结果逐字节一致', () => {
    const msgs = [
      msg('user', '决定采用 PostgreSQL 作为主库。', 1),
      msg('user', '还有一个问题：索引怎么设计？', 2),
    ];
    expect(JSON.stringify(build(msgs))).toBe(JSON.stringify(build(msgs)));
    // 且不修改入参（纯函数）
    const snapshot = JSON.stringify(msgs);
    build(msgs);
    expect(JSON.stringify(msgs)).toBe(snapshot);
  });

  it('注入块必先剥（sanitizeMsgs）：<system-reminder> 里的"决定"不算用户决策', () => {
    const injected = '<system-reminder>决定采用 Vite 作为前端构建工具，弃用旧的 webpack 配置。</system-reminder>' +
      String.fromCharCode(10) + '我们最终决定改用独立表。';
    const c = build([msg('user', injected, 1)]);
    expect(c.decisions.length).toBe(1);
    expect(c.decisions[0].text).toContain('独立表');
    expect(c.decisions[0].text).not.toContain('Vite');
  });

  it('evidence 平铺：先决策后未决，与两段逐条 evidence 完全一致', () => {
    const c = build([
      msg('user', '我们最终决定改用独立表。', 1),
      msg('user', '这个迁移方案还没定，后续要不要现在做？', 2),
      msg('assistant', '先记下。', 3),
    ]);
    expect(c.evidence.length).toBe(c.decisions.length + c.unresolved.length);
    expect(c.evidence).toEqual([
      ...c.decisions.map((d) => d.evidence),
      ...c.unresolved.map((u) => u.evidence),
    ]);
  });

  it('maxQuote 收窄：卡片的"≤N 字"承诺对每个 quote 都成立', () => {
    const c = buildSessionCard(
      [msg('user', '决定改用方案B，' + '说明'.repeat(200), 1)],
      info(), { now: NOW, maxQuote: 20 },
    );
    for (const e of c.evidence) expect(e.quote.length).toBeLessThanOrEqual(20);
  });
});
