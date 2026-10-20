# 命令参考

全部 35 个子命令。参数来自 `srelay <cmd> --help` 的实际输出，不是凭印象写的。

场景化用法（什么时候该用哪个）看 [user-guide.md](./user-guide.md)；第一次用看 [GETTING-STARTED.md](./GETTING-STARTED.md)。

---

## 初始化与采集

### `srelay init`

初始化项目并回填最近 30 天会话。检测到已初始化时只做增量同步。

| 参数 | 说明 |
|---|---|
| `--sources <ids>` | 只采这些源，逗号分隔 |
| `--backfill <window>` | 回填窗口，如 `90d` |
| `--yes` | 跳过交互（脚本/CI 用） |
| `--install-service` | 同时注册守护 |

### `srelay sync`

一次性增量捕获。守护和它是同一份逻辑。

```bash
srelay sync              # 增量
srelay sync --backfill all   # 全量重扫
```

### `srelay watch`

守护进程。

| 参数 | 说明 |
|---|---|
| `--install-service` | 注册开机自启（Windows 注册表 / launchd / systemd user） |
| `--uninstall` | 卸载服务 |
| `--status` | 状态 + 日志尾部 |
| `--foreground` | 前台跑（调试用） |

### `srelay save`

手动存会话（`mode off` 时是唯一入口）。

| 参数 | 说明 |
|---|---|
| `--recent <window>` | 如 `7d` |
| `--interactive` | 交互勾选 |
| `--tag <tags>` / `--summary <text>` | 附加元数据 |

---

## 查询与检索

### `srelay search <query>`

中文全文检索。四条路融合（主路 AND / 同义词 / 子串 / 标签）。

| 参数 | 说明 |
|---|---|
| `--topic` / `--tag` / `--source` | 维度过滤 |
| `--since` / `--until` | 时间过滤 |
| `--limit <n>` | 默认 10 |
| `--global` | 跨项目联邦检索（只读） |
| `--explain` | 打印每条的分数构成（base × 覆盖 × 长度 × 时间 × 标题 ⇒ 最终分） |
| `--json` | 机器格式，带分数；弱命中时附 `weakHint` |

0 命中时自动给**归因**（词不存在 / 词太泛 / 时间窗 / scope / 词元太多）；有命中但缺词时给**弱命中提示**（指出哪个词在本库一次都没出现）。判据在 `src/search-svc/why-empty.ts`，零模型、只归因不改检索。

### 其余查询命令

| 命令 | 做什么 | 常用参数 |
|---|---|---|
| `brief` | 开场简报一次取全：决策 + 未决 + 计数 + 高频文件 | `--limit` `--days` `--top` |
| `decisions` | 全部已确认决策（含出处） | `--topic` `--kind` `--limit` |
| `unresolved` | 未解决问题（启发式） | `--limit` |
| `history <file>` | 某文件被哪些会话讨论过 | — |
| `related <id>` | 以会话为锚找相关讨论 | `--limit` |
| `show <id>` | 查看会话消息 | `--range 10:20` |
| `list` | 列出会话 | `--source` `--state` `--limit` |
| `status` | 透明度面板：模式/守护/计数/体积 | `--json` |
| `stats` | 本地匿名计数器 | `--report` `--reset` |

### 检索范围

| 命令 | 做什么 |
|---|---|
| `scope --set/--add/--reset` | 设定检索边界（CLI 与 MCP 共用） |
| `attach <ids...>` | 挂载，本次只看这些会话 |
| `detach` | 解除挂载 |

### 语义检索（可选，默认关）

```bash
srelay semantic --enable            # 装依赖 + 下载模型 + 回填
srelay semantic --test "查询"       # 对比字面 vs 字面+语义
srelay semantic --status            # 向量数 / 积压 / 模型状态
srelay semantic --disable           # 停用（向量保留）
```

> **实测无召回提升且检索慢一倍**，默认关。纯字面匹配已经够用。这个结论写在 [SEARCH.md](./SEARCH.md) 的负结果一节。

---

## 看板与地图

### `srelay kanban [action]`

| action | 做什么 |
|---|---|
| `init` | 起草 `progress.md` 初稿（**绝不覆盖**已有文件） |
| `sync` | 只刷新自动区 |
| `graph` | 出 Mermaid 依赖图；`--html` 附可离线打开的页面 |

### `srelay map [action]`

| action | 做什么 |
|---|---|
| `read`（默认） | 读图，`--resource` 选 pages/map/nodes/edges/layers/changes |
| `apply` | 原子改图，1..100 条操作一次落盘 |
| `declare` / `update` / `remove` | 单操作糖 |
| `check` | 源码指纹对账 |
| `export` / `import` | 出图快照 / 从看板导入 |
| `init` | 建空图 |

退出码三分：**0 成功 / 1 校验拒绝 / 2 忙**。2 是「稍后重试」，1 是「你写错了」，别混。

完整手册见 [map-cli.md](./map-cli.md)。

## 自证 · 自愈 · 进化

| 命令 | 做什么 | 要点 |
|---|---|---|
| `srelay score` | 记忆体检分 0–100 + A/B/C/D | 权重 40 证据覆盖 / 25 新鲜度 / 15 碎片率 / 20 审计 P0；**归档未决不计分**（已接受历史债），FTS 不一致才算 P0；简报第一行自动显示 |
| `srelay audit` | 审计契约（七项，只读零写入） | 退出码 **0 全过 / 1 只有 P1 / 2 有 P0 或跑不起来**；含 `decision-conflict`（后者可能推翻前者） |
| `srelay handoff` | 一键交接包（固定五段） | ①现在到哪了 ②定过什么 ③还欠什么 ④下一步 ⑤坑；每条带 sessionId + msgId/seq；`--out` 落盘、`--json` |
| `srelay market [topics...]` | 跨项目经验市场 | 按工作区/领域 + 话题词元重叠推荐，每条带「为什么」；只读 |
| `srelay feedback` | 检索反馈采集状态 + 统计 | 快照新鲜/过期/损坏 + open 次数/名次分布/长度桶；样本 < `MIN_OPENS_FOR_CALIBRATION`(30) 只说「样本不足」 |

