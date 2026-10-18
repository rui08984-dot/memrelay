# 文档一致性审计报告（只读）

> 审计对象：`README.md`、`docs/ARCHITECTURE.md`、`docs/EVALUATION.md`、`docs/user-guide.md`、`docs/map-cli.md`、`docs/默认配置.md`、`docs/import-export-guide.md`、`docs/privacy-and-lifecycle-design.md`、`docs/adapters/README.md`、`docs/design/design-map-layer.md`
> 代码基准：仓库 `D:/dsh插件  记忆/core/SessionRelay`，git HEAD = `e3fbe76`（工作树有未提交改动，以磁盘现状为准）
> 版本基准：`package.json` version = **0.5.1-fork.2**；`EXTRACT_VERSION` = **26**（`src/core/extract/version.ts:64`）；`SCHEMA_VERSION` = **6**（`src/store/db.ts:17`）
> 方法：只读静态核对（grep / ls / node -e 读 JSON / git log）。**未修改任何源码或既有文档，未跑 npm test / 全量门禁**（按任务纪律），因此"测试条数""性能数字"等需实跑的断言标注为无法核实或不精确。

## 结论摘要（不符 23 条 / 断链 9 条 / 无法核实 9 条）

- **不符 23 条**：集中在四类 —— ① MCP 工具数与读写分类（README 自己三处互相打架，且漏一个真实工具 `srelay_lessons`）；② DSH 相关（插件路径写成 `plugins/dsh`、说 14 个原生工具实为 4 个、把已上线的 DSH 适配器写进"路线图"）；③ 已改名/已废弃的工具名与子命令（`get_decisions` / `get_unresolved` / `get_file_history` / `srelay semantic enable`）；④ 配置项与"热读/重启"描述（`map.dir`、`map.rows_max` 两个键代码里不存在；`archive.*`/`recompute.*` 实际是启动固化）。
- **断链 9 条**：`integrations/zcode`、`integrations/codex`、`plugins/dsh`、`.github/workflows/ci.yml`、`docs/adr-002-bigram-tokenizer.md`、`tools/_mirror_dist.mjs`、`tools/check-versions.mjs` 等在本仓库都不存在。
- **无法核实 9 条**：性能/延迟/体积类数字、无产物支撑的评测字段（MRR、P50）、"修了 30 条缺陷"、"14 → 4"的前一态（本仓库 git 已压缩为单个初始提交）。
- **核对通过的高风险项（供对照，不计入不符）**：MCP 工具名清单（`src/mcp/server.ts` 14 处 `register(`）、STAGES 11 阶段、适配器目录 6 个、`EXTRACT_VERSION=26`（`docs/ARCHITECTURE.md:55` 写"v26"正确）、`srelay_show` 20 条×1000 字/50KB 硬顶（`src/mcp/server.ts:329-331`）、图谱 100 节点/1200 边（`src/panel/snapshot.ts:987,1025,1042`）、`docs/默认配置.md` 全部出厂默认值、`docs/EVALUATION.md` 的 hit@1 11.5% / hit@10 45.6% 及三臂数字（用 `scripts/bench-out/baseline-305.json` 逐格复算一致）。

## 不符

