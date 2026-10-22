// handoff.ts —— 一键交接包：把简报、决策、未决、下一步、经验拼成一份可转发的文档。
//
// 为什么单独一个命令：brief 是给人扫的短视图，而「交接给下一个会话/同事」需要固定五段、
// 带出处、可落盘。判据全部复用（collectBrief / collectNextStep / audit），本文件只做排版。
//
// 五段（顺序固定，缺段不写空标题）：① 现在到哪了 ② 定过什么 ③ 还欠什么 ④ 下一步 ⑤ 坑（经验）
// 只读：不写库；--out 才写文件。
import fs from 'node:fs';
import { loadConfig } from '../shared/config.js';
import { requireRoot, openRelayDb } from './ui.js';
import { collectBrief, type BriefPayload } from './brief.js';
import type { DB } from '../store/db.js';

export interface HandoffInput {
  project: string;
  pay: BriefPayload;
  now?: Date;
}

const dateOf = (iso: string | null | undefined): string => (iso ? iso.slice(0, 10) : '');

/** 渲染交接包（纯函数：输入 payload、输出 markdown；测试直接钉文本）。 */
export function renderHandoff(inp: HandoffInput): string {
  const { project, pay } = inp;
  const at = (inp.now ?? new Date()).toISOString().replace('T', ' ').slice(0, 16);
  const L: string[] = [];
  L.push('# 交接包 · ' + project);
  L.push('');
  L.push('> 生成于 ' + at + ' · 由 srelay handoff 生成 · 只读');
  if (pay.auditAlert) L.push('> ' + pay.auditAlert);
  L.push('');

  L.push('## ① 现在到哪了');
  const doing = pay.nextStep?.doing ?? [];
  L.push('- 最近 7 天在动：' + (pay.recentFiles.length ? pay.recentFiles.map((r) => r.file + '（' + r.sessions + ' 场）').join('、') : '无记录'));
  L.push('- 进行中：' + (doing.length ? doing.join(' / ') : '地图未标注'));
  if (pay.relatedSessions.length > 0) {
    L.push('- 同一主题的多条会话：' + pay.relatedSessions.slice(0, 3).map((g) => (g.members[0]?.title ?? g.lead)).join('；'));
  }
  L.push('');

  L.push('## ② 定过什么');
  if (pay.decisions.length === 0) L.push('- （无）');
  for (const d of pay.decisions.slice(0, 10)) {
    const mark = d.kind === 'negative' ? '✗ 被否' : '✓';
    const prov = d.msgId ? ' · msgId=' + d.msgId : (d.seq ? ' · seq=' + d.seq : '');
    L.push('- ' + mark + ' ' + dateOf(d.at) + ' ' + d.text + '（' + d.sessionId + prov + '）');
  }
  L.push('');

  L.push('## ③ 还欠什么');
  if (pay.unresolved.length === 0) L.push('- （无未决）');
  for (const u of pay.unresolved.slice(0, 10)) {
    L.push('- ◻ ' + dateOf(u.at) + ' ' + u.q + '（' + u.sessionId + (u.msgId ? ' · msgId=' + u.msgId : '') + '）');
  }
  if (pay.counts.fragmentsHidden > 0) L.push('- （简报已隐藏 ' + pay.counts.fragmentsHidden + ' 条疑似碎片，库内仍在）');
  if (pay.counts.archivedUnresolvedHidden > 0) L.push('- （已隐藏 ' + pay.counts.archivedUnresolvedHidden + ' 条归档会话的未决：正文已删、出处无法回跳）');
  L.push('');

  L.push('## ④ 下一步');
  L.push(pay.nextStep?.next ? '- ' + pay.nextStep.next : '- （地图未写 context.next）');
  if (doing.length) L.push('- 进行中节点：' + doing.join(' / '));
  L.push('');

  L.push('## ⑤ 坑（已验证经验）');
  if (pay.experiences.length === 0) L.push('- （无）');
  for (const e of pay.experiences.slice(0, 10)) L.push('- ' + e.text);
  L.push('');

  L.push('---');
  L.push('出处回查：srelay show <sessionId>；检索：srelay search "<关键词>"；审计：srelay audit。');
  return L.join('\n');
}

export interface HandoffBuilt {
  project: string;
  payload: BriefPayload;
  /** 五段交接包 markdown（渲染只走 renderHandoff，别处不许另写格式） */
  markdown: string;
}

/**
 * 交接包的**唯一取数 + 渲染路径**（CLI 与 MCP 共用）。
 * 只读：collectBrief 只查库；不写库、不写文件（落盘是 cmdHandoff --out 的事）。
 */
export function buildHandoff(opts: { db: DB; project: string; root: string; now?: Date }): HandoffBuilt {
  const payload = collectBrief(opts.db, opts.project, {}, opts.root);
  const markdown = renderHandoff({ project: opts.project, pay: payload, now: opts.now });
  return { project: opts.project, payload, markdown };
}

export async function cmdHandoff(opts: { out?: string; json?: boolean; root?: string }): Promise<void> {
  // [1022 修「在 DSH 里点交接包却报未初始化」] 命令面板/工具调用拿不到会话 cwd 时，
  //   进程 cwd 会落到 DSH 安装目录 ⇒ requireRoot 找不到 .sessionrelay。
  //   现在支持显式 --root（由调用方传当前工作区），并在目录不对时说清楚该传什么。
  let root: string;
  if (opts.root && String(opts.root).trim()) {
    const want = String(opts.root).trim();
    if (!fs.existsSync(want)) {
      console.error('✗ 交接包目标目录不存在：' + want);
      process.exitCode = 2;
      return;
    }
    root = want;
    if (!fs.existsSync(root + '/.sessionrelay/config.json') && !fs.existsSync(root + '/.sessionrelay/relay.sqlite')) {
      console.error('✗ 这个目录还没初始化记忆库：' + root + '（在该项目根运行 srelay init）');
      process.exitCode = 2;
      return;
    }
  } else {
    root = requireRoot();
  }
  const cfg = loadConfig(root);
  const db = openRelayDb(root);
  try {
    const project = cfg.identity.project_id ?? root;
    const built = buildHandoff({ db, project, root });
    if (opts.json) { console.log(JSON.stringify({ project, payload: built.payload }, null, 2)); return; }
    const md = built.markdown;
    if (opts.out) {
      fs.writeFileSync(String(opts.out), md + '\n', 'utf8');
      console.log('✅ 交接包已写入 ' + String(opts.out) + '（五段 · 带出处 · ' + md.length + ' 字节）');
      return;
    }
    console.log(md);
  } finally { db.close(); }
}
