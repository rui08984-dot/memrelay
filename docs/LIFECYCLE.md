# 生命周期

**读这篇你会知道**：12 个阶段各自什么时候跑、干什么、哪个会删数据、以及「一排全绿」到底有多大信息量。

**什么时候该读**：`srelay status` 里某个阶段一直失败、库越来越大、或者担心数据被删。

---

## 先上手：看它跑得怎么样

```bash
srelay lifecycle           # 手动跑一轮完整流水线（守护每 5 分钟检查到期）
srelay lifecycle --only guard    # 只跑一个阶段；多个用 --only guard,repair
srelay status              # 各阶段最近一次结果
```

---

## 出问题了先看这张表

| 现象 | 大概率原因 | 怎么办 |
|---|---|---|
| 某个阶段一直失败 | 该阶段的熔断在冷却 | 等冷却期过；持续失败看 `health_events` |
| 库一直变大 | `cleanup` / `compact` 没跑或没生效 | 手动 `srelay lifecycle --only cleanup` |
| 正文不见了，只剩决策 | `aging` 归档了（唯一会删正文的阶段） | 原文在客户端；归档不可逆，重要的先 `pin` |
| 「12 阶段全 OK」但实际有问题 | `guard`/`repair` 曾恒真（已修） | 现在能真变红了；别只看绿勾，看具体计数 |
| 两个守护同时在跑 | `--install-service` 装了两遍 | `srelay status` 看进程数，多余的杀掉 |

---

生命周期是框架内的一条流水线：12 个阶段按各自的节奏跑，状态与错误落进全局库，每次运行有单写入方锁，坏阶段进熔断冷却。它由守护进程（`srelay watch`）每 5 分钟检查一次「哪些阶段到期」来驱动（`../src/capture/watch.ts:485-500`），也可以手动 `srelay lifecycle` 跑一轮（`../src/bin/srelay.ts:377`）。

**不负责**：采集适配器本身的格式解析（那在 `../src/adapters/`）、检索打分、部署物。面板 HTML / 导出这类东西由宿主通过 `opts.distribute` 注入，内核不知道 DSH 面板是什么（`../src/core/lifecycle/runner.ts:499-502`）。

![生命周期示意图：五组、节奏、职责，aging 是唯一删正文的](./diagrams/lifecycle.png)

> 示意图当前未画 `audit`（24h、只读、NO_BREAKER）；阶段清单以本文表格为准。

<sub>图源 [diagrams/lifecycle.mmd](./diagrams/lifecycle.mmd)，改完重渲染</sub>

## 阶段表（唯一权威）

以下全部来自 `../src/core/lifecycle/stages.ts:31-53`，插件 worker 与 CLI 读同一张表。`weight` 决定它能不能跑在宿主进程内：`heavy` = 全量重放/整库重写，只许独立进程跑。

| id | 职责 | 节奏 | 体量 | 改数据 | 失败怎么显形 |
|---|---|---|---|---|---|
| `guard` | 体检与自检 | 900s | light | 否 | 显式 `{ok:false}`（`runner.ts:199`）→ 真红 |
| `repair` | 损坏自愈（从原始会话重放） | 3600s | heavy | 是 | 显式 `{ok:false}`（`runner.ts:243`）→ 真红 |
| `capture` | 采集客户端会话 | 900s | heavy | 是 | 抛错（`runner.ts:272`）→ 真红 |
| `extract` | 抽取 / 按规则版本重算 | 1800s | light | 是 | 只写 note（`runner.ts:306-308`） |
| `harvest` | 经验采集（从项目记忆刨草稿） | 21600s | light | 是 | 只写 note（`runner.ts:343`） |
| `consolidate` | 经验衰减 / 退休 / 冲突标记 | 3600s | light | 是 | 只写 note |
| `compact` | 无损去重（同会话精确重复） | 3600s | light | 是 | 只写 note（`runner.ts:392` 带失败计数） |
| `cleanup` | 派生列清洗（topics/files 噪声） | 3600s | light | 是 | 只写 note（`runner.ts:406-407`、`:425`） |
| `tags` | 标签图谱重建 | 86400s | heavy | 是 | 只写 note（`runner.ts:476`） |
| `aging` | 老化压缩（老会话正文→摘要，结论留全） | 86400s | heavy | 是，且 `lossy` | 无逐项目兜底：任一项目抛错 → 整阶段红（`runner.ts:483-496`） |
| `distribute` | 分发（简报段 / 面板 / 导出） | 900s | light | 否 | 无钩子时返回「未注入」（`runner.ts:500`），不算失败 |
| `audit` | 审计契约（七项只读） | 86400s | light | **否（只读零写入）** | 永不进熔断（`NO_BREAKER`）；查出 P0 不算失败，P0 由简报首行告警 |

「可失败」不是布尔值，是三条不同路径：**抛错**（任何阶段）、**显式 `{ok:false}`**（只有 `guard`/`repair` 用）、**只写进 note**（其余阶段的「部分库失败」）。这个区别决定了下面那排勾到底有多少信息量。

