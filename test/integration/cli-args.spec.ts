import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// [10-19] CLI 参数校验：空查询 / 非法 limit 必须**报错退出**，不许伪装成「库里没有」。
// 用真子进程跑 dist：只有真进程才能钉住 process.exitCode（单测直接调函数测不到）。

const CLI = path.resolve(__dirname, '../../dist/srelay.js');
const run = (args: string[], cwd: string): { code: number; out: string } => {
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: String(err.stdout ?? '') + String(err.stderr ?? '') };
  }
};

const mkProject = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'srelay-cli-'));
  fs.mkdirSync(path.join(dir, '.sessionrelay'), { recursive: true });
  return dir;
};

describe('CLI 参数校验（真子进程）', () => {
  it('空查询：报错并退出码 2，不说「未找到」', () => {
    const dir = mkProject();
    try {
      const r = run(['search', ''], dir);
      expect(r.code).toBe(2);
      expect(r.out).toContain('检索词不能为空');
      expect(r.out).not.toContain('未找到');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('--limit 负数：报错并退出码 2', () => {
    const dir = mkProject();
    try {
      const r = run(['search', '交接', '--limit', '-5'], dir);
      expect(r.code).toBe(2);
      expect(r.out).toContain('--limit');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('--limit 非数字：报错并退出码 2', () => {
    const dir = mkProject();
    try {
      const r = run(['search', '交接', '--limit', 'abc'], dir);
      expect(r.code).toBe(2);
      expect(r.out).toContain('--limit');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
