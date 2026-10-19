// [task-14] 存量决策碎片的展示层过滤。
//
// 病历：「换成我们的了」「换成你的问法」这类句子仍在简报里。判据本身没问题 ——
//   vagueDecisionObject（core/extract/extract.ts）是**抽取端**闸门，只拦此后新提取的；
//   旧数据早已入库，抽取端再也不会碰它们 ⇒ 永远显示。
// 这里钉三件事：
//   ① 碎片不出现（且**库不动**：listDecisions 仍能全量取到，只是简报这一次不显示）；
//   ② 说明行存在（『已隐藏 N 条疑似碎片（旧数据）』）—— 过滤必须说出来，否则用户以为记忆丢了；
//   ③ 正常决策不受影响（不误杀、顺序与条数照旧）。
//
// ⚠️ 判据**只 import 不复制**：本测试也 import 同一份 vagueDecisionObject，
//    所以夹具"是不是碎片"由生产判据自己判定，不是测试自说自话（复制一份正则会让两边一起错）。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDb, dbFile, insertSession, listDecisions, type DB } from '../../src/store/db.js';
import { defaultConfig, saveConfig, type RelayConfig } from '../../src/shared/config.js';
import { projectIdOf } from '../../src/shared/paths.js';
import { collectBrief, hiddenFragmentsNote, cmdBrief } from '../../src/cli/brief.js';
import { vagueDecisionObject } from '../../src/core/extract/extract.js';

// 病历里的原句（1021 之前入库的旧碎片）+ 一条同族碎片。
const FRAGMENT_1 = '换成我们的了';
const FRAGMENT_2 = '换成你的问法';
// 正常决策：带具体对象，vagueDecisionObject 必须放行。
const NORMAL_1 = '决定改用 SQLite 作为会话存储后端';
const NORMAL_2 = '认证令牌改用 JWT 方案';

const iso = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3600_000).toISOString();

let tmp = '';
let project = '';
let pid = '';
let prevHome: string | undefined;
let prevCwd = '';

function cfg(): RelayConfig {
  return { ...defaultConfig(), identity: { project_id: pid } };
}

/** 一次性建好项目目录 + 配置 + 库（cmdBrief 走的是真实文件路径，不是内存库） */
function setupProject(decisions: Array<{ text: string; at?: string; pinned?: boolean; seq?: number }>): void {
  fs.mkdirSync(path.join(project, '.sessionrelay'), { recursive: true });
  saveConfig(project, cfg());
  const db = createDb(dbFile(project));
  insertSession(db, { id: 'sess0001', source: 'zcode', sourceSessionId: 'sess0001', projectId: pid, title: '存量碎片会话', createdAt: iso(2) });
  db.prepare('UPDATE sessions SET last_event_at = ?, decisions = ? WHERE id = ?')
    .run(iso(1), JSON.stringify(decisions.map((d, i) => ({
      text: d.text, seq: d.seq ?? i + 1, at: d.at ?? iso(1 - i * 0.1), msgId: 100 + i,
      ...(d.pinned === true ? { pinned: true } : {}),
    }))), 'sess0001');
  db.close();
}

function openProjectDb(): DB {
  return createDb(dbFile(project));
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'srelay-task14-'));
  project = path.join(tmp, 'app');
  pid = projectIdOf(project);
  prevHome = process.env.SRELAY_GLOBAL_HOME;
  process.env.SRELAY_GLOBAL_HOME = path.join(tmp, 'global');
  prevCwd = process.cwd();
  // 判据自检：夹具的"碎片/正常"分类必须由**生产判据**判定（不是本文件的假设）
  expect(vagueDecisionObject(FRAGMENT_1)).toBe(true);
  expect(vagueDecisionObject(FRAGMENT_2)).toBe(true);
  expect(vagueDecisionObject(NORMAL_1)).toBe(false);
  expect(vagueDecisionObject(NORMAL_2)).toBe(false);
});

afterEach(() => {
  process.chdir(prevCwd);
  vi.restoreAllMocks();
  if (prevHome === undefined) delete process.env.SRELAY_GLOBAL_HOME;
  else process.env.SRELAY_GLOBAL_HOME = prevHome;
  for (let i = 0; i < 3; i++) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); return; } catch { /* Windows 句柄延迟 */ }
  }
});

describe('[task-14] 简报 · 存量决策碎片过滤', () => {
  it('① 碎片不出现；库一个字节没动（listDecisions 仍全量可见）', () => {
    setupProject([
      { text: NORMAL_1 }, { text: FRAGMENT_1 }, { text: NORMAL_2 }, { text: FRAGMENT_2 },
    ]);
    const db = openProjectDb();
    try {
      const pay = collectBrief(db, pid, { limit: 200 });
      const texts = pay.decisions.map((d) => d.text);
      expect(texts).not.toContain(FRAGMENT_1);
      expect(texts).not.toContain(FRAGMENT_2);
      expect(pay.counts.fragmentsHidden).toBe(2);
      // 只隐藏这一次显示：库里两条碎片都还在，检索/导出/面板不受影响（绝不删数据）
      const all = listDecisions(db, pid).map((d) => d.text);
      expect(all).toContain(FRAGMENT_1);
      expect(all).toContain(FRAGMENT_2);
    } finally { db.close(); }
  });

  it('② 说明行存在：末尾一行「已隐藏 N 条疑似碎片（旧数据）」，N 与 counts 一致；无碎片时一个字都不打', async () => {
    setupProject([{ text: NORMAL_1 }, { text: FRAGMENT_1 }, { text: FRAGMENT_2 }]);
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
    process.chdir(project);
    await cmdBrief({});
    const note = logs.find((l) => l.includes('已隐藏'));
    expect(note).toBeDefined();
    expect(note).toContain('已隐藏 2 条疑似碎片（旧数据）');
    // 必须是**最后一行**：它解释的是"上面为什么比库里少"，属于脚注
    expect(logs[logs.length - 1]).toContain('已隐藏 2 条疑似碎片（旧数据）');
    // 碎片正文不得出现在任何一行
    expect(logs.some((l) => l.includes(FRAGMENT_1) || l.includes(FRAGMENT_2))).toBe(false);

    // 没有碎片 ⇒ 不占行（每天多一行「已隐藏 0 条」是噪音，还会让人以为简报一直在藏东西）
    expect(hiddenFragmentsNote(0)).toBeNull();
    expect(hiddenFragmentsNote(Number.NaN)).toBeNull();
  });

  it('③ 正常决策不受影响：条数、文本、顺序照旧（判据不误杀）', () => {
    setupProject([{ text: NORMAL_1 }, { text: NORMAL_2 }]);
    const db = openProjectDb();
    try {
      const pay = collectBrief(db, pid, { limit: 200 });
      // 顺序：最近在前（NORMAL_2 的 at 更近），与未加本条过滤之前完全一致
      expect(pay.decisions.map((d) => d.text)).toEqual([NORMAL_2, NORMAL_1]);
      expect(pay.counts.fragmentsHidden).toBe(0);
      expect(hiddenFragmentsNote(pay.counts.fragmentsHidden)).toBeNull();
    } finally { db.close(); }
  });
});
