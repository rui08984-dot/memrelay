// P1-1：简报的「相关会话」段把同一主题的多条会话显示成一组，而不是逐条平铺。
//
// 判据来自 groupSessions（与 srelay_search 的 groups / CLI 文本同源）。
// 这里钉三件事：① 该成组的真成组；② 没共享信号的不许硬凑；③ 组数与参与会话数有界
// （简报是 prompt，导航段不能无限膨胀）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDb, insertSession, type DB } from '../../src/store/db.js';
import { collectBrief, RELATED_MAX_GROUPS } from '../../src/cli/brief.js';

const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString();
let tmp = '';
let prevHome: string | undefined;

interface SeedRow {
  id: string;
  title: string;
  topics: string[];
  files?: string[];
  decisions: Array<{ text: string; at: string }>;
  questions?: Array<{ q: string; at: string; unresolved: boolean }>;
}

function seed(rows: SeedRow[]): DB {
  const db = createDb(':memory:');
  for (const r of rows) {
    insertSession(db, { id: r.id, source: 'zcode', sourceSessionId: r.id, projectId: 'p', title: r.title, createdAt: iso(2), topics: r.topics });
    db.prepare('UPDATE sessions SET last_event_at = ?, files_mentioned = ?, decisions = ?, key_questions = ? WHERE id = ?')
      .run(iso(0.5), JSON.stringify(r.files ?? []),
        JSON.stringify(r.decisions.map((d, i) => ({ text: d.text, seq: i + 1, msgId: 100 + i, at: d.at }))),
        JSON.stringify((r.questions ?? []).map((q, i) => ({ q: q.q, seq: i + 1, msgId: 200 + i, at: q.at, unresolved: q.unresolved }))),
        r.id);
  }
  return db;
}

const dec = (text: string) => ({ text, at: iso(0.2) });

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'srelay-brief-groups-'));
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

describe('简报 · 相关会话组', () => {
  it('共享 ≥2 个具体信号 ⇒ 合成一组（代表 + 组员 + 共享原因）', () => {
    const db = seed([
      { id: 'g1', title: '交接文档（唯一入口）', topics: ['简报', '交接'], files: ['src/cli/brief.ts'], decisions: [{ text: '决定把简报改成按组显示', at: iso(0.1) }] },
      { id: 'g2', title: '另一个会话', topics: ['简报', '交接'], files: ['src/cli/brief.ts'], decisions: [{ text: '决定把交接文档改用会话卡', at: iso(0.4) }] },
      { id: 'g3', title: '独立的数据库会话', topics: ['数据库迁移'], decisions: [dec('决定迁移改用事务包裹')] },
    ]);
    try {
      const pay = collectBrief(db, 'p', { limit: 200 });
      expect(pay.relatedSessions).toHaveLength(1);
      const g = pay.relatedSessions[0];
      expect(g.sessions.sort()).toEqual(['g1', 'g2']);
      expect(g.lead).toBe('g1');   // g1 的决策更新（iso 0.1 < 0.4 天）⇒ 组代表
      expect(g.sharedTopics).toEqual(expect.arrayContaining(['简报', '交接']));
      expect(g.sharedFiles).toContain('src/cli/brief.ts');
      // members 带标题，调用方不必再查库
      expect(g.members.map((m) => m.title).sort()).toEqual(['交接文档（唯一入口）', '另一个会话'].sort());
    } finally { db.close(); }
  });

  it('没有共享信号 ⇒ 不硬凑（相关会话段为空，整段不渲染）', () => {
    const db = seed([
      { id: 'h1', title: '认证讨论', topics: ['认证'], decisions: [dec('决定认证采用 JWT 令牌')] },
      { id: 'h2', title: '前端构建', topics: ['构建工具'], decisions: [dec('决定构建改用 Vite 方案')] },
    ]);
    try {
      const pay = collectBrief(db, 'p', { limit: 200 });
      expect(pay.relatedSessions).toEqual([]);
    } finally { db.close(); }
  });

  it('只有一场会话被简报点名 ⇒ 不成组（单场不重复占位）', () => {
    const db = seed([
      { id: 'i1', title: '唯一的会话', topics: ['简报', '交接'], decisions: [dec('决定只保留这一条结论')] },
    ]);
    try {
      expect(collectBrief(db, 'p', { limit: 200 }).relatedSessions).toEqual([]);
    } finally { db.close(); }
  });

  it('组数有硬上限（最多 3 组），不会随库里会话数膨胀', () => {
    // 文本必须**实质不同**：collectBrief 会做呈现层近重复折叠（foldNearDuplicates），
    // 只差一个编号的八条决策会先被折成两三条，测到的就不是"组数上限"了。
    const texts = [
      '决定把数据库迁移改成事务包裹', '决定把前端构建切换为 Vite 工具',
      '决定认证令牌改用 JWT 方案', '决定检索排序加入标题加权',
      '决定地图节点必须带证据来源', '决定会话卡只保留三行结论',
      '决定审计阶段每天只跑一次', '决定归档会话不再参与检索',
    ];
    const rows: SeedRow[] = [];
    for (let i = 0; i < 4; i++) {
      const t1 = '主题A' + String(i);
      const t2 = '主题B' + String(i);
      rows.push(
        { id: 'p' + String(i) + 'a', title: '组' + String(i) + '甲', topics: [t1, t2], decisions: [{ text: texts[i * 2], at: iso(0.1 + i * 0.05) }] },
        { id: 'p' + String(i) + 'b', title: '组' + String(i) + '乙', topics: [t1, t2], decisions: [{ text: texts[i * 2 + 1], at: iso(0.2 + i * 0.05) }] },
      );
    }
    const db = seed(rows);
    try {
      const pay = collectBrief(db, 'p', { limit: 200 });
      expect(pay.relatedSessions.length).toBeLessThanOrEqual(RELATED_MAX_GROUPS);
      expect(pay.relatedSessions.length).toBeGreaterThanOrEqual(1);
      for (const g of pay.relatedSessions) expect(g.sessions.length).toBeLessThanOrEqual(3);
    } finally { db.close(); }
  });
});
