# 架构

这份文档回答四个问题：系统分成哪几块、一次会话怎么变成记忆、记忆怎么被找回来、以及想改一块代码该从哪进。

---

## 一、分层

从上往下，每层只依赖它下面那层。越界依赖（比如检索层直接读适配器）是刻意禁止的——那会让「这条数据从哪来」变得说不清。

![分层架构](./diagrams/layered.png)

*图源 [layered.mmd](./diagrams/layered.mmd)*

| 层 | 目录 | 职责 |
|---|---|---|
| 接口层 | `src/bin/` `src/mcp/` `src/panel/` `integrations/` | CLI / MCP / 面板 / 客户端集成；只做形态转换，不做判断 |
| 服务层 | `src/search-svc/` `src/capture/` `src/relay/` | 同步、检索、交接编排 |
| 核心层 | `src/core/` `src/map/` | 抽取、生命周期、地图内核（纯逻辑，尽量不碰 IO） |
| 存储层 | `src/store/` | schema、FTS5、归档、重建 |
| 适配器层 | `src/adapters/` | 把六种客户端的数据格式差异吃掉 |

**两个库是硬边界**：项目库（`.sessionrelay/*.sqlite`）只放本项目的会话与派生数据；全局库（`~/.sessionrelay/global.sqlite`）
只放跨项目的东西（经验、生命周期状态、健康事件）。分开的理由很实际——项目库会被 `forget` 整个删掉，跨项目经验不该跟着蒸发。

---

## 二、六个源，一种形状

所有源都是"磁盘上有个文件/有个库，按某种格式记着对话"。适配器把这堆格式差异吃掉，往上只吐一种形状。

| 源 | 默认启用 | 读取方式 |
|---|---|---|
| Claude Code | ✅ | JSONL 逐行 |
| ZCode | ✅ | 会话库 + 压缩摘要（占位 seq 走 1e9 独立空间，避免撞掉真实消息） |
| Codex | ✅ | JSONL + 前缀指纹（识别整段重写） |
| Qoder | ✅ | 缓存目录（同名项目 ≥2 个时按路径摘要认领，对不上就拒绝而**不猜**） |
| DSH | ✅ | 会话记录 |
| Trae | 否 | 部分支持，需在 `capture.sources` 显式开启 |

适配器契约（`src/adapters/types.ts`）只有两个必需函数：`discover()` 列出有哪些会话、`readNew(游标)` 只取新增部分。
可选 `watchRoots` / `healthCheck` / `detectCompaction` 用来加速与自检。自定义适配器只支持 CommonJS，细节见 [adapters/README.md](./adapters/README.md)。

关键取舍：**判断"变没变"用内容签名，不看修改时间**。修改时间会被备份工具、文件同步、甚至读操作碰一下；
内容签名只在字节真的变了时才变——这是"不重复解析已经处理过的东西"的唯一依据。

---

## 三、一次会话怎么进来

![一次会话怎么变成记忆](./diagrams/session-flow.png)

*图源 [session-flow.mmd](./diagrams/session-flow.mmd)*

三个不显然的决定，每个都对应一次真实的坑：

**为什么整段重写要单开一代 seq。** 源文件被重写后行号会重排，新第 3 行和旧第 3 行完全是两句话。
直接覆盖等于用新内容盖掉旧正文，而且不报错。现在的做法是：重写后的内容进 `seq = 代数 × 1e6 + 行号` 的独立空间——
旧文留着，新文也进来，谁都不丢。两种重写都要识别：变短的（tailer 内部复位）、变长的（前缀指纹变了）。

**为什么采集异常必须有人读。** `SyncStats.warnings` 曾经全仓没有任何读取方：源名打错一个字母，采集静默跳过，守护一行都不打。
现在 `runSync` 会打印（跨轮去重，同一个只报一次）。**但 `source_files.suspect/bad_lines` 仍然只写不读**——这一条还没闭环，别把它当成已修。
这是"容错不许静默"最贵的一次学费。

**为什么单源抛错不能拖垮整轮。** 一个源崩掉，健康的源照采。per-source 与 per-session 各有一层 try/catch，
坏掉的跳过、好的入库。

**抽取不在这条链路里。** `sync` 只把正文落库；抽取由 `judge`（会话空闲满 `cooldown_hours` 后确认）与 `recompute`（规则版本落后）驱动。
所以「入库了但决策还没出来」是正常中间态，最长到 `cooldown_hours`（默认 6 小时）。

采集细节见 [CAPTURE.md](./CAPTURE.md)。

---

## 四、抽取

抽取是**独立于采集的一条可重算路径**：采集只负责把原文搬进来，抽取规则变了就整批重算，不用重读源文件。

产出四件套：**决策**、**话题**、**涉及文件**、**未决问题**，各自回写到派生列并进 FTS 索引。

规则版本 `EXTRACT_VERSION`（现在是 **26**）是这条路径的版本号：改了判据必须递增，否则存量库不会重算。
守护按周期重算一批，也可以手动 `srelay recompute`。

抽取端判据管的是"让垃圾根本不入库"（问句冒充决策、决策动词后紧跟逗号、口述填充词、报告残渣……）；
简报端另有几条判据管已经入库的存量。两边互补，**不许把同一判据写两遍**。

细节见 [EXTRACT.md](./EXTRACT.md)。

---

## 五、检索怎么找

![检索四路融合](./diagrams/retrieval.png)

