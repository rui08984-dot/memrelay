// srelay search / show / list（方针 §8.2；出处块强制 D10；B 档 scope 契约对 CLI 同样生效）
import { loadConfig, type CaptureMode } from '../shared/config.js';
import { assembleScope } from '../core/scope/assemble.js';
import { searchSessions, DEFAULT_TITLE_BOOST, type SearchExplain } from '../search-svc/engine.js';
import { groupSessions } from '../search-svc/session-groups.js';
// [10-19 任务 D] 检索自校准第一步：只采集 open 事件，不改检索结果/排序。
import { rememberSearch, recordSearchOpen } from '../search-svc/feedback.js';
import { diagnoseEmpty } from '../search-svc/why-empty.js';
import { findSessionByPrefix, getSession, listSessions, getMessageRange, isNoteSession } from '../store/db.js';
import { openStats } from '../core/stats/counter.js';
import { requireRoot, openRelayDb, pc, fmtDate, stateBadge } from './ui.js';

export interface SearchFlags {
  topic?: string; tag?: string; file?: string; source?: string; since?: string; until?: string;
  limit?: number; json?: boolean;
  /** [1021 namespace] 跨项目联邦检索（只读扇出 + 名次轮转合并）。默认 false = 只查本项目 */
  global?: boolean;
  /** [10-19 · 任务 B] 打印每条命中的分数构成（engine 的 explain 字段；默认关 = 零开销） */
  explain?: boolean;
}

/**
 * [10-19 · 任务 B] 把 engine 的 explain 渲染成一行可读的乘法链。
 *
 * 显示只做四舍五入，不改任何数值；titleWeight 与 searchSessions 的默认值同源
 * （CLI 不传 titleBoost，所以 DEFAULT_TITLE_BOOST 就是实际生效的那个权重）。
 */
function formatExplain(e: SearchExplain, titleWeight: number = DEFAULT_TITLE_BOOST): string {
  const w = Number.isFinite(titleWeight) && titleWeight > 0 ? titleWeight : 0;
  const titleMul = 1 + w * e.titleOverlap;
  return [
    `base ${e.baseScore.toFixed(3)}`,
    `覆盖 ×${e.coverageBoost.toFixed(2)}（${Math.round(e.coverage * 100)}%）`,
    `长度 ×${e.lengthPenalty.toFixed(2)}`,
    `时间 ×${e.recency.toFixed(2)}`,
    `标题 ×${titleMul.toFixed(2)}（${Math.round(e.titleOverlap * 100)}%）`,
    `⇒ ${e.finalScore.toFixed(3)}`,
  ].join(' · ');
}

/**
 * 跨项目联邦检索（namespace 两态里的 global 态）。
 *
 * 与默认路径的区别只有一处：命中的出处可能来自**别的项目**，所以每条都带项目名。
 * 不合并分数（不同库 BM25 不可比），合并的是**名次**（见 search-svc/namespace.ts）。
 * 全局模式不写任何库、不做自动 scope、不吃时间衰减 —— 它只是"看看别处有没有"的入口。
 */
async function cmdSearchGlobal(query: string, flags: SearchFlags): Promise<void> {
  const { searchNamespaced } = await import('../search-svc/namespace.js');
  const res = searchNamespaced({ mode: 'global', query, limit: flags.limit ?? 10, maxProjects: 20 });
  if (flags.json) {
    console.log(JSON.stringify({ mode: res.mode, scanned: res.scanned, failed: res.failed, hits: res.hits }, null, 2));
    return;
  }
  if (!res.hits.length) {
    // 容错不许静默：扫了几个库、哪个库失败，都要说出来
    console.log('没有命中（扫描 ' + res.scanned + ' 个项目库' + (res.failed.length ? '，其中 ' + res.failed.length + ' 个打不开' : '') + '）');
    for (const f of res.failed) console.log('  ⚠ 跳过 ' + f.projectRoot + '：' + f.reason);
    return;
  }
  console.log('跨项目检索「' + query + '」：扫描 ' + res.scanned + ' 个项目库，命中 ' + res.hits.length + ' 条');
  for (const h of res.hits) {
    console.log('  [' + h.projectName + '] ' + h.sessionId.slice(0, 12) + '  ' + String(h.snippet || '').replace(/\s+/g, ' ').slice(0, 70));
  }
  if (res.failed.length) {
    console.log('  ⚠ ' + res.failed.length + ' 个库打不开（已跳过）：');
    for (const f of res.failed) console.log('     ' + f.projectRoot + '：' + f.reason);
  }
}

