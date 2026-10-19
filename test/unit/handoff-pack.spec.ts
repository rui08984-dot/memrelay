import { describe, it, expect } from 'vitest';
import { renderHandoff } from '../../src/cli/handoff.js';
import type { BriefPayload } from '../../src/cli/brief.js';

// [10-19] 一键交接包：五段固定、每条决策/未决带出处、隐藏项要说明。
// 纯函数测试：不跑 CLI、不碰库。

const pay = (over: Partial<BriefPayload> = {}): BriefPayload => ({
  auditAlert: null,
  nextStep: { next: '先做 A，再做 B', doing: ['任务A'] },
  decisions: [
    { at: '2026-10-18T10:00:00Z', text: '改用独立表', kind: 'decision', sessionId: 's1', msgId: '42', seq: 7 } as never,
    { at: '2026-10-17T10:00:00Z', text: '放弃 RRF', kind: 'negative', sessionId: 's2', seq: 3 } as never,
  ],
  unresolved: [{ at: '2026-10-19T10:00:00Z', q: '要不要迁地图', sessionId: 's3', msgId: '99' } as never],
  counts: { decisions: 2, unresolved: 1, fragmentsHidden: 2, archivedUnresolvedHidden: 1 },
  recentFiles: [{ file: 'db.ts', sessions: 20, decisions: 32 } as never],
  relatedSessions: [],
  experiences: [{ text: '改完插件源码必须重新 vendor' } as never],
  ...over,
});

describe('交接包（handoff）', () => {
  it('五段齐全，顺序固定', () => {
    const md = renderHandoff({ project: 'p', pay: pay(), now: new Date('2026-10-19T00:00:00Z') });
    const idx = ['## ① 现在到哪了', '## ② 定过什么', '## ③ 还欠什么', '## ④ 下一步', '## ⑤ 坑（已验证经验）'].map((h) => md.indexOf(h));
    expect(idx.every((i) => i >= 0)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
  });

  it('决策带出处，被否的标 ✗；未决带 msgId', () => {
    const md = renderHandoff({ project: 'p', pay: pay() });
    expect(md).toContain('msgId=42');
    expect(md).toContain('✗ 被否');
    expect(md).toContain('要不要迁地图');
    expect(md).toContain('msgId=99');
  });

  it('下一步来自地图 next，进行中节点并列', () => {
    const md = renderHandoff({ project: 'p', pay: pay() });
    expect(md).toContain('先做 A，再做 B');
    expect(md).toContain('任务A');
  });

  it('隐藏项必须说出来（碎片 / 归档未决）', () => {
    const md = renderHandoff({ project: 'p', pay: pay() });
    expect(md).toContain('已隐藏 2 条疑似碎片');
    expect(md).toContain('已隐藏 1 条归档会话的未决');
  });

  it('没有地图 next / 没有经验时也不崩，给出明确占位', () => {
    const md = renderHandoff({ project: 'p', pay: pay({ nextStep: null, experiences: [], decisions: [], unresolved: [] }) });
    expect(md).toContain('（地图未写 context.next）');
    expect(md).toContain('（无）');
    expect(md).toContain('（无未决）');
  });
});
