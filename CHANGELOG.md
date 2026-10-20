# Changelog

所有显著变更将记录在此文件中。
格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 权重自校准脚本 scripts/calibrate-weights.ts（10-20）

- **D 第二步**：`npx tsx scripts/calibrate-weights.ts` 跑**固定题面**的旋钮网格（titleBoost / coverageBoost / metaBoost / bestExcerpt，各组合独立子进程，因为 engine 在模块加载时读 env），产出 hit@1 / hit@10 / MRR + 反馈佐证 + 裁决。
- 判据**只一份**在 `pickWinner`：hit@10 下降一票否决（召回上限不能拿 hit@1 换）→ hit@1/MRR 至少一项严格提升且另一项不退化 → 并列取**离默认最近**（反过拟合）→ 反馈样本 `MIN_OPENS_FOR_CALIBRATION`(30) 不足则判决固定「保持默认」。
- `--dry` 只跑默认组合验证管线（不出建议）；`--json` 给结构化结果；**绝不写 config.json**（写配置是人的动作）。失败逐条非 0 退出（用法 2 / 运行期 3）。
- 实测 `--dry`：默认组合 hit@1 43.1% / hit@10 66.7% / MRR 50.6%（198 题固定题面）；当前真实反馈仅 2 次 open ⇒ 只报「样本不足」。23 条单测只测裁决与网格（不 spawn 基准）。

### 反馈采集真正生效：候选改「落盘快照」（10-20）

- **修一个"代码在、功能没生效"的洞**：`search_feedback` 表在真机上**从未存在过**。根因不是进程旧，而是候选只留**进程内存**，而真实调用链是两个进程（DSH 插件 `srelay_search` → 子进程 `srelay search`；`srelay_show` → 另一个子进程 `srelay show`）⇒ 永远借不到候选，一次都没记上。实测：重启 DSH + 真跑 search/show 后，全局库里连表都没有。
- 现在候选落**磁盘快照**（`<SRELAY_GLOBAL_HOME>/last-search/<sha16(project)>.json`，TTL 5 分钟，原子写）：MCP 与 CLI 走**同一条**判据；快照里只有 sessionId、名次、查询哈希、长度桶，**无正文、无明文查询、无路径**。
- 去重从「进程内 Set」改成**库级唯一索引** `(search_id, session_id)`：`search_feedback` 新增 `search_id` 列（老库就地 ALTER + 补索引，NULL 历史行不受约束）。跨进程重复 show 不再记两条。
- 新增 `srelay feedback [--json] [--days N] [--project id] [--top N]`：**采集状态**（快照新鲜/过期/损坏/项目对不上）+ 统计（次数/检索数/名次分布/长度桶/入口/常被打开）。0 条时逐条给排查动作，不猜。
- 样本门槛成为常量 `MIN_OPENS_FOR_CALIBRATION = 30`（CLI 与校准脚本共用）：低于它只报「样本不足」，不许调权重。
- 真机验收：`search → show` 记到 1 条（名次 1、`cli_show`），`srelay feedback` 显示 `1 / 30 样本不足`；两个真进程的集成测试各 1 条（含重复 show 只有一行）。单测 9 条（含快照损坏、项目串位、隐私不落明文查询）。

### 简报自动显示体检分（10-19）

- `srelay brief` 第一屏新增「🩺 记忆体检 N 分 · A/B/C/D」一行（判据仍是 `core/health/score.ts`，只加渲染；计算失败打印原因，不静默）。
- 目的：体检分不再是「要人记得敲 `srelay score`」的摆设——每个新会话开场就能看见记忆健康度。

### 头脑风暴五件套落地（10-19）

- **记忆体检分**：`srelay score [--json]`，0–100 + A/B/C/D；四块权重写死 40/25/15/20（证据覆盖 / 新鲜度 / 碎片率 / 审计 P0），每项口径都 import audit 的同一判据。**归档未决属已接受历史债，只进 notes 不计分**（与 10-19 拍板一致）；FTS 不一致才是计分 P0。无数据按 0.5 并明说。5 条单测。
- **跨项目经验市场**：`srelay market [topics...]`，按工作区/领域 + 话题词元重叠 + 复用次数推荐经验，每条带「为什么」（命中哪些词、复用几次）；零模型、只读。5 条单测。
- **决策冲突检测**：`decision-conflict` 并入 audit（P1，第 7 项）——同 topic 或实词重叠 + 极性相反（否定/放弃/改用 vs 采用/保留）+ 时间序 ⇒「后者可能推翻前者」。判据复用 `subjectTokens` / `hasNegation`；5 条单测。
- **简报自压缩**：超预算时按 `pinned > refCount > 新鲜度` 淘汰，而不是简单截断；refCount 只读 `search_feedback`，淘汰条数由 `counts.decisionsCompressed/unresolvedCompressed` 说出。8 条单测。

### 「为什么没找到」诊断（10-19）

- `srelay search` 0 命中时不再只说「未找到」：确定性归因五类——词不存在 / 词太泛（覆盖 ≥30% 会话）/ 时间窗收窄 / scope 收窄 / 词元太多（>3），并给对应建议。
- 判据只在 `src/search-svc/why-empty.ts` 一份（分词器 + SQL COUNT，零模型）；5 条单测。

### 一键交接包 `srelay handoff`（10-19）

- 新增 `srelay handoff [--out <file>] [--json]`：把简报、决策、未决、下一步、经验拼成**固定五段**的可转发文档（① 现在到哪了 ② 定过什么 ③ 还欠什么 ④ 下一步 ⑤ 坑）。
- 每条决策/未决带出处（sessionId + msgId/seq）；隐藏项（碎片 / 归档未决）在文档里明说；`--out` 落盘、`--json` 给原始 payload。纯渲染函数 `renderHandoff` 5 条单测。

### 三力落地：可解释 / 自愈 / 反馈采集（10-19）

- **B 检索可解释**：`srelay search --explain` 打印每条的分数构成（title 命中 / 覆盖度 / 长度惩罚 / 衰减 / 基础分 → 最终分）。`SearchHit.explain` 仅在 opts.explain 时填充，**不加时零开销、排序逐条不变**（7 条单测钉住）。
- **C 自愈**：`srelay doctor --fix`（默认 dry-run）。只修两类已知安全项：插件副本缺文件（从 `plugins/dsh` 补拷）、面板 vendor 落后（同步源码）。实测一次修 5 项、复查 0 待修；失败不影响其它项，每条都打印「改了什么/跳过原因」。13 条单测。
- **D 反馈采集**（自校准第一步）：全局库新表 `search_feedback`（查询只存 sha256 前 16 位，明文不入库）；候选只留进程内存 TTL 5 分钟；`srelay_search → srelay_show` 与 CLI 同链路记一条 open 事件。不改检索结果；库坏了也不让 show 失败。5 条单测。

