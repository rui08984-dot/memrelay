// 决策出处回填（scripts/decision-evidence-backfill.ts）的分类与写入边界。
//
// 为什么值得测：这个脚本会给 decisions 补 msgId —— 而 msgId 是读端回跳原文的唯一稳定键。
//   写错一条不是「少一条」，是**回跳到别人的正文**，且无声无息。所以这里钉死的不是实现细节，
//   而是四条红线：
//     ① 三条证据（seq 命中 / 时间一致 / 正文含句）缺一条就**不许**写，归「歧义」而不是硬塞；
//     ② 原文已归档（messages 为空）只能是「补不了」，不许拿 seq 猜；
//     ③ 默认不写库（dry-run 跑完库一个字节都不动）；
//     ④ 重复跑幂等（第二次跑没有可写的了）。
import { describe, it, expect } from 'vitest';
import { createDb, type DB } from '../../src/store/db.js';
import {
  analyzeDecisionEvidence, backfillDecisionEvidence, timestampAgrees, textCorroborates,
} from '../../scripts/decision-evidence-backfill.js';

interface SeedDecision { text: string; seq: number; at?: string; msgId?: string | number }

function mkDb(): DB {
  return createDb(':memory:') as unknown as DB;
}

/** 建一场会话 + 它的消息；messages.id 自增，故先插消息再读回 id。 */
function seedSession(
  db: DB,
  id: string,
  msgs: Array<{ seq: number; role?: 'user' | 'assistant'; content: string; createdAt: string }>,
  decisions: SeedDecision[],
  opts: { projectId?: string } = {},
): Map<number, number> {
  db.prepare('INSERT INTO sessions (id, source, source_session_id, project_id, state, title, created_at, message_count, decisions)'
    + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, 'zcode', id, opts.projectId ?? 'p', 'confirmed', 't', '2026-10-01T00:00:00Z', msgs.length, JSON.stringify(decisions));
  const ins = db.prepare('INSERT INTO messages (session_id, role, content, seq_num, created_at) VALUES (?, ?, ?, ?, ?)');
  const ids = new Map<number, number>();
  for (const m of msgs) {
    const info = ins.run(id, m.role ?? 'assistant', m.content, m.seq, m.createdAt);
    ids.set(m.seq, Number(info.lastInsertRowid));
  }
  return ids;
}

const AT = '2026-10-01T01:00:00.000Z';

describe('决策出处回填 · 判据函数', () => {
  it('时间戳：同一时刻才算 ok，解析不了是 unknown（不是 ok）', () => {
    expect(timestampAgrees(AT, AT)).toBe('ok');
    expect(timestampAgrees(AT, '2026-10-01T01:00:01.000Z')).toBe('mismatch');
    expect(timestampAgrees('', AT)).toBe('unknown');
    expect(timestampAgrees(AT, null)).toBe('unknown');
  });

  it('正文核对：去空白比对；探针太短就没有区分度，不许当成「对得上」', () => {
    expect(textCorroborates('改用 Range 解析', '……最终 改用 Range  解析，因为')).toBe('ok');
    expect(textCorroborates('改用 Range 解析', '完全不同的正文')).toBe('mismatch');
    expect(textCorroborates('改用', '改用')).toBe('too-short');
  });
});