> **自校准（D 第二步）**：`npx tsx scripts/calibrate-weights.ts` 用固定题面跑旋钮网格（titleBoost / coverageBoost / metaBoost / bestExcerpt），
> 裁决在 `pickWinner`（hit@10 降一票否决 → hit@1/MRR 严格提升 → 并列取离默认最近），**只出建议、绝不写 config.json**。

### 决策置顶

```bash
srelay pin "PostgreSQL"     # 简报优先显示，即使很老
srelay unpin "PostgreSQL"
```

---

## 生命周期与维护

### `srelay lifecycle`

跑 12 个阶段：`guard`（体检）`repair`（自愈）`capture`（采集）`extract`（重算）`harvest`（经验）`consolidate`（去重）`compact`（压缩）`cleanup`（清洗）`tags` `aging`（老化）`distribute`（分发）`audit`（审计，只读、24h）。

| 参数 | 说明 |
|---|---|
| `--status` | 只看各阶段状态（不跑） |
| `--only <ids>` | 只跑这些阶段，逗号分隔 |
| `--once` / `--loop <sec>` | 跑一轮 / 常驻 |
| `--light` | 只跑轻阶段（宿主内 worker） |
| `--force` | 无视节奏强制全跑 |

### `srelay maintain`

**默认只读、默认不删文件。**

| 参数 | 说明 |
|---|---|
| `--fts` | 按阈值回收 FTS 索引垃圾（文件/内容 > 2 倍才动手） |
| `--apply` | 真正写入；没有它绝不写库 |
| `--force` | 配 `--fts`：无视阈值强制回收 |
| `--reap` / `--reap-apply` | 孤儿备份清理 |
| `--guard` | 守护断线核算 |

### `srelay recompute`

手动触发提取规则重算。`doctor` 提示「库是 v0，当前规则 v26」时用这个。

| 参数 | 说明 |
|---|---|
| `--search-text` | 同时刷新 FTS 用的 `search_text` |
| `--dry-run` / `--apply` | 干跑 / 真写 |
| `--batch <n>` | 每批条数 |

### 其余维护

| 命令 | 做什么 | 注意 |
|---|---|---|
| `rebuild` | 从源文件全量重建索引 | 守护在跑时拒绝，除非 `--force`；旧库留 `.bak` |
| `compress` | 把旧决策合成上级条目 | **默认关**，原文永不删，可回滚 |

---

## 交接与团队

| 命令 | 做什么 |
|---|---|
| `export` | 导出 HOP 交接包（含 HANDOFF.md + 脱敏 + sha256）；默认尊重当前 scope |
| `import <pkg>` | 导入（sha256 校验 + 归化到当前项目）；`--quarantine` 隔离审查 |
| `team status` / `team log` | 贡献者统计 / 导出导入日志 |

完整协议与五种场景见 [import-export-guide.md](./import-export-guide.md)。

---

## 隐私与删除

### `srelay forget`

**彻底抹除**，与会话本身一起消失，永不复活。

```bash
srelay forget a3f8c2d1            # 预览（将删什么/保留什么）
srelay forget a3f8c2d1 --yes      # 执行（不可逆）
srelay forget --history           # 遗忘审计
srelay forget --all --confirm <projectId> --yes   # 整库重置
```

> **AI 永远没有删除工具。** 删除权只在人手里。前缀命中多个会列候选拒绝执行；预览后数据有变化会拒绝并要求重新预览。

### 归档（省空间，不抹除）

| 命令 | 做什么 |
|---|---|
| `archive --days 90 --dry-run` | 预览 |
| `archive --days 90` | 归档：保留决策骨架，释放正文 |
| `archive --hard` | 连决策一起删 |
| `archive --history --verbose` | 审计明细 |

**永远不被归档**：进行中的会话、交接包导入的（`imported`，源不在本机）、AI 笔记、标签含「保留」的。

### 捕获模式

```bash
srelay mode full     # 全文（默认）
srelay mode meta     # 只存元数据
srelay mode off      # 关自动捕获（save 是唯一入口）
```

---

## 接入与调试

| 命令 | 做什么 |
|---|---|
| `doctor [--fix]` | 环境自检，23 项检查，每条带建议；`--fix` 默认 dry-run，只修已知安全项（插件副本缺文件 / 面板 vendor 落后），实测一次修 5 项、复查 0 待修 |
| `serve` | 起 MCP Server（stdio），给 AI agent 用 |
| `bench-extract --save` / `--diff latest` | 抽取规则改动的门禁：看谁被剔除/新增 |
| `confirm <id>` | 手动强制会话为 confirmed（触发抽取） |

---

## 全局参数

```bash
srelay --version    # 1.0.0
srelay --help       # 全部命令
srelay <cmd> --help # 单个命令的参数
```

大多数命令支持 `--json` 输出机器格式，便于脚本处理。

**版本口径**（避免"到底哪个是版本"）：core 的版本看 `package.json`（当前 **1.0.0**）。
DSH 插件（`dsh-srelay-brief`）与面板（`dsh-srelay-panel`）是**独立发布号**（0.2.3 / 0.1.0），
不要求与 core 同步；门禁 `check-versions` 比的是 **dist 文件内容（逐字节）**，不是版本号。
所以"插件显示 0.2.3、core 显示 1.0.0"是正常状态，不是没同步。
