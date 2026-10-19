// [10-19 · 任务 B] 检索可解释性（srelay search --explain）的契约测试。
//
// 钉住三件事：
//   1) 默认不填 explain（零开销路径），打开后每条都有且 finalScore === score；
//   2) --explain 只读：命中 id / 分数 / 顺序与不开时**逐条一致**（排序不变）；
//   3) 明细可复算：baseScore × 覆盖 × 长度 × 时间 × 标题 = finalScore，
//      且各因子与 engine 的单一实现（coverageBoost / lenPenaltyOf / 标题重叠）一致。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createDb, insertSession, insertMessage } from '../../src/store/db.js';
import {
  searchSessions,
  lenPenaltyOf,
  DEFAULT_TITLE_BOOST,
  type SearchHit,
} from '../../src/search-svc/engine.js';
import { parseQuery } from '../../src/core/tokenize/tokenizer.js';
import { defaultDecayConfig } from '../../src/core/decay/decay.js';

const PROJECT = 'proj-explain';
const iso = (day: number) => new Date(Date.UTC(2026, 0, day, 10, 0, 0)).toISOString();

function session(db: ReturnType<typeof createDb>, id: string, opts: { title?: string; createdAt?: string } = {}) {
  insertSession(db, {
    id,
    source: 'x',
    sourceSessionId: id,
    projectId: PROJECT,
    createdAt: opts.createdAt ?? iso(1),
    title: opts.title,
  });
}

function message(db: ReturnType<typeof createDb>, id: string, seq: number, content: string) {
  insertMessage(db, { sessionId: id, role: 'user', content, seqNum: seq, createdAt: iso(seq) });
}

/** 查询 3 个词元，但没有任何会话覆盖全部 3 个 ⇒ 稳定的 OR 兜底样本（coverage 有差异）。 */
function partialCoverageDb() {
  const db = createDb();
  session(db, 's12'); message(db, 's12', 1, '数据库 分区');
  session(db, 's13'); message(db, 's13', 1, '数据库 归档');
  session(db, 's23'); message(db, 's23', 1, '分区 归档');
  session(db, 's1'); message(db, 's1', 1, '数据库');
  return db;
}

const Q = '数据库 分区 归档';

/** explain 必须严格满足的乘法恒等式（titleWeight 与 engine 实际生效值同源）。 */
function expectMultiplicative(h: SearchHit, titleWeight = DEFAULT_TITLE_BOOST) {
  const e = h.explain!;
  expect(e).toBeTruthy();
  expect(e.finalScore).toBe(h.score);
  expect(e.coverage).toBe(h.coverage);
  const w = Number.isFinite(titleWeight) && titleWeight > 0 ? titleWeight : 0;
  const recomputed = e.baseScore * e.coverageBoost * e.lengthPenalty * e.recency * (1 + w * e.titleOverlap);
  expect(recomputed).toBeCloseTo(h.score, 9);
}

describe('search --explain：默认零开销', () => {
  it('不传 explain 时 SearchHit 上没有 explain 字段', () => {
    const db = partialCoverageDb();
    const hits = searchSessions(db, { project: PROJECT, query: Q, limit: 10, rewrite: false });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.explain === undefined)).toBe(true);
  });
});

describe('search --explain：可解释且不改排序', () => {
  it('explain 前后命中 id / 分数 / 顺序逐条一致', () => {
    const db = partialCoverageDb();
    const plain = searchSessions(db, { project: PROJECT, query: Q, limit: 10, rewrite: false });
    const explained = searchSessions(db, { project: PROJECT, query: Q, limit: 10, rewrite: false, explain: true });

    expect(explained.map((h) => h.sessionId)).toEqual(plain.map((h) => h.sessionId));
    expect(explained.map((h) => h.score)).toEqual(plain.map((h) => h.score));
    expect(explained.every((h) => h.explain !== undefined)).toBe(true);
  });

  it('base × 覆盖 × 长度 × 时间 × 标题 = final，且逐条相等', () => {
    const db = partialCoverageDb();
    const hits = searchSessions(db, {
      project: PROJECT, query: Q, limit: 10, rewrite: false, explain: true,
    });
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) {
      expectMultiplicative(h);
      expect(h.explain!.coverageBoost).toBeCloseTo(1 + h.coverage * h.coverage, 12);
    }
    // 覆盖度确实有差异（否则这条样例测不到覆盖加权）
    expect(new Set(hits.map((h) => h.coverage)).size).toBeGreaterThan(1);
    expect(hits.some((h) => h.explain!.coverageBoost > 1)).toBe(true);
  });

  it('标题重叠：命中标题词元的会话 titleOverlap > 0，且乘进 final', () => {
    const db = createDb();
    session(db, 'title-hit', { title: '数据库 迁移' });
    message(db, 'title-hit', 1, '数据库 分区');
    session(db, 'no-title');
    message(db, 'no-title', 1, '数据库 分区');
    const q = '数据库 分区';
    const units = parseQuery(q).units.flat().filter((t) => t.length >= 2);
    const bag = '数据库 迁移';
    const expected = units.filter((t) => bag.includes(t.toLowerCase())).length / units.length;

    const hits = searchSessions(db, { project: PROJECT, query: q, limit: 10, rewrite: false, explain: true, titleBoost: 2 });
    const hit = hits.find((h) => h.sessionId === 'title-hit')!;
    expect(hit.explain!.titleOverlap).toBeCloseTo(expected, 12);
    expect(hit.explain!.titleOverlap).toBeGreaterThan(0);
    expectMultiplicative(hit, 2);
  });
});

