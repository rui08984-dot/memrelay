# 存储层

存储层负责把采集结果落成可查询的结构：两块物理隔离的 SQLite 库、以 `sessions` 为中心的一组表、两张 FTS5 外部内容索引，以及两条**会真动数据**的路径（归档 aging、重建 rebuild）。它**不负责**检索排序与融合（[`../src/search-svc/engine.ts`](../src/search-svc/engine.ts) 的 `searchSessions`，:485；内部按需落到 `fusedSearch`）、不负责调度（[`../src/core/lifecycle/runner.ts`](../src/core/lifecycle/runner.ts) 的 `runLifecycle`，:112）、也不产生原文——正文的最终来源始终是客户端那边的会话文件。

## 一、两个库的硬边界

| 库 | 路径 | 放什么 |
|---|---|---|
| 项目库 | `<项目>/.sessionrelay/relay.sqlite`（shared/paths.ts:111） | 本项目的会话、消息、派生列、审计账本、向量、墓碑 |
| 全局库 | `~/.sessionrelay/global.sqlite`（shared/paths.ts:121，`SRELAY_GLOBAL_HOME` 可改） | 跨项目经验 `lessons`（store/global.ts:41-63）；生命周期状态 `lifecycle` / `health_events` / `runtime`（core/lifecycle/stages.ts:73-96） |

不能合并的理由很具体：`srelay forget --all` 会先把 `relay.sqlite` 连同 `-wal`/`-shm` 删掉，再建一个空库（cli/forget.ts:315）。若经验与生命周期状态住在项目库里，「忘掉这个项目」就等于把跨项目经验一并抹掉。反向也有边界：`~/.sessionrelay` 下有库**不算**已初始化的项目，判定只认项目目录里有没有 `relay.sqlite` 或 `config.json`（shared/paths.ts:39-42）。

两边都要 `busy_timeout = 5000`（store/db.ts:288 / store/global.ts:40）——守护与 MCP 是两个进程同时写，全局库这条曾经缺过，撞上就立刻 `SQLITE_BUSY`（CHANGELOG.md:65）。

## 二、表结构要点

`SCHEMA_VERSION = 6`（store/db.ts:17），DDL 全部 `CREATE TABLE IF NOT EXISTS`，旧库打开时补表、补列、必要时清游标。核心表：`sessions`、`messages`、`source_files`、`session_links`、`cleanup_log/detail`、`forget_tombstones/log/detail`、`compact_log/detail`、`compress_log/detail`、`compress_quota`、`session_vectors`、`decision_validity`（store/db.ts:19-282）。

最常被误解的一点：**decisions / topics / files / unresolved 都不是表**。

| 概念 | 实际落点 |
|---|---|
| decisions | `sessions.decisions` 的 JSON 文本（store/db.ts:36） |
| topics | `sessions.topics` 的 JSON 数组 |
| files | `sessions.files_mentioned` 的 JSON 数组 |
| unresolved | 无独立存储，从 `sessions.key_questions` 里筛 `unresolved=true` 派生（store/db.ts:1024-1042） |

唯一单独建表的是「这条决策还算不算数」：`decision_validity`（store/db.ts:271-281，`UNIQUE(session_id, decision_key)`），**无记录一律视为 active**——不能因为没回填就让存量决策消失。所以读决策必然是全量扫 `sessions` 再在 JS 侧解析 JSON（store/db.ts:889-894 写了不在 SQL 层用 `json_each` 的理由）。

FTS 是外部内容表：`messages_fts(search_text, content='messages')` 与 `sessions_fts(meta_text, content='sessions')`（store/db.ts:70-97）。三处触发器（insert / delete / update of search_text|meta_text）缺一不可，删除也必须往 FTS 写一行 `'delete'`，否则索引与内容分叉（store/db.ts:87 记录了这个教训）。索引文本不是原文：`search_text = toSearchText(stripInjected(正文))`（store/db.ts:429-431），超过 100KB 只索引前 100KB，正文仍全量入库（store/db.ts:1417）。`meta_text = title + topics + 每条决策前 30 字 + user_tags`（store/db.ts:392、store/db.ts:409-413）——决策确实进索引，这就是「改 decisions 必须重建 meta_text」的原因。

