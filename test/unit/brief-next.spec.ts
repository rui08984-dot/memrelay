import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectNextStep } from '../../src/cli/brief.js';

// [10-19] 交接包的「🗺 下一步」：只能来自地图账本的 context.next 与 doing/todo 节点。
// 没有地图 / 地图读坏 ⇒ null（整行不渲染），不许猜、不许报错。

let dir = '';

const writeMap = (page: unknown): void => {
  fs.mkdirSync(path.join(dir, '.sessionrelay', 'map'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.sessionrelay', 'map', 'map.json'), JSON.stringify(page));
};

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'srelay-next-')); });
afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 句柄延迟 */ } });

describe('简报 · 🗺 下一步', () => {
  it('有地图：读出 context.next 与进行中/待办节点（最多 3 个）', () => {
    writeMap({
      version: 1, title: 't',
      layers: [{ id: 'l', name: 'L', rank: 0 }],
      nodes: [
        { id: 'a', label: '任务A', layer: 'l', status: 'doing' },
        { id: 'b', label: '任务B', layer: 'l', status: 'todo' },
        { id: 'c', label: '任务C', layer: 'l', status: 'done' },
      ],
      edges: [], context: { summary: 's', next: '先做 A 再做 B' },
    });
    const got = collectNextStep(dir);
    expect(got?.next).toBe('先做 A 再做 B');
    expect(got?.doing).toEqual(['任务A', '任务B']);
  });

  it('没有地图 / 没有 root ⇒ null（整行不渲染）', () => {
    expect(collectNextStep(undefined)).toBeNull();
    expect(collectNextStep(dir)).toBeNull();
  });

  it('地图读坏 ⇒ null（不让简报整体失败）', () => {
    fs.mkdirSync(path.join(dir, '.sessionrelay', 'map'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.sessionrelay', 'map', 'map.json'), '{ not json');
    expect(collectNextStep(dir)).toBeNull();
  });
});