| # | 文档位置 | 文档原文 | 实际 | 证据 |
|---|---|---|---|---|
| 1 | `README.md:297` | 「MCP Server（14 个工具，7 读 + 6 写）」 | 7+6=13，句子内部就不成立。实际 14 个工具 = **8 读 + 6 写**（`srelay_lessons` 属读域） | `src/mcp/server.ts` 共 14 处 `register('…')`：174/312/468/483/**503**/556/578/604/620/647/669/679/700/713；`docs/user-guide.md:378` 自己写的是「读工具（8 个）」 |
| 2 | `README.md:306-317` | 「7 个读工具」表 | 表内只有 7 个，**缺 `srelay_lessons`**——它是代码里注册的读域工具 | `src/mcp/server.ts:503 register('srelay_lessons', …)`；`docs/user-guide.md:389` 有它 |
| 3 | `README.md:550-580` | 「### 14 个工具能回答什么」+「读工具（6 个）」+「写域工具（7 个）」 | 两表唯一工具合计 **13 个**，不是 14：读表把 `srelay_search` 列了两遍（`srelay_search` 与 `srelay_search kind=decisions`），缺 `srelay_lessons` 与 `get_linked_sessions`；写表又把**只读**的 `get_linked_sessions` 算进写域 | 读域：search/show/list_sessions/get_stats/set_scope/get_linked_sessions/**srelay_lessons** 共 8；写域 6 个见 `server.ts:578-679`；`get_linked_sessions` 实现只做查询（`server.ts:700-710`） |
| 4 | `README.md:74` | 「**DSH** ｜ `plugins/dsh` + 面板 ｜ **14 个原生工具** + …」 | ① 仓库**没有 `plugins/` 目录**，DSH 插件在 `integrations/dsh`；② DSH 插件只注册 **4 个**原生工具 | `ls` 根目录无 `plugins/`；`integrations/dsh/src/index.js:22-31` 只 `register` search/show/remember/project 四个；与同文件 `README.md:46`「DSH 工具面 14 → 4」自相矛盾 |
| 5 | `README.md:70` | 「本仓库额外提供**三个适配器**（`integrations/` 目录）」 | `integrations/` 下只有 `dsh/` 与 `srelay-autoinit-Sd4tb0/`（后者只有一个 `.git`，无插件内容），**没有** zcode/、codex/ 两个目录 | `ls -la integrations`；`find integrations/srelay-autoinit-Sd4tb0` 仅 `.git` |
| 6 | `README.md:253`、`README.md:186-192`、`docs/user-guide.md:12-17` | 「**五源适配**：Claude Code · ZCode · Codex · Qoder（完整支持）+ Trae（部分）」，架构图 Sources 也只有 CC/ZC/CX/QD/TR | 代码注册 **6 个**适配器（含 **dsh**），默认配置 `capture.sources` 也含 `'dsh'`——文档枚举与图都漏了 DSH | `src/adapters/registry.ts:158-163` 六次 `register(...)`；`src/shared/config-merge.ts:137 sources: ['claude-code','zcode','codex','qoder','dsh']` |
| 7 | `README.md:645`、`README.md:649` | 「DSH / Cursor 等其他工具在**路线图**（当前可用自定义适配器先行接入）」；路线图里「DSH / Cursor 官方适配」 | DSH 官方适配器**已实现并默认启用**，不是路线图项 | `src/adapters/dsh/{index.ts,format.ts}`；`registry.ts:162 register(dshAdapter)`；默认 sources 含 `dsh`（`config-merge.ts:137`） |
| 8 | `README.md:490` | 「`srelay watch --foreground` # macOS/Linux 前台运行（**服务注册开发中**）」 | launchd / systemd user 服务注册**已实现**；同文件 `README.md:640` 又写"三平台可用"，`docs/user-guide.md:313` 也如此 | `src/cli/service.ts:1`（三平台）、`:91-130`（launchd/systemd 路径）、`:214-245`（install 分支） |
| 9 | `README.md:261`、`docs/user-guide.md:272-275`、`docs/user-guide.md:657-659` | `srelay semantic enable` / `srelay semantic test "…"` / `srelay semantic status` / `srelay semantic disable` | CLI **没有** `enable/disable/status/test` 子命令，只有旗标：`--enable` / `--disable` / `--status` / `--test <query>`。按文档写法会落到默认 status 分支，不会启用 | `src/bin/srelay.ts:183-196`（`semantic` 只注册了旗标）；`src/cli/semantic.ts:17-25`（`SemanticFlags`）；**附注**：`src/cli/doctor.ts:235` 的提示文案也写成 `srelay semantic enable`，属代码侧同病，修复时一并改 |
| 10 | `README.md:288` | 「（Node 不热重载，且 `watch.ts` 的 cycle 用**启动时的配置快照**）」 | 1021 #02 起每轮 sync 前都 `loadConfig` 热读新配置；只有 6 项"启动固化"（`capture.sources`、`archive.enabled/hot_days/workflow_days/check_every_min`、`recompute.check_every_min`）才需重启 | `src/capture/watch.ts:106-121`（"运行期配置：每轮热读"的修复记录 + `startupFixedConfig` 六项清单）、`:141-146`（`STARTUP_FIXED_NOTES`） |
| 11 | `README.md:632` | 「**222 个测试**（单元 / 集成 / MCP stdio 真握手契约 / …）」 | 静态计数 = **95 个 `*.spec.ts`、879 个 `it()/test()` 用例**，与 222 相差数倍。精确运行条数未取（按纪律未跑 vitest），但"222"已被静态事实否证 | `find test -name '*.spec.ts' \| wc -l` → 95；`grep -rhoE '^\s*(it\|test)(\.skip)?\(' test --include=*.spec.ts \| wc -l` → 879 |
| 12 | `docs/user-guide.md:97` | `srelay --version   # 0.1.0` | 当前版本 **0.5.1-fork.2**（`srelay --version` 直接读 package.json） | `package.json:3`；`src/bin/srelay.ts:5-6,10`（`.version(VERSION)` 取 `pkg.version`） |
| 13 | `README.md:444,447`、`docs/user-guide.md:78,81` | `npm install -g @ewanjasper/sessionrelay` / `npx @ewanjasper/sessionrelay init` | 包名是 **`memrelay`**（无 `@ewanjasper` scope） | `package.json:2 "name": "memrelay"`；`bin` 里只有 `srelay`/`sessionrelay` 两个可执行名 |
| 14 | `docs/user-guide.md:87` | `git clone https://github.com/EwanJasper/SessionRelay.git` | 本仓库是 `rui08984-dot/memrelay`（`README.md:412,450` 已用新地址，user-guide 未跟改） | `package.json` `repository.url = git+https://github.com/rui08984-dot/memrelay.git` |
| 15 | `docs/user-guide.md:426` | 交接时序图里「`AI->>包: get_decisions()`」 | `get_decisions` **已不存在**：10-14 起四个检索工具并入 `srelay_search` 的 `kind` | `src/mcp/server.ts:165-166`（"原为 search_sessions / get_decisions / get_unresolved / get_file_history 四个工具"）；全库无 `register('get_decisions'` |
| 16 | `docs/import-export-guide.md:30-32` | 「→ 调 `get_decisions()`」「→ 调 `get_unresolved()`」「→ 调 `get_file_history("src/auth/jwt.ts")`」 | 三个工具名**全部不存在**（同上，已并入 `srelay_search(kind=sessions\|decisions\|unresolved\|files)`） | `src/mcp/server.ts:165-166`；14 个实际工具名见 `server.ts` 的 `register(` 清单 |
| 17 | `docs/import-export-guide.md:165` | 「目前覆盖 **5 类模式**（连接串/AKIA/私钥/Bearer/密码赋值）」 | 实际 **8 条正则 / 6 类**：连接串、AKIA、私钥、Bearer、密钥赋值（拆 dq/sq/裸值三条）、**裸 JWT**（文档漏了 JWT） | `src/relay/redact.ts:30-49`（`PATTERNS` 8 项，含 `:46 { name: 'jwt' }`） |
| 18 | `docs/默认配置.md:81` | 「`capture.*` / `archive.*` / `recompute.*` ｜ 守护进程**下一轮**读取，最多 60 秒」 | `capture.mode` 确为热读；但 `archive.enabled/hot_days/workflow_days/check_every_min` 与 `recompute.check_every_min` 属**启动固化**项，改了要重启守护才生效 | `src/capture/watch.ts:118-128`（`startupFixedConfig` 六项）、`:139-146`（`STARTUP_FIXED_NOTES` 明文"启动时固化"） |
| 19 | `docs/map-cli.md:15`、`docs/design/design-map-layer.md:44` | 「`<root>/.sessionrelay/map/<page>.json`（默认页 `map.json`；**目录可用 `map.dir` 配置**）」 | **没有 `map.dir` 这个配置键**；地图目录硬编码 `<root>/.sessionrelay/map` | `src/shared/config-merge.ts:70-73`（`map` 块只有 `hatch`、`complex_min_rows`）；`src/map/store/page.ts:35-37`（`mapDirOf` 直接拼 `.sessionrelay/map`）；全库 grep `map.dir`/`SRELAY_MAP_DIR` 无实现 |
| 20 | `docs/map-cli.md:411`、`docs/design/design-map-layer.md:197` | 「上限 `maxRows`（默认 12，**可配 `map.rows_max`**）」 | **没有 `map.rows_max` 键**，且唯一的生产调用点不传 `maxRows` ⇒ 恒为默认 12（改配置无效） | `src/shared/config-merge.ts:70-73`（无该键）；`src/cli/kanban.ts:191 mapKanbanRows(root, {})`；`src/map/bridge.ts:213 normRows(opts.maxRows)`；`bridge.ts:43` 注释自称"可配 map.rows_max"也与实现不符 |
| 21 | `docs/privacy-and-lifecycle-design.md:113` | 「`srelay archive --topic "薪资" --hard`」 | `archive` **没有 `--topic` 选项** | `src/bin/srelay.ts:667-681`（archive 选项：`--days/--before/--size/--source/--sessions/--hard/--dry-run/--history/--verbose/--session/--include-protected/--json`） |
| 22 | `docs/privacy-and-lifecycle-design.md:4` | 「**状态**：定稿，**待实施**」 | 文内 §四 的 9 项实施计划**已落地**：`archive` CLI（含 hard/dry-run/history）、`cleanup_at`/`original_message_count` 迁移、`cleanup_log`/`cleanup_detail`、复活、rebuild 跳过 | `src/cli/archive.ts`；`src/store/db.ts:143-153`（cleanup_detail 表 + 索引）、`:309`（`ALTER TABLE sessions ADD COLUMN original_message_count`） |
| 23 | `docs/ARCHITECTURE.md:11,63,87`【格式】 | 三处孤立一行 `![`（下一行才是真正的图片） | 图片语法被截断，渲染时会多出字面 `![` 且第一张图前的 alt 文本丢失 | `grep -n '^!\[$' docs/ARCHITECTURE.md` → 11/63/87；正确写法见 `README.md:152`、`docs/ARCHITECTURE.md:13` |

