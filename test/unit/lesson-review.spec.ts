import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDb, type DB } from '../../src/store/db.js';
import { reviewLessons } from '../../src/store/lesson-review.js';

// [1022] 经验审核的唯一实现：CLI 与面板共用。钉住「confirm 要抬级」这条踩过的坑。

let db: DB;
beforeEach(() => {
  db = createDb(':memory:');
  db.exec('CREATE TABLE lessons (id INTEGER PRIMARY KEY, status TEXT, grade TEXT, importance REAL, updated_at TEXT, needs_review INTEGER DEFAULT 0)');
  db.prepare('INSERT INTO lessons (id,status,grade,importance) VALUES (1,?,?,?)').run('draft', 'inferred', 1.5);
  db.prepare('INSERT INTO lessons (id,status,grade,importance) VALUES (2,?,?,?)').run('draft', 'verified-user', 7.5);
});
afterEach(() => { try { db.close(); } catch { /* 已关 */ } });

describe('经验复核', () => {
  it('confirm：draft → verified，且 inferred 抬到 verified-file（6.0）', () => {
    const r = reviewLessons(db, [1], 'confirm');
    expect(r).toEqual({ updated: 1, to: 'verified' });
    const row = db.prepare('SELECT status, grade, importance FROM lessons WHERE id = 1').get() as { status: string; grade: string; importance: number };
    expect(row.status).toBe('verified');
    expect(row.grade).toBe('verified-file');
    expect(row.importance).toBe(6);
  });

  it('confirm 不动已验证过的等级（不降级）', () => {
    reviewLessons(db, [2], 'confirm');
    const row = db.prepare('SELECT grade, importance FROM lessons WHERE id = 2').get() as { grade: string; importance: number };
    expect(row.grade).toBe('verified-user');
    expect(row.importance).toBe(7.5);
  });

  it('reject：终态 rejected，等级保持原样', () => {
    const r = reviewLessons(db, [1], 'reject');
    expect(r.to).toBe('rejected');
    const row = db.prepare('SELECT status, grade FROM lessons WHERE id = 1').get() as { status: string; grade: string };
    expect(row.status).toBe('rejected');
    expect(row.grade).toBe('inferred');
  });

  it('复核后清掉 needs_review（否则驳回后还赖在「待审核」里，看起来没反应）', () => {
    db.prepare('UPDATE lessons SET needs_review = 1 WHERE id = 1').run();
    reviewLessons(db, [1], 'reject');
    const row = db.prepare('SELECT needs_review FROM lessons WHERE id = 1').get() as { needs_review: number };
    expect(row.needs_review).toBe(0);
  });

  it('不存在的 id 不计入 updated', () => {
    expect(reviewLessons(db, [999], 'confirm').updated).toBe(0);
  });
});