### 交接包 · 「🗺 下一步」进简报（10-19）

- `srelay brief` 新增「🗺 下一步」段：读地图账本的 `context.next` 与 `doing`/`todo` 节点（最多 3 个），排在计数行之前。
- 只读；没有地图/读坏 ⇒ 整行不渲染（`collectNextStep` 返回 null），绝不猜。3 条单测。
- 同时：归档会话的未决按用户拍板**从简报隐藏**（复用 `scanArchivedUnresolved` 判据，计数进 `counts.archivedUnresolvedHidden`）；归档未决类 P0 不再在简报顶部报警（audit / health_events 照旧计数）。

### 审计阶段语义修正 + 路线图（10-19）

- **audit 阶段 `ok` 语义修正**：原来 `ok = p0===0`，一旦库里有 P0，生命周期里 audit 就永远 FAIL——既分不清「查出了问题」与「审计自己跑崩了」，`fails` 也会无限涨。现在 `ok = unreadable===0`（跑成了没有）；P0 的可见性由 brief 顶部告警 + health_events(warn) 负责，note 里也写明 `P0 n 项（已进简报告警）`。
- 新增 `research/ROADMAP.md`：现状数字、四条要求对照、四力路线（交接/自证/自愈/进化）、已证否清单、待拍板事项。

### 简报接线：会话卡 + 碎片过滤（10-19）

- **会话卡接进 `srelay brief`**：`src/cli/brief-cards.ts` 提供卡片装配与预算控制（`BRIEF_BUDGET_RATIO`），`brief.ts` 只决定「给哪几场出卡 + 放不放得下」。超预算时降级成单行并**明说**（`预算已用满：N 张卡降级为单行`），绝不静默截断。
- **存量决策碎片过滤**：展示层用 `vagueDecisionObject`（与抽取端、audit 同一份判据）拦掉旧碎片，末尾一行「已隐藏 N 条疑似碎片（旧数据）」；无碎片时一个字都不打。库不动、`srelay decisions` 仍全量可见。实测 agent1super：决策 4→2 条，隐藏 2 条。
- **预算下限修复**：真实 brief 基线仅 ~256B，×1.2=308B 而最短单行卡 99B ⇒ 卡片**永远 0 张**（功能等于没接）。改为 `max(基线×1.2, 基线+320)`，短简报至少落一张卡；实测 brief 从「0 张卡」变成「1 张完整卡 + 1 场省略（有说明）」。
- **卡片也必须过滤碎片**：cards 重渲染 stored decisions 时绕过了正文过滤，碎片「藏了又露出来」（task-14 的 ② 号测试当场抓到）。卡片装配改用同一份 `vagueDecisionObject` 拦截。
- 新增 10 条测试（task-14 3 条 + `brief-audit-alert` 3 条 + `brief-cards` 4 条：预算下限/不超上限/降级说明/降级保留证据）。

### 会话卡与审计契约（10-19）

- 新增 `src/core/cards/session-card.ts`：把一个会话压成结构化卡片（决策/未决/话题/文件/时间跨度 + 每条证据的 msgId/seq/原句）。判据全部 import 自 `core/extract`，零复制；先过 `sanitizeMsgs`，注入块不会被当成决策。10 条单测。
- 新增 `srelay audit`：六项只读健康检查（决策缺 msgId / 决策碎片 / 经验草稿超期 / 归档会话仍有未决 / 地图节点无 sources / FTS 一致性），P0/P1 分级、`--json`、退出码 0/1/2。7 条单测。
- 首跑 agent1super 实测：**P0 32 条**（归档会话的未决，出处永久指空）、P1 217 条（决策缺 msgId）、P1 2 条（决策碎片）、P1 13 个（地图节点无 sources，其中 12 个是 done = 假绿）。
- 修 `watch --status` 识别全局守护：原来只查项目文件锁，`--global` 明明在跑却报「未运行」（实测采集正常推进 35s +3 条消息时仍报未运行）。
- 新增 `scripts/decision-evidence-backfill.ts`（默认 dry-run，`--apply` 才写）：结论是**能回填 0 条**——392 条缺 msgId 的决策全在 179 场已归档会话里，正文已被 `runArchive` 删除，`messages` 表无行可指。8 条单测，含「剥掉 253 个真 msgId 再回填」的反事实验证（253/253 全对、幂等）。结论：msgId 缺口只能堵在写入时，堵不在回填时。

### 检索诊断与决策闸门（10-19）

- 新增 `scripts/recall-oracle.ts`：同一批题面上把「召回」与「排序」拆开。实测 305 题：词法可达 95.4%、不可达 4.6%；可达但排在 top-10 之外 53.1% ⇒ 瓶颈是排序。
- 融合 A/B（同题面）：默认 13.1/39.7、强制 12.1/40.0、关 9.5/38.0 ⇒ 强制融合没有赢默认，闸门不是主要矛盾。
- 决策抽取新增「自包含闸门」`vagueDecisionObject`：拒收『换成我们的了 / 换成你的问法 / 换成另一种错』这类宾语只有指代的碎片；带具体对象的决策不受影响。
- **检索默认启用标题/话题重排**（`titleBoost=1`）：305 题 hit@1 13.1%→20.7%、hit@10 39.7%→48.2%、MRR 20.0%→28.0%，McNemar p=0.0001；第二套 525 题同向 +1.2/+1.6。`SRELAY_TITLE_BOOST=0` 可关；语义档保持原有槽位语义。
- **返回片段改为「覆盖锚点最多的消息」**（`bestExcerpt`，同 120 字预算）：X 臂证据覆盖 34.1%→47.7%（+13.6pt，p=0.0169），检索排名不变；`SRELAY_BEST_EXCERPT=0` 可关。
- X 臂诊断：92.6% 是真跨会话题、91.6% 的证据其实已被 top-10 返回（hit@1 只有 8.4% 是指标错配）；自动会话链接与查询分句拆分均为负结果，已记录。
- **meta-only 命中不再返回空片段**：实测 X 臂 950 个 top-10 槽位里 389 个（40.9%）snippet 是空串、全部来自「只命中标题/话题」的会话。现在从该会话挑最能体现命中的正文消息；会话无正文时返回「正文已归档或为空」的明确说明。修后空片段 **40.9% → 0%**（950 槽位 0 空，228 个归档占位说明）。
- 问句外壳词表补入「几次 / 哪几次 / 哪几个 / 哪几场」等（X 臂 90/95 题带这些词，而 target 正文仅 19/95 含「几次」）。**但 `coreOnly` 仍保持默认关**：补表后 305 题 A/B 只有 hit@1 +1.7pt、hit@10 −0.3pt，仍不值得 +12.6% 延迟。
- **`srelay_search` 新增 `groups` 字段**（多会话组）：按「共享 topic / 文件」把命中会话聚成组，只新增字段、`hits` 结构不变 ⇒ 老调用方零影响。信号特异性过滤（df≤5 且 ≤2%）+ 组规模硬上限 3 + 至少 2 个共享信号才成组；实测 X 臂最大组规模 3、98.9% 的题能给出多会话组。
- **CLI `search` 同步输出会话组**：文本末尾打印「相关会话组（同一主题的几条会话）」+ 共享信号，`--json` 带 `groups` 字段。DSH 插件走 CLI 文本 ⇒ 无需改插件代码即生效。

