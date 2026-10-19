// P1-2 分析脚本：归档未决（audit P0）的只读清点 + 逐条建议。
//
// 钉三件事：① 与 audit 同一份判据（条数必须相等）；② 全程只读；③ 报告只给"标记/隐藏/迁移"
// 三条路，**永远不出现删除**；扫描失败必须显形（failedProjects），不许当 0 条。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDb, upsertCapturedSession, insertMessage, type DB } from '../../src/store/db.js';
import { scanArchivedUnresolved, auditArchivedUnresolved } from '../../src/core/audit/audit.js';
import { analyzeArchivedUnresolved, formatReport, suggestAction } from '../../scripts/archived-unresolved-report.js';

const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString();
let tmp = '';
let db: DB;

function seed(opts: { archived?: boolean; tag?: string } = {}): string {
  const tag = opts.tag ?? '';
  const id = upsertCapturedSession(db, {
    source: 'zcode', sourceSessionId: 'au-' + String(Math.random()).slice(2), projectId: 'p',
    title: '交接文档（唯一入口）' + tag, createdAt: iso(20), lastEventAt: iso(3), sourceFile: 'fixture:au',
  }).id;
  db.prepare("UPDATE sessions SET state = 'confirmed', message_count = 183 WHERE id = ?").run(id);
  // 未决文本必须**跨会话不同**：listUnresolved 有跨会话去重（同文本只保留最新一条），
  // 用同样的文本造"活会话"会让归档那条被折叠掉，测到的就不是"归档未决"了。
  db.prepare('UPDATE sessions SET key_questions = ? WHERE id = ?').run(JSON.stringify([
    { q: '归档后这条未决怎么办？' + tag, seq: 1, msgId: 7, at: iso(10), unresolved: true },
    { q: '没有锚点的那条未决是什么？' + tag, seq: 2, at: iso(9), unresolved: true },
  ]), id);
  if (opts.archived !== false) db.prepare('UPDATE sessions SET cleanup_at = ? WHERE id = ?').run(iso(1), id);
  return id;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'srelay-p0-report-'));
  db = createDb(path.join(tmp, 'relay.sqlite'));
});
afterEach(() => {
  try { db.close(); } catch { /* 已关 */ }
  for (let i = 0; i < 3; i++) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); return; } catch { /* Windows 句柄延迟 */ }
  }
});

describe('P0 分析 · 归档未决', () => {
  it('只清点归档会话上的未决；与 audit 同一份判据（条数相等）', () => {
    const archived = seed({ archived: true });
    seed({ archived: false, tag: '（活会话）' });   // 活会话的未决不许混进来
    const rep = analyzeArchivedUnresolved(db, { dbPath: 'x' });
    expect(rep.total).toBe(2);
    expect(rep.archivedSessions).toBe(1);
    expect(rep.projects).toHaveLength(1);
    expect(rep.projects[0].items.every((it) => it.sessionId === archived)).toBe(true);
    // audit 的 P0 计数必须与脚本一致（两边共用 scanArchivedUnresolved）
    expect(scanArchivedUnresolved(db, 'p').items).toHaveLength(2);
    expect(auditArchivedUnresolved(db, 'p').count).toBe(2);
  });

  it('建议按"有没有 msgId"分流：有 ⇒ mark-lost，没有 ⇒ hide-from-brief；都不删', () => {
    seed();
    const rep = analyzeArchivedUnresolved(db);
    const items = rep.projects[0].items;
    const withId = items.find((it) => String(it.msgId) === '7')!;
    const without = items.find((it) => it.msgId === undefined)!;
    expect(withId.action).toBe('mark-lost');
    expect(withId.reason).toContain('msgId');
    expect(without.action).toBe('hide-from-brief');
    expect(suggestAction({ ...withId, msgId: undefined }).action).toBe('hide-from-brief');
    expect(suggestAction({ ...withId, msgId: '   ' }).action).toBe('hide-from-brief');
    // 每条建议都不含"删除"语义
    for (const it of items) expect(it.reason).not.toMatch(/删除|清除|drop|delete/i);
  });

  it('正文剩余条数如实统计（归档会话应为 0；正文还在时必须标出来）', () => {
    const id = seed();
    insertMessage(db, { sessionId: id, role: 'user', content: '这条正文居然还在', seqNum: 50, createdAt: iso(2) });
    const rep = analyzeArchivedUnresolved(db);
    expect(rep.projects[0].items[0].messagesInDb).toBe(1);
    expect(rep.projects[0].items[0].messageCount).toBe(183);
  });

  it('报告：结论/分会话/三条路齐全，且永不建议删除', () => {
    seed();
    const md = formatReport(analyzeArchivedUnresolved(db, { dbPath: 'D:/x/relay.sqlite' }));
    expect(md).toContain('# P0 清理分析：归档会话的未决');
    expect(md).toContain('只读分析');
    expect(md).toContain('共 **2 条**未决');
    expect(md).toContain('归档后这条未决怎么办？');
    expect(md).toContain('没有锚点的那条未决是什么？');
    expect(md).toContain('### A. 标记为 `lost`');
    expect(md).toContain('### B. 从简报隐藏');
    expect(md).toContain('### C. 迁移到全局经验库');
    expect(md).toContain('**不删除**');
    expect(md).not.toMatch(/建议删除|直接删掉/);
  });

  it('只读：分析前后 sessions / key_questions 一个字节都没变', () => {
    seed();
    const before = JSON.stringify(db.prepare('SELECT id, key_questions, cleanup_at FROM sessions ORDER BY id').all());
    analyzeArchivedUnresolved(db);
    formatReport(analyzeArchivedUnresolved(db));
    const after = JSON.stringify(db.prepare('SELECT id, key_questions, cleanup_at FROM sessions ORDER BY id').all());
    expect(after).toBe(before);
  });

  it('空库：报告明说"库里没有任何项目"，不是假装 0 条债', () => {
    const md = formatReport(analyzeArchivedUnresolved(db, { dbPath: 'x' }));
    expect(md).toContain('库里没有任何项目');
  });

  it('扫描失败不许静默：failedProjects 计数 + 报告里带原因', () => {
    seed();
    db.exec('DROP TABLE messages');   // 正文表没了 ⇒ 统计正文条数会抛
    const rep = analyzeArchivedUnresolved(db);
    expect(rep.failedProjects).toBe(1);
    expect(rep.projects[0].error).toBeTruthy();
    const md = formatReport(rep);
    expect(md).toContain('扫描失败');
    expect(md).toContain('不完整');
  });
});
