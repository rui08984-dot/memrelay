// srelay doctor --fix —— 「已知且安全」的两类自愈（默认 dry-run）
//
// ═══ 为什么只有这两类 ═══
// 同一个判据：**它们是生成物，不是用户的手稿**。生成物落后于权威源 = 故障，
// 从权威源重建 = 恢复；而配置、库、会话内容都不是我们能替用户决定的。
//   ① 插件副本缺文件：DSH 真正加载的是 plugins/dsh 在
//      profiles/<p>/local-plugins 与 node_modules/.pnpm 下的两份副本；pnpm 的 file: 依赖
//      走硬链接 —— **新增文件不会自己进 .pnpm**（2026-10-15 实测：插件因一个新增文件
//      缺在 .pnpm 里整个加载失败，而所有自检全绿）。所以「副本缺文件」= 已安装但坏了，
//      补拷是恢复，不是改装。
//   ② 面板 vendor 落后：vendor/dist 是内核 dist 的逐字节镜像（面板宿主半边 import 的
//      唯一入口），判据与 tools/ses-panel-install.mjs 的 syncVendorDist 同一条：
//      源里有、副本没有（或 md5 不同）→ 补/覆盖；副本有、源里没有 → 删；清单文件重写。
//
// ═══ 三条硬边界（doctor --fix 不许越过）═══
//   · 不碰数据库（不 open relay.sqlite）、不重启进程、不写 profile 的 package.json /
//     cordis.yml —— 这里只写「已安装副本」里的文件
//   · 插件副本只补**缺的**；内容不同的文件**绝不覆盖**（那可能是用户手改的）
//   · 每个目标各自 try/catch：一项失败只影响它自己，其余照常
//
// 为什么判据写在这一个文件里：doctor 的「检查」与「修复」必须同一条规则。
// 两份判据的结局一定是「体检说健康、修复却按另一套改」，本仓已经吃过太多次这种亏。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export type HealKind = 'plugin-copy' | 'panel-vendor';
export type HealStatus = 'clean' | 'planned' | 'fixed' | 'skipped' | 'failed';

export interface HealOp {
  /** copy=补新文件；overwrite=内容不同（仅 panel vendor 生成物允许）；remove=副本多余；write=清单文件 */
  action: 'copy' | 'overwrite' | 'remove' | 'write';
  /** 相对副本根的路径，展示用（统一用 /） */
  file: string;
}

export interface HealStep {
  kind: HealKind;
  label: string;
  status: HealStatus;
  /** 「改了什么 / 跳过原因」——人读这一句就够 */
  summary: string;
  ops: HealOp[];
}

export interface HealCounts {
  clean: number;
  planned: number;
  fixed: number;
  skipped: number;
  failed: number;
}

export interface SelfHealSources {
  plugin: string | null;
  panel: string | null;
  dist: string | null;
}

export interface SelfHealReport {
  apply: boolean;
  steps: HealStep[];
  counts: HealCounts;
  sources: SelfHealSources;
  notes: string[];
}

export interface SelfHealOptions {
  /** 默认 os.homedir()（测试注入） */
  home?: string;
  /** memrelay 包根（dist 与 package.json 所在）；默认从本模块位置向上找 */
  repoRoot?: string;
  /** 外层工作区（含 plugins/dsh 与 integrations/dsh-srelay-panel）；默认按 SES_SOURCE → 上两级探测 */
  workspaceRoot?: string;
  /** 默认扫 ~/.dsh/profiles；测试可注入 */
  profiles?: string[];
  /** false=只报告（默认）；true=真写 */
  apply?: boolean;
}

export interface SelfHealMode {
  apply: boolean;
  note?: string;
}

/** 默认 dry-run；--dry-run 与 --fix 同时给出时按 dry-run 走（少写一次比多写一次安全）。 */
export function resolveSelfHealMode(flags: { fix?: boolean; dryRun?: boolean } = {}): SelfHealMode {
  if (flags.dryRun) {
    return {
      apply: false,
      note: flags.fix ? '--dry-run 与 --fix 同时给出：按 dry-run 走，未改动任何文件' : undefined,
    };
  }
  return flags.fix === true ? { apply: true } : { apply: false };
}

