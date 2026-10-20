// srelay feedback —— 检索反馈的**采集状态 + 统计**（任务 D 第一步的可见面）。
//
// 为什么必须有这条命令：采集是旁路，坏了不会有人喊。1020 实测就撞到过一次：
//   search_feedback 表**根本不存在**（候选只留进程内存，而真实调用链是两个进程），
//   但所有上层命令都"看起来正常"。所以「0 条数据」必须能被一眼看见、并分清原因：
//   从没检索过 / 检索过但快照过期了 / 快照坏了 / 项目 id 对不上。
//
// 只读纪律：不建表之外不写一个字节（ensureFeedbackTable 由 openGlobal 的调用方给，
// 这里走 feedbackStats 自己的建表路径）；**不** ensureDaemon；退出码 0/2。
//
// 退出码：0 = 读到了（0 条也是读到了）；2 = 全局库打不开 / 无项目根。
import path from 'node:path';
import { findRelayRoot } from '../shared/paths.js';
import { loadConfig } from '../shared/config.js';
import {
  MIN_OPENS_FOR_CALIBRATION,
  feedbackStats,
  lastSearchStatus,
  type FeedbackStats,
  type LastSearchStatus,
} from '../search-svc/feedback.js';
import { globalDbFile } from '../store/global.js';
import { fmtDate, pc } from './ui.js';

export interface FeedbackFlags {
  json?: boolean;
  root?: string;
  days?: number | string;
  project?: string;
  top?: number | string;
}

/** 秒数转人话（诊断里只用到粗粒度，不引第三方库）。 */
function humanAge(ms: number): string {
  if (ms < 1000) return '刚发生';
  const s = Math.round(ms / 1000);
  if (s < 60) return s + ' 秒前';
  const m = Math.round(s / 60);
  if (m < 60) return m + ' 分钟前';
  const h = Math.round(m / 60);
  if (h < 24) return h + ' 小时前';
  return Math.round(h / 24) + ' 天前';
}

function snapshotLine(s: LastSearchStatus): string {
  if (!s.exists) return pc.yellow('还没有') + pc.dim('（这个项目还没检索过，或快照已被清理）');
  if (s.note === 'expired') return pc.yellow('已过期') + pc.dim('（' + humanAge(s.ageMs ?? 0) + '检索的，超过 5 分钟就不算命中）');
  if (s.note === 'corrupt') return pc.red('坏了') + pc.dim('（' + (s.error ?? '字段/版本不认识') + '）');
  if (s.note === 'other_project') return pc.red('项目对不上') + pc.dim('（同槽位文件不是这个项目的，不借用）');
  return pc.green('新鲜') + pc.dim('（' + humanAge(s.ageMs ?? 0) + '检索 · ' + s.candidates + ' 条候选）');
}

/** 0 条时逐条排查（不猜、不说"可能"）：每行都对应一个可执行动作。 */
function emptyDiagnosis(root: string, s: LastSearchStatus): string[] {
  const out: string[] = [];
  out.push(pc.dim('  · 采集链路：检索（search）写候选快照 → 打开（show）读快照并记一条 open；两步必须同一项目。'));
  out.push(pc.dim('  · 现在没有事件，按这三条查：'));
  out.push(pc.dim('    ① 先检索一次：srelay search <关键词>  —— 快照会立刻写到 ' + s.file));
  out.push(pc.dim('    ② 5 分钟内打开其中一条：srelay show <会话前缀>  —— 超时不算命中（这是判据，不是 bug）'));
  out.push(pc.dim('    ③ 两边项目 id 必须一致：srelay status 看 project_id；跨项目不借候选。'));
  if (root) out.push(pc.dim('    当前项目根：' + root));
  return out;
}