```
watch 守护（每 5 分钟 tick 一次）
  └─ dueStages(state, now)        ← 比对 lifecycle.stages 里各阶段的 at 与 everySec
       └─ runOne(spec, fn)        ← 先过 shouldSkip（熔断）
            ├─ 成功       → recordStage(ok:true, fails=0) + 日志
            ├─ 熔断跳过   → 记 ok:false + skipped 原因 + 一行日志
            └─ 失败/抛错   → recordStage(fails+1) + health_events
  └─ saveLifecycle(state)         → lifecycle 单行（rounds / last_at / stages JSON）
panel / srelay lifecycle --status 读同一张表
```

## 状态写在哪

全局库 `~/.sessionrelay/global.sqlite`（`../src/shared/paths.ts:121-122`，可用 `SRELAY_GLOBAL_HOME` 改）。三张表由 `ensureLifecycleTables` 幂等建出（`stages.ts:73-97`）：

| 表 | 内容 |
|---|---|
| `lifecycle` | 单行 `id=1`：`version`、`rounds`、`last_at`、`stages`（JSON：每阶段的 ok/note/at/ms/fails） |
| `health_events` | 每条失败一行：`at/stage/level/message/detail` |
| `runtime` | 心跳键值：`watch` = 采集守护在线（用于让 `capture` 阶段让位） |

读侧：CLI `srelay lifecycle --status`（`../src/bin/srelay.ts:391-399`，逐阶段打印 ✅/🔴 与 note 前 90 字）；面板 `panelLifecycle`（`../src/panel/snapshot.ts:273-301`）。面板另外算一个派生状态 `stageHealthOf`：上次运行距今超过 `2 × everySec` 判 `overdue`，从没跑过判 `never`（同文件 `:255-271`）。

## 一个阶段失败不拖垮别的

四层隔离，都是可指认的代码：

1. **各自到期**：`dueStages` 按每个阶段自己的 `everySec` 判断（`stages.ts:148-157`），时钟异常时宁可跑一次。
2. **逐阶段 try/catch**：`runOne` 把每个阶段的异常兜住，记 `ok:false` 后继续下一个（`runner.ts:144-172`）。失败还会写一条 `health_events`。
3. **单写入方锁**：进程级文件锁 `~/.sessionrelay/lifecycle.lock`，pid 活着且锁龄 <1 小时才拒绝（`runner.ts:59-81`）。拿不到锁时**只返回一条 guard 的 `skipped:'locked'` 报告，其余阶段全部不跑**。
4. **采集让位**：`watch` 的心跳新鲜时，`capture` 阶段直接返回「交给它」，避免两个写入方同写一个库撞出 `SQLITE_BUSY`（`runner.ts:250-256`）。

## 熔断（breaker）

同一阶段连续失败 ≥3 次后，本轮跳过（`shouldSkip`，`stages.ts:184-192`），并记成 `ok:false` + `skipped` 原因 + 打一行日志（`runner.ts:147-152`）——不是旧实现那种「跳过还报 ok:true」的静默半失效。

跳过不等于永久放弃：冷却 30 分钟后放**一次**探测（`RETRY_AFTER_MS`，`stages.ts:172`）；探测成功由 `recordStage` 把 `fails` 归 0，自动恢复；探测再失败就继续等下一个冷却期（`stages.ts:162-171` 记着「永久停用」那个死循环病历）。

`NO_BREAKER` 白名单里**只有 `guard` 一个**（`stages.ts:182`）。理由写在同一处：熔断的目的是「别把坏掉的重活反复重试拖垮链路」，而体检是只读且极轻的操作；把它冷却掉等于「发现有病之后就不再体检」，一个持续损坏的项目会让唯一会报警的那条被关进冷却。

## 「一排全绿」的信息量

CHANGELOG 记着这条修复（`../CHANGELOG.md:38-40`）：`guard` / `repair` 的 `ok` 曾经**恒真**——失败了只写进 note 就 return，`runOne` 一律记 `ok:true`。原文给的数量是「283 轮 11 阶段全 OK」，并明说这句话对 `guard` / `repair` / `extract` / `cleanup` 四个阶段**原本不携带任何信息**。`guard` 改成会真变红之后自己又进了熔断，于是补了 `NO_BREAKER`（`../CHANGELOG.md:40`）。

现在的状态要说清楚：`guard` 与 `repair` 能真变红；`capture` 靠抛错变红；而 `extract` / `harvest` / `compact` / `cleanup` / `tags` 的「部分项目失败」仍然只写进 note，`ok` 为 true；`aging` 反过来没有逐项目兜底，一个项目抛错会让整阶段变红、同时丢掉其余项目本轮的结果。所以「11 个全绿」的含义是「12 个阶段都跑到了，且 `guard`/`repair`/`capture` 没红」，不等于 12 个阶段都验过。判据有多严，那排勾才有多可信。