const PLUGIN_NAME = 'dsh-srelay-brief';
const PANEL_NAME = 'dsh-srelay-panel';
/** 与 ses-install.mjs / ses-panel-install.mjs 的 walk 跳过集一致（node_modules 是本机开发符号链接，绝不能同步） */
const SKIP_DIRS = new Set(['node_modules', '.git']);
const MAX_DEPTH = 16;
const MAX_SHOWN = 4;
/** 与 tools/ses-panel-install.mjs 的 pjText 同一条（只有 package.json 读不到时才落到这个默认值） */
const VENDOR_PKG_DEFAULT = { name: 'memrelay', version: '1.0.0', type: 'module' };

function isDir(p: string): boolean {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function isFile(p: string): boolean {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function readText(p: string): string | null {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

function md5(p: string): string | null {
  try { return createHash('md5').update(fs.readFileSync(p)).digest('hex'); } catch { return null; }
}

/** 两边都读得到且内容一致才算 same；任一侧读不到一律算「不同」（让调用方去报错，不静默判等） */
function sameFile(a: string, b: string): boolean {
  const ha = md5(a);
  return ha !== null && ha === md5(b);
}

function shortErr(e: unknown): string {
  const err = e as NodeJS.ErrnoException;
  const text = err && err.code ? `${err.code}: ${err.message}` : (err && err.message) || String(e);
  return String(text).replace(/\s+/g, ' ').slice(0, 160);
}

/** 源目录里的普通文件（相对路径、/ 分隔、已排序）。符号链接跳过：副本里不该有，也不跟出去。 */
function walkFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string, depth: number): void => {
    if (depth > MAX_DEPTH) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name) || e.isSymbolicLink()) continue;
      const r = rel ? rel + '/' + e.name : e.name;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs, r, depth + 1);
      else if (e.isFile()) out.push(r);
    }
  };
  walk(root, '', 0);
  out.sort();
  return out;
}

function shortName(s: string, n = 30): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

function nameList(files: string[], max = MAX_SHOWN): string {
  const head = files.slice(0, max).join(', ');
  return files.length > max ? `${head} 等 ${files.length} 个` : head;
}

function partsToPath(rel: string): string[] {
  return rel.split('/').filter(Boolean);
}

