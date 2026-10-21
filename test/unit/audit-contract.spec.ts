// 审计契约（task-11）单测：逐项检查 + 分级 + 退出码 + 只读纪律。
//
// 为什么每条判据都要钉死：audit 是"唯一一处把各类数据契约同时看一遍"的地方，
// 一旦它开始报假数，人就会像对待狼来了一样忽略它——那比没有 audit 更糟。
// 所以这里刻意每条用例都用**真实形状**的夹具（真 createDb / 真 FTS 触发器 / 真地图文件），
// 不走 mock：这些检查的失败模式全是"SQL 写错但静默返回 0"，mock 一个都抓不到。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  AUDIT_CHECKS,
  LESSON_DRAFT_STALE_DAYS,
  SAMPLE_LIMIT,
  auditArchivedUnresolved,
  auditDecisionFragments,
  auditDecisionMsgIds,
  auditFtsIntegrity,
  auditMapNodesWithoutSources,
  auditStaleLessonDrafts,
  exitCodeOf,
  isStaleDraft,
  runAudit,
  type AuditFinding,
} from '../../src/core/audit/audit.js';
import { createDb, insertMessage, upsertCapturedSession, type DB } from '../../src/store/db.js';
import { openGlobal, addLesson } from '../../src/store/global.js';

const DAY = 86_400_000;
const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY).toISOString();
const PID = 'proj-audit';
let tmp = '';
let db: DB;
let seq = 0;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'srelay-audit-'));
  fs.mkdirSync(path.join(tmp, '.sessionrelay'), { recursive: true });
  db = createDb(path.join(tmp, '.sessionrelay', 'relay.sqlite'));
});
afterEach(() => {
  try { db.close(); } catch { /* 已关 */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* Windows 句柄延迟 */ }
});

/** 造一场会话并直接写 decisions/key_questions JSON（形状与抽取器输出一致）。 */
function seedSession(opts: {
  uuid: string; state?: string; daysAgo?: number; archived?: boolean;
  decisions?: Array<Record<string, unknown>>; questions?: Array<Record<string, unknown>>;
}): string {
  const days = opts.daysAgo ?? 1;
  // state 不走 upsertCapturedSession（那条路径只建 active）：状态由下面的 UPDATE 显式落，
  // 这样夹具与"真实库里一行长什么样"一致，而不是绕过类型去塞一个不存在的入参。
  const up = upsertCapturedSession(db, {
    source: 'dsh', sourceSessionId: opts.uuid, projectId: PID, title: '会话 ' + opts.uuid,
    createdAt: iso(days), lastEventAt: iso(days), sourceFile: 'fixture:' + opts.uuid,
  });
  const id = up.id;
  db.prepare("UPDATE sessions SET state = ?, confirmed_at = ? WHERE id = ?").run(opts.state ?? 'confirmed', iso(days), id);
  if (opts.decisions) db.prepare('UPDATE sessions SET decisions = ? WHERE id = ?').run(JSON.stringify(opts.decisions), id);
  if (opts.questions) db.prepare('UPDATE sessions SET key_questions = ? WHERE id = ?').run(JSON.stringify(opts.questions), id);
  if (opts.archived) db.prepare('UPDATE sessions SET cleanup_at = ?, message_count = 0 WHERE id = ?').run(iso(0), id);
  return id;
}

function addMessages(sessionId: string, n: number): number[] {
  const ids: number[] = [];
  for (let i = 0; i < n; i++) {
    insertMessage(db, { sessionId, role: i % 2 ? 'assistant' : 'user', content: '消息 ' + String(i) + ' 关于 SQLite 索引', seqNum: ++seq, createdAt: iso(1) });
    ids.push(Number((db.prepare('SELECT id FROM messages WHERE session_id = ? AND seq_num = ?').get(sessionId, seq) as { id: number }).id));
  }
  return ids;
}