export async function cmdSearch(query: string, flags: SearchFlags): Promise<void> {
  // 全局态走独立分支：不打开本库、不吃本项目 scope/decay（跨项目时这些没有意义）
  if (flags.global) {
    // 容错不许静默：global 合并的是名次、不是分数（不同库 BM25 不可比），--explain 在这里没有定义
    if (flags.explain) console.error(pc.dim('提示：--global 跨库检索按名次合并，不提供 --explain 分数构成。'));
    return cmdSearchGlobal(query, flags);
  }
  // 注：空查询/非法 limit 的校验在下面统一做（global 分支自己也会走到各自的校验）
  // [10-19] 参数校验前置：空查询 / 非法 limit 原来会一路走到「未找到」，
  //   把「你参数给错了」伪装成「库里没有」——这是本项目最贵的一种失败（静默失败）。
  const q = String(query ?? '').trim();
  if (q === '') {
    console.error(pc.red('✗ 检索词不能为空') + pc.dim('（例如：srelay search 交接 文档）'));
    process.exitCode = 2;
    return;
  }
  if (flags.limit !== undefined && (!Number.isFinite(Number(flags.limit)) || Number(flags.limit) <= 0)) {
    console.error(pc.red('✗ --limit 必须是正整数') + pc.dim('（收到：' + String(flags.limit) + '）'));
    process.exitCode = 2;
    return;
  }
  const root = requireRoot();
  const cfg = loadConfig(root);
  const db = openRelayDb(root);
  const stats = openStats(root);
  stats.increment('cli_search');
  try {
    const pred = {
      topics: flags.topic ? [flags.topic] : undefined,
      tags: flags.tag ? [flags.tag] : undefined,
      files: flags.file ? [flags.file] : undefined,
      sources: flags.source ? [flags.source] : undefined,
      since: flags.since,
      until: flags.until,
    };
    // B 档 scope 契约对 CLI 生效（交集只能收窄；CLI 不吃 A 档 auto-scope——人自己管时间窗）
    const asm = assembleScope({ root, cfg, callPred: pred, includeAuto: false });
    // 语义补充命中（未启用 → null → 与纯 FTS 行为等价）
    const { semanticSearch } = await import('../search-svc/semantic.js');
    const semHits = await semanticSearch(db, cfg, query, { project: cfg.identity.project_id ?? root, extraWhere: asm.where });
    const hits = searchSessions(db, {
      project: cfg.identity.project_id ?? root,
      query,
      limit: flags.limit ?? 10,
      extraWhere: asm.where,
      semanticHits: semHits,
      semanticReserve: cfg.semantic?.reserve_slots,
      // [1021] 时间衰减（cfg.decay.enabled 默认 false ⇒ 不传等于旧行为，单一变量）
      decay: cfg.decay,
      // [10-19 · 任务 B] 默认 false：不填 explain、不额外查询；--explain 时才生成明细
      explain: flags.explain === true,
    });
    // [10-19 任务 D / 1020 修正] 记住本次候选（**落盘快照**，TTL 5 分钟）：随后的 srelay show 据此记 open。
    //   只写快照、不改 hits。CLI 的 search 与 show 是**两个进程**，所以候选必须落盘
    //   （原实现只留内存 ⇒ CLI 这条路一次都没记上）。判据仍只有 feedback.ts 那一份。
    //   写失败不阻塞检索：rememberSearch 返回 persisted:false，用 srelay feedback 看状态。
    rememberSearch(cfg.identity.project_id ?? root, query, hits.map((h) => h.sessionId));
    if (flags.json) {
      const rows = hits.map((h) => {
        const s = getSession(db, h.sessionId);
        return {
          sessionId: h.sessionId, title: s?.title ?? null, source: s?.source ?? null,
          createdAt: s?.created_at ?? null, state: s?.state ?? null,
          score: Number(h.score.toFixed(3)), coverage: h.coverage, viaMeta: h.viaMeta,
          viaSemantic: h.viaSemantic ?? false,
          // [10-19 · 任务 B] --explain 时带出完整打分明细（字段名与 engine 的 SearchExplain 一致）
          ...(h.explain ? { explain: h.explain } : {}),
          snippet: h.snippet, provenance: { sessionId: h.sessionId },
        };
      });
      // [10-19] 多会话组：与 MCP 的 groups 同源（groupSessions 唯一实现），便于 DSH/CLI 对齐
      const groups = groupSessions(db, hits.map((h) => ({ sessionId: h.sessionId, score: h.score })));
      console.log(JSON.stringify({ query, count: rows.length, hits: rows, groups }, null, 2));
      return;
    }
    if (hits.length === 0) {
      // [10-19] 「为什么没找到」诊断：只归因、不改检索。
      //   判据全在 why-empty.ts（词太泛 / 词不存在 / 时间窗 / scope / 约束太多），
      //   这里只负责打印；没有诊断时它会给出兜底原因，绝不再只说「未找到」。
      const scoped = !!(asm.scopeFile && asm.scopeFile.mode !== 'full' && asm.where);
      const project = cfg.identity.project_id ?? root;
      let total = 0;
      try { total = (db.prepare('SELECT COUNT(*) AS c FROM sessions WHERE project_id = ?').get(project) as { c: number }).c; } catch { total = 0; }
      const diag = diagnoseEmpty({ db, projectId: project, query, sessions: total, scopeNarrowed: scoped, since: flags.since, until: flags.until });
      console.log(pc.yellow('未找到。') + pc.dim('为什么：'));
      for (const r of diag.reasons) console.log('  · ' + r);
      for (const s of diag.suggestions) console.log(pc.dim('  → ' + s));
      return;
    }
    const snap = stats.snapshot();
    if (snap['first_hit'] === undefined) stats.increment('first_hit');
    hits.forEach((h, i) => {
      const s = getSession(db, h.sessionId);
      const no = pc.cyan(`${i + 1}.`);
      console.log(`${no} ${(s?.title ?? h.sessionId).slice(0, 44)}  ${pc.dim(`${s?.source ?? ''} · ${fmtDate(s?.created_at)} · `)}${stateBadge(s?.state ?? '')}`);
      if (h.snippet) console.log(pc.dim(`   ${h.snippet.slice(0, 100)}`));
      // [10-19 · 任务 B] 为什么排在这里：base × 覆盖 × 长度 × 时间 × 标题 ⇒ final
      if (h.explain) console.log(pc.dim(`   打分：${formatExplain(h.explain)}`));
      if (!h.viaMeta) console.log(pc.dim(`   srelay show ${h.sessionId} · 命中覆盖 ${Math.round(h.coverage * 100)}%`));
    });
    // [10-19] 多会话组（只在真的分出来时才打印，避免每条命中都刷一遍噪音）
    const groups = groupSessions(db, hits.map((h) => ({ sessionId: h.sessionId, score: h.score })));
    const multi = groups.filter((g) => g.sessionIds.length >= 2);
    if (multi.length > 0) {
      console.log(pc.dim('\n相关会话组（同一主题的几条会话）：'));
      for (const g of multi.slice(0, 5)) {
        const title = getSession(db, g.lead)?.title ?? g.lead;
        const sig = [...g.sharedTopics.slice(0, 2), ...g.sharedFiles.slice(0, 1)].join(' / ');
        console.log(pc.dim('  · ') + title.slice(0, 40) + pc.dim('  [' + g.sessionIds.length + ' 条' + (sig ? ' · 共享 ' + sig : '') + ']'));
      }
    }
    console.log(pc.dim(`\n${hits.length} 条命中。--json 看机器格式。`));
  } finally {
    db.close();
  }
}