/** 从 memrelay 包根向上找 bundle 根；找不到就 null（宁可不修，也不猜 dist 在哪） */
export function findPackageRoot(startDir?: string): string | null {
  let dir: string;
  try { dir = startDir ?? path.dirname(fileURLToPath(import.meta.url)); } catch { return null; }
  for (let i = 0; i < 8; i += 1) {
    const pj = path.join(dir, 'package.json');
    const text = readText(pj);
    if (text) {
      try {
        const obj = JSON.parse(text) as { name?: unknown };
        if (obj && obj.name === 'memrelay') return dir;
      } catch { /* 坏 package.json 继续往上 */ }
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/**
 * 外层工作区（含 plugins/dsh 与 integrations/）在哪。
 * 顺序：显式 → SES_SOURCE（ses-install.mjs 用的同名环境变量）→ 包根的上两级（core/SessionRelay ← 工作区）。
 * 每个候选都要**真的含**某个已知目录才算数 —— 否则全局安装时会把 npm 前缀误认成工作区。
 */
export function resolveWorkspaceRoot(
  repoRoot: string | null,
  env: NodeJS.ProcessEnv = process.env,
  explicit?: string,
): string | null {
  const cands: string[] = [];
  if (explicit) cands.push(explicit);
  if (env.SES_SOURCE) cands.push(env.SES_SOURCE);
  if (repoRoot) {
    cands.push(path.resolve(repoRoot, '..', '..'));
    cands.push(path.resolve(repoRoot, '..'));
  }
  for (const c of cands) {
    if (!c || !isDir(c)) continue;
    if (isDir(path.join(c, 'plugins', 'dsh'))
      || isDir(path.join(c, 'integrations', 'dsh-srelay-panel'))
      || isDir(path.join(c, 'integrations', 'dsh'))) return c;
  }
  return null;
}

function listProfiles(home: string): string[] {
  const root = path.join(home, '.dsh', 'profiles');
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== 'node_modules')
      .map((d) => d.name)
      .sort();
  } catch { return []; }
}

function pnpmCopies(profileBase: string, pkg: string): Array<{ dir: string; entry: string }> {
  const root = path.join(profileBase, 'node_modules', '.pnpm');
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
  const out: Array<{ dir: string; entry: string }> = [];
  for (const e of entries) {
    if (!e.isDirectory() || !e.name.startsWith(pkg + '@')) continue;
    const dir = path.join(root, e.name, 'node_modules', pkg);
    if (isDir(dir)) out.push({ dir, entry: e.name });
  }
  out.sort((a, b) => a.entry.localeCompare(b.entry));
  return out;
}

interface CopyTarget { label: string; dir: string }

function pluginCopyTargets(home: string, profiles: string[]): CopyTarget[] {
  const out: CopyTarget[] = [];
  for (const prof of profiles) {
    const base = path.join(home, '.dsh', 'profiles', prof);
    const local = path.join(base, 'local-plugins', PLUGIN_NAME);
    if (isDir(local)) out.push({ label: `${prof} · local-plugins/${PLUGIN_NAME}`, dir: local });
    for (const p of pnpmCopies(base, PLUGIN_NAME)) {
      out.push({ label: `${prof} · .pnpm/${shortName(p.entry)}`, dir: p.dir });
    }
  }
  return out;
}

function panelVendorTargets(home: string, profiles: string[], panelSource: string | null): CopyTarget[] {
  const out: CopyTarget[] = [];
  // 作者副本：插件自测跑的就是它（真实加载路径），vendor 不在就连不起来
  if (panelSource && isDir(panelSource)) {
    out.push({ label: '作者副本 · integrations/' + PANEL_NAME, dir: panelSource });
  }
  for (const prof of profiles) {
    const base = path.join(home, '.dsh', 'profiles', prof);
    const local = path.join(base, 'local-plugins', PANEL_NAME);
    if (isDir(local)) out.push({ label: `${prof} · local-plugins/${PANEL_NAME}`, dir: local });
    for (const p of pnpmCopies(base, PANEL_NAME)) {
      out.push({ label: `${prof} · .pnpm/${shortName(p.entry)}`, dir: p.dir });
    }
  }
  return out;
}

function copyInto(sourceDir: string, targetDir: string, rel: string): string | null {
  const src = path.join(sourceDir, ...partsToPath(rel));
  const dst = path.join(targetDir, ...partsToPath(rel));
  try {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    return null;
  } catch (e) { return shortErr(e); }
}

function healPluginCopy(source: string, target: CopyTarget, apply: boolean): HealStep {
  const files = walkFiles(source);
  const head = { kind: 'plugin-copy' as const, label: target.label, ops: [] as HealOp[] };
  if (files.length === 0) {
    return { ...head, status: 'skipped', summary: `插件源为空（${source}）——跳过，不猜路径` };
  }
  const missing = files.filter((rel) => !isFile(path.join(target.dir, ...partsToPath(rel))));
  if (missing.length === 0) {
    return { ...head, status: 'clean', summary: `副本完整（${files.length} 个文件）` };
  }
  const ops: HealOp[] = missing.map((rel) => ({ action: 'copy', file: rel }));
  if (!apply) {
    return { ...head, status: 'planned', summary: `缺 ${missing.length} 个文件（--fix 将补拷）：${nameList(missing)}`, ops };
  }
  const copied: string[] = [];
  const errors: string[] = [];
  for (const rel of missing) {
    const err = copyInto(source, target.dir, rel);
    if (err) errors.push(`${rel}: ${err}`);
    else copied.push(rel);
  }
  if (errors.length > 0) {
    return {
      ...head, status: 'failed', ops: copied.map((file) => ({ action: 'copy', file })),
      summary: `缺 ${missing.length} 个：已补 ${copied.length} / 失败 ${errors.length}（${errors[0]}）`,
    };
  }
  return {
    ...head, status: 'fixed', ops,
    summary: `已补 ${copied.length} 个文件：${nameList(copied)}`,
  };
}

function vendorPackageJson(repoRoot: string | null): string {
  let identity = VENDOR_PKG_DEFAULT;
  if (repoRoot) {
    const text = readText(path.join(repoRoot, 'package.json'));
    if (text) {
      try {
        const obj = JSON.parse(text) as { name?: unknown; version?: unknown };
        if (typeof obj.name === 'string' && typeof obj.version === 'string') {
          identity = { name: obj.name, version: obj.version, type: 'module' };
        }
      } catch { /* 落到默认值 */ }
    }
  }
  return JSON.stringify(identity, null, 2) + '\n';
}

function applyCopy(authorityDist: string, dstDist: string, rel: string): string | null {
  try {
    fs.mkdirSync(dstDist, { recursive: true });
    fs.copyFileSync(path.join(authorityDist, rel), path.join(dstDist, rel));
    return null;
  } catch (e) { return shortErr(e); }
}

function healPanelVendor(
  authorityDist: string,
  target: CopyTarget,
  apply: boolean,
  expectedPkg: string,
): HealStep {
  const vendor = path.join(target.dir, 'vendor');
  const dstDist = path.join(vendor, 'dist');
  const head = { kind: 'panel-vendor' as const, label: target.label, ops: [] as HealOp[] };
  let want: string[];
  try { want = fs.readdirSync(authorityDist); } catch (e) {
    return { ...head, status: 'skipped', summary: `内核 dist 读不出来（${shortErr(e)}）——跳过` };
  }
  const wantSet = new Set(want);
  const js = want.filter((f) => f.endsWith('.js')).sort();
  const missing: string[] = [];
  const drift: string[] = [];
  for (const f of js) {
    const dst = path.join(dstDist, f);
    if (!isFile(dst)) missing.push(f);
    else if (!sameFile(path.join(authorityDist, f), dst)) drift.push(f);
  }
  const extra: string[] = [];
  if (isDir(dstDist)) {
    let names: string[] = [];
    try { names = fs.readdirSync(dstDist); } catch { names = []; }
    for (const f of names) if (!wantSet.has(f)) extra.push(f);
  }
  extra.sort();
  const pkgFile = path.join(vendor, 'package.json');
  const pkgNeeded = readText(pkgFile) !== expectedPkg;
  const ops: HealOp[] = [
    ...missing.map((f) => ({ action: 'copy' as const, file: `vendor/dist/${f}` })),
    ...drift.map((f) => ({ action: 'overwrite' as const, file: `vendor/dist/${f}` })),
    ...extra.map((f) => ({ action: 'remove' as const, file: `vendor/dist/${f}` })),
    ...(pkgNeeded ? [{ action: 'write' as const, file: 'vendor/package.json' }] : []),
  ];
  if (ops.length === 0) {
    return { ...head, status: 'clean', summary: `与内核 dist 一致（${js.length} 个 .js）` };
  }
  const what = [
    missing.length ? `缺 ${missing.length}` : '',
    drift.length ? `内容不同 ${drift.length}` : '',
    extra.length ? `多余 ${extra.length}` : '',
    pkgNeeded ? '清单不同' : '',
  ].filter(Boolean).join(' · ');
  if (!apply) {
    return { ...head, status: 'planned', summary: `落后：${what}（--fix 将同步；示例：${nameList([...missing, ...drift, ...extra]) || 'package.json'}）`, ops };
  }
  const errors: string[] = [];
  const applied: HealOp[] = [];
  for (const f of missing) {
    const err = applyCopy(authorityDist, dstDist, f);
    if (err) errors.push(`vendor/dist/${f}: ${err}`);
    else applied.push({ action: 'copy', file: `vendor/dist/${f}` });
  }
  for (const f of drift) {
    const err = applyCopy(authorityDist, dstDist, f);
    if (err) errors.push(`vendor/dist/${f}: ${err}`);
    else applied.push({ action: 'overwrite', file: `vendor/dist/${f}` });
  }
  for (const f of extra) {
    try {
      fs.rmSync(path.join(dstDist, f), { force: true, recursive: true });
      applied.push({ action: 'remove', file: `vendor/dist/${f}` });
    } catch (e) { errors.push(`vendor/dist/${f}: ${shortErr(e)}`); }
  }
  if (pkgNeeded) {
    try {
      fs.mkdirSync(vendor, { recursive: true });
      fs.writeFileSync(pkgFile, expectedPkg, 'utf8');
      applied.push({ action: 'write', file: 'vendor/package.json' });
    } catch (e) { errors.push(`vendor/package.json: ${shortErr(e)}`); }
  }
  const countOf = (a: HealOp['action']) => applied.filter((o) => o.action === a).length;
  const doneWhat = [
    countOf('copy') ? `补 ${countOf('copy')}` : '',
    countOf('overwrite') ? `覆盖 ${countOf('overwrite')}` : '',
    countOf('remove') ? `删 ${countOf('remove')}` : '',
    countOf('write') ? `写 package.json` : '',
  ].filter(Boolean).join(' · ') || '无改动';
  if (errors.length > 0) {
    return { ...head, status: 'failed', ops: applied, summary: `${doneWhat}，失败 ${errors.length} 项（${errors[0]}）` };
  }
  return { ...head, status: 'fixed', ops: applied, summary: `已同步：${doneWhat}` };
}

function countsOf(steps: HealStep[]): HealCounts {
  const counts: HealCounts = { clean: 0, planned: 0, fixed: 0, skipped: 0, failed: 0 };
  for (const s of steps) counts[s.status] += 1;
  return counts;
}

function skippedStep(kind: HealKind, label: string, summary: string): HealStep {
  return { kind, label, status: 'skipped', summary, ops: [] };
}

/** 单项包一层：探测本身出错（权限/竞态）也只把这一项标成 failed，绝不把整份 doctor 带崩 */
function safeStep(
  kind: HealKind,
  label: string,
  run: () => HealStep,
): HealStep {
  try { return run(); } catch (e) {
    return { kind, label, status: 'failed', ops: [], summary: `自愈执行异常：${shortErr(e)}` };
  }
}

export function runSelfHeal(opts: SelfHealOptions = {}): SelfHealReport {
  const apply = opts.apply === true;
  const home = opts.home ?? os.homedir();
  const repoRoot = opts.repoRoot ?? findPackageRoot();
  const workspaceRoot = resolveWorkspaceRoot(repoRoot, process.env, opts.workspaceRoot);
  const profiles = opts.profiles ?? listProfiles(home);
  const notes: string[] = [];

  const pluginSource = workspaceRoot && isDir(path.join(workspaceRoot, 'plugins', 'dsh'))
    ? path.join(workspaceRoot, 'plugins', 'dsh')
    : repoRoot && isDir(path.join(repoRoot, 'integrations', 'dsh'))
      ? path.join(repoRoot, 'integrations', 'dsh')
      : null;
  const panelSource = workspaceRoot && isDir(path.join(workspaceRoot, 'integrations', PANEL_NAME))
    ? path.join(workspaceRoot, 'integrations', PANEL_NAME)
    : repoRoot && isDir(path.join(repoRoot, 'integrations', PANEL_NAME))
      ? path.join(repoRoot, 'integrations', PANEL_NAME)
      : null;
  const dist = repoRoot && isDir(path.join(repoRoot, 'dist')) ? path.join(repoRoot, 'dist') : null;
  if (!workspaceRoot) notes.push('没找到外层工作区（plugins/dsh）；只有包内 integrations/dsh 时会退回它');

  const steps: HealStep[] = [];

  // ── ① 插件副本缺文件 ──
  const copies = pluginCopyTargets(home, profiles);
  if (!pluginSource) {
    steps.push(skippedStep('plugin-copy', '插件副本', '找不到插件源（plugins/dsh 或 integrations/dsh）——跳过 ①，不猜路径'));
  } else if (copies.length === 0) {
    steps.push(skippedStep('plugin-copy', '插件副本', `没有已安装的副本（${profiles.length} 个 profile 里都没有 ${PLUGIN_NAME}；未装可忽略）`));
  } else {
    for (const t of copies) steps.push(safeStep('plugin-copy', t.label, () => healPluginCopy(pluginSource, t, apply)));
  }

  // ── ② 面板 vendor 落后 ──
  const vendors = panelVendorTargets(home, profiles, panelSource);
  if (!dist) {
    steps.push(skippedStep('panel-vendor', '面板 vendor', '内核 dist 不存在（先 npm run build）——跳过 ②'));
  } else if (vendors.length === 0) {
    steps.push(skippedStep('panel-vendor', '面板 vendor', `没有已安装的面板副本（${profiles.length} 个 profile 里都没有 ${PANEL_NAME}；未装可忽略）`));
  } else {
    const expectedPkg = vendorPackageJson(repoRoot);
    for (const t of vendors) steps.push(safeStep('panel-vendor', t.label, () => healPanelVendor(dist, t, apply, expectedPkg)));
  }

  return {
    apply,
    steps,
    counts: countsOf(steps),
    sources: { plugin: pluginSource, panel: panelSource, dist },
    notes,
  };
}
