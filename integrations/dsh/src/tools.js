// tools.js — SessionRelay DSH 原生工具定义（4 个核心能力）
//
// 契约铁律：
// 1. defineTool 的 parameters 传扁平映射 { name: {type, required, description} }，
//    禁止外层包裹 {type:'object', properties:{}}，避免静默丢失 required/description。
// 2. output schema 必须显式声明 additionalProperties: false。
// 3. 绝不起 MCP serve 子进程，底层通过 cli.js 瞬态调用 CLI 命令。
// 4. srelay_bind_project 必须是两段式：模型调用只提议（propose），绝不直接更改生效项目。
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname, resolve as pathResolve } from 'node:path'
import { homedir } from 'node:os'
import { defineTool as defineToolRaw } from './define-tool.js'

/**
 * 原始 spec 收集器。
 *
 * 为什么需要它：工具要精简（14 → 4），新工具吃 `kind` 路由到旧实现。
 *   复制一份实现是最坏的做法（判据/逻辑立刻变成两份，改一处漏一处）。
 *   而 `defineTool()` 在 DSH 宿主里会**归一化**返回对象，归一化后的形态不保证还带 execute ——
 *   依赖它等于把命交给宿主内部实现。
 *   所以在**进 defineTool 之前**先把 spec 原样扣下来：那份 spec 就是纯函数对象，永远是同一形状。
 *   ⇒ 新工具调 `legacySpec('srelay_decisions').execute(args, exec)`，走的是和旧工具**完全同一条**代码。
 */
const SPECS = new Map()

function defineTool(spec) {
  if (spec && typeof spec.name === 'string') SPECS.set(spec.name, spec)
  return defineToolRaw(spec)
}

/** 取某个旧工具的原始 spec（不存在 → undefined）。仅供合并后的新工具复用，不要往外传。 */
export function legacySpec(name) {
  return SPECS.get(name)
}
import { execSrelay, clip } from './cli.js'
import { getActiveProject, proposeProject, confirmProject, cancelProposal } from './state.js'

/**
 * 工具侧的项目根解析：**显式参数 > agent 的 cwd（与简报同源）> 绑定/环境变量**。
 *
 * [1017 夜 08:0x] 为什么需要它（修「简报有、工具报错」的不对称）：
 *   简报走「agent 的 cwd」，而 search/record/show 原先只走 `getActiveProject()` ——
 *   后者只由**两段式绑定项目**或环境变量 `SRELAY_PROJECT_ROOT` 设定，**看不到会话 cwd**。
 *   更根本的是：这三个工具的 `execute` 签名是 `(args)`，**物理上就收不到 exec**，
 *   所以拿不到 `exec.agent.session.header.cwd`。症状是用户看到
 *   「开场简报好好的，让我搜一下就报『未找到 .sessionrelay』」。
 *
 * 判据顺序与同文件里 `srelay_init` 完全一致（architecture 纪律：复用规范 helper，别写第二套）。
 * 兜底仍用 getActiveProject()：显式绑定过的项目应当**压过**会话 cwd（用户可能在一个
 * 跨项目的窗口里，明确指定了要看哪个库）。
 */
/**
 * 从某个目录向上找最近的记忆库（.sessionrelay/config.json 或 relay.sqlite）。
 *
 * [1022 修「在 DSH 里点交接包报未初始化」] 命令面板/某些执行路径拿不到会话 cwd，
 *   进程 cwd 会落到 DSH 安装目录 ⇒ 之前直接把 cwd=null 传下去，CLI 在**错的目录**里
 *   找 .sessionrelay，于是报「本项目尚未初始化」（其实项目好好地在 D:\agent1super）。
 *   现在多一层兜底：从进程 cwd 向上找；找不到才报错，并且报错要说清该传什么。
 */
function nearestProjectRoot(start) {
  let p = pathResolve(String(start || process.cwd()))
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(p, '.sessionrelay', 'config.json')) || existsSync(join(p, '.sessionrelay', 'relay.sqlite'))) return p
    const up = dirname(p)
    if (up === p) break
    p = up
  }
  return null
}

function resolveToolRoot(args, exec) {
  const explicit = String(args?.projectPath ?? '').trim()
  if (explicit) return explicit
  const bound = getActiveProject()
  if (bound) return bound;
  const cwd = exec?.agent?.session?.header?.cwd
  if (typeof cwd === 'string' && cwd.trim()) return cwd.trim()
  // 兜底：从进程 cwd 向上找（DSH 安装目录向上找不到 ⇒ null，交给调用方报清晰错误）
  return nearestProjectRoot(process.cwd())
}
import { isInternalDir } from '../project-resolve.mjs'