## 断链

| # | 文档位置 | 引用的路径 | 核实结果 |
|---|---|---|---|
| 1 | `README.md:74` | `plugins/dsh` | 不存在（仓库根无 `plugins/`；DSH 插件实为 `integrations/dsh/`） |
| 2 | `README.md:75` | `integrations/zcode` | 不存在（`integrations/` 只有 `dsh`、`srelay-autoinit-Sd4tb0`） |
| 3 | `README.md:76` | `integrations/codex` | 不存在（同上） |
| 4 | `README.md:79` | `integrations/codex/README.md` | 不存在（同上） |
| 5 | `README.md:8` | `.github/workflows/ci.yml`（CI 徽章） | 不存在：仓库**没有 `.github/` 目录**，徽章指向的 workflow 无对应文件 |
| 6 | `README.md:282` | `docs/adr-002-bigram-tokenizer.md` | 不存在（全库 `find . -name '*adr*'` 无结果；仅在 README 这一行被引用） |
| 7 | `docs/design/design-map-layer.md:12` | `dsh-plugin/index.js:311` | 目录不存在（无 `dsh-plugin/`；对应实现是 `integrations/dsh/index.js`，且该文件仅 31 行，无第 311 行） |
| 8 | `docs/design/design-map-layer.md:15`、`:216` | `tools/_mirror_dist.mjs` | 不存在（`tools/` 只有 `_probe-autoarchive-merge.mjs`） |
| 9 | `docs/design/design-map-layer.md:216` | `tools/check-versions.mjs` | 不存在（同上） |