### 新用户路径实测（把工具当陌生框架真跑一遍）

在一个空目录里从 `init` 开始，把 CLI 全部子命令、MCP（ZCode 那条 stdio）、DSH 工具、地图、简报、生命周期逐个真调了一遍。修掉的问题：

- **MCP 的 `srelay_search` 把 `query` 写成必填** ⇒ `kind=decisions` / `kind=unresolved` 这类不需要检索词的调用在 ZCode 侧被参数校验直接拒掉（-32602），而同一件事在 DSH 侧是允许的。现在 `query` 可选，只在 `kind=sessions` 上要求，并给出明确报错。
- **DSH 工具缺参时拿 `undefined` 当参数往下走**：`kind=history` 不带 `filePath` 会去搜字符串「undefined」（返回 20 个无关会话）。现在缺参直接报错并给示例。
- **`init` 的模板占位行进地图**：新项目一开张就多一个叫「（把真实任务写在这里）」的假任务节点，doctor / 看板 / 地图全被它污染。现在孵化与导入都跳过它（模板文案仍保留给人看）。
- **`map check` 在对账 0 个节点时撒谎**：把节点总数说成「N 个带证据源的节点全部未变」。现在报告里每个节点带 `sources` 计数，没配 sources 就明说「对账覆盖不到」。
- **`srelay show` / `related` 找不到时退出码 0**（脚本化会把「没找到」当成功）⇒ 改成 1；`map` 早就是三分法退出码，现在对齐。
- **`srelay lifecycle` 不带参数会直接跑一轮重活**（体检+采集+重算+老化）。新用户想看的显然是状态 ⇒ 默认只显示状态，要跑必须显式给 `--once/--force/--loop/--only/--light`。
- **`srelay mode` 不带参数报「缺少参数」** ⇒ 改为显示当前模式（改模式仍需显式给值）。
- **`sync` 把正常情况说成失败**：「地图孵化未成功」→「跳过」；`progress.md` 只有模板行/没有依赖列都算正常。
- **老化强度门的展示值与真实判据不同口径**：摘要打印 `strength≤0.667`，真实淘汰判据却是 `strength < 1/e ≈ 0.368`。现在展示值直接取真实阈值（窗只决定「多老算候选」）。

判据：新增 `test/unit/new-user-placeholder.spec.ts`（占位行两例）；`map-stale` / `d26-auto-archive` / `panel-snapshot` 三处断言跟着新口径更新。
### 插件工具实测第二轮（23:30）

把 DSH 侧四个工具当陌生工具逐个真调，发现上一轮「修好」的 `srelay_remember` 实际没生效：

- **`srelay_remember` 的修复只出现在 CLI 层，插件没改**：`4ed43c4` 加了 `srelay note` 命令，但 `integrations/dsh/src/tools.js` 里的 `srelay_record` 仍调 `save --recent 1d --summary`。所以 remember 依旧「报成功、decisions 查不到、pin 匹配不到」。这次真改：走 `note` 通道（与 MCP `save_note` 同源），并在插件 selftest 里加两条断言防回退。
- **参数校验被并发提交改回旧版**：`fe32880` 重写 `tools.js` 时把 `824c745` 里的 `kind=history/related` 缺参校验 diff 掉了，于是 `kind=history` 不带 `filePath` 又会去搜字符串「undefined」。这次恢复。
- **工具里只显示一坨命令行**：`show` 未找到会话时，CLI 把错误打在 stdout（`✗ 未找到会话：…`）而退出码非零，`execFile` 的 `error.message` 是 `Command failed: <整条命令>`。`execSrelay` 的兜底顺序改为 stderr > stdout 最后非空行 > error.message。

验证：临时项目里真跑插件 `recordTool.execute` → 写入后 `srelay decisions` 立刻能看到该条（source=note）；插件 selftest PASS（含新增两条断言）；`check-versions` 全绿；vendor 已重建。
### `forget` 的 help 教错了用法（23:37）

`srelay forget --help` 写着 `--note <id> 限定笔记`，照它调用 `srelay forget --note <id> --yes` 会直接打在用法上退出——`--note` 只是**类型过滤器**，目标必须放在位置参数里。help 教错比功能缺失更伤人：用户会以为软件坏了，而不是自己用错了。

- 现在：位置参数优先；没给就把 `--note` / `--session` 里的 id 当目标。它们**仍然**是类型过滤器（`typeFilterMismatch` 会核对目标是不是笔记/捕获会话），语义没有变宽。
- 用法行补上 `--note <id>` 形式；两个选项的说明改成「不给位置参数时，这个 id 也可直接当目标」。

验证：临时项目里 `note` 建一条笔记 → `forget --note <id> --yes` 成功遗忘；全量 923 passed / 1 skipped。
### 包名迁移收尾：`@ewanjasper/sessionrelay` → `memrelay`（23:45）

10-17 的会话里留过一条决策：「包名没改，因为改了会连锁出事」。连锁确实存在——43 处工具链引用旧名，其中两处是**运行时**的：DSH 插件 vendor 缺失时的 CLI 兜底、ZCode hook 的 CLI 解析。这次一次做完：

- 全局安装换成 `memrelay`（Release tarball），`srelay` 命令指向它；旧包已卸载、目录删除，只剩一份全局安装。
- 插件 `cli.js` 兜底顺序：vendor → `memrelay` → 旧名（旧名只留给还没迁移的机器，不是长期方案）。
- ZCode hook（`brief.mjs` / `engine.mjs`）候选路径 `memrelay` 在前；维护脚本（`check-versions` / `_mirror_dist` / `_install_zcode_mcp` / `ses-install` / `ses-panel-install`）同步。

验证：门禁 A 段 5 份运行时指纹完全一致（`ca156a305da8`）；hook 冒烟正常输出简报 JSON；`srelay --version` = 1.0.0；插件 selftest PASS。### 经验库的噪音与假升格（23:55）

查记忆时发现一条语音碎片经验（id 25）是 `verified`、`uses=50`，正在每场会话的简报里注入。追下去是三层问题：