/**
 * 采集源校正：本机装着 DSH 时，config 的 capture.sources 必须含 'dsh'。
 * `srelay init --yes` 靠 detectSources() 自动探测，而 dsh 探测项是我们 fork 加的——
 * 上游原版或经 npx 拉到的那份没有它，建出的库 sources 只有 zcode/codex，结果是
 * 「库建好了但 DSH 会话永远采不进去，简报永远空，且没有任何报错」。
 */
function ensureDshSource(root) {
  try {
    if (!existsSync(join(homedir(), '.dsh', 'sessions'))) return
    const cfg = join(root, '.sessionrelay', 'config.json')
    if (!existsSync(cfg)) return
    const j = JSON.parse(readFileSync(cfg, 'utf8'))
    const src = j?.capture?.sources
    if (!Array.isArray(src) || src.includes('dsh')) return
    src.push('dsh')
    writeFileSync(cfg, JSON.stringify(j, null, 2))
  } catch { /* 校正失败不阻塞：库已建成，下轮采集时再看 */ }
}

/** 标准工具返回输出契约，与 dsh-reach 一致 */
const resultSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    payload: { type: 'string' },
    error: { type: 'string' },
  },
}

/**
 * 1. srelay_search
 * 按关键词检索当前项目历史会话（中文全文 + 组合过滤）
 */
export const searchTool = defineTool({
  name: 'srelay_search',
  description: '检索本项目记忆，kind 选视角：sessions 搜会话（默认）、decisions 已定结论（含被否掉的路）、'
    + 'unresolved 未解决、lessons 经验、history 某文件的来历、related 相似会话。用户说「之前/上次/定过吗」时用。',
  parameters: {
    kind: { type: 'string', description: 'sessions（默认）/ decisions / unresolved / lessons / history / related' },
    query: { type: 'string', description: '检索关键词（kind=sessions / lessons 用；多词空格分隔，如 "PostgreSQL 迁移"）' },
    limit: { type: 'number', description: '最多返回条数（各 kind 默认值不同）' },
    topic: { type: 'string', description: '按特定话题过滤（kind=sessions）' },
    tag: { type: 'string', description: '按特定标签过滤（kind=sessions）' },
    filePath: { type: 'string', description: '文件路径（kind=history 必填；可只给文件名，如 "engine.ts"）' },
    sessionIdPrefix: { type: 'string', description: '会话 ID 前缀（kind=related 必填）' },
  },
  output: {
    schema: resultSchema,
    render: (_args, value) => [{
      type: 'text',
      text: value.ok ? value.payload : `检索失败：${value.error}`,
    }],
  },
  // ⚠️ [1017 夜 08:0x · 修「简报有、工具报错」的不对称]
  // 病历：简报走「agent 的 cwd」，而 search/record/show 走 `getActiveProject()` ——
  // 后者只由**两段式绑定项目**或环境变量 SRELAY_PROJECT_ROOT 设定，**看不到会话 cwd**。
  // 于是用户看到的是「开场简报正常，但让我搜一下就报『未找到 .sessionrelay』」。
  // 根因不是绑定没做，而是**这三个工具的 execute 压根没接 exec 参数**（签名是 `execute(args)`），
  // 所以它们**在物理上无法**读到 `exec.agent.session.header.cwd`。
  // 修法沿用同文件里 srelay_init 已经有的判据顺序（architecture 技能的「复用规范 helper」）：
  //   **显式 projectPath 参数 > agent 的 cwd（与简报同源）> 绑定/环境变量兜底**。
  async execute(args, exec) {
    // [1026 工具面精简] 14 个工具 → 4 个：这一个吃 kind，把 6 种「查」合成一个入口。
    //   为什么不是复制实现：判据只许有一份。这里路由到 legacySpec 扣下来的**原始 spec**，
    //   走的是和旧工具逐字相同的那条 execute —— 合并只改「怎么找」，不改「查到什么」。
    const kind = String(args?.kind ?? 'sessions').trim().toLowerCase() || 'sessions'
    // [10-18 新用户实测] 原来缺 filePath / sessionIdPrefix 时会拿 undefined 往下走：
    //   kind=history 变成「搜字符串 "undefined"」（返回 20 个无关会话），kind=related 只回一句提示。
    //   参数缺失是**调用方错误**，要明说，别让它变成一次看起来成功的检索。
    if ((kind === 'history' || kind === 'files') && String(args?.filePath ?? '').trim() === '') {
      return { ok: false, payload: '', error: 'kind=' + kind + ' 需要 filePath（例如 {"kind":"history","filePath":"src/map/bridge.ts"}）' }
    }
    if (kind === 'related' && String(args?.sessionIdPrefix ?? '').trim() === '') {
      return { ok: false, payload: '', error: 'kind=related 需要 sessionIdPrefix（会话 ID 前缀，可先用 kind=sessions 找到）' }
    }
    if (kind !== 'sessions') {
      const ROUTE = {
        decisions: 'srelay_decisions',
        unresolved: 'srelay_unresolved',
        lessons: 'srelay_lessons',
        // MCP 侧（srelay serve）把这个能力叫 kind=files，DSH 侧照抄同一个词 ——
        // 同一个能力在两个客户端上叫两个名字，最后一定是「用户记住了 A、在 B 上试了没用」。
        files: 'srelay_history',
        history: 'srelay_history', // 旧写法留着，已经写 history 的调用不该断
        related: 'srelay_related',
      }
      const target = ROUTE[kind]
      if (!target) {
        return {
          ok: false, payload: '',
          error: '未知 kind "' + kind + '"：只认 sessions / ' + Object.keys(ROUTE).join(' / '),
        }
      }
      const spec = legacySpec(target)
      if (!spec || typeof spec.execute !== 'function') {
        return { ok: false, payload: '', error: '内部错误：kind=' + kind + ' 的实现缺失（' + target + '）' }
      }
      return spec.execute(args, exec)
    }

    const q = String(args?.query ?? '').trim()
    if (!q) return { ok: false, payload: '', error: 'query 关键词不能为空（kind=sessions 必填；列决策/未决/经验请传 kind）' }

    const cliArgs = ['search', q]
    const limit = Number(args.limit)
    if (Number.isFinite(limit) && limit > 0) {
      cliArgs.push('--limit', String(limit))
    }
    if (args.topic) cliArgs.push('--topic', String(args.topic))
    if (args.tag) cliArgs.push('--tag', String(args.tag))

    const cwd = resolveToolRoot(args, exec)
    const res = await execSrelay(cliArgs, { cwd })

    if (!res.ok) {
      return { ok: false, payload: '', error: res.stderr || '检索执行异常' }
    }

    const output = (res.stdout || '').trim()
    return {
      ok: true,
      payload: clip(output || `未检索到包含 "${q}" 的历史会话。`),
      error: '',
    }
  },
})

