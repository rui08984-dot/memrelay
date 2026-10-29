// auto-register.ts —— 新工作区**自动接入**（守护每轮 sweep 时调用）。
//
// ═══ 为什么需要 ═══
// 采集是按项目做的，而项目必须先 `srelay init` 才进注册表。用户新建一个工作区后
// （DSH 里表现为 `--D-音乐--` 这种会话组），会话一直在写，记忆层却永远看不到 ——
// 直到有人手动 init。实测 2026-10-22：D:\音乐 有 7 个会话、5.2MB，一条没采。
//
// ═══ 判据（全部保守：宁可漏收，不可污染）═══
//   ① 目录真实存在且是目录；不是盘根（D:\ 本身）
//   ② 不是临时目录（复用 shared/registry 的 isTransientRoot —— 判据只许一份）
//   ③ 不与已注册项目互为祖先/后代（避免把项目子目录当项目）
//   ④ 至少 1 个会话目录（真用过才收）
//   ⑤ 单轮最多注册 MAX_NEW_PER_RUN 个（异常目录不会一次灌爆）
// 失败只记日志、绝不抛：自动接入是增强，不能拖垮采集。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isTransientRoot, registryCandidates } from '../shared/registry.js';

const MAX_NEW_PER_RUN = 3;
const INIT_TIMEOUT_MS = 120_000;

/** DSH 默认会话根（与 adapters/dsh 同源；可用 DSH_HOME 覆盖） */
export function defaultDshSessionsDir(): string {
  return path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'sessions');
}

const norm = (p: string): string => path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/**
 * 解析「内核 CLI 在哪」。
 *
 * ⚠️ [1029 修] 原来直接用 `process.argv[1]`：在守护里它确实是 dist/srelay.js，
 *   但在 **tsx / 单元测试 / 被当作库调用** 时它是调用方脚本 —— 于是 init 子进程
 *   会去 `node xxx.ts init`，直接报错。实测表现：候选目录识别到了，created 却是空的。
 *   顺序：env 指定 → argv[1]（必须是存在的 .js）→ 相对本文件 ../../dist/srelay.js。
 */
