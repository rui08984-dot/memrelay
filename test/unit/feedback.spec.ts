// 任务 D · 零模型检索自校准（第一步：反馈采集）。
//
// 这 5 条用例钉的是**判据**，不是实现细节：
//   ① 记录：检索候选里的 show 真的落一行，名次/查询指纹/长度桶/入口都对；
//   ② 统计：跨桶聚合，且同一 query_hash 只算一次查询；
//   ③ 去重：同一份候选里反复 show 同一会话只记一条；
//   ④ TTL：5 分钟外不记、边界内仍记（过期不许把有效窗口一起砍窄）；
//   ⑤ 不存在的 session 不记；候选按项目分键，借不到别人的。
//
// 全部写进**临时全局库**（SRELAY_GLOBAL_HOME 指到 mkdtemp）：
//   绝不碰 ~/.sessionrelay（用户的真库），更不碰项目库 .sessionrelay/relay.sqlite。
//   本仓踩过这个坑：测试写过真库，读简报/经验的用例集体变红。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openGlobal } from '../../src/store/global.js';
import {
  FEEDBACK_TTL_MS,
  queryHash,
  queryLenBucket,
  rememberSearch,
  recordSearchOpen,
  feedbackStats,
  resetSearchMemory,
} from '../../src/search-svc/feedback.js';

// 固定时钟：用 Date.now() 的话，「5 分钟边界」这类用例会看运气。
const T0 = Date.UTC(2026, 9, 19, 12, 0, 0);

let tmp = '';
let prevHome: string | undefined;

beforeEach(() => {
  prevHome = process.env.SRELAY_GLOBAL_HOME;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-feedback-'));
  process.env.SRELAY_GLOBAL_HOME = path.join(tmp, 'global');
  resetSearchMemory();
});

afterEach(() => {
  // **恢复**而不是 delete：delete 会让同一 worker 里后跑的用例回落到 ~/.sessionrelay（真库）。
  if (prevHome === undefined) delete process.env.SRELAY_GLOBAL_HOME;
  else process.env.SRELAY_GLOBAL_HOME = prevHome;
  resetSearchMemory();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
});

interface Row {
  at: string; project: string; query_hash: string; query_len_bucket: string;
  position: number; session_id: string; open_kind: string;
}

/** 直接读临时全局库里的表。表还没建 → 返回空（那正是「没记」的证据）。 */
function rows(): Row[] {
  const g = openGlobal();
  try {
    const t = g.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='search_feedback'").get();
    if (!t) return [];
    return g.prepare(
      'SELECT at, project, query_hash, query_len_bucket, position, session_id, open_kind FROM search_feedback ORDER BY id',
    ).all() as Row[];
  } finally { g.close(); }
}

