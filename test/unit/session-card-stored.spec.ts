// 会话卡 · **从库里已抽取条目**出卡（归档会话的唯一可行路径）。
//
// 为什么单独钉：简报/导出里的会话，正文可能已被老化压缩删掉（cleanup_at 非空），
// 而结论还在库里。若卡片只会从 messages 抽，归档会话在简报里就会变成一张空卡 ——
// 「看起来这场什么都没定」比没有卡片更糟。这条路径还必须保住 msgId（稳定主键）。
import { describe, it, expect } from 'vitest';
import { buildSessionCardFromStored, QUOTE_MAX } from '../../src/core/cards/session-card.js';

const info = (over: Partial<{ title: string | null; messageCount: number; source: string; firstAt: string; lastAt: string | null }> = {}) => ({
  title: '交接文档（唯一入口）', messageCount: 183, source: 'zcode',
  firstAt: '2026-10-07T10:00:00Z', lastAt: '2026-10-18T09:00:00Z', ...over,
});

describe('会话卡（从库里已抽取条目）', () => {
  it('决策带 msgId（INTEGER 归一成字符串）与 seq；quote 退回条目文本本身，不编造原句', () => {
    const c = buildSessionCardFromStored({
      decisions: [
        { text: '改为一行一条', seq: 3324, msgId: 473821 },
        { text: '弃用旧的合并导出', seq: 3325, msgId: '473822', kind: 'negative' },
      ],
      questions: [],
    }, info());
    expect(c.decisions).toHaveLength(2);
    expect(c.decisions[0].evidence.msgId).toBe('473821');   // 字符串，与读端同规
    expect(c.decisions[0].evidence.seq).toBe(3324);
    expect(c.decisions[0].evidence.quote).toBe('改为一行一条');
    expect(c.decisions[0].evidence.quote.length).toBeLessThanOrEqual(QUOTE_MAX);
    expect(c.decisions[1].kind).toBe('negative');
    expect(c.unresolved).toEqual([]);
    // evidence 平铺：先决策后未决
    expect(c.evidence).toEqual(c.decisions.map((d) => d.evidence));
  });

  it('只有 unresolved=true 的问题进卡片（已回答/观察区的不进）', () => {
    const c = buildSessionCardFromStored({
      decisions: [],
      questions: [
        { q: '归档后这条未决怎么办？', seq: 10, msgId: 900, unresolved: true },
        { q: '这条已经答过了', seq: 11, msgId: 901, unresolved: false },
        { q: '这条没标状态（视为未决？不——只认 true）', seq: 12 },
      ],
    }, info());
    expect(c.unresolved.map((u) => u.q)).toEqual(['归档后这条未决怎么办？']);
    expect(c.unresolved[0].evidence.msgId).toBe('900');
  });

  it('归档会话：message_count 来自会话行（不是 messages.length=0），跨度照算', () => {
    const c = buildSessionCardFromStored({ decisions: [], questions: [] }, info({ messageCount: 183 }));
    expect(c.messageCount).toBe(183);
    expect(c.span).toEqual({ from: '2026-10-07', to: '2026-10-18', days: 11 });
    expect(c.summary).toContain('183');
    expect(c.decisions).toEqual([]);
    expect(c.evidence).toEqual([]);
  });

  it('topics/files 用会话行的派生列（不重新从正文抽）', () => {
    const c = buildSessionCardFromStored({
      decisions: [], questions: [],
      topics: ['交接文档', '简报'], files: ['src/cli/brief.ts', 'src/relay/handoff-md.ts'],
    }, info());
    expect(c.topics).toEqual(['交接文档', '简报']);
    expect(c.files).toEqual(['src/cli/brief.ts', 'src/relay/handoff-md.ts']);
  });

  it('缺 seq 的条目按 0（"位置未知"），不伪造一个真实序号', () => {
    const c = buildSessionCardFromStored({
      decisions: [{ text: '决定先做简报', msgId: 7 }],
      questions: [{ q: '预算怎么算？', unresolved: true }],
    }, info());
    expect(c.decisions[0].evidence.seq).toBe(0);
    expect(c.unresolved[0].evidence.seq).toBe(0);
  });

  it('确定性：同输入两次逐字节一致，且不修改入参', () => {
    const stored = {
      decisions: [{ text: '决定采用 FTS5', seq: 1, msgId: 1 }],
      questions: [{ q: '分页怎么做？', seq: 2, unresolved: true }],
      topics: ['检索'], files: ['src/search-svc/engine.ts'],
    };
    const snapshot = JSON.stringify(stored);
    expect(JSON.stringify(buildSessionCardFromStored(stored, info()))).toBe(JSON.stringify(buildSessionCardFromStored(stored, info())));
    expect(JSON.stringify(stored)).toBe(snapshot);
  });

  it('空条目 / 坏输入不崩：字段齐全，落到"（无标题）"与 0 条', () => {
    const c = buildSessionCardFromStored({}, { title: null, messageCount: 0, source: 'x', firstAt: '', lastAt: null });
    expect(c.title).toBe('（无标题）');
    expect(c.messageCount).toBe(0);
    expect(c.decisions).toEqual([]);
    expect(c.unresolved).toEqual([]);
    expect(c.span.from).toBeNull();
  });
});
