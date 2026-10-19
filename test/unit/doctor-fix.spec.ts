// doctor --fix 自愈（1019 C）：只做两类「已知且安全」的修复。
//
// 这些用例钉住的是**安全边界**，不是实现细节：
//   · 默认 dry-run —— 不带 --fix 时一个字节都不写
//   · 插件副本只补缺的，内容不同的一律不覆盖（可能是用户手改的）
//   · 面板 vendor 是生成物：补/覆盖/删/重写清单，与 ses-panel-install.mjs 同一条判据
//   · 一项写不动只影响它自己，其余照修，报告里说清是哪项、为什么
//   · 绝不写 profile 的 package.json / cordis.yml
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runSelfHeal, resolveSelfHealMode, findPackageRoot } from '../../src/core/selfheal.js';

let tmp = '';

const p = (...parts: string[]): string => path.join(tmp, ...parts);
const abs = (rel: string): string => p(...rel.split('/'));
const write = (rel: string, text = 'x'): void => {
  const f = abs(rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
};
const read = (rel: string): string => fs.readFileSync(abs(rel), 'utf8');
const has = (rel: string): boolean => fs.existsSync(abs(rel));

const opts = (apply: boolean, extra: Record<string, unknown> = {}) => ({
  home: p('home'),
  repoRoot: p('repo'),
  workspaceRoot: p('outer'),
  profiles: ['web'],
  apply,
  ...extra,
});

/** 最小但真实的布局：工作区插件源 / 面板作者副本 / 包根 dist / profile 的两份插件副本 + 一份面板副本 */
function fixture(): void {
  // 工作区（D:/dsh插件  记忆 的角色）
  write('outer/plugins/dsh/index.js', 'src-index');
  write('outer/plugins/dsh/src/a.mjs', 'src-a');
  write('outer/plugins/dsh/src/b.mjs', 'src-b');
  // node_modules 是开发便利链接，绝不能同步到副本（与两个 install 脚本的 SKIP 同一条）
  write('outer/plugins/dsh/vendor/node_modules/x.js', 'must-not-copy');

  write('outer/integrations/dsh-srelay-panel/lib/index.js', 'panel-lib');
  write('outer/integrations/dsh-srelay-panel/package.json', '{"name":"dsh-srelay-panel"}');

  // 包根（core/SessionRelay 的角色）
  write('repo/package.json', JSON.stringify({ name: 'memrelay', version: '9.9.9' }));
  write('repo/dist/a-H1.js', 'js-a');
  write('repo/dist/b-H2.js', 'js-b');
  write('repo/dist/notes.txt', 'not-js');

  // profile web：插件 local-plugins 副本（a 的内容与源不同 —— 只补缺、不覆盖）
  write('home/.dsh/profiles/web/local-plugins/dsh-srelay-brief/index.js', 'local-index');
  write('home/.dsh/profiles/web/local-plugins/dsh-srelay-brief/src/a.mjs', 'local-a');
  // profile web：插件 .pnpm 副本（DSH 真正加载的那份，缺文件）
  write('home/.dsh/profiles/web/node_modules/.pnpm/dsh-srelay-brief@file+local_x/node_modules/dsh-srelay-brief/package.json', '{"name":"dsh-srelay-brief"}');
  // profile web：面板副本（缺 b-H2 / a-H1 内容旧 / 多 old-H0 / 无清单）
  write('home/.dsh/profiles/web/local-plugins/dsh-srelay-panel/package.json', '{"name":"dsh-srelay-panel"}');
  write('home/.dsh/profiles/web/local-plugins/dsh-srelay-panel/vendor/dist/a-H1.js', 'stale-a');
  write('home/.dsh/profiles/web/local-plugins/dsh-srelay-panel/vendor/dist/old-H0.js', 'gone');

  // 用户配置：自愈一个字都不许动
  write('home/.dsh/profiles/web/package.json', '{"dependencies":{"dsh-srelay-panel":"file:./local-plugins/dsh-srelay-panel"}}');
  write('home/.dsh/profiles/web/cordis.yml', 'plugins: []\n');
}

beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'srelay-heal-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('doctor --fix 的模式（默认 dry-run）', () => {
  it('默认 dry-run；只有 --fix 才动手；--dry-run 压过 --fix', () => {
    expect(resolveSelfHealMode({}).apply).toBe(false);
    expect(resolveSelfHealMode({ fix: false }).apply).toBe(false);
    expect(resolveSelfHealMode({ fix: true }).apply).toBe(true);
    const both = resolveSelfHealMode({ fix: true, dryRun: true });
    expect(both.apply).toBe(false);
    expect(both.note).toContain('dry-run');
  });

  it('dry-run：报告缺什么，但一个字节都不写', () => {
    fixture();
    const r = runSelfHeal(opts(false));
    expect(r.apply).toBe(false);
    expect(r.counts.fixed).toBe(0);
    expect(has('home/.dsh/profiles/web/local-plugins/dsh-srelay-brief/src/b.mjs')).toBe(false);
    expect(has('home/.dsh/profiles/web/local-plugins/dsh-srelay-panel/vendor/dist/b-H2.js')).toBe(false);
    expect(read('home/.dsh/profiles/web/local-plugins/dsh-srelay-panel/vendor/dist/old-H0.js')).toBe('gone');
    expect(has('home/.dsh/profiles/web/local-plugins/dsh-srelay-panel/vendor/package.json')).toBe(false);
    const planned = r.steps.filter((s) => s.status === 'planned');
    expect(planned.length).toBeGreaterThan(0);
    expect(planned.some((s) => s.ops.some((o) => o.file === 'src/b.mjs'))).toBe(true);
  });
});