describe('审计契约 · 清单与分级', () => {
  it('八项齐全、P0/P1 分级固定（分级一变，CI 的退出码语义就跟着变）', () => {
    expect(AUDIT_CHECKS.map((c) => c.id)).toEqual([
      'decision-missing-msgid', 'decision-fragment', 'decision-conflict', 'lesson-draft-stale',
      'archived-unresolved', 'map-node-no-sources', 'map-source-drift', 'fts-integrity',
    ]);
    const p0 = AUDIT_CHECKS.filter((c) => c.severity === 'P0').map((c) => c.id);
    const p1 = AUDIT_CHECKS.filter((c) => c.severity === 'P1').map((c) => c.id);
    expect(p0).toEqual(['archived-unresolved', 'fts-integrity']);
    expect(p1).toEqual(['decision-missing-msgid', 'decision-fragment', 'decision-conflict', 'lesson-draft-stale', 'map-node-no-sources', 'map-source-drift']);
    // 每项都必须写清"这个数怎么算的"——没有判据的条目等于不可审计
    for (const c of AUDIT_CHECKS) expect(c.criteria.length).toBeGreaterThan(20);
  });

  it('退出码：全过 0 / 只有 P1 是 1 / 有 P0 是 2；skipped 不影响结论', () => {
    const mk = (severity: 'P0' | 'P1', status: 'ok' | 'fail' | 'skipped', count: number): AuditFinding => ({
      id: 'decision-fragment', severity, criteria: 'x', status, count, samples: [],
    });
    expect(exitCodeOf([])).toBe(0);
    expect(exitCodeOf([mk('P1', 'ok', 0), mk('P0', 'ok', 0)])).toBe(0);
    expect(exitCodeOf([mk('P1', 'fail', 3)])).toBe(1);
    expect(exitCodeOf([mk('P1', 'fail', 3), mk('P0', 'fail', 1)])).toBe(2);
    expect(exitCodeOf([mk('P1', 'skipped', 0), mk('P0', 'skipped', 0)])).toBe(0);
  });
});

describe('审计契约 · 决策缺 msgId / 碎片', () => {
  it('缺 msgId 的决策被逐条数出，样例 id = sessionId#seq，最多 5 条', () => {
    const id = seedSession({
      uuid: 'dec-1',
      decisions: [
        { text: '决定采用 SQLite FTS5 作为唯一检索层', seq: 1, msgId: 101 },
        { text: '改用 note 通道写结论', seq: 2 },
        { text: '把 refreshExtraction 挪到 confirm 里', seq: 3 },
        { text: '决定放弃向量检索', seq: 4 },
        { text: '决定用 bigram 兜底分词', seq: 5 },
        { text: '决定把守护改成全局模式', seq: 6 },
        { text: '决定 map 只读+revision 校验', seq: 7 },
      ],
    });
    const f = auditDecisionMsgIds(db, PID);
    expect(f.id).toBe('decision-missing-msgid');
    expect(f.severity).toBe('P1');
    expect(f.status).toBe('fail');
    expect(f.count).toBe(6);
    expect(f.samples).toHaveLength(SAMPLE_LIMIT);
    expect(f.samples[0]).toBe(id + '#2');
    expect(f.note).toContain('1/7');
  });

  it('碎片用 vagueDecisionObject 同一份判据：只数碎片，不误伤带具体对象的真决策', () => {
    seedSession({
      uuid: 'dec-2',
      decisions: [
        { text: '换成我们的了', seq: 1, msgId: 1 },          // 碎片（指代宾语）
        { text: '决定这样', seq: 2, msgId: 2 },              // 碎片
        { text: '改用 note 通道', seq: 3, msgId: 3 },        // 真决策
        { text: '决定采用我们的项目结构而不是 vendor', seq: 4, msgId: 4 },  // 长宾语，放行
      ],
    });
    const f = auditDecisionFragments(db, PID);
    expect(f.count).toBe(2);
    expect(f.samples).toHaveLength(2);
    expect(f.status).toBe('fail');
  });

  it('空库不报假警（0 条 = 真的没有，不是"没查到"）', () => {
    const a = auditDecisionMsgIds(db, PID);
    const b = auditDecisionFragments(db, PID);
    expect([a.status, a.count, b.status, b.count]).toEqual(['ok', 0, 'ok', 0]);
  });
});

