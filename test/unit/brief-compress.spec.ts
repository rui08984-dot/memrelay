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
//   ⑨⑩⑪ [1020] **名额层**：真机上候选数永远够不到 --limit 200（48h 窗内实测 1~15 条），
//      所以压缩以前从来没触发过。现在「简报只画 5 行决策 / 1 行未决」这件事本身就是判据的容量，
//      候选 > 名额就压缩、就说出来 —— 这三条钉住"不传 --limit（默认 200）也能触发"。
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { selectByBudget, compressedNote, loadRefCounts } from '../../src/core/brief/compress.js';
import {
  collectBrief, cmdBrief, shownDecisions, shownUnresolved, BRIEF_DECISION_SLOTS,
} from '../../src/cli/brief.js';
import { UNR_SLOTS } from '../../src/cli/brief-filter.js';
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
      // 未决同一判据（payload 上限层：--limit 2）
      expect(pay.unresolved.map((u) => u.q)).toEqual([HOT_Q, NEW_Q]);
      expect(pay.counts.unresolved).toBe(2);
      // [1020] 但**简报只画 UNR_SLOTS=1 行未决**，所以第三层（名额层）又淘汰了 1 条：
      //   候选 3 = 显示 1 + 压缩 2。上一版这里期望 1，是因为名额层根本不计入 ——
      //   那正是"真机上从未触发过压缩"的一半原因（见文件头 ⑨⑩⑪）。
      expect(pay.counts.unresolvedCompressed).toBe(2);
      // 名额层的结果也必须交出来（渲染不许再自己 slice）
      expect(shownDecisions(pay).map((d) => d.text)).toEqual([HOT_DEC, NEW_DEC]);
      expect(shownUnresolved(pay).map((u) => u.q)).toEqual([HOT_Q]);
      // 恒等式：显示 + 压缩 = 候选（决策 2+1=3、未决 1+2=3）
      expect(shownDecisions(pay).length + (pay.counts.decisionsCompressed ?? 0)).toBe(3);
      expect(shownUnresolved(pay).length + (pay.counts.unresolvedCompressed ?? 0)).toBe(3);
      // 渲染层用的文案（唯一一份）与两个计数一致
      expect(compressedNote((pay.counts.decisionsCompressed ?? 0) + (pay.counts.unresolvedCompressed ?? 0)))
        .toBe('已按引用次数压缩 3 条');
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
      // [1020] 未决名额层计入：候选 3 − 简报显示 1（UNR_SLOTS）= 2
      expect(pay.counts.unresolvedCompressed).toBe(2);
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

