# 文档地图

先看根目录 [README.md](../README.md) 弄清它是什么；要动手改代码，从 [ARCHITECTURE.md](./ARCHITECTURE.md) 开始。

## 一、讲「现在的实现」的（改代码前该读的）

| 文档 | 覆盖 | 什么时候读 |
|---|---|---|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | 分层 / 数据流 / 六块子系统 / 从哪改代码 | 第一份 |
| [CAPTURE.md](./CAPTURE.md) | 六个源、增量游标、重写识别、失败可见 | 采集漏了 / 加新源 |
| [EXTRACT.md](./EXTRACT.md) | 决策·话题·文件·未决四件套、判据清单、规则版本 | 抽错了 / 想加判据 |
| [STORE.md](./STORE.md) | 两个库、schema、FTS5、归档与重建 | 数据长什么样 / 迁移 |
| [SEARCH.md](./SEARCH.md) | 四路融合、长度惩罚、时间衰减、实测与负结果 | 检索不准 / 调排序 |
| [LIFECYCLE.md](./LIFECYCLE.md) | 11 个阶段、节奏、熔断、`aging` 的边界 | 守护在干什么 / 阶段红了 |
| [MAP.md](./MAP.md) | 地图结构真值、自动孵化、拓扑分层、增量同步 | 图不刷新 / 想分层 |
| [INTERFACES.md](./INTERFACES.md) | CLI / MCP / DSH 插件 / 面板 / 集成 | 接新客户端 |
| [map-cli.md](./map-cli.md) | `srelay map` 九动作的完整手册（参数、退出码、边界） | 用地图命令 |
| [默认配置.md](./默认配置.md) | 出厂默认值与每个配置键的含义 | 调配置 |
| [adapters/README.md](./adapters/README.md) | 自定义适配器契约（CommonJS、`custom_<id>`） | 接自研工具 |

## 二、讲「怎么用」的

| 文档 | 覆盖 |
|---|---|
| [user-guide.md](./user-guide.md) | 安装、初始化、日常命令、守护、MCP 接入、常见故障 |
| [import-export-guide.md](./import-export-guide.md) | 交接协议 `hop/1.0` 与导入导出的用法 |
| [EVALUATION.md](./EVALUATION.md) | 305 题评测方法、逐格数字、统计口径与局限 |
| [eval/memrelay-eval.xlsx](./eval/memrelay-eval.xlsx) | 同一批数字的表格版（含图表，可直接改数据看变化） |
| [privacy-and-lifecycle-design.md](./privacy-and-lifecycle-design.md) | 隐私边界、遗忘与归档的设计依据 |

## 三、设计记录（写于当时，可能与现状有出入）

这批评论文里说的是**当时的方案**，实现后来会演进。冲突时以代码与本目录前两节为准。

| 文档 | 主题 |
|---|---|
| [design/design-map-layer.md](./design/design-map-layer.md) | 地图层的初版设计（不变式、七条规则） |
| [design-auto-archive.md](./design-auto-archive.md) | 自动归档 |
| [design-dsh-adapter.md](./design-dsh-adapter.md) | DSH 适配器 |
| [design-forget.md](./design-forget.md) · [test-forget.md](./test-forget.md) | 遗忘权：设计与验收 |
| [design-semantic.md](./design-semantic.md) | 语义检索（现已默认关） |
| [design-related.md](./design-related.md) · [design-serve-resolve.md](./design-serve-resolve.md) | 相关会话 / serve 的根解析 |
| [design-notes-mcp-context-safety.md](./design-notes-mcp-context-safety.md) | MCP 上下文安全（条数×字数硬顶） |
| [hybrid-capture-design-v1.0.md](./hybrid-capture-design-v1.0.md) | 采集混合模式 |
| [product/](./product/) | 早期产品方案与指导方针（历史沿革） |

## 四、图表

所有图都在 [diagrams/](./diagrams/)，一图一份 `.mmd` 源码，改图改源码再重渲染；目录里有渲染命令和两个踩过的坑。

## 五、审计记录

| 文档 | 内容 |
|---|---|
| [_audit/staleness.md](./_audit/staleness.md) | 一次文档一致性审计：23 处不符 / 9 条断链 / 9 条无法核实，逐条带双证据 |

维护约定：**文档里出现的每个路径、数字、命令都要能被验证**。判不出来就写「未实测」，不要猜——
这份约定本身也是被一次审计打回来之后才写下来的。