- **匹配层**：经验候选是「子串包含关键词」，中文没有词边界——「要不要再」里含「不要再」，于是整句语音碎片被当成踩坑经验抓走。关键词表改成正则，`不要再` 加负向后顾 `(?<!要)`。
- **升格层（真正根因）**：`hits` 每轮采集都 +1（同一句话被重复扫描），`hits≥3 ⇒ 自动升 verified` 实际只代表「采集跑了 3 轮」，不是「反复发生的坑」。新增 `lesson_sources(lesson_id, source_ref)` 表，升格判据改成**不同出处数 ≥ 3**；`maintainLessons` 把历史上「单出处却 verified」的自动升格一次性回撤成 draft 并标 `needs_review`（只改状态、不改字）。
- **判据层**：决策侧 v27 的语音/口吃过滤与经验侧各写一份，于是同一句碎片「决策侧拒、经验侧收」。抽成 `src/core/extract/noise.ts` **一份判据**，两侧共用；经验候选侧直接拒收。

验证（真库）：`consolidate` 回撤 1 条（id 25 → draft）；连续两轮 harvest 同一出处，hits 仍为 4、状态仍 draft（旧实现会升 verified）；`brief` 的注入经验恢复为 3 条真经验。新增 7 条判据（`test/unit/lesson-noise-and-demotion.spec.ts` 6 条 + 升格语义改写 1 条），全量 **930 passed / 1 skipped**。### 看板/地图：`⏳ 待办` 被整行静默丢掉（00:10）

实测建一个 demo 项目：6 行计划里写了 `⏳ 待办` 的 3 行，`map import` 只导入了 3 行，**没有任何提示**。

- 根因：`readKanbanRows` 只认状态列以 `✅🔄⛔⬜` 开头，其余整行过滤掉；而人写「⏳ 待办」很常见。
- 修法：解析器与 `IMPORT_STATUS` 都接受 `⏳`（→ todo）；导入时把「因字形不认识被丢」的行数报出来（容错不许静默）。
- 验证：demo 6 行全部导入、按依赖排出 rank 0→5 六层（数据层→摄取层→检索层→CLI→面板→发布）；全量 930 passed / 1 skipped。
## [1.0.0] - 2026-10-18

第一个独立版本。仓库从上游 fork 独立成 memrelay，改法集中在两处：把「坏了会告诉你」做实，把「数据不会悄悄丢」做稳。

### 破的（对外可见）

- DSH 工具面 14 → 4。`srelay_search` 吃 `kind` 参数覆盖原来 7 个工具的能力，`remember` / `project` 各自合并。MCP 侧 `srelay serve` 保持 14 个不动。
- 包名 `@ewanjasper/sessionrelay` → `memrelay`（npm 尚未发布）。

### 修的（26 条，分四轮验证）

静默类 6 条、数据丢失类 7 条、项目隔离 1 条、地图 8 条、边界 4 条。逐条见 [docs/EVALUATION.md](./docs/EVALUATION.md) 与 CHANGELOG 下文。

### 判据

913 条测试通过 / 1 跳过；九道门禁全绿。

---
## [Unreleased]

### 文档（整仓重写，不再沿用上游叙述）

- **README / README.en 重写**：它是什么 / 不是什么、六块子系统分工、数据怎么流、检索实测与负结果、11 阶段、地图、接口面、已知限制。
- **新增六篇子系统文档**：`docs/CAPTURE.md`、`docs/EXTRACT.md`、`docs/STORE.md`、`docs/SEARCH.md`、`docs/LIFECYCLE.md`、`docs/INTERFACES.md`；
  另加 `docs/MAP.md`（地图层与自动孵化）与 `docs/README.md`（文档地图，按「现在的实现 / 怎么用 / 设计记录」分层）。
- **图**：新增 `map-real`（真实地图：13 节点 / 6 层 / 17 条边，由 `renderMapMermaid(root, [])` 直接导出）与 `map-hatch`（依赖列 → 拓扑分层 → 真边）；
  `session-flow` 重画——**之前把抽取画在采集链路里，是错的**（抽取由 judge 与 recompute 驱动）。
- **修文档与代码不符**（一次独立审计查出 23 处不符 / 9 条断链，逐条带双证据，报告留在 `docs/_audit/staleness.md`）：
  MCP 工具数口径自相矛盾、DSH 插件路径与工具数（`plugins/dsh`→`integrations/dsh`、14→4）、包名与版本（`@ewanjasper/sessionrelay`→`memrelay`、0.1.0→0.5.1-fork.2）、
  `srelay semantic enable`→`--enable`、已废弃工具名（`get_decisions` 等三个）、不存在的配置键（`map.dir` / `map.rows_max`）、`archive --topic`、
  默认配置里的「热读 / 启动固化」口径、脱敏模式条数（5 类 → 6 类 8 条正则，含裸 JWT）。

### 修复

- **含「待办」节点的 `board.mmd` 整张图解析失败**：Mermaid 的平行四边形必须闭合（`[/"…"/]`），`shapeOf()` 少了结尾那个 `/`。
  已加回归测试（`test/fork/kanban-map.spec.ts` ⑩：任何一处 `[/"` 都必须以 `"/]` 收尾）。
- **面板 `aging` 的热窗缺省值 30 与归档路径的 60 不一致** ⇒ 统一 60（同一判据不许写两份）。
- `doctor` 提示写成不存在的子命令 `srelay semantic enable` ⇒ 改为 `srelay semantic --enable`。
- 时间衰减默认值的注释漂移：代码 `DEFAULT_DECAY.enabled = true`，注释写「默认关」⇒ 注明以代码为准。
- `src/mcp/server.ts` 注释「第 16 个工具」⇒ 14；`src/map/bridge.ts` 注释里承诺的 `map.rows_max` 配置键并不存在 ⇒ 改正为「由调用方传」。
- 删除误入仓库的空目录 `integrations/srelay-autoinit-*`；**删掉 README 的 CI 徽章**——它此前指向一个不存在的 workflow。
  CI 本身先不上：Windows runner 上原生模块（better-sqlite3）装不起来，试过两版都红，与其挂个常红徽章，不如明说没有 CI。

## [0.5.1-fork.2] - 2026-10-18

### ⚠️ 契约变化（消费方请注意）

- **DSH 原生工具面 14 → 4**（`integrations/dsh`）：
  - `srelay_search` 现在吃 `kind`：`sessions`（默认）/ `decisions` / `unresolved` / `lessons` / `files` / `related`
  - `srelay_show` 不变（其余四个都是「找」，只有它是「读全文」）
  - `srelay_remember`：`summary` → 记决策；`text` → 置顶/取消置顶
  - `srelay_project`：`action` = init / bind / confirm / cancel / stats
  - 被合并的 10 个旧工具名**不再注册**；实现保留（新工具路由到同一份代码，零逻辑复制）
  - `srelay_search.query` 不再是必填（`kind=decisions/unresolved` 不需要它）