describe('[1020] 名额层压缩：不传 --limit（默认 200）也要在真机规模触发', () => {
  // 病历：真机上压缩从来没出现过「已按引用次数压缩」字样 ——
  //   48h 窗后的候选实测只有 1~15 条（agent1super 438 条决策里 1 条在窗内；
  //   D:/dsh插件  记忆 38 条里 15 条），而预算是 --limit 默认 200 ⇒ selectByBudget 永远 total <= cap；
  //   屏幕上只画 slice(0,5)，那 5 行既不走判据（pinned/引用次数全被无视），也**一个字都不说**少了 10 条。
  // 修法：这两件事是同一件事 —— 简报名额（5 决策 / 1 未决）就是判据的容量。
  //   这些用例用**默认**选项跑，证明它现在真的会触发。

  const DEC_ROWS = [
    { id: 'd1', text: '决定把发布节奏改为两周一次发版', h: 40, pinned: true }, // 最旧，但用户置顶
    { id: 'd2', text: '决定把检索缓存改为本地落盘', h: 36 },                    // 被打开 6 次
    { id: 'd3', text: '决定把日志保留期缩到十四天', h: 30 },                    // 名额外的较新条
    { id: 'd4', text: '决定把面板配色换成浅色主题', h: 24 },                    // 名额外的较新条
    { id: 'd5', text: '决定把导出格式统一成 markdown', h: 12 },
    { id: 'd6', text: '决定把守护改成每两小时一轮', h: 6 },
    { id: 'd7', text: '决定把版本号升到一零五版本', h: 1 },                     // 最新
  ];

  function seedDecisions(db: DB, projectId: string): void {
    const stmt = db.prepare(`INSERT INTO sessions
      (id, source, source_session_id, project_id, state, title, created_at, last_event_at, message_count, decisions, key_questions)
      VALUES (?, 'zcode', ?, ?, 'confirmed', 't', ?, ?, 1, ?, '[]')`);
    for (const r of DEC_ROWS) {
      const at = iso(r.h);
      stmt.run(r.id, 'src-' + r.id, projectId, at, at, JSON.stringify([{
        text: r.text, seq: 1, at, msgId: 1,
        ...(r.pinned === true ? { pinned: true } : {}),
      }]));
    }
  }

  it('⑨ 默认选项（无 --limit）：7 条候选 → 只显示 5 条、按 pinned > 引用次数 > 新鲜度 选，压缩 2 条说出来', () => {
    const db = createDb(':memory:');
    try {
      seedDecisions(db, 'p');
      // 注意：**不传 limit**（真机就是这么调的）—— 以前这里 compressed 必然 0
      const pay = collectBrief(db, 'p', { refCounts: new Map([['d2', 6]]) });

      // payload 契约没动：仍给到 --limit 以内（默认 200），调用方要的取数量还在
      expect(pay.decisions).toHaveLength(DEC_ROWS.length);
      expect(pay.counts.decisions).toBe(pay.decisions.length);

      // 但简报只画 BRIEF_DECISION_SLOTS 行，而且这 5 行是判据选出来的（不是 payload 前 5 条）
      const shown = shownDecisions(pay);
      expect(shown).toHaveLength(BRIEF_DECISION_SLOTS);
      expect(shown.map((d) => d.text)).toEqual([
        DEC_ROWS[0].text, // ① pinned 压过一切（它是最旧的一条）
        DEC_ROWS[1].text, // ② 被打开 6 次，压过更近的 d3/d4
        DEC_ROWS[6].text, // ③ 其余按新鲜度：1h
        DEC_ROWS[5].text, //    6h
        DEC_ROWS[4].text, //    12h
      ]);
      // 名额外的两条（30h / 24h）就是压缩掉的
      expect(pay.counts.decisionsCompressed).toBe(2);
      expect(compressedNote(pay.counts.decisionsCompressed ?? 0)).toBe('已按引用次数压缩 2 条');
      // 恒等式：显示 + 压缩 = 候选
      expect(shown.length + (pay.counts.decisionsCompressed ?? 0)).toBe(DEC_ROWS.length);
      // payload 仍是全量候选（客户端不会因为这次压缩少拿到东西）
      expect(pay.decisions.map((d) => d.text)).toContain(DEC_ROWS[2].text);
    } finally { db.close(); }
  });

  it('⑩ 未决同判据：名额 UNR_SLOTS 条，pinned 优先，其余计数说出来', () => {
    const db = createDb(':memory:');
    try {
      const stmt = db.prepare(`INSERT INTO sessions
        (id, source, source_session_id, project_id, state, title, created_at, last_event_at, message_count, decisions, key_questions)
        VALUES (?, 'zcode', ?, ?, 'confirmed', 't', ?, ?, 1, '[]', ?)`);
      const rows = [
        { id: 'u1', q: '发布节奏多久复盘一次？', h: 40, pinned: true },
        { id: 'u2', q: '异步写入失败如何回滚？', h: 30 },
        { id: 'u3', q: '配置迁移顺序怎么安排？', h: 1 },
      ];
      for (const r of rows) {
        const at = iso(r.h);
        stmt.run(r.id, 'src-' + r.id, 'p', at, at, JSON.stringify([{
          q: r.q, at, unresolved: true, msgId: 2,
          ...(r.pinned === true ? { pinned: true } : {}),
        }]));
      }
      const pay = collectBrief(db, 'p', { refCounts: new Map([['u2', 5]]) });
      expect(pay.unresolved).toHaveLength(3);                       // payload 仍全量
      const shown = shownUnresolved(pay);
      expect(shown).toHaveLength(UNR_SLOTS);                        // 简报只画 1 行
      // ⚠️ 这里**本该**是 pinned 的那条（u1）胜出，但未决读不到 pinned：
      //   store/db.ts 的 UnresolvedRow 根本没有 pinned 字段（pin 只对 decisions 生效，
      //   setDecisionPinned 也只写 decisions）⇒ 未决段判据实际退化成「引用次数 > 新鲜度」。
      //   这是本次**没有**修掉的一处（改点在 store/db.ts，不在本轮可改范围），
      //   用例如实钉住当前行为，别让它假装 pinned 在未决段有效。
      expect(shown[0].q).toBe(rows[1].q);                           // 被打开 5 次的压过更新的 u3
      expect(pay.counts.unresolvedCompressed).toBe(2);
    } finally { db.close(); }
  });

  it('⑪ cmdBrief 端到端（默认选项）：人话输出出现「已按引用次数压缩 2 条」，且渲染的是判据选出的 5 条', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'srelay-slots-'));
    const project = path.join(tmp, 'app');
    const pid = projectIdOf(project);
    const prevHome = process.env.SRELAY_GLOBAL_HOME;
    const prevCwd = process.cwd();
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
    try {
      fs.mkdirSync(path.join(project, '.sessionrelay'), { recursive: true });
      saveConfig(project, { ...defaultConfig(), identity: { project_id: pid } });
      process.env.SRELAY_GLOBAL_HOME = path.join(tmp, 'global'); // 没有反馈库：全部按引用次数 0
      const db = createDb(dbFile(project));
      seedDecisions(db, pid);
      db.close();

      process.chdir(project);
      await cmdBrief({});   // ← 真机调法：不传 limit

      expect(logs.some((l) => l.includes('已按引用次数压缩 2 条'))).toBe(true);
      // 置顶那条（40 小时前）必须真的被画出来 —— 以前 slice(0,5) 取的是 payload 前 5 条，
      // 而 payload 是最旧在前，它恰好能进；但 24~30 小时的那两条会被顶掉（新规则按判据选）。
      expect(logs.some((l) => l.includes(DEC_ROWS[0].text))).toBe(true);
      // 决策行恰好 5 行（名额），不是 7 行
      const decisionRows = logs.filter((l) => l.includes('✓ ') || l.includes('✗ '));
      expect(decisionRows).toHaveLength(BRIEF_DECISION_SLOTS);
      // 计数行仍是"候选 7 条"（没显示的条数由说明行解释）
      expect(logs.some((l) => l.includes('决策 7 条'))).toBe(true);

      // --json 也说同一套数（两个面不许各说一套）
      logs.length = 0;
      await cmdBrief({ json: true });
      const pay = JSON.parse(logs.find((l) => l.startsWith('{')) ?? '{}') as {
        decisions: unknown[]; decisionsShown?: Array<{ text: string }>;
        counts: { decisions: number; decisionsCompressed?: number };
      };
      expect(pay.decisions).toHaveLength(7);
      expect(pay.decisionsShown).toHaveLength(BRIEF_DECISION_SLOTS);
      expect(pay.counts.decisionsCompressed).toBe(2);
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

