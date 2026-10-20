// [1021 状态不说谎] 全局守护探活必须能区分三态：管道在跑 / 心跳在但管道断（重启中）/ 真没跑。
//
// 病历：重建时先杀守护再起，那几秒里管道是断的，`watch --status` 只查管道 ⇒ 报「未运行」，
//   而进程其实还活着（生命周期已跑 567 轮）。运维看到「未运行」就会重复拉起。
// 这里钉的是**判据**：心跳 60 秒内算活、超过算死，且心跳文件坏了不许抛。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmp = '';
let prevHome: string | undefined;

beforeEach(() => {
  prevHome = process.env.SRELAY_GLOBAL_HOME;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-hb-'));
  process.env.SRELAY_GLOBAL_HOME = tmp;
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.SRELAY_GLOBAL_HOME;
  else process.env.SRELAY_GLOBAL_HOME = prevHome;
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
});

const writeHb = (body: unknown): void => {
  fs.writeFileSync(path.join(tmp, 'global-heartbeat.json'), typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
};

describe('全局守护探活：心跳佐证', () => {
  it('新鲜心跳（<60s）⇒ 判活，并给出 pid 与年龄', async () => {
    writeHb({ pid: 4321, at: Date.now() - 5_000 });
    const { readGlobalHeartbeat } = await import('../../src/capture/watch.js');
    const hb = readGlobalHeartbeat();
    expect(hb).not.toBeNull();
    expect(hb!.pid).toBe(4321);
    expect(hb!.ageMs).toBeGreaterThanOrEqual(3_000);
    expect(hb!.ageMs).toBeLessThan(60_000);
  });

  it('陈旧心跳（>60s）⇒ 不算活（但仍能报出年龄，便于人判断）', async () => {
    writeHb({ pid: 99, at: Date.now() - 10 * 60_000 });
    const { readGlobalHeartbeat } = await import('../../src/capture/watch.js');
    const hb = readGlobalHeartbeat();
    expect(hb).not.toBeNull();
    expect(hb!.ageMs).toBeGreaterThan(60_000);
  });

  it('心跳文件坏了 ⇒ 返回 null，不抛', async () => {
    writeHb('{ 半个 JSON');
    const { readGlobalHeartbeat } = await import('../../src/capture/watch.js');
    expect(readGlobalHeartbeat()).toBeNull();
  });

  it('没有心跳文件 ⇒ null（不是 0 秒前的假活）', async () => {
    const { readGlobalHeartbeat } = await import('../../src/capture/watch.js');
    expect(readGlobalHeartbeat()).toBeNull();
  });
});