describe('search --explain：长度惩罚与时间衰减', () => {
  it('lengthPenalty 与 lenPenaltyOf(message_count) 同源', () => {
    const db = createDb();
    session(db, 'small'); message(db, 'small', 1, '索引');
    session(db, 'big'); message(db, 'big', 1, '索引');
    db.prepare('UPDATE sessions SET message_count = ? WHERE id = ?').run(10, 'small');
    db.prepare('UPDATE sessions SET message_count = ? WHERE id = ?').run(3000, 'big');

    const hits = searchSessions(db, {
      project: PROJECT, query: '索引', limit: 10, rewrite: false, titleBoost: 0, explain: true,
    });
    const small = hits.find((h) => h.sessionId === 'small')!;
    const big = hits.find((h) => h.sessionId === 'big')!;
    expect(small.explain!.lengthPenalty).toBeCloseTo(lenPenaltyOf(10), 12);
    expect(big.explain!.lengthPenalty).toBeCloseTo(lenPenaltyOf(3000), 12);
    expect(big.explain!.lengthPenalty).toBeLessThan(small.explain!.lengthPenalty);
    expectMultiplicative(small, 0);
    expectMultiplicative(big, 0);

    // 关掉长度归一后，明细必须跟着变成 1（而不是照旧抄一条惩罚）
    const off = searchSessions(db, {
      project: PROJECT, query: '索引', limit: 10, rewrite: false, titleBoost: 0, lengthNorm: false, explain: true,
    });
    expect(off.every((h) => h.explain!.lengthPenalty === 1)).toBe(true);
  });

  it('recency 记录实际衰减乘数（老会话被 floor 兜住时也是真值）', () => {
    const db = createDb();
    session(db, 'old', { createdAt: '2020-01-01T00:00:00.000Z' });
    message(db, 'old', 1, '索引');
    const decay = defaultDecayConfig();
    decay.enabled = true;

    const hits = searchSessions(db, {
      project: PROJECT, query: '索引', limit: 10, rewrite: false, titleBoost: 0, decay, explain: true,
    });
    const hit = hits[0]!;
    expect(hit.explain!.recency).toBeGreaterThan(0);
    expect(hit.explain!.recency).toBeLessThanOrEqual(1);
    // 6 年 >> 2 个半衰期（90 天）⇒ 被 floor=0.25 兜住，值应稳定可断言
    expect(hit.explain!.recency).toBeCloseTo(decay.floor, 12);
    expectMultiplicative(hit, 0);
  });
});

// ─────────── CLI 层：真的 spawn 一次 srelay，确认 --explain 被解析且打印 ───────────
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

describe('search --explain：CLI 打印', () => {
  it('--explain 打印每条的分数构成；不加时 JSON 不带 explain', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'srelay-explain-cli-'));
    try {
      fs.mkdirSync(path.join(root, '.sessionrelay'), { recursive: true });
      fs.writeFileSync(
        path.join(root, '.sessionrelay', 'config.json'),
        JSON.stringify({ version: '1.0', identity: { project_id: PROJECT } }, null, 2),
      );
      const db = createDb(path.join(root, '.sessionrelay', 'relay.sqlite'));
      insertSession(db, {
        id: 'cli-1', source: 'x', sourceSessionId: 'cli-1', projectId: PROJECT,
        createdAt: iso(1), title: '数据库 迁移',
      });
      insertMessage(db, { sessionId: 'cli-1', role: 'user', content: '数据库 分区 归档', seqNum: 1, createdAt: iso(1) });
      db.close();

      const withExplain = runCli(['search', '数据库', '分区', '--explain', '--json'], root);
      expect(withExplain.code).toBe(0);
      const parsed = JSON.parse(withExplain.out) as { hits: Array<{ score: number; explain?: Record<string, number> }> };
      expect(parsed.hits.length).toBeGreaterThan(0);
      const e = parsed.hits[0]!.explain!;
      expect(e).toBeTruthy();
      for (const k of ['titleOverlap', 'coverage', 'coverageBoost', 'lengthPenalty', 'recency', 'baseScore', 'finalScore']) {
        expect(typeof e[k]).toBe('number');
      }
      // JSON 的 score 只保留 3 位；finalScore 保留全值，四舍五入后必须对得上
      expect(Number(e.finalScore!.toFixed(3))).toBe(parsed.hits[0]!.score);

      const text = runCli(['search', '数据库', '分区', '--explain'], root);
      expect(text.code).toBe(0);
      expect(text.out).toContain('打分：');
      expect(text.out).toContain('base ');

      const plain = runCli(['search', '数据库', '分区', '--json'], root);
      expect(plain.code).toBe(0);
      const plainParsed = JSON.parse(plain.out) as { hits: Array<{ explain?: unknown }> };
      expect(plainParsed.hits.every((h) => h.explain === undefined)).toBe(true);
    } finally {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* Windows 文件锁：清理失败不影响判据 */ }
    }
  }, 120_000);
});