/**
 * 2. srelay_show
 * 查看指定历史会话的详细对话片段与出处
 */
export const showTool = defineTool({
  name: 'srelay_show',
  description: '查看指定历史会话的具体对话消息与决策上下文详情。当通过 srelay_search 找到感兴趣的会话 ID 并需要阅读具体讨论细节时使用。',
  parameters: {
    sessionIdPrefix: { type: 'string', required: true, description: '会话 ID 或其前缀（如 search 结果中的 8-16 位 hash）' },
    range: { type: 'string', description: '消息序号范围，格式为 "起始:结束"（例如 "1:20"，可选）' },
  },
  output: {
    schema: resultSchema,
    render: (_args, value) => [{
      type: 'text',
      text: value.ok ? value.payload : `查看失败：${value.error}`,
    }],
  },
  async execute(args, exec) {
    const id = String(args?.sessionIdPrefix ?? '').trim()
    if (!id) return { ok: false, payload: '', error: 'sessionIdPrefix 不能为空' }

    const cliArgs = ['show', id]
    if (args.range && typeof args.range === 'string') {
      cliArgs.push('--range', args.range.trim())
    }

    const cwd = resolveToolRoot(args, exec)
    const res = await execSrelay(cliArgs, { cwd })

    if (!res.ok) {
      return { ok: false, payload: '', error: res.stderr || `未找到会话或读取失败：${id}` }
    }

    const output = (res.stdout || '').trim()
    return {
      ok: true,
      payload: clip(output || `会话 ${id} 无消息内容。`),
      error: '',
    }
  },
})

/** 把一段摘要收成一个笔记标题：取第一行、剥掉列表符号、最多 40 字。
 *  为什么不用整段当标题：note 的 title 是会话标题，会出现在 list/search/brief 里，
 *  一屏能扫完才有用（`srelay note` 本身要求 title 至少 2 字，这里给兜底）。 */
