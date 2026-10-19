import { describe, it, expect } from 'vitest';
import { createDb, insertSession } from '../../src/store/db.js';
import { groupSessions } from '../../src/search-svc/session-groups.js';

const seed = (db: ReturnType<typeof createDb>, id: string, topics: string[], files: string[]) =>
  insertSession(db, { id, source: 'x', sourceSessionId: id, projectId: 'p', createdAt: '2026-10-01', topics, files });

describe('多会话分组（session-groups）', () => {
  it('共享 topic 的会话归为一组，并给出共享信号', () => {
    const db = createDb();
    seed(db, 'a', ['交接', '调优'], []);
    seed(db, 'b', ['交接'], []);
    seed(db, 'c', ['无关'], []);
    const groups = groupSessions(db, [
      { sessionId: 'a', score: 3 },
      { sessionId: 'b', score: 2 },
      { sessionId: 'c', score: 1 },
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0].sessionIds.sort()).toEqual(['a', 'b']);
    expect(groups[0].sharedTopics).toContain('交接');
    expect(groups[0].lead).toBe('a'); // 分数最高者为代表
  });

  it('共享文件也能成组；单条命中也单独成组', () => {
    const db = createDb();
    seed(db, 'a', [], ['src/x.ts']);
    seed(db, 'b', [], ['src/x.ts']);
    seed(db, 'c', [], ['src/y.ts']);
    const groups = groupSessions(db, [
      { sessionId: 'a', score: 2 },
      { sessionId: 'b', score: 1 },
      { sessionId: 'c', score: 0.5 },
    ]);
    expect(groups.map((g) => g.sessionIds.sort())).toEqual([['a', 'b'], ['c']]);
    expect(groups[0].sharedFiles).toContain('src/x.ts');
  });

  it('无共享信号时每条各自成组（不强行合并）', () => {
    const db = createDb();
    seed(db, 'a', ['x'], []);
    seed(db, 'b', ['y'], []);
    const groups = groupSessions(db, [
      { sessionId: 'a', score: 1 },
      { sessionId: 'b', score: 1 },
    ]);
    expect(groups).toHaveLength(2);
  });

  it('空输入返回空数组', () => {
    const db = createDb();
    expect(groupSessions(db, [])).toEqual([]);
  });
});
