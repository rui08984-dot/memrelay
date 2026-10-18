# 检索层

这块负责：把一条查询变成**会话级的有序结果**——分词、多路召回、融合、排序、长度惩罚、时间衰减，以及跨项目库的名次合并。不负责：采集与抽取（`src/capture/`、`src/core/extract/`）、结果如何进入模型上下文（见 [INTERFACES.md](./INTERFACES.md)）、嵌入模型本身的选型（`src/search-svc/semantic.ts` 只是可选补充路）。

![四条检索路径汇到融合，末端是实测 hit@1 / hit@10](./diagrams/retrieval.png)

<sub>图源 [diagrams/retrieval.mmd](./diagrams/retrieval.mmd)，改完重渲染</sub>

## 一次查询走哪几条路

```
query
 └─ parseQuery  分词 / 剔冗余子词 / 引号内=短语单元         src/core/tokenize/tokenizer.ts:127
     └─ searchOnce  每个单元一条 FTS5 查询（messages_fts）    src/search-svc/engine.ts:46
         ├─ 会话级 AND（单元必须全覆盖，可跨消息）            src/search-svc/engine.ts:262-280
         ├─ 零命中 → OR 兜底（+ 子词回退 ×0.6，默认关）       src/search-svc/engine.ts:282-292
         ├─ meta 面 sessions_fts（标题/决策/话题）            src/search-svc/engine.ts:326-342
         ├─ BM25+ delta（默认关）→ 覆盖率加权 → 长度惩罚       src/search-svc/engine.ts:349/375/382
         └─ 语义保底槽位（默认关；reserve 默认 3）             src/search-svc/engine.ts:407-418
     └─ searchCore  融合闸门 → fusedSearch                    src/search-svc/engine.ts:507/554-561
     └─ searchSessions  时间衰减（默认开）→ 标签扩展（默认关） src/search-svc/engine.ts:485-503
```

| 路 | 何时进入 | 融合权重 | 代码 |
|---|---|---|---|
| 主路（AND，零命中转 OR 兜底） | 总是 | 1.0 | `engine.ts:806` |
| 同义家族 + CJK bigram 改写 | 走到融合时 | 0.6 | `engine.ts:807-813` |
| 剔问句外壳后重搜 | `coreOnly: true`（默认关） | 0.8 | `engine.ts:839-842` |
| 子串 LIKE（不走分词器） | 查询里没有短语单元时 | 0.4 | `engine.ts:846-852` |
| 标签共现扩展 | `tagExpand: true`（默认关） | 0.5 | `engine.ts:855-860` |

查询真的走到融合时（见下一节闸门），默认并进的是**主路 + 改写路 + 子串路**三条；另两条默认关。融合按**归一化分数**而不是纯名次：`(N-i)/N * w * 长度惩罚`，多路互证再加 `min(0.1, 0.05*(路数-1))`（`engine.ts:873-885`）。纯 RRF 只看名次，那一代实测负结果已回滚（`engine.ts:794-802`）。

## 长度惩罚为什么必须在打分阶段

`score *= 1 / (1 + log10(1 + message_count / 300))`（唯一实现 `lenPenaltyOf`，`engine.ts:690-692`；常数 `LEN_PENALTY_PIVOT`=`engine.ts:626`）。长会话「什么词都碰得到，在每一条路上都是第一名」，事后乘系数改不动名次（`engine.ts:359-363`、`799-801`）。子路必须关掉 `searchOnce` 里那一次，否则二次乘罚（`engine.ts:809-811`）。

代价要一并记着：反向出题「答案恰好是那个巨无霸」时 hit@1 21.4%→9.5%（`engine.ts:152-158`）。要调就先动常数，不是关开关（同处）。

## 排序稳定性

- 主路排序键 `(score, coverage)`（`engine.ts:394`）；走 OR 兜底时反成 `(coverage, score)`（`engine.ts:397`）。
- 融合路排序键只有 `score`（`engine.ts:887`）；衰减后重排用 `(score, coverage)`（`engine.ts:482`）。
- **没有第三键**（比如 sessionId）。完全并列时靠 JS 排序的稳定性 + 输入顺序决定：同一库同一查询逐次一致；库变了插入顺序可能变，那条并列的位次就可能翻转。

多库检索在 `src/search-svc/namespace.ts`：两种命名空间（`project` / `global`），`global` 只读扇出各项目库（`namespace.ts:160`），每库用**它自己的** project_id 去查（`namespace.ts:167-170`）——用调用方的 id 会把别人的结果过滤光，且表现为「静默空结果」。合并按**名次轮转** `mergeByRoundRobin`（`namespace.ts:72-95`）：簇间只看各组首条的分数，簇内顺序原样保留，所以「过滤掉别的项目」不改变项目内次序是**由构造成立**的。判据 `admissible` 要求合并结果**逐位等于**单库结果的前缀（`namespace.ts:102-122`），因为旧实现的两个盲区（limit 太小导致整组没出现、丢中间一段仍递增）都会真空通过。