## 无法核实

| # | 文档位置 | 声明 | 缺什么 |
|---|---|---|---|
| 1 | `README.md:46` | 「DSH 工具面 **14 → 4**（v0.5.1-fork.2 起）」 | 只能核实"现在 = 4"（`integrations/dsh/src/index.js:22-31`）。"14"那一侧无法核实：`git log -- integrations/dsh/src/index.js` 只有 `4fc676e` 一个初始提交（历史被压缩），看不到旧版注册 14 个工具 |
| 2 | `README.md:37` | 「相对上游，这一版修了 **30 条缺陷**」 | 需要上游 diff 与逐条缺陷台账；本仓库无结构化清单（CHANGELOG 未按 30 条编号） |
| 3 | `docs/EVALUATION.md:38` | 「MRR **20.4%**」 | `scripts/bench-out/*.json` 的 `acc` 只有 `n/h1/h3/h10/satTop1`，**无 MRR 字段**；无 MRR 计算脚本产物（`scripts/bench-compare.mjs` 需喂两份结果跑） |
| 4 | `docs/EVALUATION.md:39` | 「P50 延迟 **388ms**」 | 评测产物里没有延迟分布/分位数，需实跑带计时的 bench |
| 5 | `docs/EVALUATION.md:65` | 「这次实测是 **1.12 倍**」（簇级/题级区间比） | 无对应产物文件；`bench-out` 里未见该比较的落盘结果 |
| 6 | `README.md:633` | 「CI **三平台 × Node 22/24** 常绿（typecheck + test + build + dist 冒烟）」 | 仓库无 `.github/workflows`（见断链 5），也无运行记录可查；本地无法核实"常绿" |
| 7 | `docs/map-cli.md:21,560`、`docs/design/design-map-layer.md:205` | 「开销预算：无变化时 **< 20ms**」 | 需在真实项目上实跑计时；本轮按纪律未跑 sync/bench |
| 8 | `README.md:500`（~80MB）、`docs/user-guide.md:283`（2.6ms/查询、20ms/条、50MB） | 守护内存与语义检索性能 | 需实跑测量（本轮未跑） |
| 9 | `docs/privacy-and-lifecycle-design.md:99,135` | 「空间回收 **99.4%**」 | 需对真实归档前后库体积实测；本仓库无 measurement 产物 |

