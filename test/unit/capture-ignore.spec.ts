// 采集层「子代理任务书」判据的回归锁（1021 夜 · 任务书污染）
//
// 病历：D:/agent1super 库 702 场会话里 **245 场**是子代理任务书（标题 = 任务书原文，
// 如「你是红队审查员。任务：…」），其中 202 场 <= 3 条消息。简报层早就有显示过滤
// （plugins/dsh/index.js 的 SUBAGENT_TASK_TITLE），但**库里**一直是噪声：检索排序、
// 简报计数、审计全被它带着走。
// 本用例锁三件事：
//   ① 判据本身（窄、不误杀真会话、空值不抛）；
//   ② 默认开：命中就不进库，且 blocked_by_ignore 计数 +1（可观测，不许静默）；
//   ③ 可关：capture.ignore_subagent_tasks=false 时放行（否则用户永远救不回来）。
// 存量那 245 场不归这里管（删除权只在人手里），本用例只证明"将来不再新增"。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SUBAGENT_TASK_TITLE_RE, isSubagentTaskTitle } from '../../src/capture/ignore.js';
import { runSync, captureSessions } from '../../src/capture/sync.js';
import { mergeConfig } from '../../src/shared/config.js';
import type { RelayConfig } from '../../src/shared/config.js';
import { registerCustom } from '../../src/adapters/registry.js';
import type { SessionSourceAdapter } from '../../src/adapters/types.js';
import { createDb, listSessions } from '../../src/store/db.js';
import { openStats } from '../../src/core/stats/counter.js';
import { projectIdOf } from '../../src/shared/paths.js';

const TASK_BOOK = '你是红队审查员。任务：审查 src/capture/sync.ts 的入库闸，输出问题清单。';

let root = '';
let db: ReturnType<typeof createDb>;

/**
 * 最小假源：discover 给出会话描述（title 可为 null —— DSH 适配器就是这样），
 * readNew 给出两条已写入的消息。唯一目的是把 runSync 的两道闸都走真。
 */
function makeAdapter(id: string, rows: Array<{ sid: string; title: string | null; first: string }>): SessionSourceAdapter {
  return {
    id,
    displayName: 'fake ' + id,
    discover: () => rows.map((r) => ({
      source: id,
      sourceSessionId: r.sid,
      sourceFile: path.join(root, r.sid + '.jsonl'),
      title: r.title,
      createdAt: '2026-10-20T10:00:00.000Z',
      updatedAt: '2026-10-20T10:00:00.000Z',
      sizeBytes: 100,
      mtimeMs: 1_760_000_000_000,
    })),
    readNew: async (ds) => {
      const r = rows.find((x) => x.sid === ds.sourceSessionId)!;
      return {
        messages: [
          { role: 'user' as const, content: r.first, seqNum: 1, createdAt: '2026-10-20T10:00:00.000Z' },
          { role: 'assistant' as const, content: '收到。先给结论：这道闸必须放在 ingest 之前。', seqNum: 2, createdAt: '2026-10-20T10:00:01.000Z' },
        ],
        badLines: 0,
        cursor: { seq: 2 },
      };
    },
  };
}

/** 配置：只开一个假源；captureOver 用来测开关 */
const mkCfg = (sources: string[], captureOver: Record<string, unknown> = {}): RelayConfig =>
  mergeConfig({ capture: { sources, ...captureOver } });

const blockedCount = (): number => openStats(root).snapshot()['blocked_by_ignore'] ?? 0;

// 计数器由**调用方**注入（守护 watch.ts:278 就是这么传的）。
// 实测发现（本次顺带记录）：srelay sync 的 CLI 路径不传 stats ⇒ blocked_by_ignore
// 只在守护路径落盘；本用例按守护口径传，才能真正验证"计数 +1"。
const stats = () => openStats(root);

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'srelay-subagent-'));
  fs.mkdirSync(path.join(root, '.sessionrelay'), { recursive: true });
  db = createDb(path.join(root, '.sessionrelay', 'relay.sqlite'));
});

afterEach(() => {
  try { db.close(); } catch { /* 已关 */ }
  for (let i = 0; i < 3; i++) { try { fs.rmSync(root, { recursive: true, force: true }); break; } catch { /* Windows 句柄延迟 */ } }
});