describe('审计契约 · 经验草稿超期', () => {
  it('判据：draft + 年龄 > 30 天；时间坏了宁可漏报也不误报', () => {
    expect(LESSON_DRAFT_STALE_DAYS).toBe(30);
    expect(isStaleDraft(iso(31))).toBe(true);
    expect(isStaleDraft(iso(29))).toBe(false);
    expect(isStaleDraft(null)).toBe(false);
    expect(isStaleDraft('not-a-date')).toBe(false);
  });

  it('全局库打不开 ⇒ skipped 且带原因（绝不当成 0 条草稿）', () => {
    const f = auditStaleLessonDrafts(null, {});
    expect(f.status).toBe('skipped');
    expect(f.count).toBe(0);
    expect(f.note).toBeTruthy();
  });

  it('只数可见范围内的超期草稿：老 draft 命中，verified 与新鲜 draft 不命中', () => {
    // 刻意用**真的** openGlobal + addLesson：lessons 表结构与写入判据（grade/status 的联动）
    // 只有那一份，测试里再抄一遍 DDL 就等于埋了第二套口径（本仓最爱踩的坑）。
    const prevHome = process.env.SRELAY_GLOBAL_HOME;
    process.env.SRELAY_GLOBAL_HOME = path.join(tmp, 'global');
    const g = openGlobal();
    try {
      // scope 必须显式给：默认是 project，而 project 档要求 workspaceId（addLesson 自己的闸门）
      const stale = addLesson(g, { text: '超期草稿：正文早该有人看一眼了', status: 'draft', scope: 'global' });
      const fresh = addLesson(g, { text: '新鲜草稿：刚采集上来', status: 'draft', scope: 'global' });
      const verified = addLesson(g, { text: '已升格的经验', grade: 'verified-user', sourceRef: 'session:x', scope: 'global' });
      const other = addLesson(g, { text: '别的项目的超期草稿', status: 'draft', workspaceId: 'D:/other-project' });
      expect(verified).toBeTruthy();
      // 直接把 created_at 推到过去：这是唯一能"造出 40 天前"的办法（不改判据，只改时间）
      const backdate = g.prepare('UPDATE lessons SET created_at = ? WHERE id = ?');
      backdate.run(iso(40), stale.id);
      backdate.run(iso(60), other.id);
      const f = auditStaleLessonDrafts(g as never, { workspaceId: tmp, domain: 'writing' });
      expect(f.status).toBe('fail');
      expect(f.count).toBe(1);
      expect(f.samples[0]).toBe('lesson#' + String(stale.id));
      expect(f.note).toContain('2');   // 可见草稿共 2 条（超期 1 + 新鲜 1）
      expect(fresh.id).not.toBe(stale.id);
    } finally {
      g.close();
      if (prevHome === undefined) delete process.env.SRELAY_GLOBAL_HOME;
      else process.env.SRELAY_GLOBAL_HOME = prevHome;
    }
  });
});

describe('审计契约 · 已归档会话仍有未决', () => {
  it('把未决落在 cleanup_at 非空的会话上 ⇒ P0；普通会话的未决不算', () => {
    const archived = seedSession({
      uuid: 'arch-1', archived: true,
      questions: [{ q: '归档后还剩哪个坑没填', seq: 3, msgId: 7, unresolved: true }],
    });
    seedSession({
      uuid: 'live-1',
      questions: [{ q: '这条未决的正文还在', seq: 4, msgId: 8, unresolved: true }],
    });
    const f = auditArchivedUnresolved(db, PID);
    expect(f.severity).toBe('P0');
    expect(f.status).toBe('fail');
    expect(f.count).toBe(1);
    expect(f.samples[0]).toBe(archived + '#7');
    expect(f.note).toContain('1');
  });

  it('没有未决 / 没有归档会话都算通过（且不因 listUnresolved 默认上限被截断成假 0）', () => {
    seedSession({ uuid: 'arch-2', archived: true, questions: [] });
    expect(auditArchivedUnresolved(db, PID).count).toBe(0);
    // 45 条未决全部落在归档会话上：默认 limit=20 会漏，audit 必须数到 45
    const many = Array.from({ length: 45 }, (_, i) => ({ q: '未决问题 ' + String(i) + ' 需要拍板', seq: i + 1, msgId: 100 + i, unresolved: true }));
    seedSession({ uuid: 'arch-3', archived: true, questions: many });
    const f = auditArchivedUnresolved(db, PID);
    expect(f.count).toBe(45);
    expect(f.samples).toHaveLength(SAMPLE_LIMIT);
  });
});

describe('审计契约 · 地图节点无 sources', () => {
  function writeMap(pageId: string, nodes: unknown[]): void {
    const dir = path.join(tmp, '.sessionrelay', 'map');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, pageId + '.json'), JSON.stringify({
      version: 1, title: '审计夹具',
      layers: [{ id: 'a', name: 'A', rank: 0 }],
      groups: [], lanes: [], nodes, edges: [],
    }, null, 2) + '\n', 'utf8');
  }

  it('sources 空/缺省都算无证据，done 的排前面样例', () => {
    writeMap('map', [
      { id: 'n-done', label: '已完成但没证据', layer: 'a', status: 'done' },
      { id: 'n-todo', label: '待办', layer: 'a', status: 'todo' },
      { id: 'n-ok', label: '有证据', layer: 'a', status: 'done', sources: [{ path: 'src/core/audit/audit.ts', sha256: 'a'.repeat(64) }] },
      { id: 'n-empty', label: 'sources 是空数组', layer: 'a', status: 'doing', sources: [] },
    ]);
    const f = auditMapNodesWithoutSources(tmp);
    expect(f.id).toBe('map-node-no-sources');
    expect(f.status).toBe('fail');
    expect(f.count).toBe(3);
    expect(f.samples[0]).toBe('map/n-done');   // done 优先
    expect(f.note).toContain('status=done 的 1 个');
  });

  it('没有地图是 skipped（未建图 ≠ 有债），不是 0 条通过', () => {
    const f = auditMapNodesWithoutSources(tmp);
    expect(f.status).toBe('skipped');
    expect(f.note).toBeTruthy();
    expect(auditMapNodesWithoutSources(null).status).toBe('skipped');
  });
});