## 附：核对通过的高风险项（不计入上面三张表）

| 文档位置 | 声明 | 代码事实 |
|---|---|---|
| `README.md:47` | 14 个 MCP 工具名全列 | 与 `src/mcp/server.ts` 的 14 处 `register('…')` **逐字一致**（唯一一处写对的地方） |
| `docs/ARCHITECTURE.md:85,89,96` | 「守护进程按各自的节奏跑 **11 个阶段**」 | `src/core/lifecycle/stages.ts:31-53` 恰好 11 条（guard/repair/capture/extract/harvest/consolidate/compact/cleanup/tags/aging/distribute） |
| `docs/ARCHITECTURE.md:55` | 「抽取规则会变（现在已经是 **v26**）」 | `src/core/extract/version.ts:64 export const EXTRACT_VERSION = 26` |
| `docs/ARCHITECTURE.md:72-76`、`docs/EVALUATION.md` | hit@1 11.5% / hit@10 45.6%（各臂 15.2/13.3/5.3 与 57.1/47.6/30.5） | 用 `scripts/bench-out/baseline-305.json` 复算：R 16/105、X 5/95、T 14/105 ⇒ 35/305=11.48%、139/305=45.57%，逐项吻合 |
| `docs/EVALUATION.md:7,13-15` | 305 题 / 105 会话 / R105·X95·T105 | `scripts/bench-questions-paraphrase-v2.json`：305 items、105 unique target、arms R105/X95/T105 |
| `README.md:584`、`docs/user-guide.md:383,608` | `srelay_show` 默认 20 条 × 1000 字 ≈ 20KB，硬顶 50KB | `src/mcp/server.ts:329-331 DEFAULT_MSGS=20 / DEFAULT_CHARS=1000 / HARD_TOTAL=50*1024` |
| `README.md:48` | 图谱「**100 节点 / 1200 边**」 | `src/panel/snapshot.ts:987 panelGraph(root, limit=20)` → `:1025 nodeLimit=max(60,min(200,limit*5))=100`；`:1042 ORDER BY w DESC LIMIT 1200` |
| `docs/默认配置.md:8-41` | 全部出厂默认值 | 与 `src/shared/config-merge.ts defaultConfig()` 逐键一致（version 1.0 / full / 10 / 6 / sources 5 个含 dsh / jieba / 3 / 30 / enabled true / 30 / 7 / 60 / 360 / decay false） |
| `docs/默认配置.md:12-13`、`docs/user-guide.md:156,158` | idle 10 分钟、cooldown 6 小时 | 配置键 `idle_threshold_min: 10`、`cooldown_hours: 6` 一致 |
| `README.md:195`、`docs/user-guide.md:20,292` | 守护每 **30 秒**同步 | `src/capture/watch.ts:297 setInterval(() => cycle('tick'), 30_000)` |
| `README.md:640`、`docs/user-guide.md:313` | 三平台服务注册（Windows Run 键 / launchd / systemd user） | `src/cli/service.ts:1,191,214,230` |
| `docs/map-cli.md:48-58,141-143,421` | 9 个动词、1..100 条操作、退出码三分法 | `src/cli/map.ts:71-79`（9 个动作）、`:1600-1613`（switch）、`apply.ts` 上限；退出码 `EXIT_CODE` 与文档一致 |
| `docs/map-cli.md:102,111,115,190,204` | limit 默认 30 上限 100、光标、`--fields` 仅 list 类、`>8MiB → unknown`、`--to` 必须配 `--json` | `src/cli/map.ts:126-127 LIMIT_DEFAULT=30/LIMIT_MAX=100`、`:331-341 fieldsOf`、`src/map/stale.ts:41 HASH_MAX_BYTES=8*1024*1024`、`src/cli/map.ts:986-1000` |
| `docs/adapters/README.md:52-60,72-74,139-151,160` | 自定义适配器：`capture.sources`、`custom_<id>` 配置、watchRoots/healthCheck/detectCompaction 可选、仅 CommonJS | `src/adapters/types.ts:22-48`；`src/adapters/registry.ts:103-130`（`.js/.cjs` + `require()` ⇒ CommonJS）、`:152-153 custom_<sourceId>` |
