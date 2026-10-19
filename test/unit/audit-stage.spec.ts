// P0-2：审计挂进生命周期 —— 阶段只读、24h 节奏、P0 出告警、无 P0 静默。
//
// 为什么这些判据必须钉死：
//   · 「24h 一次」若退化成每轮都跑，health_events 会每天刷 96 条同样的账，真告警被淹；
//   · 「只读」若被破坏，audit 就成了第三个写入方（1017 的 SQLITE_BUSY 就是这么来的）；
//   · 「P0 才告警」若写反，每天一条假红字 = 狼来了，比没有更糟。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDb, upsertCapturedSession, type DB } from '../../src/store/db.js';
import { projectIdOf, dbFile } from '../../src/shared/paths.js';
import { runAuditStage, latestAuditAlert, auditAlertLine, AUDIT_ALERT_MAX_AGE_MS } from '../../src/core/lifecycle/audit-stage.js';
import { STAGES, dueStages, recordStage, ensureLifecycleTables, logHealthEvent, type LifecycleState, LIFECYCLE_VERSION } from '../../src/core/lifecycle/stages.js';

const DAY = 86_400_000;
const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY).toISOString();

let tmp = '';
let pid = '';

function seedProject(opts: { archivedUnresolved?: boolean } = {}): void {
  fs.mkdirSync(path.join(tmp, '.sessionrelay'), { recursive: true });
  const db = createDb(dbFile(tmp));
  try {
    const id = upsertCapturedSession(db, {
      source: 'dsh', sourceSessionId: 'stage-1', projectId: pid, title: '归档会话',
      createdAt: iso(5), lastEventAt: iso(1), sourceFile: 'fixture:stage-1',
    }).id;
    db.prepare("UPDATE sessions SET state = 'confirmed' WHERE id = ?").run(id);
    if (opts.archivedUnresolved) {
      db.prepare('UPDATE sessions SET cleanup_at = ?, message_count = 0 WHERE id = ?').run(iso(0), id);
      db.prepare('UPDATE sessions SET key_questions = ? WHERE id = ?')
        .run(JSON.stringify([{ q: '归档后这条未决怎么办', seq: 1, msgId: 7, unresolved: true }]), id);
    }
  } finally { db.close(); }
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'srelay-audit-stage-'));
  pid = projectIdOf(tmp);
});
afterEach(() => {
  for (let i = 0; i < 3; i++) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); return; } catch { /* Windows 句柄延迟 */ }
  }
});

describe('生命周期 · audit 阶段', () => {
  it('阶段表第 12 项是 audit：只读、24h 节奏、不参与熔断', () => {
    expect(STAGES.map((s) => s.id)).toContain('audit');
    expect(STAGES).toHaveLength(12);
    const a = STAGES.find((s) => s.id === 'audit')!;
    expect(a.mutates).toBe(false);          // 只读：不得写业务表
    expect(a.everySec).toBe(86400);         // 默认 24h 最多一次
    expect(a.weight).toBe('light');
  });

  it('24h 幂等：跑过一次之后，同一天不会再到期；跨过 24h 才到期', () => {
    const st: LifecycleState = { version: LIFECYCLE_VERSION, rounds: 0, lastAt: null, stages: {} };
    const t0 = Date.parse('2026-10-19T08:00:00Z');
    expect(dueStages(st, t0).map((s) => s.id)).toContain('audit');   // 从没跑过 ⇒ 到期
    recordStage(st, 'audit', { ok: true, note: 'P0 0 项', at: new Date(t0).toISOString(), ms: 5 });
    expect(dueStages(st, t0 + 3600_000).map((s) => s.id)).not.toContain('audit');    // 1 小时后：不到期
    expect(dueStages(st, t0 + 23 * 3600_000).map((s) => s.id)).not.toContain('audit'); // 23 小时：不到期
    expect(dueStages(st, t0 + 25 * 3600_000).map((s) => s.id)).toContain('audit');   // 25 小时：到期
  });

  it('有 P0（归档会话仍有未决）⇒ fail + 一行告警；六项全部有 status', () => {
    seedProject({ archivedUnresolved: true });
    const rep = runAuditStage({ roots: [tmp], openGlobalDb: () => ({ db: null }) });
    const it = rep.items[0];
    expect(it.status).toBe('fail');
    expect(it.p0).toBe(1);
    expect(it.alert).toBe('⚠ 审计 P0：1 条归档会话仍有未决');
    expect(rep.alert).toBe(it.alert);
    expect(rep.note).toContain('P0 1 项');
    // 命中摘要必须带条数（"哪里坏了"不够，得说"坏了几条"）
    expect(it.hits.some((h) => h.includes('1 条'))).toBe(true);
  });

  it('无 P0 ⇒ ok + alert=null（静默）；P1 照常计数但不告警', () => {
    seedProject({ archivedUnresolved: false });
    // 造一条 P1：缺 msgId 的决策
    const db = createDb(dbFile(tmp));
    db.prepare('UPDATE sessions SET decisions = ?').run(JSON.stringify([{ text: '决定采用 SQLite FTS5 作为唯一检索层', seq: 1 }]));
    db.close();
    const rep = runAuditStage({ roots: [tmp], openGlobalDb: () => ({ db: null }) });
    expect(rep.items[0].status).toBe('ok');
    expect(rep.items[0].p1).toBeGreaterThanOrEqual(1);
    expect(rep.items[0].alert).toBeNull();
    expect(rep.alert).toBeNull();
  });

  it('库打不开 / 没建库 ⇒ skipped + 原因（不许当 0 条通过）', () => {
    const missing = path.join(tmp, 'not-initialized');
    fs.mkdirSync(missing, { recursive: true });
    const rep = runAuditStage({ roots: [missing], openGlobalDb: () => ({ db: null }) });
    expect(rep.items[0].status).toBe('skipped');
    expect(rep.items[0].note).toContain('项目库不存在');
    expect(rep.unreadable).toBe(1);
    expect(rep.note).toContain('没测到');
  });

  it('只读：跑完后业务列一个字节都没变', () => {
    seedProject({ archivedUnresolved: true });
    const before = (() => {
      const db = createDb(dbFile(tmp));
      try {
        return JSON.stringify(db.prepare('SELECT id, decisions, key_questions, cleanup_at, message_count FROM sessions ORDER BY id').all());
      } finally { db.close(); }
    })();
    runAuditStage({ roots: [tmp], openGlobalDb: () => ({ db: null }) });
    const after = (() => {
      const db = createDb(dbFile(tmp));
      try {
        return JSON.stringify(db.prepare('SELECT id, decisions, key_questions, cleanup_at, message_count FROM sessions ORDER BY id').all());
      } finally { db.close(); }
    })();
    expect(after).toBe(before);
  });

  it('告警行拼法：只拼 P0、带条数、多项用 · 分隔', () => {
    const line = auditAlertLine([
      { id: 'archived-unresolved', severity: 'P0', criteria: 'x', status: 'fail', count: 32, samples: [] },
      { id: 'fts-integrity', severity: 'P0', criteria: 'x', status: 'fail', count: 3, samples: [] },
      { id: 'decision-fragment', severity: 'P1', criteria: 'x', status: 'fail', count: 9, samples: [] },
      { id: 'map-node-no-sources', severity: 'P1', criteria: 'x', status: 'skipped', count: 0, samples: [] },
    ]);
    expect(line).toBe('⚠ 审计 P0：32 条归档会话仍有未决 · FTS 索引不一致 3 行');
    expect(auditAlertLine([])).toBe('');
  });
});