describe('审计契约 · FTS 一致性（只读等价实现）', () => {
  it('健康库通过；幽灵行与漏索引行都被数出并带样例', () => {
    const sid = seedSession({ uuid: 'fts-1' });
    const ids = addMessages(sid, 3);
    const clean = auditFtsIntegrity(db);
    expect(clean.status).toBe('ok');
    expect(clean.count).toBe(0);

    // 幽灵行：索引里有、messages 里没有（手工往 FTS 塞一个不存在的 rowid）
    db.prepare("INSERT INTO messages_fts(rowid, search_text) VALUES (?, '幽灵行')").run(999_999);
    // 漏索引行：内容表有、索引里没有（把触发器摘掉再插，模拟写路径绕过触发器）
    db.exec('DROP TRIGGER messages_fts_ai');
    insertMessage(db, { sessionId: sid, role: 'user', content: '这条不会被索引', seqNum: ++seq, createdAt: iso(1) });

    const f = auditFtsIntegrity(db);
    expect(f.status).toBe('fail');
    expect(f.severity).toBe('P0');
    expect(f.count).toBe(2);
    expect(f.samples).toContain('messages_fts:ghost#999999');
    expect(f.samples.some((s) => s.startsWith('messages_fts:missing#'))).toBe(true);
    expect(ids.length).toBe(3);
  });

  it('会话索引（rowid 主键）也一起查：sessions_fts 的幽灵行同样被抓', () => {
    seedSession({ uuid: 'fts-2' });
    db.prepare("INSERT INTO sessions_fts(rowid, meta_text) VALUES (?, '幽灵会话')").run(888_888);
    const f = auditFtsIntegrity(db);
    expect(f.status).toBe('fail');
    expect(f.samples).toContain('sessions_fts:ghost#888888');
    expect(f.note).toBeUndefined();
  });
});

describe('审计契约 · 汇总报告', () => {
  it('runAudit 八项全跑一遍；单项抛错降级 skipped 而不拖垮整场审计', () => {
    const broken = {
      prepare: () => { throw new Error('模拟坏库'); },
    } as unknown as DB;
    const r = runAudit({ db: broken, projectId: PID, global: null, root: tmp });
    expect(r.checks).toHaveLength(8);
    expect(r.checks.map((c) => c.id)).toEqual(AUDIT_CHECKS.map((c) => c.id));
    // 读库的五项 + 地图项全部因坏库 skipped；经验项因 global=null 也 skipped
    expect(r.totals.skipped).toBeGreaterThanOrEqual(5);
    expect(r.exitCode).toBe(0);   // skipped 不是失败：没测到 ≠ 有债
  });

  it('报告口径：P0 命中即 exitCode=2，totals 按级别分开数', () => {
    const sid = seedSession({
      uuid: 'sum-1', archived: true,
      decisions: [{ text: '换成我们的了', seq: 1 }],
      questions: [{ q: '归档会话里的未决问题', seq: 2, unresolved: true }],
    });
    addMessages(sid, 2);
    const r = runAudit({ db, projectId: PID, global: null, root: tmp });
    const byId = new Map(r.checks.map((c) => [c.id, c]));
    expect(byId.get('archived-unresolved')?.status).toBe('fail');
    expect(byId.get('decision-fragment')?.status).toBe('fail');
    expect(byId.get('decision-missing-msgid')?.status).toBe('fail');
    expect(r.totals.p0).toBe(1);
    expect(r.totals.failed).toBe(3);
    expect(r.exitCode).toBe(2);
    expect(r.generatedAt).toBeTruthy();
    expect(r.projectId).toBe(PID);
  });
});
// ─────────── CLI 层：退出码 0/1/2（端到端，真的 spawn 一个 srelay 子进程）───────────
//
// 为什么这段不走 mock：退出码是**契约**，而"把 process.exitCode 写对"这件事
// 只在真的跑一次进程时才被测到（历史上这里是空过最多次的地方）。
// 也不走 requireRoot：audit 自己解析根，且**不**懒启动守护 —— 子进程里断言不到"守护没被拉起"，
// 所以只断言退出码与 JSON 形状。