*图源 [retrieval.mmd](./diagrams/retrieval.mmd)*

一次查询同时走四条路，按归一化分数融合：

| 路 | 做什么 | 代价 |
|---|---|---|
| 主路 | FTS5 会话级 AND | 覆盖面窄；查询词多一个候选就少一截 |
| 同义词 | 手写词族 + bigram | 只能往队尾补 |
| 子串 | LIKE 短语匹配 | 短语查询时关闭 |
| 标签 | 图谱跳一跳 | 专名命中率高 |

融合后做长度惩罚：长会话天然命中更多词，不打折就会霸榜（巨无霸在每条路都第一）。

实测（305 题 / 105 会话）：**hit@1 11.5%、hit@10 45.6%**，簇级 95% CI ±3.85pt。
中间那 34 个百分点说明问题是**排序**不是**召回**。试过没用的东西（同义词族扩展、问句外壳剥离、纯 RRF、语义档）
都记在 [SEARCH.md](./SEARCH.md)，默认关着，附理由。

---

## 六、生命周期

![生命周期 11 阶段](./diagrams/lifecycle.png)

*图源 [lifecycle.mmd](./diagrams/lifecycle.mmd)*

11 个阶段按各自节奏独立跑，状态写全局库的 `lifecycle` / `health_events` 表。**不是流水线**——一个阶段失败不该拖垮别的。
可失败的阶段有自己的熔断；只读且极轻的体检（`guard`）在 `NO_BREAKER` 白名单里，不该因为"体检发现有问题"而被冷却。

`aging` 是唯一**删正文**的阶段：只有强度低于阈值、且不在保护名单里的会话才归档，归档前把决策与话题骨架留下。

诚实提醒：**「11 个阶段全 OK」这句话本身信息量有限**。`guard` / `repair` 曾经是"恒真"的——失败了只写进 note、`ok` 还是 true。
现在能真变红了，但含金量取决于每个阶段判据有多严，不是那排勾。

细节见 [LIFECYCLE.md](./LIFECYCLE.md)。

---

## 七、地图

![自动孵化：依赖列 → 拓扑分层 → 真边](./diagrams/map-hatch.png)

*图源 [map-hatch.mmd](./diagrams/map-hatch.mmd)*

地图（`.sessionrelay/map/map.json`）是计划的**结构真值**：层、节点、依赖边、状态。
一条不变式贯穿全部写入路径：**边必须严格跨层向下**（`rank(from) > rank(to)`）——图因此天生无环。

自动孵化 = 解析 `progress.md` 的依赖列 → 拓扑分层 → 边从关系里长出来。三条纪律：
**匹配不上不建边、认不准不建边、有环整批拒绝**。没有依赖列就落单层 0 边，层名也不写"已分层"。

投影单向：地图 → `progress.md` 的 `auto:map` 行 / `board.mmd` / 简报一行；**看板不反过来定义地图**。

细节见 [MAP.md](./MAP.md) 与 [map-cli.md](./map-cli.md)。

---

## 八、接口面

| 面 | 入口 | 写什么 |
|---|---|---|
| CLI | `src/bin/srelay.ts` | 全部能力；子命令表见 `srelay --help` |
| MCP Server | `src/mcp/server.ts` | 14 个工具，可通过 `SRELAY_MCP_TOOLS` 白名单裁剪 |
| DSH 插件 | `integrations/dsh/` | 4 个原生工具 + 开场简报 |
| 面板 | `src/panel/` | 只读；快照直接从 SQLite 读 |
| ZCode / Codex | `integrations/`（工作区仓） | 简报注入 + 会话收尾 |

所有接口面共享同一份数据口径：**判据只有一份**，渲染可以多份。历史上「工具清单写两份、其中一份漏一个名字」
和「`auto:todos` 一处用模块列精确匹配、另一处用整行子串匹配」都导致过静默故障。

细节见 [INTERFACES.md](./INTERFACES.md)。

---

## 九、想改代码从哪看

| 想做的事 | 从哪个文件进 |
|---|---|
| 支持一个新的 AI 工具 | `src/adapters/<name>/index.ts`，实现 discover / readNew；再在 registry 注册 |
| 改检索排序 | `src/search-svc/engine.ts` 的 `fusedSearch`（融合权重、长度惩罚都在那儿） |
| 改抽取规则 | `src/core/extract/`，改完递增 `EXTRACT_VERSION`，否则存量不会重算 |
| 加生命周期阶段 | `src/core/lifecycle/stages.ts` 的 `STAGES` 表是唯一权威，别在别处加分支 |
| 改看板 / 地图投影 | `src/map/bridge.ts`（写侧口径）+ `src/cli/kanban.ts`（读回） |
| 改地图的自动孵化 | `src/map/plan-graph.ts`（纯函数：解析、分层、建边、环检测） |
| 改简报 | `src/cli/brief-filter.ts`（判据）+ 各客户端适配器（渲染） |

---

## 十、三条纪律

1. **判据只许有一份。** 同一个判断两处各写一遍，迟早会漂。工具清单、白名单、`auto:todos` 匹配、配置默认值——都栽过。
2. **容错不许静默。** 跳过可以，但必须有人能看见。采集 warnings、修复失败、审计异常都汇入可读路径。
3. **常驻进程不会自己换新代码。** 改完要重启守护或让它自检；插件、面板宿主同理。这条被写进了看门狗：启动时间早于最新构建产物就自动重启。