describe('简报告警 · latestAuditAlert', () => {
  function globalDb(): DB {
    const db = createDb(path.join(tmp, 'global-test.sqlite'));
    ensureLifecycleTables(db);
    return db;
  }

  it('最新一条是 warn+alert ⇒ 返回告警；同项目更新的 info ⇒ 立刻静默', () => {
    const g = globalDb();
    try {
      logHealthEvent(g, 'audit', 'warn', '⚠ 审计 P0：1 条归档会话仍有未决', JSON.stringify({ root: tmp, alert: '⚠ 审计 P0：1 条归档会话仍有未决' }));
      expect(latestAuditAlert(g, tmp)).toBe('⚠ 审计 P0：1 条归档会话仍有未决');
      logHealthEvent(g, 'audit', 'info', '审计无 P0', JSON.stringify({ root: tmp, alert: null }));
      expect(latestAuditAlert(g, tmp)).toBeNull();   // 修好之后旧 warn 不许继续挂红字
    } finally { g.close(); }
  });

  it('别的项目的告警不会串台；路径分隔符/大小写不影响匹配', () => {
    const g = globalDb();
    try {
      logHealthEvent(g, 'audit', 'warn', 'x', JSON.stringify({ root: 'D:/another/project', alert: '⚠ 审计 P0：9 条归档会话仍有未决' }));
      expect(latestAuditAlert(g, tmp)).toBeNull();
      logHealthEvent(g, 'audit', 'warn', 'x', JSON.stringify({ root: tmp.replace(/\\/g, '/').toUpperCase(), alert: '⚠ 审计 P0：2 条归档会话仍有未决' }));
      expect(latestAuditAlert(g, tmp)).toBe('⚠ 审计 P0：2 条归档会话仍有未决');
    } finally { g.close(); }
  });

  it('结论过期（>7 天）⇒ 静默，不拿旧账吓人', () => {
    const g = globalDb();
    try {
      const r = g.prepare("INSERT INTO health_events (at, stage, level, message, detail) VALUES (?, 'audit', 'warn', 'x', ?)")
        .run(iso(8), JSON.stringify({ root: tmp, alert: '⚠ 审计 P0：1 条归档会话仍有未决' }));
      expect(Number(r.lastInsertRowid)).toBeGreaterThan(0);
      expect(latestAuditAlert(g, tmp)).toBeNull();
      // 边界内仍然有效
      expect(latestAuditAlert(g, tmp, { now: Date.now() - 6 * DAY, maxAgeMs: AUDIT_ALERT_MAX_AGE_MS })).toBe('⚠ 审计 P0：1 条归档会话仍有未决');
    } finally { g.close(); }
  });

  it('读不到全局库 / 老库没有 health_events 表 ⇒ null（不抛）', () => {
    expect(latestAuditAlert(null, tmp)).toBeNull();
    const bare = createDb(path.join(tmp, 'bare.sqlite'));
    try { expect(latestAuditAlert(bare, tmp)).toBeNull(); } finally { bare.close(); }
  });
});