## 三、seq 语义

`seq_num` 是消息在会话内的位置，也是幂等键：`UNIQUE(session_id, seq_num)`（store/db.ts:68）。两条例外要记住：

- **代际偏移**：文件型源被整段重写后，`seq = 代数 × 1e6 + 行号`（claude-code/index.ts:101-103 等）。旧文留在 0 代，新文进 1 代起，互不撞车。
- zcode 用源库 `sequence`（zcode/index.ts:257），压缩摘要固定放 `1e9 + time_created/1000`（zcode/index.ts:285）。

**为什么不能直接覆盖**：重写后同一 seq 上坐着完全不同的话，无条件覆盖等于用新内容盖掉已采到的原文，而且不报错。现有判据是「只有流式生长（旧正文是新正文的前缀且更长）才允许 UPDATE」，其余一律保留旧文并回 `conflict=true`（store/db.ts:1449-1461），由采集层计数并告警（capture/sync.ts:398-405）。代价：`seq_num` 不连续、不能当「第几条消息」用；同一代内的重写仍会报 conflict（那一代新文写不进，需 `srelay forget` 后重收）。

## 四、两条会动数据的路径

**归档 aging**（capture/archive.ts:59-208）：

- 保留：`sessions` 行本身、`decisions` / `topics` / `key_questions` / `summary_*`、`cleanup_at`、`original_message_count`。
- 蒸发：整场 `messages` 删除（capture/archive.ts:171）、`session_vectors` 一并删（capture/archive.ts:175，语义随之过期）。
- 判据只有一份：`planAging` 是唯一选择器（core/compact/aging.ts:78-118）——已归档跳过、`active` 跳过、`imported` 与笔记跳过（判据来自 shared/session-kind.ts:29-37）、`extracted_version` 必须等于当前版本、决策数 ≥ `minDecisions`（生产传 0，靠版本门当安全网）、`strength < T = 1/e`（core/decay/strength.ts:25）；每轮封顶 200（core/compact/aging.ts:122）。
- 双通道顺序：先 workflow（默认 7 天窗）后普通（默认 30 天窗），否则 workflow 会话的 7~30 天区间会被普通通道提前蒸发（capture/archive.ts:312-324）。
- 审计与数据在同一个 `BEGIN IMMEDIATE` 事务里，异常整批回滚（capture/archive.ts:103、capture/archive.ts:201）。

**重建 rebuild**（capture/rebuild.ts:89-201）：源文件是唯一事实源，库是可重建的索引。

1. 新库建在 `<db>.rebuild`（capture/rebuild.ts:97），从源全量重摄（capture/rebuild.ts:106）。
2. 无法从源重建的会话整行搬迁：`imported` 与笔记，判据收敛在 `isNoteSession` / `isUnrebuildableSession`（shared/session-kind.ts:29-37）；搬完按 seq 重映射决策里的 `msgId`，映射不到就删字段（宁缺勿假，capture/rebuild.ts:61-87）。
3. 任何一条搬不过去 ⇒ 中止、旧库不动（capture/rebuild.ts:174-176）。
4. 显式 `rebuild` 两张 FTS（capture/rebuild.ts:179-180），否则「数据在但搜不到」。
5. 原子换库，旧库留 `.bak-<ts>`（capture/rebuild.ts:187-192）；守护在跑时拒绝，除非 `--force`（capture/rebuild.ts:90-93）。

## 五、索引与体积