describe('决策出处回填 · 分类', () => {
  it('三条证据全过 ⇒ backfillable；缺一条 ⇒ ambiguous；正文已归档 ⇒ unrecoverable', () => {
    const db = mkDb();
    seedSession(db, 's1', [
      { seq: 1, content: '讨论一下，最后 改用 Range 解析，因为跨段更稳', createdAt: AT },
      { seq: 2, content: '另一个话题的正文，跟那条决策无关', createdAt: '2026-10-01T02:00:00.000Z' },
    ], [
      // 能回填：seq 命中 + 时间一致 + 正文含句
      { text: '改用 Range 解析', seq: 1, at: AT },
      // 歧义（时间对不上）：seq 命中但时间戳不一致 —— 说明这条 seq 已经不是当初那条消息
      { text: '另一个话题的正文', seq: 2, at: AT },
      // 歧义（正文对不上）：seq 上没有这句话
      { text: '这句正文里根本没有出现过', seq: 1, at: AT },
      // 补不了：seq 上已经没有消息
      { text: '裁掉的那条', seq: 99, at: AT },
      // 补不了：压根没记 seq
      { text: '没有 seq 的老条目', seq: Number.NaN as unknown as number, at: AT },
    ]);
    const rep = analyzeDecisionEvidence(db, { sampleLimit: 5 });
    expect(rep.decisions).toBe(5);
    expect(rep.missingMsgId).toBe(5);
    expect(rep.counts.backfillable).toBe(1);
    expect(rep.counts.ambiguous).toBe(2);
    expect(rep.counts.unrecoverable).toBe(2);
    expect(rep.counts.ok).toBe(0);
    // 反查成功率：seq 1/2/1/99/NaN → 前三条命中
    expect(rep.reverseLookup.attempted).toBe(5);
    expect(rep.reverseLookup.resolved).toBe(3);
    expect(rep.samples.length).toBe(5);
    db.close();
  });

  it('原文已归档的会话：msgId 悬空与缺 msgId 都只能如实报告，不猜', () => {
    const db = mkDb();
    seedSession(db, 'gone', [], [
      { text: '归档前定的决策', seq: 3, at: AT },
      { text: '归档前带 msgId 的决策', seq: 4, at: AT, msgId: '999' },
    ]);
    const rep = analyzeDecisionEvidence(db);
    expect(rep.counts.unrecoverable).toBe(1);
    expect(rep.counts.danglingMsgId).toBe(1);
    expect(rep.counts.backfillable).toBe(0);
    expect(rep.reverseLookup.missingResolved).toBe(0);
    expect(Object.keys(rep.reasons).some((k) => k.startsWith('archived'))).toBe(true);
    db.close();
  });

  it('有 msgId 且能定位 ⇒ ok；同时数出 seq 漂移', () => {
    const db = mkDb();
    const ids = seedSession(db, 's2', [
      { seq: 10, content: '改用 Range 解析，因为跨段更稳', createdAt: AT },
    ], []);
    const good = ids.get(10)!;
    db.prepare('UPDATE sessions SET decisions = ? WHERE id = ?').run(JSON.stringify([
      { text: '改用 Range 解析', seq: 10, at: AT, msgId: String(good) },
      // msgId 对、seq 记错了（漂移）：仍然算 ok，但要被 seqDrift 数出来
      { text: '改用 Range 解析', seq: 7, at: AT, msgId: String(good) },
    ]), 's2');
    const rep = analyzeDecisionEvidence(db);
    expect(rep.counts.ok).toBe(2);
    expect(rep.missingMsgId).toBe(0);
    expect(rep.seqDrift).toBe(1);
    expect(rep.coverage.decisions).toEqual({ total: 2, withMsgId: 2 });
    db.close();
  });
});

describe('决策出处回填 · 写库边界', () => {
  function seedMixed(): { db: DB; ids: Map<number, number> } {
    const db = mkDb();
    const ids = seedSession(db, 's3', [
      { seq: 1, content: '决定 改用 Range 解析，因为跨段更稳', createdAt: AT },
      { seq: 2, content: '无关正文在这里摆着', createdAt: '2026-10-01T02:00:00.000Z' },
    ], [
      { text: '改用 Range 解析', seq: 1, at: AT },
      { text: '这条正文对不上', seq: 2, at: AT },
      { text: '这条已经没有 seq 了', seq: 42, at: AT },
    ]);
    return { db, ids };
  }

  it('默认 dry-run：一条都不写（库内容逐字节不变）', () => {
    const { db } = seedMixed();
    const before = (db.prepare('SELECT decisions FROM sessions WHERE id = ?').get('s3') as { decisions: string }).decisions;
    const rep = backfillDecisionEvidence(db, { sampleLimit: 10 });
    expect(rep.dryRun).toBe(true);
    expect(rep.counts.backfillable).toBe(1);
    expect(rep.written.decisions).toBe(0);
    const after = (db.prepare('SELECT decisions FROM sessions WHERE id = ?').get('s3') as { decisions: string }).decisions;
    expect(after).toBe(before);
    db.close();
  });

  it('--apply：只补「能回填」那一条，其余原样不动', () => {
    const { db, ids } = seedMixed();
    const rep = backfillDecisionEvidence(db, { apply: true, sampleLimit: 0 });
    expect(rep.dryRun).toBe(false);
    expect(rep.written.decisions).toBe(1);
    expect(rep.written.sessions).toBe(1);
    const decs = JSON.parse((db.prepare('SELECT decisions FROM sessions WHERE id = ?').get('s3') as { decisions: string }).decisions) as SeedDecision[];
    expect(decs[0].msgId).toBe(String(ids.get(1)));
    expect(decs[1].msgId).toBeUndefined();
    expect(decs[2].msgId).toBeUndefined();
    // 正文与顺序一字不动
    expect(decs.map((d) => d.text)).toEqual(['改用 Range 解析', '这条正文对不上', '这条已经没有 seq 了']);
    db.close();
  });

  it('重复跑幂等：第二次没有可写的，且已补的 msgId 被读端认作 ok', () => {
    const { db } = seedMixed();
    backfillDecisionEvidence(db, { apply: true, sampleLimit: 0 });
    const second = backfillDecisionEvidence(db, { apply: true, sampleLimit: 0 });
    expect(second.written.decisions).toBe(0);
    expect(second.counts.backfillable).toBe(0);
    expect(second.counts.ok).toBe(1);
    db.close();
  });
});
