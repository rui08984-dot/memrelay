// [任务S] 简报自压缩：超预算时按「被引用次数」淘汰，而不是按时间一刀切。
//
// 钉五件事（任务书原文）：
//   ① 引用多的优先（refCount 压过新鲜度）；
//   ② 无引用时按新鲜度（refCount 全 0 = 旧行为，不至于把简报打乱）；
//   ③ 淘汰计数必须能被调用方说出来（evicted / compressedNote）；
//   ④ 确定性（同一批条目换遍历顺序进来，选出的是同一批、同一序 —— 平手用稳定键）；
//   ⑤ pinned 优先（置顶压过引用次数与新鲜度）。
// 另加三条接线钉子：
//   ⑥ brief 真的用它：超条数时旧但被引用的条目留下，counts.decisionsCompressed / unresolvedCompressed 报数；
//   ⑦ refCount 的唯一来源 search_feedback 被只读地读出来（表不存在 = 空表，且**不建表**）；
//   ⑧ cmdBrief 端到端：全局库的 open 次数真的驱动压缩，人话末尾与 --json counts 都说出来。
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { selectByBudget, compressedNote, loadRefCounts } from '../../src/core/brief/compress.js';
import { collectBrief, cmdBrief } from '../../src/cli/brief.js';
import { createDb, dbFile, type DB } from '../../src/store/db.js';
import { defaultConfig, saveConfig } from '../../src/shared/config.js';
import { projectIdOf } from '../../src/shared/paths.js';
import { SEARCH_FEEDBACK_DDL } from '../../src/search-svc/feedback.js';

// 必须相对**真实 now** 造时间：collectBrief 的 48h 窗口用的是 Date.now()，
// 写死一个日期会让 ⑥⑧ 在两天后变成红（时间炸弹）。
const NOW = Date.now();
const iso = (hoursAgo: number) => new Date(NOW - hoursAgo * 3600_000).toISOString();

/** 简报条目：refCount 按 sessionId 注入（与真实决策/未决行一致）。 */
const item = (sid: string, hoursAgo: number, over: Record<string, unknown> = {}) => ({
  sessionId: sid,
  text: '决策 ' + sid,
  at: iso(hoursAgo),
  ...over,
});

describe('[任务S] 简报超预算淘汰（selectByBudget）', () => {
  it('① 引用多的优先：超预算时 refCount 压过新鲜度', () => {
    const r = selectByBudget([item('fresh', 1), item('hot', 20), item('warm', 10)], 2, {
      refCounts: new Map([['hot', 5], ['warm', 1]]),
    });
    // 最新但没人看的那条被淘汰；两条被打开过的留下（按优先级从高到低）
    expect(r.kept.map((x) => x.sessionId)).toEqual(['hot', 'warm']);
    expect(r.evicted).toBe(1);
    expect(r.evictedKeys).toHaveLength(1);
    expect(r.compressed).toBe(true);
  });

  it('② 无引用时按新鲜度：refCount 全 0 → 与旧行为同序（最新优先）', () => {
    const r = selectByBudget([item('old', 30), item('mid', 10), item('new', 1)], 2);
    expect(r.kept.map((x) => x.sessionId)).toEqual(['new', 'mid']);
    expect(r.evicted).toBe(1);
    // 条目自带 refCount 也能用（没有映射时）
    const own = selectByBudget([item('a', 1), item('b', 2, { refCount: 3 })], 1);
    expect(own.kept.map((x) => x.sessionId)).toEqual(['b']);
  });

  it('③ 淘汰计数：evicted / total / evictedKeys 对得上，未超预算原样返回', () => {
    const many = Array.from({ length: 10 }, (_, i) => item('s' + i, i));
    const r = selectByBudget(many, 4);
    expect(r.total).toBe(10);
    expect(r.kept).toHaveLength(4);
    expect(r.evicted).toBe(6);
    expect(r.evictedKeys).toHaveLength(r.evicted);
    // 预算 0 = 全淘汰（调用方自己决定要不要这么干）
    expect(selectByBudget(many, 0).evicted).toBe(10);
    // 未超预算：连顺序都不动（纪律②：只改「超条数时选谁」）
    const same = selectByBudget(many, 10);
    expect(same.evicted).toBe(0);
    expect(same.compressed).toBe(false);
    expect(same.kept).toEqual(many);
    // 「淘汰了多少」必须能说出来，且没有淘汰时一个字都不打
    expect(compressedNote(6)).toBe('已按引用次数压缩 6 条');
    expect(compressedNote(0)).toBeNull();
  });

  it('④ 确定性：同输入结果一致；换遍历顺序进来，选出同一批、同一序', () => {
    const base = [item('a', 5), item('b', 5), item('c', 5), item('d', 5)];
    const r1 = selectByBudget(base, 2);
    const r2 = selectByBudget(base, 2);
    expect(r2.kept.map((x) => x.sessionId)).toEqual(r1.kept.map((x) => x.sessionId));
    const shuffled = [base[2], base[0], base[3], base[1]];
    const r3 = selectByBudget(shuffled, 2);
    // 分数全同 → 稳定键（sessionId + 正文）裁决，不靠数组下标
    expect(r3.kept.map((x) => x.sessionId)).toEqual(r1.kept.map((x) => x.sessionId));
    expect(r3.evictedKeys).toEqual(r1.evictedKeys);
  });

  it('⑤ pinned 优先：置顶压过引用次数与新鲜度', () => {
    const r = selectByBudget([item('fresh', 1), item('pinned-old', 40, { pinned: true })], 1, {
      refCounts: new Map([['fresh', 9]]),
    });
    expect(r.kept.map((x) => x.sessionId)).toEqual(['pinned-old']);
    expect(r.evicted).toBe(1);
  });
});