删消息不会让 FTS 变小：触发器只往影子表写 delete 标记，要等 merge/optimize/rebuild 才真回收（[`../src/core/maintain/fts.ts`](../src/core/maintain/fts.ts) 顶部病历，:21）。判据故意保守：文件 / 实际内容 ≥ 2 倍，且内容 ≥ 64KB、消息 ≥ 50 条才动手（core/maintain/fts.ts:62-71）；动作是 `rebuild` 两张索引再 `VACUUM`（core/maintain/fts.ts:118-121），`optimize` 不够——它只合并段、不退墓碑（core/maintain/fts.ts:99-100）。

唯一自动入口是生命周期 `cleanup` 阶段（core/lifecycle/runner.ts:414-426）；手动入口 `srelay maintain --fts` 默认干跑，加 `--apply` 才真写库（bin/srelay.ts:59-62、bin/srelay.ts:88）。

## 六、实测数字

均引自仓库内记录，本次改写未独立复测：

- FTS 空间回收（2026-10-18，在**副本**上跑 rebuild + VACUUM）：六库 195.02 → 135.74 MB，省 59.28 MB / 30%，总耗时 4 秒；其中 E:/work 32.27 → 3.02 MB（`messages` 0.86 MB / 902 条，`messages_fts_data` 却占 28.55 MB，33 倍）、小说项目 14.20 → 1.41 MB（0.67 MB / 310 条，19 倍）（core/maintain/fts.ts:8-19）。
- FTS 测量本身有过两次静默失效：列名写错导致 `contentBytes` 恒 0；`length(TEXT)` 数字符导致中文比值被放大，修前 agent1super 判成 3.55 倍、实际 1.7 倍（core/maintain/fts.ts:80-86）。
- 正文占比：messages + FTS 占库 94~97%，落盘系数 3.1× 正文；热窗 60→30 天实测可省 agent1super 36.9% / music 69.3%（shared/config-merge.ts:142-143）。
- 库体积事故记录：09-21 涨到 229 MB；10-10 五库共 187 MB，其中 56 MB 是 freelist 空洞（小说项目 70%、music player 40%）（design-auto-archive.md:6-7）。
- 决策重复率：E:/music player 实测 423 条决策里 74 条重复（17%），最狠的一条重复 24 次，把简报仅有的 2 个名额占满（store/db.ts:898-899）。
- 归档空间回收的口径是 99.4% 正文（capture/archive.ts:2；代码注释与设计文档同口径，非本机逐库复核，privacy-and-lifecycle-design.md:135）。
- 未实测：写入吞吐（条/秒）、VACUUM 在 GB 级库上的耗时、并发写下的 P99 延迟。

## 已知限制

- decisions / topics / files 是 JSON 列，没有 SQL 索引；「按决策查」是全量扫 `sessions` + JS 过滤（store/db.ts:889-894），库大时是线性成本。
- 归档不可逆：正文蒸发后只剩派生结论，原文要回客户端会话里取；同时 `session_vectors` 被删（capture/archive.ts:175），归档会话不再参与语义检索。
- 重建救不回「源文件已被客户端删除」的会话——只有 `imported` 与笔记会被整行搬迁（capture/rebuild.ts:123-148），其余会话在源消失后重建即消失。
- 回收要独占写锁并重写整个文件（VACUUM）；期间其它写会被 `busy_timeout`（5000ms）挡下（core/maintain/fts.ts:26-28）。高并发下的实际影响未实测。
- schema 只向前兼容：库由更新版本的 srelay 创建会直接抛错并关闭（store/db.ts:290-293）。
- 全局库与项目库 schema 不同，用项目库的 `createDb` 去开全局库会抛（core/lifecycle/runner.ts:84-86 记录过这个事故），必须走 `openGlobal`。
- `forget_tombstones` 随库走：`forget --all` 连墓碑一起删，那时唯一的防复活闸是 ignore 文件里的 `session:` 规则（store/db.ts:224-232、cli/forget.ts:288-313）。
- `source_files.deleted` 列有定义（store/db.ts:116）但没有写入方，源端删除不会反映到库里。
- 未核实：`docs/EVALUATION.md` 里的 305 题指标属于检索层，不能拿来当存储层数字；本文档未从那里挪用任何数。
