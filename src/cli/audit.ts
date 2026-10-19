// srelay audit —— 审计契约（task-11）：六项只读检查，P0/P1 分级，条数 + 前 5 条样例 id。
//
// 与 doctor 的分工：doctor 查**环境**（Node/jieba/源目录/守护服务），audit 查**库里内容契约**。
// 两者都是只读命令，但 doctor 会 ensureDaemon（懒启动守护），audit **绝不**——审计不该为了看
// 一眼数据就顺手拉起一个写进程（那样"只读"就只是嘴上说说）。
//
// ═══ 退出码（唯一实现见 core/audit/audit.ts 的 exitCodeOf）═══
//   0 = 六项全过
//   1 = 只有 P1 命中（质量债，可修）
//   2 = 有 P0 命中，或**审计根本跑不起来**（没初始化 / 库打不开）
// 把"跑不起来"也算 2：脚本里 `srelay audit || 处理` 必须能被"没测到"触发，
// 否则最危险的情况（什么都没查）反而给出 0（本仓最嫌恶的静默失效）。
//
// ═══ 只读纪律 ═══
// 两个库都用 openReadonly 打开（readonly + fileMustExist + busy_timeout 2000）：
// 不建表、不迁移、不写一个字节。全局经验库被守护占着写时，本项降级为 skipped 并说清原因，
// **不**当成"没有超期草稿"（0 条与"没测到"是两件事）。

import path from 'node:path';
import { findRelayRoot } from '../shared/paths.js';
import { openReadonly } from '../store/db.js';
import { loadConfig } from '../shared/config.js';
import { resolveDomain, resolveWorkspaceId } from '../shared/workspace.js';
import { runAudit, auditDbPaths, openGlobalAuditReadonly, type AuditFinding, type AuditReport } from '../core/audit/audit.js';
import { pc } from './ui.js';

export interface AuditFlags {
  json?: boolean;
  /** 显式项目根（默认向上探测；与 doctor 同规，不走 requireRoot 以免懒启动守护） */
  root?: string;
}

/** 只读打开全局经验库的实现在 core/audit/audit.ts（CLI / 生命周期 / 简报共用一份） */
const openGlobalReadonly = openGlobalAuditReadonly;

function mark(f: AuditFinding): string {
  if (f.status === 'skipped') return pc.dim('○ 跳过');
  if (f.status === 'ok') return pc.green('✓ 通过');
  return f.severity === 'P0' ? pc.red('✗ P0') : pc.yellow('● P1');
}

function printHuman(r: AuditReport): void {
  console.log('审计契约 · ' + (r.root ? r.root.replace(/\\/g, '/').split('/').pop() : '(无项目根)') + '   ' + r.generatedAt);
  console.log('─'.repeat(72));
  for (const f of r.checks) {
    console.log(mark(f) + '  ' + f.id + (f.count > 0 ? '  ' + String(f.count) + ' 条' : ''));
    if (f.status !== 'ok') console.log('    ' + pc.dim('判据：' + f.criteria));
    if (f.samples.length > 0) {
      console.log('    样例：' + f.samples.join(' · '));
      if (f.count > f.samples.length) console.log(pc.dim('    （只列前 ' + String(f.samples.length) + ' 条，共 ' + String(f.count) + ' 条）'));
    }
    if (f.note) console.log('    ' + pc.dim(f.note));
  }
  console.log('─'.repeat(72));
  console.log('P0 命中 ' + String(r.totals.p0) + ' 项 · P1 命中 ' + String(r.totals.p1) + ' 项 · 跳过 ' + String(r.totals.skipped) + ' 项');
  if (r.exitCode === 0) console.log(pc.green('结论：六项全过（跳过项见上，未被当成 0 条）'));
  else if (r.exitCode === 1) console.log(pc.yellow('结论：只有 P1 质量债 —— 可修，不必停工'));
  else console.log(pc.red('结论：有 P0 —— 不可逆的数据缺失 / 检索静默损坏，先处理再谈别的'));
  // 修法只在失败时给，避免每次审计都刷一屏没人看的建议
  if (r.exitCode !== 0) {
    console.log(pc.dim('  下一步：缺 msgId → srelay recompute --apply（只覆盖有正文的会话）· 碎片 → 同上'
      + ' · 草稿 → srelay lesson confirm <id> · 地图 → srelay map apply 补 sources'));
  }
}

export async function cmdAudit(f: AuditFlags = {}): Promise<void> {
  const root = f.root ? path.resolve(f.root) : findRelayRoot(process.cwd());
  if (!root) {
    const msg = '未找到 .sessionrelay（本项目尚未初始化） —— 审计需要项目库';
    if (f.json) console.log(JSON.stringify({ error: msg, exitCode: 2 }, null, 2));
    else console.error(pc.red('✗ ') + msg + '\n' + pc.dim('  下一步：在项目根运行 srelay init'));
    process.exitCode = 2;
    return;
  }
  const paths = auditDbPaths(root);
  if (!paths.projectExists) {
    const msg = '项目库不存在：' + paths.project;
    if (f.json) console.log(JSON.stringify({ error: msg, exitCode: 2 }, null, 2));
    else console.error(pc.red('✗ ') + msg + '\n' + pc.dim('  下一步：srelay sync（或 srelay init）先建库'));
    process.exitCode = 2;
    return;
  }

  // loadConfig 只用来取 project_id：**不要**在审计里漏掉它，否则 pid 退回 root，
  // 而库里存的是 config 的 project_id ⇒ 所有检查都报 0 条（假绿，最坏的一种）。
  let projectId = root;
  try { const cfg = loadConfig(root); projectId = cfg.identity?.project_id ?? root; }
  catch { /* 配置坏了不阻塞审计：退回 root 作 pid，各项自然报 0；config 的毛病归 doctor 管 */ }

  const db = openReadonly(paths.project);
  const g = openGlobalReadonly();
  let report: AuditReport;
  try {
    // 经验可见范围与 lesson list 同源（workspace = 项目根，不是 cwd；见 shared/workspace.ts 的病历）
    const lessonSel = { workspaceId: resolveWorkspaceId(root), domain: resolveDomain(root) };
    report = runAudit({ db, projectId, global: g.db, root, lessonSel });
    // 全局库打不开 → 本项必须是 skipped 而不是"0 条"：把具体原因补进去
    // （runAudit 只看到 null，说不出"不存在"还是"被占用"）
    if (g.db === null) {
      report.checks = report.checks.map((c) => (c.id === 'lesson-draft-stale' && c.status === 'skipped'
        ? { ...c, note: g.reason ?? c.note } : c));
    }
  } finally {
    try { db.close(); } catch { /* 关不上不影响结果 */ }
    try { g.db?.close(); } catch { /* 同上 */ }
  }

  if (f.json) console.log(JSON.stringify(report, null, 2));
  else printHuman(report);
  process.exitCode = report.exitCode;
}
