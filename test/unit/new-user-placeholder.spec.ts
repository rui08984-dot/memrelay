// [10-18 新用户实测] init 生成的 progress.md 模板行不是任务：它不能进地图。
// 病历：新项目 init 后 doctor 显示「地图层 1 页 / 1 节点 / 0 边」，`map read` 里那个节点叫
// 「（把真实任务写在这里）」——模板占位被当成真任务导入了，看板/地图/doctor 全被它污染。
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hatchMapFromKanban } from '../../src/cli/map.js';
import { PLACEHOLDER_ROW_LABEL } from '../../src/cli/kanban.js';

const dirs: string[] = [];
function project(boardLines: string[]): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'nu-placeholder-'));
  dirs.push(d);
  fs.writeFileSync(path.join(d, 'progress.md'), ['# 看板', '', '| 任务 | 状态 | 模块 | 明细 |', '|---|---|---|---|', ...boardLines, ''].join('\n'), 'utf8');
  return d;
}
afterAll(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

describe('新用户路径：init 模板占位不进地图', () => {
  it('只有占位行时，孵化不产生任何节点（按「没有可解析的人写行」拒绝）', () => {
    const d = project([`| ${PLACEHOLDER_ROW_LABEL} | ⬜ 待办 | — | 示例：状态列以 ✅/🔄/⛔/⬜ 开头 |`]);
    const got = hatchMapFromKanban(d);
    expect(got.ok).toBe(false);
    expect(got.note).toMatch(/没有可解析|只有机器行|没有可导入/);
    expect(fs.existsSync(path.join(d, '.sessionrelay', 'map', 'map.json'))).toBe(false);
  });

  it('占位行 + 一条真任务：只导入真任务', () => {
    const d = project([
      `| ${PLACEHOLDER_ROW_LABEL} | ⬜ 待办 | — | 示例 |`,
      '| 接上采集管道 | 🔄 进行中 | capture | 先把 sync 跑通 |',
    ]);
    const got = hatchMapFromKanban(d);
    expect(got.ok).toBe(true);
    const page = JSON.parse(fs.readFileSync(path.join(d, '.sessionrelay', 'map', 'map.json'), 'utf8'));
    const labels = (page.nodes ?? []).map((n: { label: string }) => n.label);
    expect(labels).toEqual(['接上采集管道']);
    expect(labels.some((l: string) => l.includes(PLACEHOLDER_ROW_LABEL))).toBe(false);
  });
});