- **`srelay_search(limit)`**：负数不再返回「全部减 N 条」，入口统一 clamp 到非负
- **采集 seq 代际**：源文件被整段重写后，新内容进 `seq = rewrites × 1e6 + 行号` 的独立空间
  （旧文保留、新文也进库）。同一 seq 上不再发生「读得到写不进」
- **地图不再从看板反推 status**：地图是结构真值，看板只是它的投影（`docs/map-cli.md` §415 的承诺现在是真的）

### 新增

- **地图增量同步**：看板新增行 → 地图新增节点（落 `inbox` 层，**不猜它属于哪层**）；
  只增不删、只同步状态、单轮上限 20；匹配极少时判为人写结构图、不新增
- **地图开工档位** `map.hatch`：`always`（默认）/ `complex`（人写行 ≥ complex_min_rows）/ `manual`
- **决策时效标注**：`ageDays` 字段 + 30 天旧标。**明确不做自动推翻**（判不出来，且误判无声无息）
- **评测基建**：305 题 paraphrase 题集 + 唯一校验脚本 + 按**会话聚簇**重采样的配对比较（McNemar）
  - 实测：hit@1 11.5% ±[题级 3.44pt / 簇级 3.85pt]，hit@10 45.6%；
  - 簇级只比题级宽 1.12 倍 ⇒ 同一会话的题**并不高度相关**（原先按题数推算的 ×1.70 是错的）

### 修复（三路独立红队 + 一轮验证红队，共 30+ 条）

**静默类**（坏了不吭声，最难发现）：
- 采集 `warnings` 与 `source_files.suspect/bad_lines` **全仓无读取方** ⇒ 现在真的打出来（跨轮去重）
- 单源/单会话抛错拖垮整轮采集 ⇒ per-source / per-session 隔离
- `extract` / `cleanup` 吞 per-project 错误 ⇒ note 里显形
- **`guard` / `repair` 的 `ok` 恒真** ⇒ `runOne` 支持 `{ok:false}`
  （实测：「283 轮 11 阶段全 OK」对 guard/repair/extract/cleanup 四个阶段原本不携带任何信息）
- `guard` 从恒真变成会失败后**自己进了熔断** ⇒ 加 `NO_BREAKER` 白名单（体检不该被冷却）

**数据丢失类**：
- `cleanup` 重写 `meta_text` 只写 title+topics ⇒ **决策从检索索引里静默消失**；改用 `recomputeSessionMetaText` 唯一口径
- 源文件**变大式**整段重写后新正文永久丢（连 conflict 都不报）⇒ `readTailProbe` 搬进共享 tailer，三适配器共用
- ZCode 压缩摘要占位 seq 撞掉真实消息 ⇒ 挪到 1e9 起的独立空间（按 `time_created` 偏移，跨轮幂等）
- `last_event_at` 可倒退（10-17 被 06-01 盖掉）⇒ 改 MAX。**它参与归档判定，倒退 = 可能提前蒸发正文**
- 0 字节库被判 `error` ⇒ repair 永久「本轮跳过」而 guard 报异常（两阶段自相矛盾）⇒ 归入 `missing`
- `runArchive`：`BEGIN IMMEDIATE` 之后、`try` 之外的 `insertCleanupLog` 抛错 ⇒ 写锁不放、归档永久失败

**项目隔离**：
- Qoder 同名项目会互相认领会话（`company-a/app` 与 `company-b/app`）⇒ 按「绝对路径的常见摘要」精确匹配，
  对不上就**拒绝认领并报出来**（`SRELAY_QODER_TRUST_NAME=1` 可退回按名字认领）

**地图**：
- 节点 id 生成器产出**非法 id**（`kb1_x`，下划线不符合 `MAP_ID_RULE`）⇒ 第二次新增起整批被拒、**永久停摆**
- 每轮从看板反推 status ⇒ **静默回滚文档明写的地图改法**（见上方契约变化）
- 人写行只要**文本含** `auto:todos` 字样就被整行删除 ⇒ 判据改成模块列精确匹配
- 「0 匹配」护栏被 1 个偶然同名节点、以及同轮重复行击穿 ⇒ `matched` 只认存量 + 相对量上限
- 节点 label 含竖线时投影出的行被读回成「人写行」、多出幻影节点 ⇒ 在**投影侧**剥离
- `hatch` 补齐分层整页 remove+declare 会把人的 `blocked` 改回 `doing` ⇒ declare 时保住原 status

**边界**：
- `mcnemar` 在 `b+c ≥ 1075` 时下溢 ⇒ **p 恒 0（假显著）**；改对数空间（实测 (700,650) 从 0 修正回 0.1823）
- `limit` 负数 ⇒ `slice(0,-1)` 返回「全部减一条」
- `global.sqlite` 缺 `busy_timeout`（守护 + MCP 双进程写 ⇒ 立即 SQLITE_BUSY）
- `forget` 的防复活提示指向写死的 `.sessionrelayignore`，规则实际写进配置里那个文件

### 已知未修（有理由）

- `pathSlug` 有损（`D:/a-b/c` 与 `D:/a/b/c` 同 slug）⇒ 修它要改 slug 算法，现有库 `project_id` 全变，
  已采集会话全部对不上。属**迁移级**改动，需单独拍板
- 非 ISO 时间戳（`2026/10/10 10:00`）永不 pending/confirmed：概率低，而时间规范化会改所有时间比较行为
- meta 模式的计数口径：`meta` 本来就不存正文，该按什么算属**产品决策**而非缺陷
## [0.5.1-fork.1] - 2026-10-18

### ⚠️ 契约变化（MCP 消费方请注意）
- **`get_session_context`**：`range` 在空结果时从 `[from, from-1]` 变为 `null`；
  `totalInDb` 从会话的 `message_count` 改为**真实消息行数**（条数与序号不再是同一个量）。
- **`srelay_search` 的 `limit` 现在真的生效**（`kind=decisions` / `kind=unresolved` 以前静默忽略）；
  `scope` 对这两个 kind 也生效了 —— 以前它们会返回 scope 范围外的条目。
- `kind=decisions` / `kind=unresolved` **不按 `query` 过滤**（决策是结论清单，不是全文索引）。
  为免静默，响应里带 `not_applied: ['query']` 与说明；要按词筛请改用 `kind=sessions`。
- 其余 11 个工具只有新增字段，无删除/改名。