## 时间衰减

模块 `src/core/decay/decay.ts`，零依赖纯函数；乘性、恒在 (0,1]、只乘排序分数不过滤（`decay.ts:246`、`274`、`291-299`）。默认**开**：`DEFAULT_DECAY.enabled = true`（`decay.ts:96`），经 `defaultConfig()` → `mergeConfig()` 的 `resolveDecayConfig` 生效（`src/shared/config-merge.ts:153`、`174`）。接线点在 `searchSessions` 出口（`engine.ts:494-496`），不放在 `searchOnce` 里，否则每条子路都会重复衰减（`engine.ts:488-491`）。

注意一处注释漂移：`engine.ts:493`、`src/cli/query.ts:75`、`src/shared/config-merge.ts:75` 仍写「默认关」，与代码实际默认值相反。行为以 `decay.ts:96` 为准。

实测（`src/core/decay/decay-control.mjs`，真库 139 条候选，记录在 `decay.ts:87-95`）：候选集 100% 保留、老记录 11 条全部仍可检索、top-10 换血 3 条、平均年轻 15.1 天；**「提升多少」没有基准数据**，只有「不伤害召回」的证据（`decay.ts:93-95`）。配置键与默认：`decay.enabled/mode/half_life_days/floor(0.25)/alpha`（`decay.ts:48-58`、`86-101`）。

## 语义档（向量）当前状态

默认**关**：`if (cfg.semantic?.enabled !== true) return null`（`src/search-svc/semantic.ts:264`）——`semantic.enabled` 不写就是不启用。理由（`engine.ts:87-96`，978 题面里采 80 题）：语义开保底 3 槽 hit@10 40.0% / 610ms，开 1 槽 43.8%，关 45.0% / 284ms ⇒ 召回差异在统计噪声内（n=80），延迟 2.15 倍不是噪声；机制是保底槽位从 FTS 尾部抢名额，而语义选得不如 FTS。要开就把 `reserve_slots` 降到 1（同上注释）。

运行期状态落盘到 `~/.sessionrelay-semantic/status.json`（`src/search-svc/semantic-status.ts:25-28`），因为 CLI / 守护 / DSH 宿主是三个进程，而「启用了但装载失败」与「没启用」必须在运行期分得开（`semantic-status.ts:1-8`）。

## 中文分词

索引与查询共用一份实现（`src/core/tokenize/tokenizer.ts:1-3`）：jieba `cutForSearch`（`tokenizer.ts:11-12`、`48`）；索引侧保留单字（短语位置保真），非引号查询侧丢单字（`tokenizer.ts:38-52`）。查询解析还剔**冗余子词**——`数据库` 会被展开成 数据/据库/数据库，查询侧只留 `数据库`，实测单元 5→3（`tokenizer.ts:118-149`）。

为什么不用词典式（纯 bigram）：bigram 实现一直在（`tokenizer.ts:74-80`，依据 SIGIR 1997 那篇「中文检索不需要词典」）。本机实测 65 个真实查询召回打平 65/65，但 jieba 平均返回 38.5 条、bigram 3.0 条（`tokenizer.ts:66-72`）——那份 ground truth 是「正文字面包含」，定义本身偏向 bigram，paraphrase 场景没验过，所以不走默认（`tokenizer.ts:71-73`）。配置键 `search.tokenizer`：`'jieba' | 'bigram'`（`src/shared/config-merge.ts:34`，默认 jieba 见 `139`）。

同义家族表是手写的 26 族（`src/core/tokenize/rewrite.ts:23-52`），问句外壳词也是手写表，剔外壳入口 `pickScaffold`（`rewrite.ts:115`）；CJK bigram 展开只对长度 ≥4 的词做（`rewrite.ts:60-66`）。

## 判据与边界：什么会被拒绝/跳过/告警

| 情形 | 行为 | 出处 |
|---|---|---|
| 查询解析出 0 个单元 | 直接返回空，不查库 | `engine.ts:216` |
| `limit` 是负数/非数 | 入口一次性夹成非负整数（否则 `slice(0,-1)` 语义反了） | `engine.ts:508-513` |
| 取不到 `message_count` | 不惩罚（`catch` 里不做替代猜测） | `engine.ts:391` |
| 时间戳缺失/损坏 | 不衰减，并在 `note` 写明原因 | `decay.ts:259-261` |
| 分数非有限或 ≤0 | 原样返回，不乘系数（负分乘 <1 会变成「越老越靠前」） | `decay.ts:297` |
| 衰减配置写错键/越界 | `decayConfigWarnings` 逐条列出并说明退化到什么 | `decay.ts:116-164` |
| 某个项目库打不开 | 跳过并记入 `failed[]`，不废掉整次检索 | `namespace.ts:173-175` |
| 读不到库的 project_id | 记 `failed` 跳过，不返回空结果冒充「没有」 | `namespace.ts:170` |
| 某扩展词检索抛错 | 跳过该词并 `console.warn` | `engine.ts:747` |
| 语义词失效 | 状态文件记 `failed` + 人话摘要，面板/CLI 同读一份 | `semantic-status.ts:72-99` |