function noteTitleOf(text) {
  const first = String(text).split(/\r?\n/).map((s) => s.trim()).find(Boolean) || ''
  const t = first.replace(/^[#>*\-–—\d.、)）\s]+/, '').replace(/[。；;，,]+$/, '').trim()
  return (t.length >= 2 ? t : '结论笔记').slice(0, 40)
}

/**
 * 3. srelay_record
 * 主动记录重要技术决策与备忘笔记到当前项目记忆库
 */
export const recordTool = defineTool({
  name: 'srelay_record',
  description: '主动向当前项目的 SessionRelay 记忆库中沉淀记录一条已确认的技术决策或重要笔记。记录后即可被后续所有 AI 会话及自动简报检索到。',
  parameters: {
    summary: { type: 'string', required: true, description: '已确定的技术决策内容、方案结论或备忘总结' },
    tag: { type: 'string', description: '分类标签，多个标签用英文逗号分隔（如 "architecture,database"，可选）' },
    sessionId: { type: 'string', description: '（已废弃，保留兼容）note 通道写的是独立笔记会话，不再关联某个旧会话' },
  },
  output: {
    schema: resultSchema,
    render: (_args, value) => [{
      type: 'text',
      text: value.ok ? value.payload : `记录失败：${value.error}`,
    }],
  },
  async execute(args, exec) {
    const summary = String(args?.summary ?? '').trim()
    if (!summary) return { ok: false, payload: '', error: 'summary 决策摘要不能为空' }
    // [10-18 实测修复] 这里原来调的是 `srelay save --recent 1d --summary ...`：
    //   那是「把最近一天的会话重新存一遍并附个摘要」，摘要落进会话的 summary 字段，
    //   **不进 decisions**。于是 remember 报成功、decisions 查不到、pin 也匹配不到——写与读对不上。
    //   改走 `srelay note`（→ createNoteSession），和 MCP 的 save_note 是同一条路：
    //   写一场 source=note 的会话、立即 confirmed、走正常抽取。
    //   两个客户端从此共用一个通道，不会再出现「一边对、一边假成功」。
    if (summary.length < 4) {
      return { ok: false, payload: '', error: 'summary 太短（至少 4 个字）：结论没成形就先别记，等它成形' }
    }
    const title = noteTitleOf(summary)
    const cliArgs = ['note', '--title', title, '--content', summary]
    if (args.tag) {
      cliArgs.push('--tag', String(args.tag).trim())
    }
    cliArgs.push('--json')

    const cwd = resolveToolRoot(args, exec)
    const res = await execSrelay(cliArgs, { cwd })

    if (!res.ok) {
      return { ok: false, payload: '', error: res.stderr || '记录决策失败' }
    }

    let report = ''
    try {
      const parsed = JSON.parse(res.stdout.trim())
      report = [
        `✓ 已写入结论笔记（source=note，已确认；正文里的决策句式会进决策库）`,
        `- 工作区：${cwd}`,
        `- 标题：${parsed.title ?? title}`,
        `- 正文：${summary}`,
        `- 标签：${(parsed.tags ?? []).join(', ') || '无'}`,
        `- 笔记会话：${parsed.sessionId ?? '?'}（srelay show <id> 可回看原文）`,
        `- 查证：srelay decisions / srelay pin "<片段>"`,
      ].join('\n')
    } catch {
      report = res.stdout.trim() || `✓ 已写入结论笔记：${summary}`
    }

    return {
      ok: true,
      payload: clip(report),
      error: '',
    }
  },
})

/**
 * 4. srelay_bind_project
 * 提议切换/绑定工作区（★两段式：模型调用仅记录提议，必须等用户确认才生效）
 */
export const bindProjectTool = defineTool({
  name: 'srelay_bind_project',
  description: '提议绑定或切换当前项目工作区路径（两段式安全保护：模型调用仅发起提议并做路径校验，绝不直接切换写入目标，必须经用户明确回复确认后才能正式生效）。',
  parameters: {
    projectPath: { type: 'string', required: true, description: '欲绑定的目标项目绝对路径（例如 "E:\\music player" 或 "E:\\mc整合包"）' },
  },
  output: {
    schema: resultSchema,
    render: (_args, value) => [{
      type: 'text',
      text: value.ok ? value.payload : `绑定提议失败：${value.error}`,
    }],
  },
  async execute(args, exec) {
    const rawPath = String(args?.projectPath ?? '').trim()
    if (!rawPath) return { ok: false, payload: '', error: 'projectPath 不能为空' }

    const proposalResult = proposeProject(rawPath)
    if (!proposalResult.ok) {
      return {
        ok: false,
        payload: '',
        error: proposalResult.message,
      }
    }

    return {
      ok: true,
      payload: proposalResult.message,
      error: '',
    }
  },
})

/**
 * 7. srelay_init —— 为当前项目建立记忆库
 *
 * 为什么需要它：「尚未接入」那条简报以前写着"对我说一声'接入'，我再执行 srelay init"，
 * 但插件压根没有能建库的工具——那句话是空头承诺，用户说了"接入"模型也无从下手
 * （只能猜着去 shell 里敲命令，且不一定找得到 CLI）。本工具把这条断点补上。
 *
 * 为什么不需要两段式：建库的代价极低且**可逆**（只建一个 .sessionrelay/ 目录，
 * 删掉就彻底消失），与"绑定到已有库"（写错库不可逆）是完全不同的风险等级。
 * 所以这里是单段执行，但返回值必须说清楚建在哪、下一步是什么。
 */
export const initProjectTool = defineTool({
  name: 'srelay_init',
  description: '为当前项目建立 SessionRelay 记忆库（可逆：删掉 .sessionrelay 目录即恢复原状）。当项目尚未接入，或用户明确说"接入"时使用。已建库的项目调用会直接返回无需重复建立。',
  parameters: {
    projectPath: { type: 'string', description: '项目绝对路径（可选；缺省取当前会话的工作目录）' },
  },
  output: {
    schema: resultSchema,
    render: (_args, value) => [{
      type: 'text',
      text: value.ok ? value.payload : `建立记忆库失败：${value.error}`,
    }],
  },
  async execute(args, exec) {
    // 目标路径优先级：显式参数 > agent 的 cwd（与简报同一来源）> 报错要求显式传
    let root = String(args?.projectPath ?? '').trim()
    if (!root) {
      const cwd = exec?.agent?.session?.header?.cwd
      if (typeof cwd === 'string' && cwd.trim()) root = cwd.trim()
    }
    if (!root) {
      return { ok: false, payload: '', error: '无法确定项目路径：请显式传入 projectPath（项目绝对路径）' }
    }

    // 黑名单：临时目录 / DSH 自身 / npm 全局 / 盘符根，一律拒绝
    // （与自动接入共用同一份 isInternalDir，规则只有一处，不会两边漂移）
    if (isInternalDir(root)) {
      return { ok: false, payload: '', error: `拒绝在 ${root} 建立记忆库：该目录属于临时目录或工具自身的安装/配置位置` }
    }

    // 采集源校正放在"已建库"早退之前：历史遗留的坏配置（sources 缺 dsh）也要能修好，
    // 否则调用方看到"无需重复建立"就走了，坏配置一直留着。
    ensureDshSource(root)

    const dbFile = join(root, '.sessionrelay', 'relay.sqlite')
    if (existsSync(dbFile)) {
      return { ok: true, payload: `项目已有记忆库，无需重复建立：${root}` }
    }

    // --backfill none：默认 30 天回填实测 1050ms，裸 init 154ms；建库这一步不需要历史
    const res = await execSrelay(['init', '--yes', '--backfill', 'none'], { cwd: root, timeoutMs: 30000 })
    if (!res.ok) {
      return { ok: false, payload: '', error: (res.stderr || res.stdout || 'srelay init 执行失败').slice(0, 300) }
    }
    // 建库后再确认一次：init 成功但库没落盘的情况必须报出来，不能假装成功
    if (!existsSync(dbFile)) {
      return { ok: false, payload: '', error: `srelay init 返回成功但未找到 ${dbFile}` }
    }
    return {
      ok: true,
      payload: `已为 ${root} 建立记忆库。下一轮起，本项目的决策与未决问题会自动出现在系统提示里。`,
    }
  },
})

/**
 * 【两段式第二段】确认绑定。仅在用户明确回复"确认"后由模型调用。
 * 缺失这个工具时，第一段的提议永远无法生效——用户说"确认"模型也无从执行。
 */
export const confirmBindTool = defineTool({
  name: 'srelay_confirm_bind_project',
  description: '确认上一个项目绑定提议（两段式第二段）。仅在用户明确同意切换后才调用；没有待确认提议时会失败。',
  parameters: {},
  output: {
    schema: resultSchema,
    render: (_args, value) => [{
      type: 'text',
      text: value.ok ? value.payload : `确认失败：${value.error}`,
    }],
  },
  async execute() {
    const r = confirmProject()
    if (!r.ok) return { ok: false, payload: '', error: r.message }
    return { ok: true, payload: r.message, error: '' }
  },
})

/** 取消待确认的绑定提议（用户改主意时用）。 */
export const cancelBindTool = defineTool({
  name: 'srelay_cancel_bind_project',
  description: '取消待确认的项目绑定提议。用户反悔或想换个项目时使用。',
  parameters: {},
  output: {
    schema: resultSchema,
    render: (_args, value) => [{ type: 'text', text: value.ok ? value.payload : value.error }],
  },
  async execute() {
    cancelProposal()
    return { ok: true, payload: '已取消待确认的项目绑定提议。', error: '' }
  },
})

// ══════════════════════ [1021 满血版] 补齐 MCP 已有的能力 ══════════════════════
//
// 病历：MCP 侧（srelay serve）暴露 13 个工具，而 DSH 插件只有 7 个 ——
//   同一个产品，两个面能力不一样。用户在 ZCode 能做的事，在 DSH 做不了，反之亦然。
//   本轮把 CLI **已经有**的能力全部包成 DSH 工具（不为它们新写内核逻辑，只是换个入口）。
//
// 全部走 execSrelay（与 search/show 同一条子进程路径），所以：
//   · projectPath 解析、cwd 回退、错误包装、输出裁剪 —— 全部复用，不另立判据；
//   · 内核变了这里不用跟着改。

/** 纯文本类 CLI 工具的统一包装：参数数组 → CLI → 文本 */
function describeTextTool({ name, description, parameters, buildArgs, emptyHint, format }) {
  return defineTool({
    name,
    description,
    parameters,
    output: {
      schema: resultSchema,
      render: (_args, value) => [{ type: 'text', text: value.ok ? value.payload : `执行失败：${value.error}` }],
    },
    async execute(args, exec) {
      const cwd = resolveToolRoot(args, exec)
      if (!cwd) {
        return { ok: false, payload: '', error: '找不到项目工作区：当前目录不是记忆库，也没传 projectPath。请传 projectPath=项目根（例如 D:/agent1super），或先 srelay init。' }
      }
      const res = await execSrelay(buildArgs(args), { cwd })
      if (!res.ok) return { ok: false, payload: '', error: res.stderr || '执行异常' }
      const output = (res.stdout || '').trim()
      // format：CLI 的 --json 是给程序读的，工具输出去是给模型读的。
      //   lessons 原来直接把 JSON 数组丢给模型（与其他 kind 的排版完全不一致），这里允许各工具自定排版。
      const text = typeof format === 'function' ? format(output, args) : output
      return { ok: true, payload: clip(text || emptyHint), error: '' }
    },
  })
}

/** 以会话为锚推荐相关历史会话（算法发现，非显式关联）。治「记不清关键词、换个说法就搜不到」 */
export const relatedTool = describeTextTool({
  name: 'srelay_related',
  description: '给定一个会话 ID，推荐与它主题相关的**其他**历史会话（算法发现：向量相似 + 话题/文件重叠）。何时用：正在看某个会话想知道「还有哪些相关讨论」、记不清关键词搜不到时**以会话为锚**找线索。推荐仅为导航，内容以 srelay_show 为准。',
  parameters: {
    sessionIdPrefix: { type: 'string', required: true, description: '锚会话 ID（支持前缀）' },
    limit: { type: 'number', description: '最多推荐几条，默认 5' },
  },
  buildArgs: (a) => {
    const out = ['related', String(a.sessionIdPrefix)]
    const n = Number(a.limit)
    if (Number.isFinite(n) && n > 0) out.push('--limit', String(n))
    return out
  },
  emptyHint: '没有找到相关会话（可能是该会话太新或话题过于独特）。',
})

/** 某文件被哪些会话讨论过（跨 agent 的溯源） */
export const historyTool = describeTextTool({
  name: 'srelay_history',
  description: '查某个文件路径被哪些会话讨论过、说了什么。何时用：改一个文件前想先看「这个文件历史上被哪些讨论碰过」、接手陌生代码想知道来历。',
  parameters: {
    filePath: { type: 'string', required: true, description: '文件路径（可只给文件名，如 "engine.ts"）' },
  },
  buildArgs: (a) => ['history', String(a.filePath)],
  emptyHint: '没有会话讨论过这个文件。',
})

/** 列出所有已确认决策（含被否掉的路） */
export const decisionsTool = describeTextTool({
  name: 'srelay_decisions',
  description: '列出本项目**全部**已确认技术决策（含被否掉的方案，标 kind=negative）。何时用：动手前确认「这件事以前是不是已经定过」、避免重复提议一条已被否决的路。只想看最近几条用 srelay_search(kind=decisions)。',
  parameters: {
    limit: { type: 'number', description: '最多几条，默认 30' },
  },
  buildArgs: (a) => {
    const out = ['decisions']
    const n = Number(a.limit)
    if (Number.isFinite(n) && n > 0) out.push('--limit', String(n))
    return out
  },
  emptyHint: '本项目还没有已确认的决策。',
})

/**
 * 查经验（1021 新增）。
 *
 * 为什么需要它：经验此前只有一条路 —— **每轮自动注入 3 条（200 字符）**。
 * 库一大，3 条必然覆盖不到当前问题，而模型没有任何手段去深挖。
 * 这个工具就是那条缺失的路：自动注入保底，需要时主动查。
 *
 * 判据全部在内核（visibleWhere / isInjectable / liveImportance），本文件只构造 CLI 参数。
 */
export const lessonsTool = describeTextTool({
  name: 'srelay_lessons',
  description: '经验库：mode=list 列出、mode=search 检索、mode=market 从别的项目推荐（带「为什么」）。只读。',
  parameters: {
    mode: { type: 'string', description: 'list | search（默认）| market' },
    query: { type: 'string', description: '检索词；mode=market 时也当话题' },
    topics: { type: 'string', description: 'mode=market：话题，空格分隔（不填=本项目最近话题）' },
    limit: { type: 'number', description: '最多几条，默认 10（market 默认 5）' },
  },
  buildArgs: (a) => {
    // [1020 合并] 原 srelay_market 并入这里（mode=market）：同一个问题「有没有能借用的经验」，
    //   取数与排序仍走 CLI 的 market（唯一实现），不另写一套。
    const mode = String(a.mode || (String(a.query || '').trim() ? 'search' : 'list')).trim()
    if (mode === 'market') {
      const t = String(a.topics || a.query || '').trim()
      const arr = t ? t.split(/\s+/).filter(Boolean) : []
      const n = Number(a.limit)
      return ['market', ...arr, ...(Number.isFinite(n) && n > 0 ? ['--limit', String(n)] : [])]
    }
    const q = String(a.query || '').trim()
    return q ? ['lesson', 'search', q, '--json'] : ['lesson', '--json']
  },
  // [10-18 实测] 原来把 CLI 的 JSON 数组原样丢给模型，与 kind=decisions 等排版完全不一致。
  //   一行一条：等级 / 用途次数 / 正文。**不在这里重算「能不能注入」**——那是内核的判据，
  //   插件只负责排版（判据只许有一份）。
  //   limit 在**排版层**截断：CLI 的 lesson 没有 --limit（顺序即重要度排序），
  //   但工具参数承诺了 limit —— 承诺了就得兑现，否则模型拿到 20 条还以为只返 3 条。
  format: (stdout, a) => {
    // market 模式输出是人话（CLI 的 market 没有 --json），原样透传
    if (String(a?.mode || '').trim() === 'market') return stdout
    try {
      const all = JSON.parse(stdout)
      if (!Array.isArray(all) || all.length === 0) return ''
      const n = Number(a?.limit)
      const arr = Number.isFinite(n) && n > 0 ? all.slice(0, n) : all.slice(0, 10)
      const lines = arr.map((x, i) => `${i + 1}. [${x.grade ?? '?'}] ${x.text}  · 用 ${x.uses ?? 0} 次`)
      if (all.length > arr.length) lines.push(`…共 ${all.length} 条，只列前 ${arr.length} 条（放个大点的 limit 看更多）`)
      return lines.join('\n')
    } catch { return stdout }
  },
  emptyHint: '经验库里没有匹配的条目。',
})

/** 列出未解决问题 */
export const unresolvedTool = describeTextTool({
  name: 'srelay_unresolved',
  description: '列出本项目提出过但**尚未解决**的问题。何时用：接手项目想知道「有什么坑还没填」、避免把已提过的疑问当新问题重问一遍。',
  parameters: {
    limit: { type: 'number', description: '最多几条，默认 20' },
  },
  buildArgs: (a) => {
    const out = ['unresolved']
    const n = Number(a.limit)
    if (Number.isFinite(n) && n > 0) out.push('--limit', String(n))
    return out
  },
  emptyHint: '没有未解决的问题。',
})

/** 本地匿名统计 */
export const statsTool = describeTextTool({
  name: 'srelay_stats',
  description: '本项目记忆库的规模与健康状况（会话数/决策数/未决数/归档数/体积/守护状态）。何时用：想确认「记忆层到底存了多少东西」「采集是不是在跑」。',
  parameters: {},
  buildArgs: () => ['stats'],
  emptyHint: '暂无统计。',
})

/** 置顶 / 取消置顶决策 */
export const pinTool = describeTextTool({
  name: 'srelay_pin',
  description: '把文本包含指定片段的所有决策**置顶**（简报优先显示，即使时间很老），或取消置顶（unpin=true）。何时用：某条结论太重要、必须每次开场都被看到。',
  parameters: {
    text: { type: 'string', required: true, description: '要匹配的文本片段（子串匹配）' },
    unpin: { type: 'boolean', description: 'true = 取消置顶' },
  },
  buildArgs: (a) => (a.unpin ? ['unpin', String(a.text)] : ['pin', String(a.text)]),
  emptyHint: '没有匹配的决策条目。',
})
// ─────────────────── 工具面精简：14 → 4（2026-10-18） ───────────────────
//
// 为什么合并：14 个工具的**描述本身就吃掉大量上下文**，而模型每次只能选一个动作。
//   合并的判断依据不是「功能像」而是「**同一个问题**」：
//     · 六个「查」都是「我想知道点什么」→ 一个 search，用 kind 分视角；
//     · 「记一条」和「把某条顶上去」都是「我想让这件事以后被看见」→ 一个 remember；
//     · 建库/切库/看规模都是「这个项目」。
//   判断依据**不是**「参数差不多」—— 参数像而用途不同的硬合并，只会让人记不住该传哪个。
//
// 实现一律路由到 legacySpec（旧工具的原始 spec），**不复制任何一段逻辑**：
//   合并改的是「怎么找到能力」，不是「能力本身」。旧工具的实现留着，只是不再注册给模型。

/** 交接包：五段固定格式的交接文档（程序拼、每条带出处）。 */
export const handoffTool = describeTextTool({
  name: 'srelay_handoff',
  description: '交接包：五段（现状/定过什么/还欠什么/下一步/坑），每条带 sessionId+msgId 出处。用户说「交接一下 / 换会话继续」时用。只读。默认用当前工作区；要指定别的项目就传 projectPath。',
  parameters: {
    projectPath: { type: 'string', description: '可选：项目根目录（默认＝当前会话的工作区）' },
  },
  buildArgs: (a) => {
    const p = String(a?.projectPath ?? '').trim()
    return p ? ['handoff', '--root', p] : ['handoff']
  },
  emptyHint: '交接包生成失败（项目尚未初始化或库里没有可交接的内容）。',
})

/** 系统健康：体检 + 校准就绪度（合并；只读或显式修）。 */
export const healthTool = describeTextTool({
  name: 'srelay_health',
  description: '系统健康：mode=check 查环境与库（fix=true 才修副本）；mode=calibrate 看检索反馈够不够调权重。默认只读。',
  parameters: {
    mode: { type: 'string', description: 'check（默认）| calibrate' },
    fix: { type: 'boolean', description: 'mode=check 时 true 才真修（默认 false 只体检）' },
  },
  buildArgs: (a) => {
    const mode = String(a.mode || 'check').trim()
    if (mode === 'calibrate') return ['feedback', '--json']
    return a.fix ? ['doctor', '--fix'] : ['doctor']
  },
  format: (stdout, a) => {
    if (String(a?.mode || 'check').trim() !== 'calibrate') return stdout
    try {
      const j = JSON.parse(stdout)
      const n = Number(j?.stats?.total ?? 0)
      const need = Number(j?.minOpens ?? 30)
      return [
        (n >= need ? '✅ 样本已够（' : '⏳ 样本不足（') + n + ' / ' + need + '）：'
          + (n >= need ? '可以跑了' : '现在跑只会得到「保持默认」'),
        '跑法：npx tsx scripts/calibrate-weights.ts --n 60（只出建议，绝不改 config.json）',
      ].join('\n')
    } catch { return stdout }
  },
  emptyHint: '没有输出（可能不是 srelay 项目目录）。',
})


/** 记一条结论，或把某条顶上去 —— 两件事的共同点是「让以后看得见」。 */
export const rememberTool = defineTool({
  name: 'srelay_remember',
  description: '把结论落进记忆库，二选一：'
    + '给 summary → 记为「已确认决策」（此后所有会话的简报与检索都会带上它）；'
    + '给 text → 置顶/取消置顶包含该片段的决策（置顶的不受 48h 简报时间窗限制）。',
  parameters: {
    summary: { type: 'string', description: '已确定的技术决策 / 方案结论 / 备忘总结（记录用）' },
    tag: { type: 'string', description: '分类标签，逗号分隔（记录用，如 "architecture,database"）' },
    sessionId: { type: 'string', description: '关联会话 ID 前缀（记录用；缺省关联最近 1 天内的活跃会话）' },
    text: { type: 'string', description: '要匹配的决策文本片段，子串匹配（置顶用）' },
    unpin: { type: 'boolean', description: 'true = 取消置顶' },
  },
  output: {
    schema: resultSchema,
    render: (_args, value) => [{
      type: 'text',
      text: value.ok ? value.payload : `记忆写入失败：${value.error}`,
    }],
  },
  async execute(args, exec) {
    const summary = String(args?.summary ?? '').trim()
    if (summary) return legacySpec('srelay_record').execute(args, exec)
    const text = String(args?.text ?? '').trim()
    if (text) return legacySpec('srelay_pin').execute(args, exec)
    return {
      ok: false, payload: '',
      error: 'summary 和 text 都没给：记录一条结论给 summary，置顶某条给 text',
    }
  },
})

/** 这个项目的记忆库：建、切、看。 */
export const projectTool = defineTool({
  name: 'srelay_project',
  description: '项目库管理：init 建库（可逆）、bind 提议切换（两段式，不立即生效）、confirm/cancel 确认或撤销、stats 看规模与健康。',
  parameters: {
    action: { type: 'string', required: true, description: 'init / bind / confirm / cancel / stats' },
    projectPath: { type: 'string', description: '目标项目绝对路径（action=init / bind 用）' },
  },
  output: {
    schema: resultSchema,
    render: (_args, value) => [{
      type: 'text',
      text: value.ok ? value.payload : `项目操作失败：${value.error}`,
    }],
  },
  async execute(args, exec) {
    const action = String(args?.action ?? '').trim().toLowerCase()
    const ROUTE = {
      init: 'srelay_init',
      bind: 'srelay_bind_project',
      confirm: 'srelay_confirm_bind_project',
      cancel: 'srelay_cancel_bind_project',
      stats: 'srelay_stats',
    }
    const target = ROUTE[action]
    if (!target) {
      return { ok: false, payload: '', error: '未知 action "' + action + '"：只认 ' + Object.keys(ROUTE).join(' / ') }
    }
    const spec = legacySpec(target)
    if (!spec || typeof spec.execute !== 'function') {
      return { ok: false, payload: '', error: '内部错误：action=' + action + ' 的实现缺失（' + target + '）' }
    }
    return spec.execute(args, exec)
  },
})