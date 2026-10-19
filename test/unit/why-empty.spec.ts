import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDb, insertSession, insertMessage, type DB } from '../../src/store/db.js';
import { diagnoseEmpty } from '../../src/search-svc/why-empty.js';

// [10-19] 「为什么没找到」：只归因、不改检索。五类原因都要能说清。

let db: DB;
const seed = (id: string, text: string, project = 'p'): void => {
  insertSession(db, { id, source: 'dsh', sourceSessionId: id, projectId: project, title: id, createdAt: '2026-10-01T00:00:00Z' });
  insertMessage(db, { sessionId: id, role: 'user', content: text, seqNum: 1 });
};
const run = (query: string, extra: Partial<Parameters<typeof diagnoseEmpty>[0]> = {}) =>
  diagnoseEmpty({ db, projectId: 'p', query, sessions: 4, ...extra });

beforeEach(() => {
  db = createDb(':memory:');
  seed('s1', '项目使用数据库迁移到 PostgreSQL');
  seed('s2', '项目前端样式改成 webp');
  seed('s3', '项目文档补充交接说明');
  seed('s4', '项目构建改用 esbuild');
});
afterEach(() => { db.close(); });

describe('检索 0 命中的诊断', () => {
  it('词不存在 ⇒ 明说是哪个词、建议换同义词', () => {
    const d = run('Kubernetes');
    expect(d.reasons.join(' ')).toContain('全库一次都没出现');
    expect(d.suggestions.join(' ')).toContain('同义词');
  });

  it('词太泛 ⇒ 报覆盖率并建议更具体', () => {
    const d = run('项目');
    expect(d.reasons.join(' ')).toMatch(/词太泛|覆盖了/);
  });

  it('约束太多 ⇒ 报词元数', () => {
    const d = run('项目 数据库 迁移 PostgreSQL 前端');
    expect(d.reasons.join(' ')).toContain('约束太多');
  });

  it('时间窗 / scope 收窄 ⇒ 各有一条原因', () => {
    const d = run('数据库', { since: '2026-09-01', until: '2026-09-30', scopeNarrowed: true });
    const all = d.reasons.join(' ');
    expect(all).toContain('时间窗');
    expect(all).toContain('scope');
  });

  it('词都命中但交集为空 ⇒ 兜底原因（不静默）', () => {
    const d = run('PostgreSQL webp');
    expect(d.reasons.length).toBeGreaterThan(0);
  });
});
