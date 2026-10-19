// srelay score —— 记忆体检分（task-H）：一行分数 + 四个分项；--json 给完整结构。
//
// 与 audit 的分工：audit 逐项列债（P0/P1、样例、退出码），score 只回答"整体几分、什么等级"。
// 判据完全复用 core/health/score.ts（它又复用 audit / listDecisions / vagueDecisionObject），
// 本文件只做排版与入口，**不重算任何一项**——否则屏幕上会出现第二个分数。
//
// 只读纪律（与 audit 同规）：
//   · openReadonly 打开项目库：不建表、不迁移、不写一个字节；
//   · **不** ensureDaemon：体检不该为了看一眼数据就顺手拉起一个写进程；
//   · 全局经验库完全不碰（体检分只用项目库的四条判据）。
//
// 退出码：
//   0 = 算出来了（分数高低只体现在 grade，不劫持退出码——0/1/2 这套语义属于 audit，
//       两个命令抢同一组退出码，脚本里就分不清是"体检低分"还是"审计有 P0"）
//   2 = 没项目根 / 项目库不存在 / 库打不开（"没测到"不许伪装成 0 分）

import path from 'node:path';
import { existsSync } from 'node:fs';
import { findRelayRoot, dbFile } from '../shared/paths.js';
import { loadConfig } from '../shared/config.js';
import { openReadonly, type DB } from '../store/db.js';
import { computeHealth, HEALTH_WEIGHTS, FRESHNESS_WINDOW_DAYS, type HealthReport } from '../core/health/score.js';
import { pc } from './ui.js';

export interface ScoreFlags {
  json?: boolean;
  /** 显式项目根（默认向上探测；与 audit 同规，不走 requireRoot 以免懒启动守护） */
  root?: string;
  /** 新鲜度窗口天数（默认 30） */
  days?: number | string;
}

function pct(x: number): string {
  return String(Math.round(x * 100)) + '%';
}

export async function cmdScore(f: ScoreFlags = {}): Promise<void> {
  const root = f.root ? path.resolve(String(f.root)) : findRelayRoot(process.cwd());
  if (!root) {
    const msg = '未找到 .sessionrelay（本项目尚未初始化） —— 体检分需要项目库';
    if (f.json) console.log(JSON.stringify({ error: msg, exitCode: 2 }, null, 2));
    else console.error(pc.red('✗ ') + msg + '\n' + pc.dim('  下一步：在项目根运行 srelay init'));
    process.exitCode = 2;
    return;
  }
  const file = dbFile(root);
  if (!existsSync(file)) {
    const msg = '项目库不存在：' + file;
    if (f.json) console.log(JSON.stringify({ error: msg, exitCode: 2 }, null, 2));
    else console.error(pc.red('✗ ') + msg + '\n' + pc.dim('  下一步：srelay sync（或 srelay init）先建库'));
    process.exitCode = 2;
    return;
  }

  // 与 audit 同一条注意：project_id 必须走 config 优先，否则 pid 退回 root，
  // 而库里存的是 config 的 project_id ⇒ 所有项都"无数据"，算出 60 分假装正常。
  let projectId = root;
  try { projectId = loadConfig(root).identity?.project_id ?? root; }
  catch { /* 配置坏了不阻塞：退回 root，四项自然无数据并写进 notes；config 的毛病归 doctor 管 */ }

  const daysRaw = f.days !== undefined && f.days !== null ? Number(f.days) : NaN;
  const opts = Number.isFinite(daysRaw) && daysRaw > 0
    ? { freshnessDays: daysRaw }
    : { freshnessDays: FRESHNESS_WINDOW_DAYS };

  let db: DB;
  try {
    db = openReadonly(file);
  } catch (e) {
    // 库坏了/被独占：如实说"打不开"，不输出一个凭空的分数（"没测到"不许伪装成 0 分或 60 分）
    const msg = '项目库打不开：' + (e instanceof Error ? e.message : String(e));
    if (f.json) console.log(JSON.stringify({ error: msg, exitCode: 2 }, null, 2));
    else console.error(pc.red('✗ ') + msg + '\n' + pc.dim('  下一步：srelay doctor（检查库与锁）'));
    process.exitCode = 2;
    return;
  }
  try {
    let report: HealthReport;
    try {
      report = computeHealth(db, projectId, opts);
    } catch (e) {
      // 极端情况（库能打开但读不了）：如实报"没测到"，不输出一个凭空的分数
      const msg = '体检失败：' + (e instanceof Error ? e.message : String(e));
      if (f.json) console.log(JSON.stringify({ error: msg, exitCode: 2 }, null, 2));
      else console.error(pc.red('✗ ') + msg);
      process.exitCode = 2;
      return;
    }

    if (f.json) {
      console.log(JSON.stringify({ projectId, root, weights: HEALTH_WEIGHTS, ...report }, null, 2));
      return;
    }

    const gradeColor = report.grade === 'A' || report.grade === 'B' ? pc.green : report.grade === 'C' ? pc.yellow : pc.red;
    const p0Text = report.components.auditP0 === 1
      ? '无命中'
      : report.components.auditP0 === 0 ? pc.red('有命中') : pc.yellow('未测');
    // 一行分数 + 四个分项（方向：证据覆盖/新鲜度越高越好；碎片率越低越好；P0 看有无）
    console.log('记忆体检 ' + pc.bold(String(report.score)) + ' 分 · ' + gradeColor(report.grade)
      + ' ｜ 证据覆盖 ' + pct(report.components.evidenceCoverage)
      + ' · 新鲜度 ' + pct(report.components.freshness)
      + ' · 碎片率 ' + pct(report.components.fragmentRate)
      + ' · 审计 P0 ' + p0Text);
    // 分项口径与"无数据/未测"的解释都在 notes 里：一行之外的补充，不是第二个结论
    for (const n of report.notes) console.log(pc.dim('  · ' + n));
  } finally {
    try { db.close(); } catch { /* 关不上不影响已算出的结果 */ }
  }
}
