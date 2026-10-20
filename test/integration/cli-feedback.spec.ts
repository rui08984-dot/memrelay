// 真子进程端到端：**跨进程**的检索反馈采集（1020 修的那个洞）。
//
// 为什么要真进程：原实现把候选留在**进程内存**里，而真实调用链是
//   DSH 插件 srelay_search → 子进程 `srelay search`（退出）
//   DSH 插件 srelay_show   → 另一个子进程 `srelay show`
// ⇒ 内存永远借不到，search_feedback 一次都没记上（实测连表都不存在）。
// 单测只能证明"同一进程内函数能串起来"，钉不住这个洞 —— 必须两个真进程。
//
// 断言链：search 落快照 → show 读快照 → 全局库多一行 → 再 show 一次仍是 1 行（库级去重）。
// 全程在临时项目 + 临时 SRELAY_GLOBAL_HOME 里跑：不碰用户真库，也不碰 ~/.sessionrelay。
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createDb, insertSession, insertMessage } from '../../src/store/db.js';

const CLI = path.resolve(__dirname, '../../dist/srelay.js');
const HAS_DIST = fs.existsSync(CLI);

interface RunResult { code: number; out: string }

function run(args: string[], cwd: string, env: NodeJS.ProcessEnv): RunResult {
  try {
    return { code: 0, out: execFileSync(process.execPath, [CLI, ...args], { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: String(err.stdout ?? '') + String(err.stderr ?? '') };
  }
}

/** 临时项目：真 SQLite 库 + 一条一定能被检索到的会话（项目 id 缺省 = 项目根）。 */
function mkProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'srelay-fb-'));
  fs.mkdirSync(path.join(dir, '.sessionrelay'), { recursive: true });
  const db = createDb(path.join(dir, '.sessionrelay', 'relay.sqlite'));
  try {
    insertSession(db, {
      id: 'sess-fb-1', source: 'claude-code', sourceSessionId: 'fb-1', projectId: dir,
      createdAt: '2026-10-19', topics: ['db'],
    });
    insertMessage(db, { sessionId: 'sess-fb-1', role: 'user', content: '我们讨论了建索引的方案', seqNum: 1 });
    insertMessage(db, { sessionId: 'sess-fb-1', role: 'assistant', content: '索引策略选 B+树，建索引时注意最左前缀', seqNum: 2 });
  } finally { db.close(); }
  return dir;
}

describe.skipIf(!HAS_DIST)('检索反馈采集（两个真进程）', () => {
  it('search 落快照 → show 记账；跨进程成立，且重复 show 只有一行', () => {
    const dir = mkProject();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'srelay-fb-home-'));
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      SRELAY_GLOBAL_HOME: home,
      SRELAY_NO_DAEMON_SPAWN: '1',
      SRELAY_TITLE_BOOST: '0',   // 与产品默认无关：这里只验证采集链路，不验证排序
    };
    try {
      // ① 进程一：检索（写快照）
      const s = run(['search', '建索引 方案', '--json'], dir, env);
      expect(s.code).toBe(0);
      const parsed = JSON.parse(s.out) as { count: number; hits: Array<{ sessionId: string }> };
      expect(parsed.count).toBeGreaterThan(0);
      const sid = parsed.hits[0].sessionId;

      const snapDir = path.join(home, 'last-search');
      expect(fs.existsSync(snapDir)).toBe(true);
      const snapFiles = fs.readdirSync(snapDir).filter((f) => f.endsWith('.json'));
      expect(snapFiles).toHaveLength(1);
      const snap = JSON.parse(fs.readFileSync(path.join(snapDir, snapFiles[0]), 'utf8')) as { positions: Record<string, number> };
      expect(snap.positions[sid]).toBe(1);
      // 隐私：快照里没有明文查询
      expect(fs.readFileSync(path.join(snapDir, snapFiles[0]), 'utf8')).not.toContain('建索引');

      // ② 进程二：打开（读快照 → 记账）
      const sh = run(['show', sid.slice(0, 8)], dir, env);
      expect(sh.code).toBe(0);

      const gfile = path.join(home, 'global.sqlite');
      const read = (): Array<{ project: string; session_id: string; position: number; open_kind: string }> => {
        const g = new Database(gfile, { readonly: true, fileMustExist: true });
        try {
          const t = g.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='search_feedback'").get();
          if (!t) return [];
          return g.prepare('SELECT project, session_id, position, open_kind FROM search_feedback ORDER BY id').all() as never;
        } finally { g.close(); }
      };
      const rows = read();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ project: dir, session_id: sid, position: 1, open_kind: 'cli_show' });

      // ③ 再开一次：库级唯一索引去重（跨进程时内存 Set 天然失效，靠这条判据）
      expect(run(['show', sid.slice(0, 8)], dir, env).code).toBe(0);
      expect(read()).toHaveLength(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('srelay feedback：0 条时说明原因（不假装有数据），有数据时给名次分布', () => {
    const dir = mkProject();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'srelay-fb-home2-'));
    const env: NodeJS.ProcessEnv = { ...process.env, SRELAY_GLOBAL_HOME: home, SRELAY_NO_DAEMON_SPAWN: '1' };
    try {
      const empty = run(['feedback', '--json'], dir, env);
      expect(empty.code).toBe(0);
      const e = JSON.parse(empty.out) as { stats: { total: number; avgPosition: number | null }; snapshot: { exists: boolean } };
      expect(e.stats.total).toBe(0);
      expect(e.stats.avgPosition).toBeNull();
      expect(e.snapshot.exists).toBe(false);

      const s = JSON.parse(run(['search', '建索引 方案', '--json'], dir, env).out) as { hits: Array<{ sessionId: string }> };
      run(['show', s.hits[0].sessionId.slice(0, 8)], dir, env);

      const filled = run(['feedback', '--json'], dir, env);
      const f = JSON.parse(filled.out) as { stats: { total: number; avgPosition: number; positions: Array<{ position: number; opens: number }> }; snapshot: { exists: boolean; candidates: number } };
      expect(f.stats.total).toBe(1);
      expect(f.stats.avgPosition).toBe(1);
      expect(f.stats.positions).toEqual([{ position: 1, opens: 1 }]);
      expect(f.snapshot.exists).toBe(true);
      expect(f.snapshot.candidates).toBeGreaterThan(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