### 修复
- **DSH 事件钩子依赖的导出从未存在于发布模块**（审查 #17）：`integrations/dsh/src/hooks.mjs` 用
  `recall.js` 的 `loadConfig` / `runSync` 做宿主内即时采集，而产物只导出 `runLifecycle`
  ⇒ 事件驱动这一路恒失败；且失败日志被 `SRELAY_BRIEF_DEBUG=1` 挡着，等于默认静默
  （主路径 `srelay watch` 正常，所以症状是"偶尔慢半拍"而非完全没采集，更难发现）。
  现在 `src/recall-entry.ts` 显式导出这两个原语，钩子在**挂载时**校验一次导出契约，
  缺失/载入失败一律 `console.warn` 到宿主正常日志（去抖 8s + 冷却 60s 防刷屏）。
- **发布检查与实现脱节**（审查 #18）：`scripts/check-artifacts.mjs` 用 `registerTool(` 正则提取
  MCP 工具名，而实现早已改成封装过的 `register(` ⇒ 提取恒为空，脚本在第一条失败即停，
  「文档覆盖 / 旧计数」两段**从未执行**。改为解析真实 `register(...)` 调用，并加三条不变量
  （抽到 0 个 / 出现裸 `registerTool(` / 调用数与名字数不符，任一都判红），防止抽取规则再静默漂移。
  新增断言：从 `dist/recall.js` 加载并**真跑一次采集**（临时项目 + 合成 claude-code 会话），
  要求 1 会话 / 2 消息落库。
- **文档工具清单同步**：MCP 侧实际 **13 个工具（7 读 + 6 写）**；`README.md` 与
  `docs/user-guide.md` 里残留的「16 个工具」、旧工具名（`search_sessions` / `get_decisions` /
  `get_session_detail` / `get_file_history` / `get_unresolved`）以及 `set_scope` 的读写归属已改正。

### 新增
- 工作区根 `tools/ses-rebuild.mjs` 守门从 7 门增至 **8 门**：新增 `check:artifacts` ——
  此前天天说"七门全绿"，而发布检查红着却没人知道（不进守门的检查等于没有）。

## [0.5.1] - 2026-09-18

### 修复
- **测试套件污染真实注册表**：dist 冒烟测试以生产环境子进程跑真实 `srelay init`，而 init 的登记（0.5.0 新增）会把项目根写进全局注册表——实测三次全量测试留下三条 Temp 垃圾条目。修复：测试子进程统一以 `SRELAY_REGISTRY_DIR` 重定向到临时目录（读侧剪枝本就会剔除已消失路径，现在从源头不写）
- serve 根解析诊断补一行：deferred 模式下把 roots 回报数/有效数落到 stderr（本机验证 roots 链路时发现排障缺现场）

## [0.5.0] - 2026-09-18

### 新增
- **serve 根解析信号链（design-serve-resolve，0.5.0）**：环境变量 → cwd 向上探测 → **MCP roots 协议**（自动问客户端"工作区在哪"；仅当客户端声明 roots 能力才发请求，避免超时挂起）→ **全局项目注册表**（`~/.sessionrelay-registry/projects.json`，恰好一个存活守护时自动选中）。新信号只插在原有"找不到项目即退出"的失败路径上——现有 env / cwd 行为零改动（回归用例钉死）
- **解析失败不再 exit(1)**：MCP 连接照常建立、16 工具照常列出，工具调用返回 `unresolved_project` 指导载荷（各信号下场 tried + 候选项目列表 + howTo）。红线不变：候选多个时绝不静默猜项目（串库比连不上更糟），AI 带 `project` 参数选一次、本连接记住、可随时切换
- 全部 16 个工具新增可选 `project` 参数（项目根绝对路径），用于未解析 / 多项目场景的显式选择与连接内切换
- 全局项目注册表：`srelay init` 登记、守护每 10 分钟心跳、serve 任何成功解析也登记（目录名刻意避开 `~/.sessionrelay`——findRelayRoot 向上探测的就是该名字，语义目录 `~/.sessionrelay-semantic` 同款规避）；测试用 `SRELAY_REGISTRY_DIR` 重定向
- `srelay doctor` 新增"项目注册表"检查项：预先回答"无配置时 serve 会自动选中谁"

### 修复
- **Qoder 连 MCP 报 `MCP_STDIO_PROCESS_EXITED_BEFORE_READY · exit 1`**（用户实报，Qoder 侧 AI 交叉诊断、我方源码核实）：根因是 Qoder 启动 MCP 子进程不把 cwd 设为项目根，serve 找不到 `.sessionrelay` 起手退出且 GUI 客户端不透传 stderr。现按上述信号链 + deferred 模式根治；README（中/英）与 user-guide 接入文档同步
- `SRELAY_PROJECT_ROOT` 指向打不开的库：从未捕获异常堆栈改为干净 stderr 报错 + exit 1（退出时机与非零码不变）
- R3 测试抓出并修复：客户端真实能力在 MCP initialize 握手完成后才可查，connect 返回后立即读恒为 undefined——生产上 roots 会永远被判"不支持"

### 测试
- 新增 serve 根解析回归 9 例（R1/R2 钉死 env/cwd 旧行为、R3 roots 自动选中、R4 注册表单存活自动选中、R5 多候选指导+选择+记住+切换、R6 零候选指导、R7 注册表损坏降级、R1b 坏库干净报错、R9 显式切换），含"仓库根自带 .sessionrelay（dogfood）导致仓库内 cwd 全部误命中"的环境预检；全量 222 例

## [0.4.5] - 2026-09-13

### 修复
- **assistant 消息整批丢失（用户实报，另一 AI 交叉诊断确认）**：ZCode 先写 message 行、正文 part 流式后到；守护同步恰逢窗口期读到"无正文"行时跳过该行、游标却照常越过——正文落库后永久失扫。实测某会话 2167 条 assistant 全部丢失（user 完好：user 消息原子写入不踩竞态）。修复：宽限期（10 分钟）内游标停在空正文行之前，下轮重扫追回（seq_num 唯一键幂等）；过宽限的空行不拖死游标
- **历史缺口自愈**：schema v5 迁移自动清空 zcode 源游标，升级后首次 sync 全量重扫，丢失的 assistant 消息自动补回（已捕获的不重复）；claude-code 源不受影响（JSONL 行内原子写入无此竞态）

### 测试
- 新增竞态回归 4 例（R1 跳过不越界/追回、R2 幂等、R3 宽限防停滞、R4 全周期）+ v5 迁移 1 例，破坏性验证通过（回退修复 R1 即红）

## [0.4.4] - 2026-09-07

### 修复
- **npm 页面 License 显示 "Proprietary"**：package.json 缺 license 字段（npm 缺省行为），而 LICENSE 文件实为 MIT——显式声明，npm 页面现已正确显示

### 文档
- README（中/英）头部新增 shields.io 徽章行：CI 实时状态 / npm 版本 / 月下载量（实时）+ Node ≥22 / MCP 16 工具 / 三平台 / 语义检索可选 / MIT

