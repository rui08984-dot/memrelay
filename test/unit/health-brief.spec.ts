// [1020 全自动] 体检分固化成一行的判据：
//   ① 只放稳定项（分数/等级/两分项），不放会跳动的条数——它进 system prompt，变一次就废一次缓存；
//   ② 有缓存，TTL 内不重算；
//   ③ 没数据/算不出来 ⇒ **删掉旧文件**，不留过期分数（与 map/brief.txt 同一条纪律）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDb, insertSession, insertMessage } from '../../src/store/db.js';
import { formatHealthLine, writeHealthBrief, HEALTH_BRIEF_FILE } from '../../src/core/health/brief.js';

let tmp = '';
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-health-')); });
afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ } });

const mkProject = (): string => {
  const dir = path.join(tmp, 'proj');
  fs.mkdirSync(path.join(dir, '.sessionrelay'), { recursive: true });
  const db = createDb(path.join(dir, '.sessionrelay', 'relay.sqlite'));
  try {
    insertSession(db, { id: 's1', source: 'dsh', sourceSessionId: 's1', projectId: dir, title: 's1', createdAt: new Date().toISOString() });
    insertMessage(db, { sessionId: 's1', role: 'user', content: '采用 PostgreSQL 作为主库', seqNum: 1 });
  } finally { db.close(); }
  return dir;
};

describe('体检分一行（health.txt）', () => {
  it('格式化只含稳定项：分数/等级/证据覆盖/新鲜度，不含会跳动的条数', () => {
    const line = formatHealthLine({ score: 64, grade: 'C', components: { evidenceCoverage: 0.5, freshness: 0.37, fragmentRate: 0, auditP0: 1 } });
    expect(line).toBe('🩺 记忆体检 64 分 · C · 证据覆盖 50% · 新鲜度 37%');
    // 不含"条"这类随采集变动的量（缓存稳定性）
    expect(line).not.toMatch(/\d+\s*条/);
  });

  it('写出文件；TTL 内不重算（mtime 不变）', () => {
    const dir = mkProject();
    const first = writeHealthBrief(dir, { now: Date.now() });
    expect(first.written).toBe(true);
    const file = path.join(dir, '.sessionrelay', HEALTH_BRIEF_FILE);
    expect(fs.existsSync(file)).toBe(true);
    const mtime = fs.statSync(file).mtimeMs;
    const second = writeHealthBrief(dir, { now: Date.now() + 60_000 });
    expect(second.written).toBe(false);
    expect(fs.statSync(file).mtimeMs).toBe(mtime);
    expect(second.line).toContain('🩺 记忆体检');
  });

  it('没库/算不出来 ⇒ 删掉旧文件，不留过期分数', () => {
    const dir = path.join(tmp, 'empty');
    fs.mkdirSync(path.join(dir, '.sessionrelay'), { recursive: true });
    const file = path.join(dir, '.sessionrelay', HEALTH_BRIEF_FILE);
    fs.writeFileSync(file, '🩺 记忆体检 99 分 · A（过期）\n', 'utf8');
    const r = writeHealthBrief(dir, { now: Date.now(), ttlMs: 0 });
    expect(r.written).toBe(false);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('不抛：root 不存在也安全', () => {
    expect(() => writeHealthBrief(path.join(tmp, 'nope'), { ttlMs: 0 })).not.toThrow();
  });
});
