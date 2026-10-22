import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decodeDshSlug, discoverDshRootCandidates, autoRegisterNewProjects } from '../../src/capture/auto-register.js';

// [1022] 新工作区自动接入：解 slug、数会话、保守过滤、可注入 init。

let tmp = '';
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'srelay-auto-')); });
afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* Windows 句柄延迟 */ } });

/** 把真实路径编码成 DSH 的会话组名：非字母数字一律转成 ~XXXX（含 '-'，否则与分隔符冲突）*/
const slugOf = (p: string): string => {
  const root = path.parse(p).root.replace(/[:\\/]/g, '');
  const segs = p.replace(path.parse(p).root, '').split(/[\\/]/).filter(Boolean);
  const enc = (s: string): string => s.replace(/[^A-Za-z0-9]/g, (ch) => '~' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0'));
  return '--' + root + '-' + segs.map(enc).join('-') + '--';
};

const mkGroup = (dir: string, slug: string, sessions: number): void => {
  for (let i = 0; i < sessions; i++) {
    const id = String(i).padStart(8, '0') + '-1111-2222-3333-444444444444';
    fs.mkdirSync(path.join(dir, slug, 'session-' + id), { recursive: true });
  }
};

describe('DSH 会话组名解码', () => {
  it('普通路径 / 中文 / 空格', () => {
    expect(decodeDshSlug('--D-agent1super--')).toBe('D:\\agent1super');
    expect(decodeDshSlug('--D-~97F3~4E50--')).toBe('D:\\音乐');
    expect(decodeDshSlug('--E-music~0020player--')).toBe('E:\\music player');
  });
  it('不合法的名字返回 null（不猜）', () => {
    expect(decodeDshSlug('foo')).toBeNull();
    expect(decodeDshSlug('--1-abc--')).toBeNull();
  });
});

describe('发现未注册候选', () => {
  it('只返回有会话目录的组，并按根聚合', () => {
    const box = path.join(tmp, 'sessions');
    mkGroup(box, '--D-~6D4B~8BD5--', 2);
    mkGroup(box, '--D-emptydir--', 0);
    const got = discoverDshRootCandidates(box);
    const roots = got.map((c) => c.root);
    expect(roots).toContain('D:\\测试');
    expect(roots.some((r) => r.toLowerCase().includes('emptydir'))).toBe(false);
    expect(got.find((c) => c.root === 'D:\\测试')?.sessions).toBe(2);
  });
});

describe('autoRegisterNewProjects', () => {
  it('dryRun 只报告、不调用 init', () => {
    const box = path.join(tmp, 'sessions');
    const proj = path.join(tmp, 'newproj');
    fs.mkdirSync(proj, { recursive: true });
    mkGroup(box, slugOf(proj), 1);
    let calls = 0;
    const r = autoRegisterNewProjects({ sessionsDir: box, dryRun: true, log: () => {}, init: () => { calls++; }, isTransient: () => false });
    expect(calls).toBe(0);
    expect(r.candidates.length + r.skipped.length).toBeGreaterThan(0);
  });

  it('不存在的目录被跳过（解错的 slug 不会误建项目）', () => {
    const box = path.join(tmp, 'sessions');
    mkGroup(box, '--D-this-dir-does-not-exist-9f8e7d--', 1);
    let calls = 0;
    const r = autoRegisterNewProjects({ sessionsDir: box, init: () => { calls++; }, log: () => {} });
    expect(calls).toBe(0);
    expect(r.created).toEqual([]);
    expect(r.skipped.some((s) => s.reason.includes('不存在'))).toBe(true);
  });

  it('真目录 + 真会话 ⇒ 调用 init 并记入 created', () => {
    const box = path.join(tmp, 'sessions');
    const proj = path.join(tmp, 'realproj');
    fs.mkdirSync(proj, { recursive: true });
    mkGroup(box, slugOf(proj), 3);
    const initCalls: string[] = [];
    // 测试目录在 %TEMP% 下 = 真实判据会（正确地）判成临时目录；这里注入 false 以验证 init 路径。
    const r = autoRegisterNewProjects({ sessionsDir: box, init: (root) => { initCalls.push(root); }, log: () => {}, isTransient: () => false });
    expect(initCalls).toEqual([proj]);
    expect(r.created).toEqual([proj]);
  });
});
