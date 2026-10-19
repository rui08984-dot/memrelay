import { describe, it, expect } from 'vitest';
import { createDb, insertSession } from '../../src/store/db.js';
import { applyTitleBoost } from '../../src/search-svc/engine.js';

const hit = (sessionId: string, score: number) => ({ sessionId, score, snippet: '', viaMeta: false, coverage: 0, seq: 0 });

describe('titleBoost 重排', () => {
  it('标题/话题命中可以把低分会话抬到高分会话之前', () => {
    const db = createDb();
    insertSession(db, { id: 'a', source: 'x', sourceSessionId: 'a', projectId: 'p', createdAt: '2026-10-01', title: '部署 方案', topics: ['release'] });
    insertSession(db, { id: 'b', source: 'x', sourceSessionId: 'b', projectId: 'p', createdAt: '2026-10-01', title: '无关', topics: [] });
    const hits = [hit('b', 1), hit('a', 0.4)];
    const out = applyTitleBoost(db, hits, { project: 'p', query: '部署 方案', titleBoost: 2 } as never);
    expect(out.map((h) => h.sessionId)).toEqual(['a', 'b']);
    expect(out[0].score).toBeGreaterThan(out[1].score);
  });

  it('权重为 0/未设时原样返回', () => {
    const db = createDb();
    insertSession(db, { id: 'a', source: 'x', sourceSessionId: 'a', projectId: 'p', createdAt: '2026-10-01', title: '部署 方案', topics: [] });
    const hits = [hit('a', 1)];
    expect(applyTitleBoost(db, hits, { project: 'p', query: '部署 方案' } as never)).toBe(hits);
  });

  it('查询没有可用于匹配的词元时不改顺序', () => {
    const db = createDb();
    insertSession(db, { id: 'a', source: 'x', sourceSessionId: 'a', projectId: 'p', createdAt: '2026-10-01', title: '部署', topics: [] });
    const hits = [hit('a', 1), hit('b', 0.5)];
    expect(applyTitleBoost(db, hits, { project: 'p', query: '   ', titleBoost: 1 } as never)).toBe(hits);
  });
});