export async function cmdShow(idPrefix: string, opts: { range?: string; json?: boolean }): Promise<void> {
  const root = requireRoot();
  const cfg = loadConfig(root);
  const db = openRelayDb(root);
  const stats = openStats(root);
  stats.increment('cli_show');
  try {
    const s = findSessionByPrefix(db, idPrefix, cfg.identity.project_id ?? root);
    if (!s) { console.log(pc.red('✗ 未找到会话：') + idPrefix); process.exitCode = 1; return; }
    // [10-19 任务 D] 反馈采集：同进程刚检索过、且该会话在候选里 → 记一条 open（旁路，不影响 show）
    recordSearchOpen({ project: cfg.identity.project_id ?? root, sessionId: s.id, openKind: 'cli_show' });
    const [from, to] = parseRange(opts.range, s.message_count);
    if (opts.json) {
      const msgs = getMessageRange(db, s.id, from, to);
      console.log(JSON.stringify({ session: s, range: [from, to], messages: msgs }, null, 2));
      return;
    }
    console.log(pc.bold(`「${s.title ?? s.id}」`));
    console.log(pc.dim(`${s.source} · ${fmtDate(s.created_at)} · ${s.state} · ${s.message_count} 消息 · 显示 #${from}-#${to}`));
    console.log('─'.repeat(58));
    const msgs = getMessageRange(db, s.id, from, to);
    // 总预算保护（20KB）：超出时停止输出并提示分段查看
    const BUDGET = 20 * 1024;
    let used = 0;
    let stopped = false;
    for (const m of msgs) {
      const body = m.content.length > 600 ? m.content.slice(0, 600) + ` …(截断，共 ${m.content.length} 字)` : m.content;
      used += Buffer.byteLength(body, 'utf8');
      if (used > BUDGET) {
        stopped = true;
        const shown = msgs.indexOf(m);
        console.log(pc.yellow(`\n⚠️ 输出已达 20KB 预算，已显示 #${from}–#${from + shown - 1}（共 ${msgs.length} 条中）。`));
        console.log(pc.dim(`  分段查看：--range ${from + shown}:${to}；只看提问：MCP get_session_detail(role: 'user')`));
        break;
      }
      const who = m.role === 'user' ? pc.cyan('用户') : pc.green('AI  ');
      console.log(`${pc.dim(`#${m.seq_num}`)} ${who} ${body.replace(/\n+/g, '\n   ')}`);
    }
    if (!stopped) {
      console.log(pc.dim(`\n💡 省上下文技巧：MCP get_session_detail 支持 role:'user' 只看提问、max_chars 控制单条长度`));
    }
  } finally {
    db.close();
  }
}

export async function cmdList(opts: { source?: string; state?: string; limit?: number; json?: boolean }): Promise<void> {
  const root = requireRoot();
  const cfg = loadConfig(root);
  const db = openRelayDb(root);
  try {
    const asm = assembleScope({ root, cfg, includeAuto: false });
    const rows = listSessions(db, { projectId: cfg.identity.project_id ?? root, source: opts.source, state: opts.state, limit: opts.limit ?? 20, where: asm.where });
    if (opts.json) {
      console.log(JSON.stringify({ count: rows.length, sessions: rows }, null, 2));
      return;
    }
    if (rows.length === 0) { console.log(pc.dim('（空）先 srelay sync 或等待守护捕获。')); return; }
    // 笔记单独分组展示（note 是 AI 结论记录，不是对话会话）
    // [1021 回归 P3] 判据统一走 isNoteSession（含历史 origin='note' 形态）
    const sessions = rows.filter(s => !isNoteSession(s));
    const notes = rows.filter(s => isNoteSession(s));
    for (const s of sessions) {
      console.log(`${pc.dim(fmtDate(s.last_event_at ?? s.created_at))}  ${s.source.padEnd(11)} ${stateBadge(s.state).padEnd(10)} 「${(s.title ?? '').slice(0, 36)}」 ${pc.dim(`${s.id} · ${s.message_count}msg`)}`);
    }
    if (notes.length > 0) {
      console.log(pc.dim(`\n── AI 笔记（${notes.length} 条，srelay list --source note 查看）──`));
      for (const s of notes) {
        console.log(`${pc.dim(fmtDate(s.created_at))}  📝 「${(s.title ?? '').slice(0, 40)}」 ${pc.dim(s.id)}`);
      }
    }
  } finally {
    db.close();
  }
}

function parseRange(r: string | undefined, total: number): [number, number] {
  if (!r) return [1, Math.max(total, 1)];
  const m = /^(\d*):(\d*)$/.exec(r);
  if (!m) return [1, Math.max(total, 1)];
  return [Number(m[1] || 1), Number(m[2] || Math.max(total, 1))];
}

// srelay related（design-related）：以会话为锚推荐相关历史——人用的导航入口
export async function cmdRelated(idPrefix: string, opts?: { limit?: string; json?: boolean }): Promise<void> {
  const root = requireRoot();
  const cfg = loadConfig(root);
  const db = openRelayDb(root);
  try {
    const anchor = findSessionByPrefix(db, idPrefix, cfg.identity.project_id ?? root) ?? getSession(db, idPrefix);
    if (!anchor) { console.log(pc.yellow('未找到锚会话。') + pc.dim('用 srelay list 查看可用会话')); process.exitCode = 1; return; }
    const { suggestRelated, RELATED_HARD_CAP } = await import('../search-svc/related.js');
    let limit: number | undefined;
    if (opts?.limit !== undefined) {
      limit = Number(opts.limit);
      if (!Number.isFinite(limit)) { console.log(pc.yellow('--limit 需要数字')); process.exit(2); }
      limit = Math.min(limit, RELATED_HARD_CAP);
    }
    const { items } = await suggestRelated(db, cfg, {
      projectId: cfg.identity.project_id ?? root, anchorId: anchor.id, limit,
    });
    if (opts?.json) { console.log(JSON.stringify({ anchor: { sessionId: anchor.id, title: anchor.title }, count: items.length, suggestions: items }, null, 2)); return; }
    console.log(`与「${(anchor.title ?? anchor.id).slice(0, 36)}」相关的会话：`);
    if (items.length === 0) { console.log(pc.dim('（无——共享话题/文件/向量相似度都不够；语义未启用时可 srelay semantic --enable 增强）')); return; }
    for (const it of items) {
      console.log(`  ${String(it.score).padEnd(6)} 「${(it.title ?? '').slice(0, 32)}」 ${pc.dim(`${it.source} · ${it.state} · ${it.reason}`)} ${pc.dim(it.sessionId)}`);
    }
    console.log(pc.dim('  推荐仅为导航线索；srelay show <id> 看原文'));
  } finally {
    db.close();
  }
}