describe('① 判据：subagent 任务书标题', () => {
  it('「你是红队审查员。任务：…」被拦', () => {
    expect(SUBAGENT_TASK_TITLE_RE.test(TASK_BOOK)).toBe(true);
    expect(isSubagentTaskTitle(TASK_BOOK)).toBe(true);
  });

  it('同类前缀都算（你作为 / 任务：|: / 你的任务 / act as / you are），大小写与前后空格不影响', () => {
    const hits = [
      '你作为文档工程师，把这段改成英文',
      '任务：补空值检查',
      '任务:补空值检查',
      '你的任务：跑完全量测试',
      'act as a reviewer',
      'You are the red team',
      '  你是子代理',
    ];
    for (const t of hits) expect(isSubagentTaskTitle(t), t).toBe(true);
  });

  it('普通标题放行（判据故意窄，不误杀真会话）', () => {
    const misses = ['改用 note 通道', '今天天气不错', '请精读这篇论文', '帮我改一下索引', 'subagent_child'];
    for (const t of misses) expect(isSubagentTaskTitle(t), t).toBe(false);
  });

  it('空 / undefined / null 标题放行且不抛（判据不许把采集链炸掉）', () => {
    expect(() => isSubagentTaskTitle(undefined)).not.toThrow();
    expect(isSubagentTaskTitle(undefined)).toBe(false);
    expect(isSubagentTaskTitle(null)).toBe(false);
    expect(isSubagentTaskTitle('')).toBe(false);
    expect(isSubagentTaskTitle('   ')).toBe(false);
  });
});

describe('配置语义：缺省 = 开（存量项目不迁移配置就生效）', () => {
  it('没写这个键时是 undefined（= 生效）；显式 false 才是关', () => {
    expect(mergeConfig(null).capture.ignore_subagent_tasks).toBeUndefined();
    expect(mergeConfig({ capture: {} }).capture.ignore_subagent_tasks).toBeUndefined();
    expect(mergeConfig({ capture: { ignore_subagent_tasks: false } }).capture.ignore_subagent_tasks).toBe(false);
  });
});

describe('② 采集层默认开：命中就不进库 + blocked_by_ignore +1', () => {
  it('任务书与普通会话同批：任务书被拦，普通会话照常入库', async () => {
    const id = 'fake-sub-a';
    registerCustom(makeAdapter(id, [
      { sid: 'task1', title: TASK_BOOK, first: TASK_BOOK },
      { sid: 'ok1', title: '改用 note 通道', first: '讨论一下 note 通道的取舍' },
    ]), root);
    const before = blockedCount();
    const s = await runSync({ projectRoot: root, config: mkCfg([id]), db, stats: stats() });
    expect(s.discovered).toBe(2);
    expect(s.blocked).toBe(1);
    expect(s.newSessions).toBe(1);
    const ids = listSessions(db, { projectId: projectIdOf(root) }).map((r) => r.source_session_id);
    expect(ids).toContain('ok1');
    expect(ids).not.toContain('task1');
    expect(blockedCount() - before).toBe(1);
  });

  it('discover 拿不到标题（DSH 路径，title=null）：用第一条用户消息复查，同样拦下', async () => {
    const id = 'fake-sub-b';
    registerCustom(makeAdapter(id, [{ sid: 'task2', title: null, first: TASK_BOOK }]), root);
    const before = blockedCount();
    const s = await runSync({ projectRoot: root, config: mkCfg([id]), db, stats: stats() });
    expect(s.newSessions).toBe(0);
    expect(s.blocked).toBeGreaterThanOrEqual(1);
    expect(listSessions(db, { projectId: projectIdOf(root) }).some((r) => r.source_session_id === 'task2')).toBe(false);
    expect(blockedCount() - before).toBeGreaterThanOrEqual(1);
  });
});

describe('②-b 手动 save（用户在场）：拦下也必须说出来，不许静默不存', () => {
  it('srelay save 命中判据时 blocked+1、计数+1，并留一条人话 warning', async () => {
    const id = 'fake-sub-d';
    registerCustom(makeAdapter(id, [{ sid: 'task4', title: TASK_BOOK, first: TASK_BOOK }]), root);
    const ds = {
      source: id,
      sourceSessionId: 'task4',
      sourceFile: path.join(root, 'task4.jsonl'),
      title: TASK_BOOK,
      sizeBytes: 100,
      mtimeMs: 1_760_000_000_000,
    };
    const s = await captureSessions({ projectRoot: root, config: mkCfg([id]), db, sessions: [ds], stats: stats() });
    expect(s.blocked).toBe(1);
    expect(s.newSessions).toBe(0);
    expect(s.warnings.join('\n')).toContain('子代理任务书');
    expect(listSessions(db, { projectId: projectIdOf(root) })).toHaveLength(0);
    expect(blockedCount()).toBe(1);
  });
});

describe('③ 可关：capture.ignore_subagent_tasks=false 保住子代理会话', () => {
  it('显式关掉后同一场任务书会话正常入库，且不计数', async () => {
    const id = 'fake-sub-c';
    registerCustom(makeAdapter(id, [{ sid: 'task3', title: TASK_BOOK, first: TASK_BOOK }]), root);
    const s = await runSync({ projectRoot: root, config: mkCfg([id], { ignore_subagent_tasks: false }), db, stats: stats() });
    expect(s.blocked).toBe(0);
    expect(s.newSessions).toBe(1);
    const row = listSessions(db, { projectId: projectIdOf(root) }).find((r) => r.source_session_id === 'task3');
    expect(row).toBeDefined();
    expect(row!.title).toBe(TASK_BOOK);
    expect(blockedCount()).toBe(0);
  });
});
