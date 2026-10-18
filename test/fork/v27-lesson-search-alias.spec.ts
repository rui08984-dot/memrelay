// [1018 修] searchLessons 是两表 JOIN，visibleWhere 生成的 SQL 不带表前缀 ⇒ 列名歧义。
//
// 病历（2026-10-18 实测）：DSH 插件的 srelay_search(kind=lessons) 直接崩：
//   SqliteError: ambiguous column name: domain
//     at searchLessons (vendor/dist/chunk-*.js:122:19)
// 根因：
//   searchLessons:  SELECT l.* FROM lessons_fts f JOIN lessons l ON l.id = f.rowid
//   visibleWhere:   parts.push("(scope = 'domain' AND domain = ?)")   ← 没有表前缀
//   lessons_fts 和 lessons **两张表都有 domain 列**，且这条分支只在带了 domain
//   选择器时才拼进去 —— 所以平时不崩，插件默认带 domain（实测可见范围 "D:\agent1super + domain:writing"）就必崩。
//
// 修法：visibleWhere 增加可选 alias 参数，JOIN 调用点传 'l'。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openGlobal, addLesson, searchLessons, listLessons } from '../../src/store/global.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ses-lesson-alias-'));
const mk = () => openGlobal(path.join(tmp, Math.random().toString(36).slice(2) + '.sqlite'));
const V = { grade: 'verified-tool' as const, sourceRef: 'x:1' };

describe('[1018] 经验 FTS 检索的列名歧义', () => {
  it('① 带 domain 选择器时 searchLessons 不抛异常（曾经必崩）', () => {
    const db = mk();
    addLesson(db, { text: 'FTS5 的 unicode61 不切中文，索引要用自家分词器', scope: 'global', ...V });
    addLesson(db, { text: '写作类经验：先列提纲再写正文', scope: 'domain', domain: 'writing', ...V });
    // 这一行在修复前抛 SqliteError: ambiguous column name: domain
    expect(() => searchLessons(db, 'FTS5', { domain: 'writing' })).not.toThrow();
    db.close();
  });

  it('② 带 domain 时能取到 global 与同 domain 的条目', () => {
    const db = mk();
    addLesson(db, { text: 'FTS5 的 unicode61 不切中文', scope: 'global', ...V });
    addLesson(db, { text: 'FTS5 写作经验：提纲先行', scope: 'domain', domain: 'writing', ...V });
    addLesson(db, { text: 'FTS5 阅读经验：不该出现', scope: 'domain', domain: 'reading', ...V });
    const got = searchLessons(db, 'FTS5', { domain: 'writing' });
    const texts = got.map((r) => r.text);
    expect(texts.some((t) => t.includes('unicode61'))).toBe(true);
    expect(texts.some((t) => t.includes('提纲先行'))).toBe(true);
    expect(texts.some((t) => t.includes('阅读经验'))).toBe(false);
    db.close();
  });

  it('③ 单表路径（listLessons）不受影响', () => {
    const db = mk();
    addLesson(db, { text: '全局经验一条', scope: 'global', ...V });
    addLesson(db, { text: '写作经验一条', scope: 'domain', domain: 'writing', ...V });
    expect(listLessons(db, { domain: 'writing' }).length).toBe(2);
    expect(listLessons(db, {}).length).toBe(1);
    db.close();
  });
});