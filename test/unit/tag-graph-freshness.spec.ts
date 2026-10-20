// [1021 修「标签一直不更新」] 图的复用判据必须能感知**已有会话里追加的新消息**。
//
// 病历：agent1super 图 693 场 / 库 707 场，图落后一天多，而生命周期日志一直显示"已刷新"。
//   根因：contentFingerprint 只看 sessions 三列（数量 / 抽取版本和 / 最新 created_at）——
//   已有会话追加消息时这三样一个都不变 ⇒ 判据认为"没变化" ⇒ 复用旧图。
// 本文件钉三条不变量：
//   ① 新会话 → 指纹变；
//   ② **已有会话加消息 → 指纹也变**（这是原来漏的那条）；
//   ③ 什么都没变 → 指纹不变（不能变成"每轮必重建"）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDb, insertSession, insertMessage, type DB } from '../../src/store/db.js';
import { contentFingerprint, buildTagGraph } from '../../src/core/graph/tags.js';

let db: DB;
const mk = (id: string, createdAt: string): void => {
  insertSession(db, {
    id, source: 'dsh', sourceSessionId: id, projectId: 'p', title: '会话 ' + id + ' 交付脚本与迁移',
    createdAt, topics: ['db'],
  });
};

beforeEach(() => { db = createDb(':memory:'); });
afterEach(() => { db.close(); });

describe('标签图谱的复用判据（freshness）', () => {
  it('新会话 ⇒ 指纹变', () => {
    mk('s1', '2026-10-01T00:00:00Z');
    insertMessage(db, { sessionId: 's1', role: 'user', content: '采用 PostgreSQL 作为主库', seqNum: 1 });
    const fp1 = contentFingerprint(db);
    mk('s2', '2026-10-02T00:00:00Z');
    insertMessage(db, { sessionId: 's2', role: 'user', content: '索引策略选 B+树', seqNum: 1 });
    expect(contentFingerprint(db)).not.toBe(fp1);
  });

  it('**已有会话追加消息** ⇒ 指纹也要变（原来漏的那条）', () => {
    mk('s1', '2026-10-01T00:00:00Z');
    insertMessage(db, { sessionId: 's1', role: 'user', content: '采用 PostgreSQL 作为主库', seqNum: 1 });
    const fp1 = contentFingerprint(db);
    // 同一会话、同一创建时间，只多一条消息 —— 旧判据会认为"没变化"
    insertMessage(db, { sessionId: 's1', role: 'assistant', content: '补一条：连接池用 20', seqNum: 2, createdAt: '2026-10-03T00:00:00Z' });
    expect(contentFingerprint(db)).not.toBe(fp1);
  });

  it('什么都没变 ⇒ 指纹不变（不能变成每轮必重建）', () => {
    mk('s1', '2026-10-01T00:00:00Z');
    insertMessage(db, { sessionId: 's1', role: 'user', content: '采用 PostgreSQL 作为主库', seqNum: 1 });
    expect(contentFingerprint(db)).toBe(contentFingerprint(db));
  });

  it('buildTagGraph：内容变了会真的重建（reused=false）', () => {
    mk('s1', '2026-10-01T00:00:00Z');
    insertMessage(db, { sessionId: 's1', role: 'user', content: '采用 PostgreSQL 作为主库，迁移脚本放在 scripts/migrate.ts', seqNum: 1 });
    const a = buildTagGraph(db);
    expect(a.reused).toBeFalsy();
    // 同一内容再建一次 ⇒ 复用
    const b = buildTagGraph(db);
    expect(b.reused).toBe(true);
    // 追加一条消息 ⇒ 必须重建
    insertMessage(db, { sessionId: 's1', role: 'assistant', content: '补充：索引走 BRIN，见 core/index.ts', seqNum: 2, createdAt: '2026-10-04T00:00:00Z' });
    const c = buildTagGraph(db);
    expect(c.reused).toBeFalsy();
  });
});