export async function cmdFeedback(f: FeedbackFlags = {}): Promise<void> {
  const root = f.root ? path.resolve(String(f.root)) : findRelayRoot(process.cwd());
  let projectId = root ?? process.cwd();
  if (root) {
    try { projectId = loadConfig(root).identity?.project_id ?? root; }
    catch { /* 配置坏了不阻塞：直接用 root，统计仍可按项目过滤 */ }
  }
  if (f.project) projectId = String(f.project);

  const daysRaw = f.days !== undefined && f.days !== null ? Number(f.days) : NaN;
  const topRaw = f.top !== undefined && f.top !== null ? Number(f.top) : NaN;

  let stats: FeedbackStats;
  try {
    stats = feedbackStats({
      project: projectId || undefined,
      ...(Number.isFinite(daysRaw) && daysRaw > 0 ? { sinceDays: daysRaw } : {}),
      ...(Number.isFinite(topRaw) && topRaw > 0 ? { topN: topRaw } : {}),
    });
  } catch (e) {
    const msg = '全局库打不开：' + (e instanceof Error ? e.message : String(e))
      + '（' + globalDbFile() + '）';
    if (f.json) console.log(JSON.stringify({ error: msg, exitCode: 2 }, null, 2));
    else console.error(pc.red('✗ ') + msg + '\n' + pc.dim('  反馈是旁路数据：它坏了不影响检索与简报；确认磁盘可写后用 srelay doctor 复查'));
    process.exitCode = 2;
    return;
  }

  const snap = lastSearchStatus(projectId);
  if (f.json) {
    console.log(JSON.stringify({ projectId, root, snapshot: snap, stats, minOpens: MIN_OPENS_FOR_CALIBRATION }, null, 2));
    return;
  }

  console.log(pc.bold('反馈采集') + pc.dim(' · 项目 ' + (projectId || '(未识别)')));
  console.log('  候选快照：' + snapshotLine(snap));
  console.log('  事件：' + (stats.total === 0
    ? pc.yellow('0 条')
    : pc.bold(String(stats.total)) + ' 次 open · ' + stats.searches + ' 次检索 · ' + stats.sessions + ' 个会话'
      + ' · 平均名次 ' + (stats.avgPosition === null ? '—' : String(stats.avgPosition))));

  if (stats.total === 0) {
    for (const line of emptyDiagnosis(root ?? '', snap)) console.log(line);
    return;
  }

  if (stats.positions.length) {
    console.log('  名次分布：' + stats.positions.map((p) => '#' + p.position + ' ' + p.opens).join(' · '));
  }
  if (stats.buckets.length) {
    console.log('  查询长度：' + stats.buckets.map((b) => b.bucket + ' ' + b.opens + (b.avgPosition === null ? '' : '（均 ' + b.avgPosition + '）')).join(' · '));
  }
  if (stats.kinds.length) {
    console.log('  入口：' + stats.kinds.map((k) => k.kind + ' ' + k.opens).join(' · '));
  }
  if (stats.firstAt && stats.lastAt) {
    // 库里存的是 UTC ISO；给人看必须是**本地时间**（否则用户看到 07:05 而墙上是 15:05）
    console.log('  时间：' + fmtDate(stats.firstAt) + ' → ' + fmtDate(stats.lastAt));
  }
  if (stats.topSessions.length) {
    console.log('  常被打开：' + stats.topSessions.map((s) => s.sessionId + '×' + s.opens + '（最好 #' + s.bestPosition + '）').join(' · '));
  }

  // 样本够不够 —— 只说事实与下一步，不替用户改权重
  if (stats.total < MIN_OPENS_FOR_CALIBRATION) {
    console.log(pc.yellow('  ⏳ 样本不足：') + stats.total + ' / ' + MIN_OPENS_FOR_CALIBRATION
      + pc.dim(' —— 攒够之前不调权重（几个样本的手感不是证据）'));
  } else {
    console.log(pc.green('  ✅ 样本已够：') + pc.dim('可以跑 npx tsx scripts/calibrate-weights.ts（它只给建议，不自动改配置）'));
  }
}
