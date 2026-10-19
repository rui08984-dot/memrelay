// 会话卡的紧凑文本渲染：格式、上界、证据行。
//
// 为什么钉格式：简报是给 agent 读的，行结构一旦漂移（比如把决策行换成散文），
// 依赖"读第二行拿决策"的下游就静默失准。这里钉的是**行序与行的语义**，不是文案细节。
import { describe, it, expect } from 'vitest';
import { buildSessionCardFromStored } from '../../src/core/cards/session-card.js';
import { renderCardLines, evidenceText, clipLine } from '../../src/core/cards/card-text.js';

const card = (over: Partial<Parameters<typeof buildSessionCardFromStored>[0]> = {}, info?: Partial<Parameters<typeof buildSessionCardFromStored>[1]>) =>
  buildSessionCardFromStored({
    decisions: [
      { text: '改为一行一条', seq: 3324, msgId: 473821 },
      { text: '决定计划', seq: 3325, msgId: 473822 },
    ],
    questions: [],
    ...over,
  }, {
    title: '交接文档（唯一入口）', messageCount: 183, source: 'zcode',
    firstAt: '2026-10-07T10:00:00Z', lastAt: '2026-10-18T09:00:00Z', ...info,
  });

describe('会话卡文本（renderCardLines）', () => {
  it('四行结构：标题+跨度+条数 / 决策 / 未决 / 证据', () => {
    const lines = renderCardLines(card());
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe('● 交接文档（唯一入口）  10-07 → 10-18 · 183 条消息');
    expect(lines[1]).toBe('  决策：改为一行一条 / 决定计划');
    expect(lines[2]).toBe('  未决：无');
    expect(lines[3]).toBe('  证据：msgId=473821 seq=3324（+1 条出处）');
  });

  it('没有决策/未决时显式写「无」（不是缺行）', () => {
    const lines = renderCardLines(card({ decisions: [], questions: [] }));
    expect(lines[1]).toBe('  决策：无');
    expect(lines[2]).toBe('  未决：无');
    expect(lines).toHaveLength(3);   // 没有证据就不占行
  });

  it('未决有内容时逐条列出（最多 2 条，超出用 …）', () => {
    const c = card({
      questions: [
        { q: '第一个未决问题', seq: 1, unresolved: true, msgId: 1 },
        { q: '第二个未决问题', seq: 2, unresolved: true, msgId: 2 },
        { q: '第三个未决问题', seq: 3, unresolved: true, msgId: 3 },
      ],
    }, { lastAt: null });
    const lines = renderCardLines(c);
    expect(lines[0]).toBe('● 交接文档（唯一入口）  10-07 · 183 条消息');   // 没有终点就只报起点
    expect(lines[2]).toBe('  未决：第一个未决问题 / 第二个未决问题 / …');
  });

  it('决策超过上限：只列前 N 条 + …（默认 3）', () => {
    const c = card({
      decisions: Array.from({ length: 5 }, (_, i) => ({ text: '决策 ' + String(i + 1) + ' 的具体内容', seq: i + 1, msgId: 100 + i })),
    });
    const lines = renderCardLines(c);
    expect(lines[1]).toBe('  决策：决策 1 的具体内容 / 决策 2 的具体内容 / 决策 3 的具体内容 / …');
  });

  it('证据行：没有 msgId 就只报 seq（不伪造主键）；可以关掉', () => {
    const c = card({ decisions: [{ text: '决定改用独立表', seq: 42 }], questions: [] });
    expect(renderCardLines(c)[3]).toBe('  证据：seq=42');
    expect(renderCardLines(c, { evidence: false })).toHaveLength(3);
  });

  it('标题与单条内容有长度上界，且截断以 … 收尾（计入上限）', () => {
    const long = '决定把' + '非常长的说明'.repeat(30);
    const c = card({ decisions: [{ text: long, seq: 1, msgId: 1 }], questions: [] }, { title: '标题'.repeat(40) });
    const lines = renderCardLines(c, { maxTitle: 20, maxItem: 18 });
    expect(lines[0].length).toBeLessThanOrEqual('● '.length + 20 + 2 + 40);
    expect(lines[0]).toContain('…');
    expect(lines[1].startsWith('  决策：')).toBe(true);
    expect(lines[1].endsWith('…')).toBe(true);
    expect(lines[1].length).toBeLessThanOrEqual('  决策：'.length + 18);
  });

  it('evidenceText / clipLine 是纯函数：折叠空白、超长截断', () => {
    expect(evidenceText({ msgId: 'm1', seq: 7, quote: 'x' })).toBe('msgId=m1 seq=7');
    expect(evidenceText({ msgId: null, seq: 7, quote: 'x' })).toBe('seq=7');
    expect(clipLine('  a\n\n b  ', 10)).toBe('a b');
    expect(clipLine('abcdefghij', 5)).toBe('abcd…');
  });
});