## 实测数字（305 题基线，口径照抄 `docs/EVALUATION.md`）

| 指标 | 值 |
|---|---|
| hit@1 | 11.5% |
| hit@10 | 45.6% |
| MRR | 20.4% |
| P50 延迟 | 388ms |

三臂：R（换说法）105 题 15.2%/57.1%，T（时间相关）105 题 13.3%/47.6%，X（跨会话）95 题 5.3%/30.5%，合计 305 题（`docs/EVALUATION.md:11-15`、`28-39`）。

口径与局限，三条都要说：

1. **题量小且题不独立**：305 题落在 105 个真实会话上，同一会话最多 3 题（`EVALUATION.md:3`、`17`）。所以置信区间必须按**会话整簇**重采样再配 McNemar，题级区间是假窄；hit@1 的区间是题级 ±3.44pt / 簇级 ±3.85pt（`CHANGELOG.md:28-29`）。
2. **换题面就是换尺子**：同一份代码，978 题面集上 hit@10 = 56.44%（`engine.ts:590`），305 题集上是 45.6%——两个数不能互相引用。更硬的一例：融合闸门在 198 条查询上「0/198 不同」（据此写「死代码」），978 条上变成「15/978 不同（1.5%）」（`engine.ts:533-537`）。
3. **只量了会话级命中**：hit@k 的 k 是「会话排第几」，没量片段级/消息级准确率；P50 是本机数据，不含跨库扇出（`--global` 是另一条路径）。

## 负结果：默认关着的东西，别再试一遍

| 试过的 | 结论 | 出处 |
|---|---|---|
| 同义家族改写在主路之后追加 | 305 题 A/B：hit@1 −0.3pt、hit@10 +1.0pt、P50 388→437ms（+12.6%）⇒ 默认关 | `engine.ts:829-838`、`EVALUATION.md:47` |
| 标签共现扩展（追加 / 保底 3 槽 / 并进融合） | 978 题 hit@10 56.44% 持平或 −1.43pt，hit@1 所有臂一动不动 ⇒ 默认关 | `engine.ts:588-612` |
| 子词回退（长中文词拆 2 字滑窗） | 23 题 6/23 → 6/23，命中集合逐条相同；不是没触发，是触发也没用 ⇒ 默认关 | `engine.ts:661-678` |
| 语义向量补充 | n=80 hit@10 40.0% vs 45.0%、延迟 2.15× ⇒ 默认关 | `engine.ts:87-96` |
| 纯 RRF（第一代融合） | 已证否回滚 | `engine.ts:794-800` |
| meta 双路命中加分 `META_BOOST` | 默认 0，先量再接 | `engine.ts:629-638` |
| BM25F / BM25+ | 实现与默认值都在，但 `opts` 不传就是关，没进默认档 | `src/search/bm25.ts:62-66`、`98-102` |

一句话理由：这些路都只在**补位置**，而主路的会话级 AND 已经把候选卡死；能真正改 hit@1 的在查询侧（拆题面/减约束），不在加同义词族。

## 已知限制

- 语义档关着，「换个说法」只能靠手写的 26 族同义词表（`rewrite.ts:23-52`），表外的说法搜不到。
- 打分粒度是**单个会话**，跨会话拼图题结构性吃亏（X 臂 hit@1 5.3%，`EVALUATION.md:51`）；要治得换粒度，不是调参。
- 排序没有第三键，完全并列的位次依赖输入顺序（见「排序稳定性」）。
- 长度惩罚对「答案恰在巨无霸里」的问法是负收益（`engine.ts:155`）；可调的是常数 `LEN_PENALTY_PIVOT`，不是开关（`engine.ts:156-158`）。
- 时间衰减的**增益幅度**未实测（`decay.ts:93-95`），只有「不伤害召回」的证据。
- 跨库只合并名次、不合并分数：不同库的 BM25 分数不可比（`namespace.ts:21-26`）。
- `srelay search --global` 不吃本项目 scope 与 decay（`src/cli/query.ts:47`）。
- 所有实测都在单机、中文仓库数据上；换语言/换库规模，上面每个数字都要重量。
