import { describe, it, expect } from 'vitest';
import { extractDecisions, vagueDecisionObject, type Msg } from '../../src/core/extract/extract.js';

const msg = (content: string, seq = 1): Msg => ({ role: 'user', content, seqNum: seq, createdAt: '2026-10-19T00:00:00Z' });

// [10-19] 自包含闸门：判据只该拒「宾语整个是指代」的碎片，不该误杀带具体对象的决策。
describe('决策自包含闸门（指代宾语）', () => {
  it('拒收「换成我们的了 / 换成你的问法 / 换成另一种错」这类碎片', () => {
    const d = extractDecisions([
      msg('换成我们的了', 1),
      msg('换成你的问法', 2),
      msg('换成另一种错', 3),
    ]);
    expect(d.map((x) => x.text)).toEqual([]);
  });

  it('放行带具体对象的决策', () => {
    const d = extractDecisions([
      msg('改用独立表/列，不占用源 seq 空间', 1),
      msg('改用 note 通道取代 save --recent 1d', 2),
      msg('改为带原因；写链失败不再静默吞掉', 3),
    ]);
    expect(d.length).toBe(3);
  });

  it('判据本身：指代/所属整句为宾语 → true；带名词 → false', () => {
    expect(vagueDecisionObject('换成我们的了')).toBe(true);
    expect(vagueDecisionObject('决定这样')).toBe(true);
    expect(vagueDecisionObject('换成另一种错')).toBe(true);
    expect(vagueDecisionObject('决定这个方案')).toBe(false);
    expect(vagueDecisionObject('改用 note 通道')).toBe(false);
    expect(vagueDecisionObject('改为 90 秒超时')).toBe(false);
  });
});
