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
import { createRequire } from 'node:module';

// ⚠️ 本文件是 ESM：`require` 在 ESM 里**不存在**。原来直接在函数里写 require('better-sqlite3')，
//   抛出的 ReferenceError 被 catch 吞成「没有候选」—— 看起来像「ZCode 没数据」，
//   实际是代码路径根本没跑。用 createRequire 拿一个真正的 require。
const nodeRequire = createRequire(import.meta.url);
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

/**
 * ZCode 库里的「工作区目录」候选。
 *
 * [1029] 为什么需要：自动接入原来只扫 DSH 的会话分组目录（`~/.dsh/sessions/--D-xxx--`），
 *   于是 **ZCode 用过的新工作区永远不会被自动建库** —— 实测本机就有 2 个真实工作区
 *   （`D:\新建文件夹 (4)` 9 场、`E:\super-agent-party` 8 场）从来没进过记忆层。
 *
 * ZCode 的归属字段是 `session.directory`（会话启动时的 cwd），与 DSH 的会话组等价。
 * 只读打开、只做一次 GROUP BY；库不存在/没有 session 表 ⇒ 返回空（不抛）。
 */
export function discoverZcodeRootCandidates(dbPath?: string): RootCandidate[] {
  const envDb = String(process.env.SRELAY_ZCODE_DB || '').trim();
  const file = dbPath || envDb || path.join(os.homedir(), '.zcode', 'cli', 'db', 'db.sqlite');
  if (!fs.existsSync(file)) return [];
  let db: { prepare: (s: string) => { all: () => unknown[] }; close: () => void } | null = null;
  try {
    // 延迟 require：非 ZCode 用户不该为它付出原生模块加载成本（本文件可能在纯 DSH 环境跑）
    const Database = nodeRequire('better-sqlite3') as new (p: string, o?: Record<string, unknown>) => typeof db;
    db = new Database(file, { readonly: true, fileMustExist: true });
    const rows = db!.prepare('SELECT directory AS d, COUNT(*) AS n FROM session GROUP BY lower(directory)').all() as Array<{ d?: string; n?: number }>;
    const out: RootCandidate[] = [];
    for (const r of rows) {
      const root = String(r.d ?? '').trim();
      if (!root) continue;
      out.push({ root, sessions: Number(r.n ?? 0) });
    }
    return out;
  } catch { return []; }
  finally { try { db?.close(); } catch { /* 已关 */ } }
}
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
  /** ZCode 的会话库（默认 ~/.zcode/cli/db/db.sqlite；也可用 SRELAY_ZCODE_DB） */
  zcodeDb?: string;
  /** 关掉 ZCode 来源（测试用） */
  includeZcode?: boolean;
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
  // [1029] 自动接入的回填窗口默认 **all**（不只 30 天）。
  //   病历：实测 ZCode 那两个工作区（`D:\新建文件夹 (4)` 9 场、`E:\super-agent-party` 8 场）
  //   最近活动停在 8–9 月，而 init 的 30 天窗口正好把它们全挡在外面 ⇒ 库建好了、会话 0 条，
  //   用户看到的就是「接进来了但什么都没有」。
  //   窗口对**单个目录**的会话数是有界的（这里 8–9 场），所以 all 不会失控；
  //   想省时间：SRELAY_AUTO_REGISTER_BACKFILL=30d。
  const backfill = String(process.env.SRELAY_AUTO_REGISTER_BACKFILL || 'all').trim() || 'all';
  const init = opts.init ?? ((root: string) => {
    const cli = resolveCliPath();
    if (!cli) throw new Error('找不到内核 CLI（dist/srelay.js）—— 无法自动 init');
    execFileSync(process.execPath, [cli, 'init', '--yes', '--backfill', '30d'], {
      cwd: root, stdio: 'pipe', timeout: INIT_TIMEOUT_MS,
    });
    // 再把「窗口之外的旧会话」补进来（init 只认 30d/90d/none，sync 才支持 all）
    try {
      execFileSync(process.execPath, [cli, 'sync', '--backfill', backfill], {
        cwd: root, stdio: 'pipe', timeout: INIT_TIMEOUT_MS,
      });
    } catch { /* 回填失败不影响「库已建好」这个结果；下轮采集会继续追新 */ }
  });
  const transient = opts.isTransient ?? isTransientRoot;
  const registered = registryCandidates().map((c) => norm(c.root));
  // [1029] 两个来源合起来看：DSH 会话组 + ZCode 的 session.directory。
  //   同一个目录两边都有时取会话数较大的那条（去重键 = 归一化路径）。
  const merged = new Map<string, RootCandidate>();
  const addAll = (list: RootCandidate[]) => {
    for (const c of list) {
      const k = norm(c.root);
      const prev = merged.get(k);
      if (!prev || c.sessions > prev.sessions) merged.set(k, c);
    }
  };
  addAll(discoverDshRootCandidates(opts.sessionsDir));
  if (opts.includeZcode !== false) addAll(discoverZcodeRootCandidates(opts.zcodeDb));
  const all = [...merged.values()];
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
  // [1029] 两条保守过滤（自动建库是「不可撤销的副作用」，宁可少建）：
  //   ① 候选之间互为父子时只保留父目录（`D:\新建文件夹 (4)` 与它的 `\work\paper` 只建一个）；
  //   ② 全场只有 1 个会话的目录先不建（一次性临时用，等它有第 2 场再自动进来）。
  const MIN_SESSIONS = 2;
  const byLen = [...candidates].sort((a, b) => a.root.length - b.root.length);
  const kept: RootCandidate[] = [];
  for (const c of byLen) {
    const r = norm(c.root);
    if (c.sessions < MIN_SESSIONS) { skipped.push({ root: c.root, reason: '会话太少（' + c.sessions + ' < ' + MIN_SESSIONS + '）' }); continue; }
    if (kept.some((p) => r === norm(p.root) || r.startsWith(norm(p.root) + '/'))) {
      skipped.push({ root: c.root, reason: '被父目录覆盖（' + kept.find((p) => r.startsWith(norm(p.root) + '/'))?.root + '）' });
      continue;
    }
    kept.push(c);
  }
  const todo = kept.slice(0, maxNew);
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
