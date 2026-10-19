// P0-2 的简报出口：审计 P0 必须出现在**简报最前**（auditAlert），无 P0 时完全静默。
//
// 为什么单独钉：告警只有真的进到简报里才算闭环。只把结果写进 health_events 等于
// 换了个地方放抽屉 —— 面板/数据库有，但 agent 看不到。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDb, insertSession, type DB } from '../../src/store/db.js';
import { collectBrief } from '../../src/cli/brief.js';
import { openGlobal } from '../../src/store/global.js';
import { ensureLifecycleTables, logHealthEvent } from '../../src/core/lifecycle/stages.js';

let tmp = '';
let prevHome: string | undefined;

function withGlobal(fn: (g: ReturnType<typeof openGlobal>) => void): void {
  const g = openGlobal();
  try { ensureLifecycleTables(g); fn(g); } finally { g.close(); }
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'srelay-brief-audit-'));
  prevHome = process.env.SRELAY_GLOBAL_HOME;
  process.env.SRELAY_GLOBAL_HOME = path.join(tmp, 'global');
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.SRELAY_GLOBAL_HOME;
  else process.env.SRELAY_GLOBAL_HOME = prevHome;
  for (let i = 0; i < 3; i++) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); return; } catch { /* Windows 句柄延迟 */ }
  }
});

function projectDb(): DB {
  const db = createDb(':memory:');
  insertSession(db, { id: 's1', source: 'dsh', sourceSessionId: 's1', projectId: 'p', title: '会话一', createdAt: new Date().toISOString() });
  return db;
}

describe('简报顶部 · 审计告警', () => {
  it('最近一次审计是 P0 ⇒ auditAlert 出现在 payload（简报第一行）；修好后静默', () => {
    const alert = '⚠ 审计 P0：32 条归档会话仍有未决';
    withGlobal((g) => {
      logHealthEvent(g, 'audit', 'warn', alert, JSON.stringify({ root: tmp, p0: 1, p1: 0, skipped: 0, alert, hits: [] }));
    });
    const db = projectDb();
    try {
      expect(collectBrief(db, 'p', {}, tmp).auditAlert).toBe(alert);
    } finally { db.close(); }

    // 下一轮审计（无 P0）写 info ⇒ 简报立刻恢复静默（不拿旧账吓人）
    withGlobal((g) => {
      logHealthEvent(g, 'audit', 'info', '审计无 P0（P1 0 项 / 跳过 1 项）', JSON.stringify({ root: tmp, p0: 0, p1: 0, skipped: 1, alert: null }));
    });
    const db2 = projectDb();
    try {
      expect(collectBrief(db2, 'p', {}, tmp).auditAlert).toBeNull();
    } finally { db2.close(); }
  });

  it('别的项目的 P0 不会串到本项目简报里', () => {
    withGlobal((g) => {
      logHealthEvent(g, 'audit', 'warn', '⚠ 审计 P0：9 条归档会话仍有未决', JSON.stringify({ root: 'D:/other/project', alert: '⚠ 审计 P0：9 条归档会话仍有未决' }));
    });
    const db = projectDb();
    try { expect(collectBrief(db, 'p', {}, tmp).auditAlert).toBeNull(); } finally { db.close(); }
  });

  it('没跑过审计 / 没给 root ⇒ null（正常状态，不报错）', () => {
    const db = projectDb();
    try {
      expect(collectBrief(db, 'p', {}, tmp).auditAlert).toBeNull();
      expect(collectBrief(db, 'p', {}).auditAlert).toBeNull();
    } finally { db.close(); }
  });
});