describe('① 插件副本：从 plugins/dsh 补拷缺的文件', () => {
  it('只补缺的：内容不同的文件不覆盖（本地手改不动）', () => {
    fixture();
    const r = runSelfHeal(opts(true));
    const dir = 'home/.dsh/profiles/web/local-plugins/dsh-srelay-brief';
    expect(read(dir + '/src/b.mjs')).toBe('src-b');
    expect(read(dir + '/index.js')).toBe('local-index'); // 源里是 src-index，绝不覆盖
    expect(read(dir + '/src/a.mjs')).toBe('local-a');   // 源里是 src-a，绝不覆盖
    // 源里的 node_modules 不跟着抄
    expect(has(dir + '/vendor/node_modules/x.js')).toBe(false);
    const step = r.steps.find((s) => s.label.includes('local-plugins/dsh-srelay-brief'));
    expect(step?.status).toBe('fixed');
    expect(step?.ops.map((o) => o.file)).toEqual(['src/b.mjs']);
    expect(step?.summary).toContain('已补 1');
  });

  it('.pnpm 副本同样补拷（DSH 实际加载的是这一份）', () => {
    fixture();
    const r = runSelfHeal(opts(true));
    const dir = 'home/.dsh/profiles/web/node_modules/.pnpm/dsh-srelay-brief@file+local_x/node_modules/dsh-srelay-brief';
    expect(has(dir + '/index.js')).toBe(true);
    expect(has(dir + '/src/a.mjs')).toBe(true);
    expect(has(dir + '/src/b.mjs')).toBe(true);
    const step = r.steps.find((s) => s.label.includes('.pnpm/dsh-srelay-brief@'));
    expect(step?.status).toBe('fixed');
    expect(step?.ops).toHaveLength(3);
  });

  it('副本不存在就不代装（只修已安装的副本）', () => {
    fixture();
    fs.rmSync(abs('home/.dsh/profiles/web/local-plugins/dsh-srelay-brief'), { recursive: true, force: true });
    const r = runSelfHeal(opts(true));
    expect(has('home/.dsh/profiles/web/local-plugins/dsh-srelay-brief')).toBe(false);
    expect(r.steps.some((s) => s.label.includes('local-plugins/dsh-srelay-brief'))).toBe(false);
  });
});