## [0.4.3] - 2026-09-07

### 修复（内存评估驱动）
- **watch --status / doctor 不再全量读日志**：此前 readFileSync 整文件进堆再取尾部，大日志=内存尖峰；现 readLogTail 只 seek 读尾部（实测 5MB 日志堆增量 0.01MB）
- **轮转周期化**：此前仅守护启动时轮转，开机到关机不重启则持续堆积（实测本机增速约 60KB/小时 ≈ 1.4MB/天）；现守护内每小时检查一次，文件稳定在 1.1MB 峰值→截断保留尾部 100KB

## [0.4.2] - 2026-09-07

### 新增
- **守护日志落盘与可诊断性**（0.4.1 静默启动的补全——用户反馈："下次报错我可能都看不到了"）：
  - 三平台服务化运行输出统一落 `.sessionrelay/watch.log`（cmd 重定向 / launchd StandardOut-ErrorPath / systemd append）
  - 日志自轮转：超 1MB 启动时截断保留尾部 100KB，不自转就会慢慢吃盘
  - `srelay watch --status` 直接展示日志尾部；`srelay doctor` 在"服务已注册但守护未运行 + 日志含错误"时提示疑似异常退出
- 原则落定：静默启动换来的不是"没有信号"，而是"信号换了个地方"——平时零打扰，出错必有处可查

## [0.4.1] - 2026-09-07

### 修复
- **Windows 开机守护脚本失效（用户实报）**：服务注册此前把带 hash 的 chunk 文件名写死进启动脚本，srelay 升级重建 dist 后旧 chunk 消失，开机即报 `Cannot find module`。现解析稳定入口 `dist/srelay.js`，并在安装时预检入口存在性
- **开机闪黑框**：注册表 Run 键现指向 wscript 静默启动器（.vbs 隐藏窗口运行）——登录不再弹出 cmd 窗口
- **Windows 用户需重装一次服务**：`srelay watch --uninstall && srelay watch --install-service`

## [0.4.0] - 2026-09-06

### 新增
- **相关会话推荐 `suggest_related_sessions`（MCP 第 16 个工具）+ `srelay related <id>`**：搜索是你带着词去找，推荐是库主动告诉你"这几个和手头这个是一伙的"——记不清关键词时以会话为锚找线索
  - 双轨：语义向量相似（semantic 已启用时，active 锚即时嵌入不入库）+ 话题/标签/文件重叠打分（未启用语义时的降级），融合输出且每条带**可解释理由**（`向量相似 0.72` / `共享话题：数据库`）
  - 完全无状态：无新表无新配置；推荐不写入 session_links（防 A→B→A 回音室固化）
  - 导航辅助定位：不过 scope 契约（条目仅 brief 元数据）；输出明示"内容以 get_session_detail 为准"
  - 真模型验收 4/4（top1 合理性）；小语料下 bge 短文本 cos 挤在 0.6-0.7 的 tail 噪音如实登记于设计文档 §9
- **MCP 契约不变量升级**："恒 15 工具"（现为 16）的真正意图是删除类工具永远为 0——契约测试新增**名称黑名单扫描**（工具名含 delete/remove/forget/purge 即 fail），比计数更强且不随工具数增长失效
- **守护服务注册覆盖三平台**：`srelay watch --install-service` 此前仅 Windows（注册表 Run 键），现新增 macOS（launchd LaunchAgent）与 Linux（systemd user unit，附带 linger 尝试）——三平台同为"登录自启动"，卸载/状态对称（`--uninstall` / `--status`）
  - CI 验证策略：macOS runner 真装真卸（已注册→卸载→文件移除断言），Linux 因 runner 用户 systemd 不可靠只做内容断言，欢迎实机反馈
  - 行为对齐：不做崩溃自动重启（KeepAlive/Restart 关闭）——守护自带 30s 周期与懒启动兜底
- **产物断言脚本（`npm run check:artifacts`，已挂 CI 与 prepublishOnly）**：MCP 工具名在文档全覆盖、无旧工具计数残留、CHANGELOG 顶部版本与 package.json 一致——固化发版审核两轮事故（文档静默漏改 / 包体积膨胀）的防线

### 变更
- 服务注册实现收敛到 `cli/service.ts`（Windows 原逻辑不变），`watch.ts` 只保留守护入口

## [0.3.1] - 2026-09-05

### 修复
- **npm 包体积事故（发版审核抓出）**：`dist/` 中累积了历次构建的孤儿 chunk（tsup 只清理它认识的文件，模块改名后旧 hash 文件静默残留），0.3.0 及更早版本的包携带了最多 94 个死代码文件。`build` 脚本现先清空 `dist/` 再构建——0.3.1 包 142 → 46 文件（99.5KB）。功能无影响（孤儿文件无人引用），但请从 0.3.1 起使用

## [0.3.0] - 2026-09-05

### 新增
- **语义检索（可选，`srelay semantic`）**：换一种说法也能命中——"登录"↔"认证"、"很卡"↔"性能"这类换词查询不再落空
  - 实测依据：12 个真实感技术会话语料上，同义查询 miss 率 33% → **0%**（12/12），字面命中不劣化（5/5）
  - 本地 CPU 推理（bge-small-zh-v1.5，Q8 约 35MB），零云端依赖；依赖与模型装在用户缓存目录 `~/.sessionrelay-semantic`，npm 包体积不变
  - `srelay semantic enable` 一条命令：自动装依赖（国内走 npmmirror）+ 模型就绪（`HF_ENDPOINT=https://hf-mirror.com`）+ 存量回填；`disable` / `status` / `test "查询"` 对比 FTS 与融合效果
  - **融合原则：字面优先、语义补充**——FTS 命中永不被替换，语义命中以 `viaSemantic` 标注追加在后（top-5 限量 + 余弦阈值 0.4 可调）
  - 检索性能：5000 会话级全量余弦 2.6ms/查询（暴力扫描，无 ANN 依赖）；嵌入约 20ms/条，守护每周期限量补嵌不抢 CPU
  - 未启用时行为与 0.2.5 完全一致（可选参数注入，MCP 恒 15 工具）；schema v3→v4 自动迁移（`session_vectors` 表，启用前恒空）
- 生命周期联动：resume 回滚/归档时删向量（正文变了语义即过期），forget 的 CASCADE 自动清向量，换模型自动全量重嵌
- `srelay doctor` 新增语义检查项；`srelay status` 面板新增语义状态行

### 修复
- digest 正文拼接改为 SQLite 端限量截断（前 30 条 × 200 字）——大会话不再全量拼接
- 嵌入失败的目标自动跳过并计数（防毒丸阻塞队列），进程重启后自动重试；enable 回填循环加双轮零产出退出保护