describe('[任务S] 接线：brief 超条数时按引用次数保留 + 说出淘汰数', () => {
  /** 三条会话、各一条决策 + 一条未决（都落在 48h/14 天窗内）。 */
  const HOT_DEC = '决定改用 SQLite 作为存储后端';
  const MID_DEC = '前端框架最终选定为 Vite 方案';
  const NEW_DEC = '认证令牌改用 JWT 方案';
  const HOT_Q = '缓存一致性策略如何落地？';
  const MID_Q = '异步写入失败如何回滚？';
  const NEW_Q = '配置迁移顺序怎么安排？';

  function seedInto(db: DB, projectId: string): void {
    const stmt = db.prepare(`INSERT INTO sessions
      (id, source, source_session_id, project_id, state, title, created_at, last_event_at, message_count, decisions, key_questions)
      VALUES (?, 'zcode', ?, ?, 'confirmed', 't', ?, ?, 1, ?, ?)`);
    const rows: Array<{ id: string; dec: string; q: string; h: number }> = [
      { id: 's-hot', dec: HOT_DEC, q: HOT_Q, h: 40 },   // 最旧，但被打开 9 次
      { id: 's-mid', dec: MID_DEC, q: MID_Q, h: 20 },
      { id: 's-new', dec: NEW_DEC, q: NEW_Q, h: 1 },
    ];
    for (const r of rows) {
      const at = iso(r.h);
      stmt.run(r.id, 'src-' + r.id, projectId, at, at,
        JSON.stringify([{ text: r.dec, seq: 1, at, msgId: 1 }]),
        JSON.stringify([{ q: r.q, at, unresolved: true, msgId: 2 }]));
    }
  }

  function seed(): DB {
    const db = createDb(':memory:');
    seedInto(db, 'p');
    return db;
  }

  it('⑥ 超条数时旧但被引用多的决策/未决被留下，淘汰数进 counts', () => {
    const db = seed();
    try {
      const pay = collectBrief(db, 'p', { limit: 2, refCounts: new Map([['s-hot', 9]]) });
      // 决策：hot（被引用 9 次）压过 mid（更新），new 因最新仍入选；mid 被淘汰
      expect(pay.decisions.map((d) => d.text)).toEqual([HOT_DEC, NEW_DEC]);
      expect(pay.counts.decisions).toBe(2);
      expect(pay.counts.decisionsCompressed).toBe(1);
      // 未决同一判据
      expect(pay.unresolved.map((u) => u.q)).toEqual([HOT_Q, NEW_Q]);
      expect(pay.counts.unresolved).toBe(2);
      expect(pay.counts.unresolvedCompressed).toBe(1);
      // 渲染层用的文案（唯一一份）与两个计数一致
      expect(compressedNote((pay.counts.decisionsCompressed ?? 0) + (pay.counts.unresolvedCompressed ?? 0)))
        .toBe('已按引用次数压缩 2 条');
    } finally { db.close(); }
  });

  it('⑦ refCount 来自 search_feedback：按项目统计，表不存在返回空表且不建表', () => {
    const db = new Database(':memory:');
    try {
      db.exec(SEARCH_FEEDBACK_DDL);
      const ins = db.prepare(
        'INSERT INTO search_feedback(at, project, query_hash, query_len_bucket, position, session_id, open_kind) VALUES (?,?,?,?,?,?,?)',
      );
      ins.run(iso(1), 'p', 'h1', '5-9', 1, 's-hot', 'cli_show');
      ins.run(iso(2), 'p', 'h2', '5-9', 2, 's-hot', 'mcp_show');
      ins.run(iso(3), 'p', 'h3', '5-9', 1, 's-mid', 'mcp_show');
      ins.run(iso(4), 'other', 'h4', '5-9', 1, 's-hot', 'mcp_show');
      expect(Object.fromEntries(loadRefCounts(db, { project: 'p' }))).toEqual({ 's-hot': 2, 's-mid': 1 });
      // 只统计本项目：other 的那一条不能算进来
      expect(loadRefCounts(db, { project: 'other' }).get('s-hot')).toBe(1);
      expect(loadRefCounts(db, { project: 'nope' }).size).toBe(0);
    } finally { db.close(); }

    // 表不存在 = 还没跑过 feedback（正常状态）：返回空表，且**不建表**（brief 读路径只读）
    const bare = new Database(':memory:');
    try {
      expect(loadRefCounts(bare).size).toBe(0);
      const t = bare.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'search_feedback'").get();
      expect(t).toBeUndefined();
    } finally { bare.close(); }
  });

  it('⑧ cmdBrief 端到端：全局库 open 次数驱动压缩，人话末尾与 --json counts 都说得出来', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'srelay-task-s-'));
    const project = path.join(tmp, 'app');
    const pid = projectIdOf(project);
    const prevHome = process.env.SRELAY_GLOBAL_HOME;
    const prevCwd = process.cwd();
    let logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
    try {
      fs.mkdirSync(path.join(project, '.sessionrelay'), { recursive: true });
      saveConfig(project, { ...defaultConfig(), identity: { project_id: pid } });
      const db = createDb(dbFile(project));
      seedInto(db, pid);
      db.close();

      // 全局反馈库：只给最旧的那条会话记 open（9 次）—— 压缩必须让它赢
      const gdir = path.join(tmp, 'global');
      fs.mkdirSync(gdir, { recursive: true });
      process.env.SRELAY_GLOBAL_HOME = gdir;
      const g = new Database(path.join(gdir, 'global.sqlite'));
      try {
        g.exec(SEARCH_FEEDBACK_DDL);
        const ins = g.prepare(
          'INSERT INTO search_feedback(at, project, query_hash, query_len_bucket, position, session_id, open_kind) VALUES (?,?,?,?,?,?,?)',
        );
        for (let i = 0; i < 9; i++) ins.run(new Date().toISOString(), pid, 'h' + i, '5-9', 1, 's-hot', 'cli_show');
      } finally { g.close(); }

      process.chdir(project);
      await cmdBrief({ limit: 2 });
      // 渲染层说明「已按引用次数压缩 N 条」——少掉的条目必须说出来
      expect(logs.some((l) => l.includes('已按引用次数压缩'))).toBe(true);
      // 旧但被打开 9 次的决策压过更新的那条，真的进了简报
      expect(logs.some((l) => l.includes(HOT_DEC))).toBe(true);

      logs = [];
      await cmdBrief({ limit: 2, json: true });
      const pay = JSON.parse(logs.find((l) => l.startsWith('{')) ?? '{}') as {
        decisions: Array<{ text: string }>;
        counts: { decisionsCompressed?: number; unresolvedCompressed?: number };
      };
      expect(pay.decisions.map((d) => d.text)).toEqual([HOT_DEC, NEW_DEC]);
      expect(pay.counts.decisionsCompressed).toBe(1);
      expect(pay.counts.unresolvedCompressed).toBe(1);
    } finally {
      spy.mockRestore();
      process.chdir(prevCwd);
      if (prevHome === undefined) delete process.env.SRELAY_GLOBAL_HOME;
      else process.env.SRELAY_GLOBAL_HOME = prevHome;
      for (let i = 0; i < 3; i++) {
        try { fs.rmSync(tmp, { recursive: true, force: true }); break; } catch { /* Windows 句柄延迟 */ }
      }
    }
  });
});