describe('② 面板 vendor：与 ses-panel-install.mjs 的 syncVendorDist 同一条判据', () => {
  it('补新的 / 覆盖不同的 / 删多余的 / 重写清单；非 .js 不抄', () => {
    fixture();
    const r = runSelfHeal(opts(true));
    const v = 'home/.dsh/profiles/web/local-plugins/dsh-srelay-panel/vendor';
    expect(read(v + '/dist/b-H2.js')).toBe('js-b');
    expect(read(v + '/dist/a-H1.js')).toBe('js-a');
    expect(has(v + '/dist/old-H0.js')).toBe(false);
    expect(has(v + '/dist/notes.txt')).toBe(false);
    expect(JSON.parse(read(v + '/package.json'))).toEqual({ name: 'memrelay', version: '9.9.9', type: 'module' });
    const step = r.steps.find((s) => s.kind === 'panel-vendor' && s.label.includes('local-plugins'));
    expect(step?.status).toBe('fixed');
    expect(step?.ops.some((o) => o.action === 'copy')).toBe(true);
    expect(step?.ops.some((o) => o.action === 'overwrite')).toBe(true);
    expect(step?.ops.some((o) => o.action === 'remove')).toBe(true);
    expect(step?.ops.some((o) => o.action === 'write')).toBe(true);
  });

  it('作者副本（integrations/dsh-srelay-panel）也在自愈范围', () => {
    fixture();
    runSelfHeal(opts(true));
    expect(has('outer/integrations/dsh-srelay-panel/vendor/dist/b-H2.js')).toBe(true);
    expect(has('outer/integrations/dsh-srelay-panel/vendor/package.json')).toBe(true);
  });

  it('内核 dist 缺失 → 跳过并给出可执行的下一步，不凭空建', () => {
    fixture();
    fs.rmSync(abs('repo/dist'), { recursive: true, force: true });
    const r = runSelfHeal(opts(false));
    const step = r.steps.find((s) => s.kind === 'panel-vendor');
    expect(step?.status).toBe('skipped');
    expect(step?.summary).toContain('npm run build');
  });
});

describe('安全边界与失败隔离', () => {
  it('一项写不动，另一项照修；报告说清哪项、为什么', () => {
    fixture();
    // 把副本里的 src 变成普通文件 → 补 src/*.mjs 时 mkdir 必失败（Windows/POSIX 同）
    fs.rmSync(abs('home/.dsh/profiles/web/local-plugins/dsh-srelay-brief/src'), { recursive: true, force: true });
    write('home/.dsh/profiles/web/local-plugins/dsh-srelay-brief/src', 'blocker');

    const r = runSelfHeal(opts(true));
    const local = r.steps.find((s) => s.label.includes('local-plugins/dsh-srelay-brief'));
    expect(local?.status).toBe('failed');
    expect(local?.summary).toMatch(/失败/);
    const pnpm = r.steps.find((s) => s.label.includes('.pnpm/dsh-srelay-brief@'));
    expect(pnpm?.status).toBe('fixed'); // 别的项没有被拖下水
    expect(r.counts.failed).toBe(1);
  });

  it('不碰用户配置：profile 的 package.json / cordis.yml 字节级不变', () => {
    fixture();
    const pj = read('home/.dsh/profiles/web/package.json');
    const cordis = read('home/.dsh/profiles/web/cordis.yml');
    runSelfHeal(opts(true));
    expect(read('home/.dsh/profiles/web/package.json')).toBe(pj);
    expect(read('home/.dsh/profiles/web/cordis.yml')).toBe(cordis);
  });

  it('找不到插件源 → 跳过并说明，不猜路径、不抛错', () => {
    fixture();
    const r = runSelfHeal(opts(false, { workspaceRoot: p('nowhere') }));
    expect(r.sources.plugin).toBe(null);
    const step = r.steps.find((s) => s.kind === 'plugin-copy');
    expect(step?.status).toBe('skipped');
    expect(step?.summary).toContain('找不到插件源');
    // 面板 profile 副本仍在自愈范围（不依赖作者副本）
    expect(r.steps.some((s) => s.kind === 'panel-vendor' && s.status === 'planned')).toBe(true);
  });

  it('修完再跑：全部 clean，不再产生任何写操作（幂等）', () => {
    fixture();
    runSelfHeal(opts(true));
    const again = runSelfHeal(opts(true));
    expect(again.counts.planned).toBe(0);
    expect(again.counts.fixed).toBe(0);
    expect(again.counts.failed).toBe(0);
    expect(again.steps.every((s) => s.status === 'clean')).toBe(true);
  });

  it('findPackageRoot 只认 memrelay 包根（不把随便哪个目录当 dist 源）', () => {
    fixture();
    expect(findPackageRoot(p('repo/dist'))).toBe(p('repo'));
    expect(findPackageRoot(p('repo'))).toBe(p('repo'));
    expect(findPackageRoot(tmp)).toBe(null);
  });
});