interface CliRun { code: number; out: string }

function runCli(args: string[], cwd: string): CliRun {
  const repo = fileURLToPath(new URL('../..', import.meta.url));
  const loader = 'file:///' + path.join(repo, 'node_modules', 'tsx', 'dist', 'loader.mjs').replace(/\\/g, '/');
  const env = { ...process.env, VITEST: '1', SRELAY_GLOBAL_HOME: path.join(cwd, 'no-global-here') };
  try {
    const out = execFileSync(process.execPath, ['--import', loader, path.join(repo, 'src', 'bin', 'srelay.ts'), ...args], {
      cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? -1, out: String(err.stdout ?? '') + String(err.stderr ?? '') };
  }
}

describe('审计契约 · CLI 退出码（srelay audit --json）', () => {
  it('未初始化 ⇒ 2（"没测到"不许给 0）', () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'srelay-audit-cli-bare-'));
    try {
      const r = runCli(['audit', '--json'], bare);
      expect(r.code).toBe(2);
      expect(r.out).toContain('未找到 .sessionrelay');
    } finally { try { fs.rmSync(bare, { recursive: true, force: true }); } catch { /* 清理失败不影响判据 */ } }
  }, 60_000);

  it('干净项目（无地图/无经验/索引健康）⇒ 0；只有缺 msgId ⇒ 1；有归档未决 ⇒ 2', () => {
    const clean = fs.mkdtempSync(path.join(os.tmpdir(), 'srelay-audit-cli-ok-'));
    try {
      fs.mkdirSync(path.join(clean, '.sessionrelay'), { recursive: true });
      fs.writeFileSync(path.join(clean, '.sessionrelay', 'config.json'), JSON.stringify({ version: '1.0', identity: { project_id: 'proj-cli' } }, null, 2));
      const cdb = createDb(path.join(clean, '.sessionrelay', 'relay.sqlite'));
      try {
        const sid = upsertCapturedSession(cdb, {
          source: 'dsh', sourceSessionId: 'cli-1', projectId: 'proj-cli', title: '干净会话',
          createdAt: iso(1), lastEventAt: iso(1), sourceFile: 'fixture:cli-1',
        }).id;
        insertMessage(cdb, { sessionId: sid, role: 'user', content: '决定采用 SQLite FTS5', seqNum: 1, createdAt: iso(1) });
        cdb.prepare("UPDATE sessions SET state = 'confirmed' WHERE id = ?").run(sid);
        // 干净：有 msgId 的真决策
        cdb.prepare('UPDATE sessions SET decisions = ? WHERE id = ?')
          .run(JSON.stringify([{ text: '决定采用 SQLite FTS5 作为唯一检索层', seq: 1, msgId: 1 }]), sid);

        const okRun = runCli(['audit', '--json'], clean);
        expect(okRun.code).toBe(0);
        const okReport = JSON.parse(okRun.out) as { exitCode: number; checks: Array<{ id: string; status: string }> };
        expect(okReport.exitCode).toBe(0);
        expect(okReport.checks).toHaveLength(8);
        // 没有地图 ⇒ 该项 skipped（未建图 ≠ 有债），但结论仍是 0
        expect(okReport.checks.find((c) => c.id === 'map-node-no-sources')?.status).toBe('skipped');

        // 只有 P1：一条缺 msgId 的决策
        cdb.prepare('UPDATE sessions SET decisions = ? WHERE id = ?')
          .run(JSON.stringify([{ text: '决定采用 SQLite FTS5 作为唯一检索层', seq: 1 }]), sid);
        const p1 = runCli(['audit', '--json'], clean);
        expect(p1.code).toBe(1);
        expect((JSON.parse(p1.out) as { totals: { p1: number } }).totals.p1).toBe(1);

        // P0：把这条未决挂到已归档会话上
        cdb.prepare('UPDATE sessions SET state = ' + "'confirmed'," + ' cleanup_at = ?, message_count = 0 WHERE id = ?').run(iso(0), sid);
        cdb.prepare('UPDATE sessions SET key_questions = ? WHERE id = ?')
          .run(JSON.stringify([{ q: '归档后这条未决怎么办', seq: 1, msgId: 1, unresolved: true }]), sid);
        const p0 = runCli(['audit', '--json'], clean);
        expect(p0.code).toBe(2);
        expect((JSON.parse(p0.out) as { totals: { p0: number } }).totals.p0).toBe(1);
      } finally { cdb.close(); }
    } finally { try { fs.rmSync(clean, { recursive: true, force: true }); } catch { /* 同上 */ } }
  }, 120_000);
});
