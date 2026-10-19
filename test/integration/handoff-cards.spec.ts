// 集成：HANDOFF 简报里的「会话摘要」段必须是**会话卡**，而且总体积不超旧版的 1.2 倍。
//
// 为什么走真实导出链路（runExportMarkdown → buildHandoff）而不是直接调渲染函数：
// 卡片的数据来自 sessions.decisions / key_questions 的落库形状，中间还要经过
// getSessionFull → HopSessionFile 的投影。投影一旦漏字段（历史上有过白名单吃掉 pinned/kind
// 的先例），单测渲染函数永远是绿的，用户拿到的 HANDOFF 却是空卡。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createDb, dbFile, insertSession, getSessionFull, type DB } from '../../src/store/db.js';
import { defaultConfig, saveConfig, type RelayConfig } from '../../src/shared/config.js';
import { projectIdOf } from '../../src/shared/paths.js';
import { runExportMarkdown } from '../../src/relay/export.js';
import { legacySessionSummaryChars, CARD_BUDGET_RATIO } from '../../src/relay/handoff-md.js';
import type { HopSessionFile } from '../../src/relay/hop.js';

const TMP = path.resolve('test/.tmp/handoff-cards');
const PROJECT = path.join(TMP, 'app');
const PID = projectIdOf(PROJECT);
const OUT = path.join(TMP, 'HANDOFF.md');

const SES = [
  {
    id: 'aa10000000000001', source: 'zcode', title: '交接文档（唯一入口）',
    createdAt: '2026-10-07T10:00:00Z', lastEventAt: '2026-10-18T09:00:00Z', messageCount: 183,
    topics: ['简报', '交接'], files: ['src/relay/handoff-md.ts', 'src/core/cards/session-card.ts'],
    decisions: [
      { text: '改为一行一条', seq: 3324, msgId: 473821 },
      { text: '决定计划', seq: 3325, msgId: 473822 },
    ],
    questions: [{ q: '归档后这条未决怎么办？', seq: 10, msgId: 900, unresolved: true }],
    // 旧版摘要故意写长：预算基线要能"夹住"新渲染，而不是拿一个天然短小的情况自证
    summaryRule: '交接文档（唯一入口）\n决策（2）：1) 改为一行一条 2) 决定计划\n未决（1）：归档后这条未决怎么办？\n话题：简报、交接',
  },
  {
    id: 'aa10000000000002', source: 'zcode', title: '另一个会话',
    createdAt: '2026-10-09T10:00:00Z', lastEventAt: '2026-10-16T09:00:00Z', messageCount: 12,
    topics: ['简报', '交接'], files: [],
    decisions: [{ text: '简报按组呈现', seq: 20, msgId: 500 }],
    questions: [],
    summaryRule: '另一个会话\n决策（1）：1) 简报按组呈现\n话题：简报、交接',
  },
  {
    id: 'aa10000000000003', source: 'claude-code', title: '独立的第三场',
    createdAt: '2026-10-10T10:00:00Z', lastEventAt: '2026-10-17T09:00:00Z', messageCount: 7,
    topics: ['数据库迁移'], files: ['src/store/db.ts'],
    decisions: [{ text: '迁移改用事务包裹', seq: 3, msgId: 77 }],
    questions: [],
    summaryRule: '独立的第三场\n决策（1）：1) 迁移改用事务包裹\n话题：数据库迁移',
  },
];

function cfg(): RelayConfig {
  return { ...defaultConfig(), identity: { project_id: PID } };
}

/** 与导出侧一致的最小 HopSessionFile（legacySessionBlock 只用 title/created_at/source/summary_rule/messages） */
function fixture(s: typeof SES[number]): HopSessionFile {
  return {
    id: s.id, source: s.source, source_session_id: s.id, project_id: PID,
    title: s.title, created_at: s.createdAt, last_event_at: s.lastEventAt,
    state: 'confirmed', origin: 'auto', author: null, summary_rule: s.summaryRule,
    message_count: s.messageCount, topics: s.topics, files: s.files,
    decisions: s.decisions, questions: s.questions, messages: [],
  };
}

let db: DB;

beforeAll(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* Windows 句柄延迟 */ }
  fs.mkdirSync(path.join(PROJECT, '.sessionrelay'), { recursive: true });
  saveConfig(PROJECT, cfg());
  db = createDb(dbFile(PROJECT));
  for (const s of SES) {
    insertSession(db, { id: s.id, source: s.source, sourceSessionId: s.id, projectId: PID, title: s.title, createdAt: s.createdAt });
    db.prepare(`UPDATE sessions SET state = 'confirmed', origin = 'auto', last_event_at = ?, message_count = ?,
      topics = ?, files_mentioned = ?, decisions = ?, key_questions = ?, summary_rule = ? WHERE id = ?`)
      .run(s.lastEventAt, s.messageCount, JSON.stringify(s.topics), JSON.stringify(s.files),
        JSON.stringify(s.decisions), JSON.stringify(s.questions), s.summaryRule, s.id);
  }
});

afterAll(() => {
  try { db.close(); } catch { /* 已关 */ }
  for (let i = 0; i < 3; i++) {
    try { fs.rmSync(TMP, { recursive: true, force: true }); return; } catch { /* retry */ }
  }
});

describe('HANDOFF 简报 · 会话卡', () => {
  it('会话摘要段用卡片替代「标题+摘要」，多会话组合成一组，且总长度 ≤ 旧版 × 1.2', () => {
    runExportMarkdown({ root: PROJECT, cfg: cfg(), db, all: true, output: OUT });
    const md = fs.readFileSync(OUT, 'utf8');
    const at = md.indexOf('## 📖 会话摘要');
    expect(at).toBeGreaterThanOrEqual(0);
    const section = md.slice(at, md.indexOf('\n---', at));

    // ① 卡片结构：标题行 + 决策行 + 未决行 + 证据行
    expect(section).toContain('● 交接文档（唯一入口）  10-07 → 10-18 · 183 条消息');
    expect(section).toContain('  决策：改为一行一条 / 决定计划');
    expect(section).toContain('  未决：归档后这条未决怎么办？');
    expect(section).toContain('  证据：msgId=473821 seq=3324');
    // 旧版的「### 标题（日期，来源）」必须已经退场（否则就是两套并存）
    expect(section).not.toContain('### 交接文档（唯一入口）');

    // ② 多会话组：同组的两场只出一张卡，另一场在「↳ 同组」行里点名
    expect(section).toContain('↳ 同组（共 2 场）：另一个会话（10-09，zcode）');
    expect(section).not.toContain('● 另一个会话');
    // 不成组的会话仍然各有一张卡（分组只改变"同主题"的呈现，不吞会话）
    expect(section).toContain('● 独立的第三场');
    expect(section).toContain('  决策：迁移改用事务包裹');

    // ③ 体积预算：以旧版渲染为基线（同一批会话），不超 1.2 倍
    const legacySection = '## 📖 会话摘要'.length + 1 + legacySessionSummaryChars(SES.map(fixture)) + 1;
    expect(section.length).toBeLessThanOrEqual(Math.ceil(legacySection * CARD_BUDGET_RATIO));
  });

  it('导出投影不丢 message_count（归档会话的条数不能被 messages.length 顶掉）', () => {
    const full = getSessionFull(db, SES[0].id)!;
    expect(full.messageCount).toBe(183);
  });
});
