// 体检分 → 一行文件（供三端简报直接读）。
//
// 为什么要有它：`srelay score` 只能人手敲。而"记忆健康度"应该是**每个会话开场就能看见**的东西，
// 否则它等于体检报告躺在抽屉里（本仓对"模块做完≠进入运行"已经吃过几次亏）。
//
// 判据不在这里：分数、等级、分项全部来自 `core/health/score.ts` 的 computeHealth（唯一实现）。
// 本模块只做两件事：① 把报告压成**一行、稳定文本**（波动大的项不放进来，免得每轮刷新都把
// prompt 前缀缓存作废）；② 写好供适配器读的文件。
//
// 纪律：只读计算 + 写一个附属文件；任何失败返回空串/不写，绝不影响采集或简报主体。
import fs from 'node:fs';
import path from 'node:path';
import { dbFile } from '../../shared/paths.js';
import { loadConfig } from '../../shared/config.js';
import { openReadonly } from '../../store/db.js';
import { computeHealth, type HealthReport } from './score.js';

/** 附属文件名（与 map/brief.txt 同级，适配器只读文件、不做判断）。 */
export const HEALTH_BRIEF_FILE = 'health.txt';

/**
 * 报告 → 一行文本。**只放稳定项**：分数/等级/证据覆盖/新鲜度。
 * 刻意不放：条数类计数（决策总数、P0 计数）——它们会随每次采集变动，进 system prompt 就是缓存杀手。
 */
export function formatHealthLine(r: Pick<HealthReport, 'score' | 'grade' | 'components'>): string {
  const pct = (x: number): string => String(Math.round(Number(x) * 100)) + '%';
  return '🩺 记忆体检 ' + String(r.score) + ' 分 · ' + String(r.grade)
    + ' · 证据覆盖 ' + pct(r.components.evidenceCoverage)
    + ' · 新鲜度 ' + pct(r.components.freshness);
}

/** 算一次并压成一行；任何异常返回空串（调用方据此决定"不写文件"，不写假分数）。 */
export function healthBriefLine(root: string): string {
  try {
    const file = dbFile(root);
    if (!fs.existsSync(file)) return '';
    let projectId = root;
    try { projectId = loadConfig(root).identity?.project_id ?? root; } catch { /* 配置坏了退回 root 口径 */ }
    const db = openReadonly(file);
    try {
      return formatHealthLine(computeHealth(db, projectId));
    } finally { try { db.close(); } catch { /* 关不掉不影响已算出的结果 */ } }
  } catch { return ''; }
}

/** 默认 30 分钟缓存：体检分是"日"级指标，每 30 秒重算一次纯属浪费 CPU。 */
export const HEALTH_BRIEF_TTL_MS = 30 * 60 * 1000;

/**
 * 写 `.sessionrelay/health.txt`（TTL 内不重算）。
 * 失败/无库 ⇒ **删掉旧文件**：留着过期的分数比没有更糟（与 map/brief.txt 同一条纪律）。
 */
export function writeHealthBrief(root: string, opts: { now?: number; ttlMs?: number } = {}): { written: boolean; line: string } {
  const now = opts.now ?? Date.now();
  const ttl = Number.isFinite(opts.ttlMs) ? Number(opts.ttlMs) : HEALTH_BRIEF_TTL_MS;
  const dir = path.join(root, '.sessionrelay');
  const file = path.join(dir, HEALTH_BRIEF_FILE);
  try {
    const st = fs.statSync(file);
    // ttl=0 表示【禁用缓存】（测试/强制重算用）。另外 now - mtime 可能是负数（文件系统时间戳精度），
    // 所以必须先判 ttl>0 —— 否则 ttl=0 时负差恒 < 0，会把【强制重算】变成【永远跳过】。
    if (ttl > 0 && now - st.mtimeMs < ttl) return { written: false, line: fs.readFileSync(file, 'utf8').trim() };
  } catch { /* 没有文件 = 该算 */ }
  const line = healthBriefLine(root);
  try {
    if (!line) { try { fs.unlinkSync(file); } catch { /* 本来就没有 */ } return { written: false, line: '' }; }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, line + '\n', 'utf8');
    return { written: true, line };
  } catch { return { written: false, line: '' }; }
}