## [0.2.5] - 2026-09-03

### 新增
- **遗忘权 `srelay forget`**：删除权交还给人——整条会话（含决策）从本库彻底消失，AI/MCP 保持零删除能力（工具恒 15 个）
  - 两阶段确认：无 `--yes` 仅预览（年龄/移除/保留/双向链接对方/imported 警示），`--yes` 单事务执行
  - **双防复活闸**：`.sessionrelayignore` 新增 `session:<source>/<sid>` 精确规则（主防线，跨 rebuild 存活）+ 墓碑表（次级防线）——原始文件还在磁盘，但本库永不重新收录
  - 前缀歧义防护：多命中时列出候选表格拒绝执行，绝不静默猜一个
  - 乐观锁：预览到执行之间数据变化（如守护新捕消息）→ 重统计 diff 拒绝执行
  - `--all` 整库重置：守护运行中拒绝 + `--confirm <projectId>` 逐字确认 + `forgot-at-<ts>.txt` 库外摘要
  - `--history` / `--history --verbose`：遗忘审计永久可查
- schema v3：`forget_tombstones` / `forget_log` / `forget_detail`（旧库打开自动迁移，降级打开明确报错）

### 变更
- `save_note` 返回话术补充"可由用户以 srelay forget 移除"；`archive --hard` 帮助引导 forget（防复活缺口明示）
- README 新增「遗忘权」小节（含 archive 与 forget 选型口诀）
- `srelay save` 命中遗忘闸时给出非静默提示（曾被 forget 的会话不会被静默吞掉）

### 测试
- 新增 `test/forget/` 43 用例（按三轮迭代的测试用例集 v3）：功能/检索不命中/误用防护/并发乐观锁/整库重置，以及**防复活对抗**——用真实源文件（JSONL 字节游标 + SQLite rowid 游标双源型）验证删后增量 sync、rebuild、手动 save 三条路径均不复活

## [0.2.4] - 2026-09-01

### 测试
- 新增发布产物冒烟套件：直接测试 `dist/srelay.js`（用户实际运行的文件），覆盖 `--version`/`init`/MCP 握手，断言版本与 `package.json` 一致（运行时无变更）
- 新增 `npm run e2e:pack`：npm pack → 全新目录真实安装 → bin → init/status → MCP 握手的端到端验证
- CI 三平台（ubuntu/windows/macos）挂载 pack-e2e，并修正 test/build 顺序使产物冒烟真正生效

## [0.2.3] - 2026-08-31

### 修复
- MCP 握手 `serverInfo.version` 与 `srelay --version` 改为读取 `package.json`（此前硬编码 `0.1.0` / `0.2.0`，与实际版本脱节，误导排障）
- `srelay doctor` 的 Node 版本检查从 ≥18 对齐为 ≥22（与 engines 声明一致；better-sqlite3 / jieba 预编译按新 ABI 分发，旧版 Node 会以难排查的方式失败）

## [0.2.2] - 2026-08-31

### 文档
- README 新增 4 张架构/流程图：架构总览（全景）、记忆生命周期（状态机）、HOP 交接时序图、守护进程对比（timeline）
- README 修正过时信息：五源适配现状、125 测试数、路线图清理（移除已完成项）
- 文档区精简为用户视角 5 条；设计决策文档入口移至 CONTRIBUTING
- 过程性内部资料（阶段报告 P0-P3.5、第三方存储格式逆向笔记）移出公开仓库（本地保留）

## [0.2.1] - 2026-08-30

### 变更
- npm 包精简：813 → 39 文件（1.3MB → 79KB），移除内部文档与 sourcemap

## [0.2.0] - 2026-08-29

### 新增
- **归档机制**（`srelay archive`）：按时间/体积归档旧会话，保留决策骨架释放 99.4% 空间；硬删除模式；归档审计日志（`--history --verbose`）
- **MCP 写域 7 工具**（总计 15 工具）：`annotate_session` / `save_note` / `export_handoff` / `import_handoff` / `release_quarantine` / `link_sessions` / `get_linked_sessions`
- **关键往返提取**：confirmed 时自动提取"用户提问+AI 结论对"（`include_exchanges`），归档后推导过程的中间粒度
- **五源适配**：新增 Codex + Qoder + Trae（部分）适配器，加上原有 Claude Code / ZCode 共五源
- **适配器注册表**：统一 `SessionSourceAdapter` 接口 + `.sessionrelay/adapters/*.js` custom 通道，加新 agent 零改核心
- **init 源选择**：检测已安装 AI 工具，交互勾选或 `--sources` 参数指定
- **守护懒启动**：任何 CLI 命令或 MCP serve 发现守护不在 → 自动后台拉起
- **`watch --install-service`**：Windows 注册表 Run 键（无需管理员）
- **MCP 上下文安全护栏**：get_session_detail 默认 20 条 × 1000 字 + 50KB 硬顶 + estimated_tokens + 省 token 路径引导
- **`srelay doctor` 扩展至 14 项检查**（含五源可达性/归档表/custom 适配器）
- **comaction 摘要捕获**：ZCode 压缩时 AI 生成的摘要存为 system 消息（不丢推导过程）
- **`srelay export --format markdown|summary`**：HANDOFF.md 直出

### 修复
- full 模式和 save_note 维护 message_count
- HOP 导入归化（project_id 重写，原值存 origin_project）
- ignore 谓词按排除语义编译（NOT OR）
- sessions_fts 补 INSERT/DELETE 触发器（meta 模式检索修复）
- rebuild 后状态从事实推导（超冷却期直接 confirm）
- 守护三项泄漏（合并去抖/连接缓存/重复 watcher）

### 变更
- **自动捕获与手动 save 并存**（D2）：mode off 时 save 是唯一入口
- **Scope 交集语义**（D5）：只能互相收窄，`set_scope({mode:'full'})` 逃生口
- **出处块 100% 强制**（D10）：所有检索结果携带来源标注
- **命名统一**：SessionGraph → 会话接力 / SessionRelay（D1）
- 包名改为 `@ewanjasper/sessionrelay`
- 移除 `purge` 命令（归档替代）

## [0.1.0] - 2026-08-28

### 新增
- 首个公开发布：MVP Phase 0-3.5 全量交付
- 双源适配（Claude Code JSONL + ZCode SQLite）
- 中文检索（jieba + FTS5，C1-C6 验收用例）
- MCP Server 8 个只读工具（stdio，契约测试真握手）
- Scope 检索边界（A/B/C 三档 + 交集语义）
- HOP 交接包协议（hop/1.0，sha256 完整性 + 默认脱敏 + 隔离导入）
- 三档隐私模式 + .sessionrelayignore 硬边界
- 两阶段会话结束判定（active → pending → confirmed）+ resume 自动回滚