function resolveCliPath(): string | null {
  const env = String(process.env.SRELAY_CLI_PATH ?? '').trim();
  if (env && fs.existsSync(env)) return env;
  const argv1 = String(process.argv[1] ?? '');
  if (argv1.endsWith('.js') && fs.existsSync(argv1)) return argv1;
  // ⚠️ 必须用 fileURLToPath：new URL().pathname 会把中文目录名做百分号编码，
  //   实测 `D:\dsh插件  记忆\...` 变成 `%E6%8F%92...` ⇒ existsSync 恒 false。
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    for (const rel of [['..', '..'], ['..'], []]) {
      const guess = path.resolve(here, ...rel, 'dist', 'srelay.js');
      if (fs.existsSync(guess)) return guess;
    }
  } catch { /* 拿不到就返回 null，由调用方报错 */ }
  try {
    const cwdGuess = path.resolve(process.cwd(), 'dist', 'srelay.js');
    if (fs.existsSync(cwdGuess)) return cwdGuess;
  } catch { /* 忽略 */ }
  return null;
}
const SEG_RE = /~([0-9A-Fa-f]{4})/g;
const SESSION_DIR_RE = /^(session-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * DSH 会话组目录名 → 项目路径。
 *
 * 形如 `--D-agent1super--`、`--D-~97F3~4E50--`（音乐）、`--E-music~0020player--`（music player）。
 * `~XXXX` 是 UTF-16 码元十六进制（空格转成 ~0020），`-` 是路径分隔符。
 *
 * ⚠️ 目录名本身有歧义（名字里真有 `-` 的目录解码会错），所以调用方**必须再用 existsSync 校验**：
 *   解错了就不存在 ⇒ 跳过。宁可漏收，不收错。
 */
export function decodeDshSlug(slug: string): string | null {
  const m = /^--(.+)--$/s.exec(String(slug ?? ''));
  if (!m) return null;
  const parts = m[1].split('-');
  if (parts.length < 2 || !/^[A-Za-z]$/.test(parts[0])) return null;
  const decode = (s: string): string => s.replace(SEG_RE, (_all, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  const segs = parts.slice(1).map(decode).filter((s) => s.length > 0);
  if (segs.length === 0) return null;
  return parts[0].toUpperCase() + ':\\' + segs.join('\\');
}

export interface RootCandidate { root: string; sessions: number }

/** 扫 DSH 会话组，返回「会话数 ≥ 1」的候选根（未过滤注册状态） */
export function discoverDshRootCandidates(sessionsDir = defaultDshSessionsDir()): RootCandidate[] {
  let groups: string[] = [];
  try { groups = fs.readdirSync(sessionsDir).filter((n) => n.startsWith('--')); } catch { return []; }
  const out = new Map<string, number>();
  for (const g of groups) {
    const root = decodeDshSlug(g);
    if (!root) continue;
    let n = 0;
    try {
      n = fs.readdirSync(path.join(sessionsDir, g), { withFileTypes: true })
        .filter((e) => e.isDirectory() && SESSION_DIR_RE.test(e.name)).length;
    } catch { continue; }
    if (n <= 0) continue;
    const prev = out.get(root) ?? 0;
    out.set(root, prev + n);
  }
  return [...out].map(([root, sessions]) => ({ root, sessions }));
}

export interface AutoRegisterOptions {
  sessionsDir?: string;
  /** 只报告不落盘（测试与手工体检用） */
  dryRun?: boolean;
  maxNew?: number;
  log?: (line: string) => void;
  /** 测试注入：真正执行 init；默认起 CLI 子进程（init 的判据只有一份） */
  init?: (root: string) => void;
  /** 测试注入：临时目录判据；默认用 shared/registry 的那一份（生产口径不变） */
  isTransient?: (root: string) => boolean;
}

export interface AutoRegisterResult {
  candidates: RootCandidate[];
  created: string[];
  skipped: Array<{ root: string; reason: string }>;
}

/**
 * 把「真用过但没注册」的工作区自动 init。守护每轮 sweep 调一次（10 分钟）。
 * 只读扫描 + 最多起 3 个 init 子进程；任何异常都降级为 skipped 理由，不抛。
 */
export function autoRegisterNewProjects(opts: AutoRegisterOptions = {}): AutoRegisterResult {
  const log = opts.log ?? (() => { /* 静默：由调用方决定是否打日志 */ });
  const dryRun = opts.dryRun === true;
  const maxNew = Number.isFinite(opts.maxNew) && (opts.maxNew as number) > 0 ? Number(opts.maxNew) : MAX_NEW_PER_RUN;
  const init = opts.init ?? ((root: string) => {
    const cli = resolveCliPath();
    if (!cli) throw new Error('找不到内核 CLI（dist/srelay.js）—— 无法自动 init');
    execFileSync(process.execPath, [cli, 'init', '--yes', '--backfill', '30d'], {
      cwd: root, stdio: 'pipe', timeout: INIT_TIMEOUT_MS,
    });
  });
  const transient = opts.isTransient ?? isTransientRoot;
  const registered = registryCandidates().map((c) => norm(c.root));
  const all = discoverDshRootCandidates(opts.sessionsDir);
  const candidates: RootCandidate[] = [];
  const skipped: Array<{ root: string; reason: string }> = [];
  for (const c of all.sort((a, b) => b.sessions - a.sessions)) {
    const r = norm(c.root);
    if (!fs.existsSync(c.root) || !fs.statSync(c.root).isDirectory()) { skipped.push({ root: c.root, reason: '目录不存在' }); continue; }
    if (path.parse(c.root).root.toLowerCase() === r + '/') { skipped.push({ root: c.root, reason: '盘根' }); continue; }
    if (transient(c.root)) { skipped.push({ root: c.root, reason: '临时目录' }); continue; }
    const overlap = registered.find((p) => p === r || r.startsWith(p + '/') || p.startsWith(r + '/'));
    if (overlap) { skipped.push({ root: c.root, reason: '已注册或与已注册项目重叠' }); continue; }
    candidates.push(c);
  }
  const todo = candidates.slice(0, maxNew);
  const created: string[] = [];
  for (const c of todo) {
    if (dryRun) { created.push(c.root); continue; }
    try {
      init(c.root);
      created.push(c.root);
      log('自动接入新工作区：' + c.root + '（' + c.sessions + ' 个会话已回填）');
    } catch (e) {
      skipped.push({ root: c.root, reason: 'init 失败：' + (e instanceof Error ? e.message : String(e)).slice(0, 120) });
      log('自动接入失败：' + c.root + '：' + (e instanceof Error ? e.message : String(e)));
    }
  }
  return { candidates, created, skipped };
}