## aging：唯一会删正文的阶段

`aging` 是阶段表里唯一标 `lossy:true` 的（`stages.ts:51`）。判据分两层，都是纯函数、可单测：

**选择器 `planAging`**（`../src/core/compact/aging.ts:78-118`）逐条保护：

- 已归档过（`cleanup_at` 非空）→ 跳过；
- `state === 'active'` → 跳过（`aging.ts:96`）；
- `origin === 'imported'` 或笔记会话（`isNoteSession`）→ 跳过（`:100`）；
- `extracted_version` ≠ 当前 `EXTRACT_VERSION` → 先重算再说（`:101`）；
- 派生决策数 < `minDecisions` → 跳过（自动通道传 0，因为版本门才是安全网，`../src/capture/archive.ts:307`）；
- 强度 `exp(−age/S) < 1/e` 才归档，`S` 就是调用方的窗（`aging.ts:103-110`）。

**窗与上限**：`archive.hot_days` 默认 60 天、`archive.workflow_days` 默认 7 天（`archive.ts:261-262`），先跑 workflow 通道再跑普通通道，每轮封顶 200 条（`ARCHIVE_CAP_PER_ROUND`，`aging.ts:122`）——渐变不突变。`archive.enabled === false` 时策略返回 `null`，整个阶段不动作。

**执行器 `runArchive`** 再拦一次保护名单：`active`、`imported`、笔记会话、`user_tags` 含「保留」的都不动（`archive.ts:47-57`、`:137-142`）。

**归档前后各留什么**（`archive.ts:171-175`）：删 `messages` 与 `session_vectors`；`sessions` 行保留，打 `cleanup_at`、`message_count` 置 0、`original_message_count` 存归档前的真实条数（复活合并靠它）。决策 / 未决 / 话题 / 摘要骨架全部留着。审计走 `cleanup_log` + `cleanup_detail`，整个写入段包在 `BEGIN IMMEDIATE` 事务里（`archive.ts:103`、`:196-205`）。判据摘要进日志，写成「strength≤… (窗60d) · 计划 x+y · 实际 x+y · 上限 200/轮」（`archive.ts:327-331`），能回答「为什么归档它 / 为什么没动」。

## 实测数字

| 数字 | 出处 |
|---|---|
| 「283 轮 11 阶段全 OK」 | `../CHANGELOG.md:39` |
| 面板曾同时显示「已执行 196 次」与「最近运行：—」——`lastAt` 从未被赋值 | `runner.ts:125-129` |
| `aging` 曾是死代码：重建库 719/719 场都是 `pending_end`，而门禁写死 `confirmed` ⇒ 计划恒空 | `aging.ts:93-95` |
| `tags` 620 会话全量重建 1.3s | `stages.ts:49` |
| FTS 六库 195 MB 里 59 MB 是墓碑垃圾 | `runner.ts:411` |
| 三份 `.damaged-*` 备份占 88 MB 躺了 2 天，没有任何机制会清 | `runner.ts:430` |
| 当前运行库实际跑过多少轮、各阶段最近结果 | **未实测**（本次没读 `global.sqlite`） |

## 已知限制

- 除 `guard`/`repair`/`capture` 外，阶段的「部分项目失败」不会把 `ok` 拉红，只写 note。这是当前最大的判据缺口。
- `heavy` 阶段放进宿主进程会阻塞 UI（`stages.ts:24-27` 明写这个字段就是为了不靠人记得别那么干）；宿主 worker 应传 `lightOnly`（`runner.ts:131`）。
- 锁是**进程级文件锁**，不是跨主机/容器锁；陈旧锁（pid 已死或锁龄 ≥1 小时）会被接管（`runner.ts:69-79`），所以长时间挂起的进程锁不住。
- `aging` 依赖版本门：重算没追平的会话不会被归档。安全，但意味着「库不缩」可能只是重算没跑完。
- 展示口径与判据口径不一致：`strengthGateOf` 打的是旧线性门 `1 − 窗/90`（30 天窗时 0.667、60 天窗时 0.333），真实阈值是 1/e≈0.368（`aging.ts:124-133`，注释自己登记了这笔账）。
- 坏阶段进冷却后最多每 30 分钟探一次，期间没有额外告警（只有一轮一条日志 + `health_events`）。
- `distribute` 在宿主没注入钩子时是空转，返回一句「未注入分发钩子」且记成功——这是分层边界，不是故障，但也意味着「分发正常」这句话在 CLI 单跑时没有意义。
- 同一个配置键有两个默认值：生命周期路径的 `archive.hot_days` 缺省 60（`../src/capture/archive.ts:261`），面板展示缺省 30（`../src/panel/snapshot.ts:614`）。没配过这一项的项目，两处显示的热窗不是同一个数。
- 未实测：本机当前 `rounds`、`lastAt`、逐阶段 `ok/fails`。要核这些只能直接读全局库或跑 `srelay lifecycle --status`。