describe('检索自校准反馈采集（feedback）', () => {
  it('记录：候选里的 show 落一行，名次/查询指纹/长度桶/入口/项目都对', () => {
    // 纯函数先钉死：加密指纹对归一化后的查询取（空格折叠、大小写一致才算同一次查询）
    expect(queryLenBucket('短')).toBe('1-4');
    expect(queryLenBucket('一个比较长的查询词')).toBe('5-9');
    expect(queryLenBucket('')).toBe('0');
    expect(queryHash(' 交接  文档 ')).toBe(queryHash('交接 文档'));

    rememberSearch('proj-a', '交接 文档', ['sess-a', 'sess-b', 'sess-c'], { now: T0 });

    const first = recordSearchOpen({ project: 'proj-a', sessionId: 'sess-a', openKind: 'mcp_show', now: T0 + 1_000 });
    const third = recordSearchOpen({ project: 'proj-a', sessionId: 'sess-c', openKind: 'cli_show', now: T0 + 2_000 });
    expect(first).toMatchObject({ recorded: true, position: 1 });
    expect(third).toMatchObject({ recorded: true, position: 3 });

    const got = rows();
    expect(got).toHaveLength(2);
    expect(got[0]).toEqual({
      at: new Date(T0 + 1_000).toISOString(),
      project: 'proj-a',
      query_hash: queryHash('交接 文档'),
      query_len_bucket: '5-9',
      position: 1,
      session_id: 'sess-a',
      open_kind: 'mcp_show',
    });
    expect(got[1]).toMatchObject({ position: 3, session_id: 'sess-c', open_kind: 'cli_show' });
    // 隐私：明文查询不入库，只有 16 位十六进制指纹
    expect(got[0].query_hash).toHaveLength(16);
    expect(got[0].query_hash).not.toContain('交接');
  });

  it('统计：跨桶聚合，同一 query_hash 只算一次查询', () => {
    // 短查询两次（同指纹，名次 1 / 2）+ 长查询一次（名次 3）
    rememberSearch('proj-a', '短', ['a'], { now: T0 });
    recordSearchOpen({ project: 'proj-a', sessionId: 'a', openKind: 'mcp_show', now: T0 + 1_000 });
    rememberSearch('proj-a', '短', ['a', 'b'], { now: T0 + 2_000 });
    recordSearchOpen({ project: 'proj-a', sessionId: 'b', openKind: 'cli_show', now: T0 + 3_000 });
    rememberSearch('proj-a', '一个比较长的查询词', ['c', 'd', 'e'], { now: T0 + 4_000 });
    recordSearchOpen({ project: 'proj-a', sessionId: 'e', openKind: 'cli_show', now: T0 + 5_000 });

    const s = feedbackStats();
    expect(s.total).toBe(3);
    expect(s.queries).toBe(2);                       // '短'×2 只算一个查询
    expect(s.sessions).toBe(3);                      // a / b / e
    expect(s.avgPosition).toBe(2);                   // (1+2+3)/3
    expect(s.positions).toEqual([
      { position: 1, opens: 1 }, { position: 2, opens: 1 }, { position: 3, opens: 1 },
    ]);
    expect(s.buckets).toEqual([
      { bucket: '1-4', opens: 2, avgPosition: 1.5 },
      { bucket: '5-9', opens: 1, avgPosition: 3 },
    ]);
    expect(s.kinds).toEqual([{ kind: 'cli_show', opens: 2 }, { kind: 'mcp_show', opens: 1 }]);
    expect(s.topSessions.map((t) => t.sessionId)).toEqual(['a', 'b', 'e']);
    expect(s.firstAt).toBe(new Date(T0 + 1_000).toISOString());
    expect(s.lastAt).toBe(new Date(T0 + 5_000).toISOString());
  });

  it('去重：同一份候选里重复 show 同一会话只记一条', () => {
    rememberSearch('proj-a', 'x', ['a', 'b'], { now: T0 });
    const first = recordSearchOpen({ project: 'proj-a', sessionId: 'a', openKind: 'mcp_show', now: T0 + 1_000 });
    const again = recordSearchOpen({ project: 'proj-a', sessionId: 'a', openKind: 'cli_show', now: T0 + 2_000 });

    expect(first.recorded).toBe(true);
    expect(again.recorded).toBe(false);
    expect(again.reason).toBe('duplicate');
    expect(again.position).toBe(1);                  // 去重也回报它本来命中第几名
    expect(rows()).toHaveLength(1);
  });

  it('TTL：5 分钟外不记，边界内仍记', () => {
    rememberSearch('proj-a', 'q', ['a'], { now: T0 });
    const late = recordSearchOpen({ project: 'proj-a', sessionId: 'a', openKind: 'mcp_show', now: T0 + FEEDBACK_TTL_MS + 1 });
    expect(late).toMatchObject({ recorded: false, reason: 'expired' });
    expect(rows()).toHaveLength(0);

    // 再检索一次，在 TTL 边界内（-1ms）打开：过期只该砍掉过期的，不该顺手砍窄有效窗口
    rememberSearch('proj-a', 'q', ['a'], { now: T0 });
    const ok = recordSearchOpen({ project: 'proj-a', sessionId: 'a', openKind: 'mcp_show', now: T0 + FEEDBACK_TTL_MS - 1 });
    expect(ok.recorded).toBe(true);
    expect(rows()).toHaveLength(1);
  });

  it('不存在的 session 不记：不在候选里、或别的项目都没候选，都不产生事件', () => {
    rememberSearch('proj-a', 'q', ['a', 'b'], { now: T0 });

    const ghost = recordSearchOpen({ project: 'proj-a', sessionId: 'ghost', openKind: 'mcp_show', now: T0 + 1_000 });
    expect(ghost).toMatchObject({ recorded: false, reason: 'not_in_candidates' });

    // 候选按项目分键：proj-b 打开 'a' 不能借 proj-a 的候选
    const other = recordSearchOpen({ project: 'proj-b', sessionId: 'a', openKind: 'cli_show', now: T0 + 2_000 });
    expect(other).toMatchObject({ recorded: false, reason: 'no_recent_search' });

    expect(rows()).toHaveLength(0);
  });
});
