# 上游同步评估（2026-10-20）

**对象**：`upstream/main` 5 个提交 vs 本地 `main`

**结论先说**：**这 5 个提交一个都不用并** —— 3 个能力我们已有且更强，2 个是上游自己的发布版本号。`git merge` 在本仓**物理上不可用**（unrelated histories）。

**范围**：只读分析。未执行 merge / cherry-pick / checkout / stash，未改 src。本文件是唯一新增。

---

## 0. 先纠正一个前提：本仓历史与上游**没有共同祖先**

这条决定后面所有策略，必须先说清。

| 事实 | 我跑的命令 | 观测 |
|---|---|---|
| 我们的根提交是**独立根**（无父） | `git rev-list --max-parents=0 HEAD` | `4fc676e` |
| 它是 2026-10-18 的全仓重写 | `git log --reverse --format='%h %ad %s'` | `4fc676e 2026-10-18 memrelay — 属于项目、不属于任何厂商的本地记忆层` |
| 上游侧被 **shallow** 截断 | `cat .git/shallow` | `74dc0c4cfacdd97ea33ae486f2ef933207e15457` |
| 74dc0c4 其实**有父**，只是对象不在本地 | `git cat-file -p 74dc0c4` | `parent d66f9dd...`；`git cat-file -t d66f9dd` → `fatal: Not a valid object name` |
| 两棵树**没有** merge-base | `git merge-base --all HEAD upstream/main` | 空输出，exit=1 |

**会误导人的地方**：`git show --stat 74dc0c4` 把它渲染成「118 files changed, +21639」—— 那是因为它是 shallow 边界、父树缺失，**不是**它真建了 118 个文件。这个假 diff 既不能当判定依据，也不能拿去做 cherry-pick。

**但**：`archive/pre-memrelay`（=`a8accb9`）这条旧历史**包含**上游（`git merge-base archive/pre-memrelay upstream/main` = `05e7919`，即 upstream/main 本身）。说明 0.5.1 曾经在我们的 fork 链里，10-18 重写时内容被带过来了 —— 所以「我们是否已有」必须**按内容核**，不能按 git 祖先判定。下文判定全部按内容。

---

## 1. 逐提交判定

| # | 提交 | 内容 | 判定 | 一句话理由 |
|---|---|---|---|---|
| 1 | `74dc0c4` | docs：Qoder 需 SRELAY_PROJECT_ROOT（3 文件 +12/-2） | **不该并** | 措辞已被紧随的 `0c77aa9` 改写成「0.5.0 起免配置」，并进去等于把过时建议搬回；且它落在 shallow 边界，diff 不可用 |
| 2 | `0c77aa9` | serve 根解析信号链 + 多项目模式（12 文件） | **已有（且更强）** | design 文档与上游**逐字节相同**，9 条回归**实跑 9/9 通过**，registry 实现比上游多了写侧闸门与 TTL |
| 3 | `89c1a90` | release 0.5.0（2 文件：CHANGELOG 标题 + package.json version） | **不该并** | 纯版本号；我们包名/版本已分叉（`memrelay` 1.0.0 vs `@ewanjasper/sessionrelay` 0.5.1），CHANGELOG 里 [0.5.0] 段已在 |
| 4 | `e7fe17a` | fix：测试子进程重定向注册表 + roots 诊断行（3 文件） | **已有（且更强）** | server 诊断行**逐字相同**、dist.spec 重定向**已存在**；我们另有 `isTransientRoot` + `VITEST` 双闸门 |
| 5 | `05e7919` | release 0.5.1（2 文件，同上） | **不该并** | 同 #3 |

### 1.1 `74dc0c4` 细节（本地看不到 diff，我用 GitHub patch 补齐）

本地 diff 不可用，所以取了只读的 `curl .../commit/74dc0c4.patch`：

```
 README.en.md       | 6 +++++-
 README.md          | 6 +++++-
 docs/user-guide.md | 2 ++
 3 files changed, 12 insertions(+), 2 deletions(-)
```

它加的是「Qoder 不设 cwd → 起手 exit 1 → 请改用 `SRELAY_PROJECT_ROOT` 兜底」。

**为什么说已被取代**：下一个提交 `0c77aa9` 把同一批段落改写成了「**0.5.0 起免配置**」（roots 协议 + 注册表）。上游现在的 `README.md:307` 就是这个新措辞。

**我们这边**：

- `docs/user-guide.md:352` 与上游 `user-guide.md:351` **逐字相同**（`diff` 两行 → IDENTICAL）。
- `docs/design-serve-resolve.md` 与上游 **0 差异**（`git diff upstream/main -- docs/design-serve-resolve.md` 空输出）。
- `CHANGELOG.md:306` 已有 Qoder 事故记录。
- **唯一真空缺**：`README.md` / `README.en.md` 里 `grep 'SRELAY_PROJECT_ROOT\|MCP_STDIO\|极简配置'` → **无任何命中**（我们 README 是整篇重写过的，没有「MCP 接入」这一章）。

所以这条的正确处理不是合并，而是**可选手写补一段**（措辞用 `0c77aa9` 之后的新版，不用 `74dc0c4` 的旧版）。这是润色，不产生任何 merge。

### 1.2 `0c77aa9`（最关键的一条）—— 为什么是「已有」

它改了 12 个文件（`git show 0c77aa9 --name-status`）：`CHANGELOG.md`、`README.en.md`、`README.md`、`docs/design-serve-resolve.md`(A)、`docs/user-guide.md`、`src/cli/doctor.ts`、`src/cli/init.ts`、`src/cli/watch.ts`、`src/mcp/server.ts`、`src/shared/registry.ts`(A)、`test/mcp/serve-resolve.spec.ts`(A)、`test/smoke/dist.spec.ts`。

逐项对照（左=上游交付物，右=我们仓实测）：

| 上游能力 | 我们的实现 | 证据 |
|---|---|---|
| `src/shared/registry.ts` | 有，**150 行**，`registryDir()` 认 `SRELAY_REGISTRY_DIR` | `wc -l` / `grep registryDir` |
| 根解析信号链 env→cwd→roots→registry | `RootHolder` + `resolveViaRoots`(:827) + `resolveViaRegistry`(:857) + `Tried` 类型(:49) | `grep` |
| 失败不再 exit(1)，给 `unresolved_project` 载荷 | `class UnresolvedProject`(:45)、`guidance()` 带 `tried`/`candidates`/`howTo`(:791) | `grep` |
| 各工具可选 `project` 参数 | `zProject`(:66) 注入全部工具；`guard()` 包装(:143) | `grep` |
| doctor 注册表预演项 | `src/cli/doctor.ts:250`「全局项目注册表…预演 serve 会选中谁」，用 `registryCandidates()` | `grep` |
| init / watch 登记注册表 | `init.ts:172 touchRegistry(root)`；`watch.ts:67-68` 登记 + 10 分钟心跳 | `grep touchRegistry` |
| initialize 完成后才查客户端能力（R3 抓的 bug） | `server.ts:829-835` 有同款注释与重试取值 | `grep getClientCapabilities` |
| TTY 裸跑旧行为保留 | `server.ts:910 if (!ctx && process.stdin.isTTY)` | `grep isTTY` |
| 9 条回归 | `test/mcp/serve-resolve.spec.ts` 224 行，9 个 `it`（R1/R1b/R2/R3/R4/R5/R6/R7/R9） | **实跑 9 passed (9)，7.20s** |

**与上游的差异只有「我们更新」这一类**：

- `docs/design-serve-resolve.md`：**0 diff**（逐字节相同）
- `test/mcp/serve-resolve.spec.ts`：仅 3 行差异，全是 `16 工具` → `14`（我们 Phase 1 检索四合一后的口径）
- `test/smoke/dist.spec.ts`：仅 2 行，同上
- `src/cli/init.ts`：+36/-7（超集：env 优先探测、DSH 源、看板初稿）
- `src/cli/watch.ts`：+30/-4（超集：多了 `--global` 全局守护）
- `src/cli/doctor.ts`：+280/-11（重写加大）
- `src/mcp/server.ts`：+392/-96（重写加大，14 工具）

> 注：`zProject` 上方注释仍写着「全部 16 工具可选」，而实际注册 14 个（`grep -c '}, guard(' = 14`）。属**注释残留**，不是功能缺口。


### 1.3 `e7fe17a` 细节（你特别关心的「测试污染真实家目录」）

这条上游只改 3 个文件：`CHANGELOG.md`、`src/mcp/server.ts`（+1 行）、`test/smoke/dist.spec.ts`（+7/-1）。

**两处改动我们都已经有了**：

1. 诊断行 —— 上游加在 `server.ts` 的：

   ```ts
   process.stderr.write(`[srelay-serve] roots 回报 ${dirs.length} 个目录，有效 ${valid.length} 个\n`);
   ```

   我们 `src/mcp/server.ts:843` **逐字相同**。
2. 测试重定向 —— 我们 `test/smoke/dist.spec.ts` 已有 `SRELAY_REGISTRY_DIR` 指向临时目录（含同款注释「0.5.0 真实事故：三次全量测试 = 三条 Temp 垃圾条目」）。与上游版本仅差工具数 16→14。

**你问「我们仓里测试是否也写真实家目录」—— 答案：历史上写过，现在被三道闸门挡住。** 这是实测，不是推断：

| 闸门 | 位置 | 作用 |
|---|---|---|
| ① `VITEST` 环境闸 | `server.ts:886`：`maySpawn = !process.env.VITEST && !process.env.SRELAY_NO_DAEMON_SPAWN` | 测试下 serve **根本不写注册表**（`server.ts:812/879` 都被 `maySpawn` 包着） |
| ② 写侧临时目录闸（**上游没有**） | `registry.ts:55` 调用、`:99 isTransientRoot()` | 临时目录不是项目，`touchRegistry` 直接 return |
| ③ 读侧剪枝 + TTL（**上游没有**） | `registry.ts:132` 剪枝、`:111 REGISTRY_TTL_DAYS = 30` | 存量垃圾条目也会被剔除 |

`registry.ts` 里的原注释（我们 1013 审计 P2 写的）已经把话说明白：

> 上游 e7fe17a 只让测试子进程不再污染新条目，但手工在 Temp 下建栈的存量条目永不过期（实测 16 个候选里 12 个是 %TEMP%\sb7-* 沙盒）。这里是写侧闸门。

**当前真实家目录实测**：

- `~/.sessionrelay-registry/projects.json`：**10 条，0 条 Temp**（`grep -oiE 'temp|tmp'` 无命中）。10 条全是真实项目（`D:\agent1super`、`E:\music player` …）。
- 但备份文件留下了历史：`projects.json.bak-before-p2-20261013-190127` 有 **11 处 Temp 命中**，`bak-before-clean-20261017` 有 1 处 —— 说明我们**确实中过同一个坑**并已手工清过。
- `~/.sessionrelay/last-search/` 只有 2 个快照，project 分别是 `proj_d--agent1super`(15:26) 与 `proj_d--dsh插件  记忆`(15:05)，**都是真实工作区**，不是测试临时目录 → 无污染（这是 fork 新增功能的正常记账）。

**结论**：`e7fe17a` 本身不用并；它代表的 bug 类在我们这边**已经解决得更彻底**。

*（顺带记一笔可选加固）*：`test/contract/mcp.spec.ts` 会 spawn `serve` 但没有设 `SRELAY_REGISTRY_DIR`，靠的是闸门①。防御性补一行也无害，但非必须。

---

## 2. 合并策略：`merge` 不可用，`cherry-pick` 也无事可做

### 2.1 `git merge` 直接被 git 拒绝

```console
$ git merge-tree --write-tree upstream/main HEAD
fatal: refusing to merge unrelated histories
```

原因见 §0：我们根提交 `4fc676e` 是独立根，`git merge-base` 返回空。**这不是「会冲突」，是「没有共同祖先、git 拒绝开始」。**

若强加 `--allow-unrelated-histories`，git 会用空树当 base，结果是灾难性的 add/add：

```console
$ git merge-tree $(git merge-base HEAD upstream/main || echo 4fc676e) HEAD upstream/main
added in remote
  their  100644 31b18a9... .github/ISSUE_TEMPLATE/adapter_request.md
  ...（上游每个文件都被当成「新增」）
```

规模：`git diff --name-status upstream/main HEAD` →

- **71 个文件两边都存在但内容不同**（= add/add 冲突候选）
- **4 个只在上游**：`.github/ISSUE_TEMPLATE/adapter_request.md`、`.github/workflows/ci.yml`、`assets/demo-en.gif`、`assets/demo-zh.gif`（后两个共约 11.8 MB）
- 342 个只在下方

### 2.2 `cherry-pick` 同样打不进去（只读预演）

用 `git show <sha> --format='' | git apply --check` 预演（**不写工作区、不动 index**），5 条全部失败：

| sha | 预演结果 |
|---|---|
| `74dc0c4` | 每个文件都 `already exists in working directory`（假 diff：被当成「新建 118 文件」） |
| `0c77aa9` | `patch failed`：CHANGELOG.md / README.en.md / README.md / docs/user-guide.md / src/cli/doctor.ts / src/cli/init.ts …；`docs/design-serve-resolve.md: already exists` |
| `e7fe17a` | `patch failed`：CHANGELOG.md:3、src/mcp/server.ts:544、test/smoke/dist.spec.ts:18 |
| `89c1a90` | `patch failed`：CHANGELOG.md:3、package.json:1 |
| `05e7919` | `patch failed`：CHANGELOG.md:3、package.json:1 |

`e7fe17a` 的 `server.ts:544` 失败尤其说明问题：那行我们**已经有**（在 :843），只是行号/上下文不同 —— cherry-pick 会以为要新增，实则会变成重复。

### 2.3 推荐策略

> **一条：都不并（0 个提交进入本仓）。保留 upstream 远端作为「读上游用的镜子」，只在将来出现「我们确实没有的新能力」时，按单提交、先 `apply --check` 预演、再 `cherry-pick -n` 人工挑。绝不走 `merge`。**

理由链：

1. 5 个提交中 3 个（`74dc0c4` 的内容被取代 / `89c1a90` / `05e7919`）**不该进**；
2. 余下 2 个（`0c77aa9` / `e7fe17a`）的能力**已完整存在且更强**，并入只会带来「把 16→14 改回 16」这类**回归**；
3. `merge` 在此仓需要 `--allow-unrelated-histories`，代价是 71 处 add/add 冲突 + 重加 4 个上游文件（含 11.8MB gif）**换不到任何新代码**；
4. 我们与上游是**两个不同的 npm 包**，版本线本来就该分开走。

---

## 3. 预计冲突文件清单

按「如果硬来」分别列，便于将来有人手滑时对照。

### A) 若 `git merge --allow-unrelated-histories upstream/main`（**不推荐，仅备查**）

71 个双向修改文件会全部 add/add 冲突，其中**必然要人做决策**的核心文件：

```
CHANGELOG.md                  ← 必然冲突（我们 479 行重写 vs 上游 Unreleased）
package.json                  ← name/version 直接对立（memrelay 1.0.0 vs @ewanjasper/sessionrelay 0.5.1）
package-lock.json
README.md  README.en.md  docs/user-guide.md
src/mcp/server.ts             ← 最大的一个（+392/-96）
src/shared/registry.ts  src/cli/{init,watch,doctor}.ts
src/cli/{save,query,status,sync,service,ui,forget,meta,misc,semantic}.ts
src/store/db.ts  src/shared/{config,lock,paths}.ts
src/search-svc/{engine,semantic}.ts  src/core/tokenize/tokenizer.ts
test/contract/mcp.spec.ts
（其余 30+ 见 git diff --name-status upstream/main HEAD | awk '$1=="M"{print $2}'）
```

### B) 若逐条 `cherry-pick`（**推荐路径，但当前 0 条需要**）

| sha | 冲突 / 失败文件 |
|---|---|
| `74dc0c4` | `README.md`、`README.en.md`、`docs/user-guide.md`（且 diff 本身是假的全量新建） |
| `0c77aa9` | `CHANGELOG.md`、`README.md`、`README.en.md`、`docs/user-guide.md`、`src/cli/doctor.ts`、`src/cli/init.ts`、`src/mcp/server.ts`；`docs/design-serve-resolve.md` / `src/shared/registry.ts` / `test/mcp/serve-resolve.spec.ts` 报 *already exists* |
| `e7fe17a` | `CHANGELOG.md`、`src/mcp/server.ts`、`test/smoke/dist.spec.ts` |
| `89c1a90` / `05e7919` | `CHANGELOG.md`、`package.json` |

---

## 4. 版本号：**不要动**

| | 我们 | 上游 |
|---|---|---|
| package name | `memrelay` | `@ewanjasper/sessionrelay` |
| version | **1.0.0** | 0.5.1 |
| bin | `srelay` / `sessionrelay` | 同 |
| `git describe` | `v1.0.0-57-g4fba407` | `v0.5.1` |

- 上游 0.5.0/0.5.1 是**它们自己 npm 包的发布号**，与 `memrelay` 无关；我们 1.0.0 在数值上也已高于它。
- 我们的 CHANGELOG 已完整收录 `## [0.5.0] - 2026-09-18`（:296）与 `## [0.5.1] - 2026-09-18`（:290）两段（e7fe17a 的修复写在 :293-294），**知识没有丢**，只是版本号各自演进。
- 本地 `git tag` 现状：`v0.5.0`=`89c1a90`、`v0.5.1`=`05e7919`（都是**上游**提交）、`v1.0.0`=`30caef9`、`v0.5.1-fork.2`=`2a1340c`、`archive/pre-memrelay`=`a8accb9`。命名空间已混了上游标签，但 `git describe` 取到的是可达的 `v1.0.0`，无实际影响。
- **结论：不改 package.json，不动 tag，不打 release。** 唯一「动作」是不动作。

---

## 5. 推荐操作序列（命令级）

当前正确做法 = **只做 #1（可选），其余全部不动**。

```bash
cd "D:/dsh插件  记忆/core/SessionRelay"

# --- 0. 确认现状（每次都先看，别凭记忆） ---
git rev-list --left-right --count HEAD...upstream/main     # 期望 69  5
git status --porcelain                                     # 期望空
git describe --tags                                        # v1.0.0-57-g4fba407

# --- 1. 【唯一可选动作】README 补一段 Qoder / MCP 接入提示（手写，不走 git 合并） ---
#     我们 README 完全重写、无「MCP 接入」章节；user-guide 与 design 文档已覆盖，属锦上添花。
#     ⚠️ 用 0c77aa9 之后的新措辞（「0.5.0 起免配置」），不要用 74dc0c4 的旧措辞。
#     可参考的原文：git show upstream/main:README.md | sed -n '300,315p'
#     （若不做，本条留空，本项目无需任何变更）

# --- 2. 不 merge、不 cherry-pick（5 条全部判定为不需要） ---
#     将来若上游出现「我们真没有」的新提交，按下面三步走：
#   a) 先只读预演，绝不直接 pick
git show SLOT_SHA --format='' | git apply --check
#   b) 看它到底改哪些文件，逐个对照我们是否已有
git show SLOT_SHA --name-status --format=''
#   c) 预演通过才进工作区（-n 不自动提交，留人工审）
git cherry-pick -n SLOT_SHA
git diff --cached          # 人看
npx vitest run test/mcp/serve-resolve.spec.ts test/smoke/dist.spec.ts test/contract/mcp.spec.ts

# --- 3. 保持现状时的常规回归 ---
npx vitest run test/mcp/serve-resolve.spec.ts   # 9 passed（本次实测 7.20s）
npx vitest run test/smoke/dist.spec.ts
```

（上面 `SLOT_SHA` 是占位符，真要用时替换成具体 sha。）

**若坚持要拿到上游完整历史以便将来评估**（可选，会改 `.git`，需你点头我再做）：

```bash
# 补深历史，让 74dc0c4 的真 diff 变得可读（只动 .git/objects，不动工作区）
git fetch --deepen=200 upstream
git log --oneline upstream/main`6..upstream/main    # 现在能看见 d66f9dd 了
```

> 我**没有**执行这条（它写 `.git`，超出本次只读授权）。

---

## 6. 我不确定的地方（不猜，标出来）

1. **`74dc0c4` 的本地 diff 无法自证**。我是用 `curl` 取 GitHub 的 `.patch` 才知道它改了哪 3 个文件、加了几行。若离线，这条只能靠「内容是否已在」间接判断 —— **我无法从本地 git 对象证明**它就是那 12 行。
2. **`0c77aa9` 是否 100% 覆盖**：我按「能力清单逐项对照 + 9/9 测试通过 + design 文档 0 diff」判为「已完整覆盖」。但我**没有**做上游/本地 `server.ts` 的逐函数等价证明 —— 两边实现已分叉（我们 +392/-96），存在「上游某处边界处理我们没有」的理论可能。要彻底排除，需在同一临时克隆里对两边跑同一套 9 条用例（会新建目录，本次未做）。
3. **我们全量测试是否真的零家目录写入**：我核了注册表（0 Temp）与 last-search（2 条真实项目）。但 `/.sessionrelay/` 下其它文件（如 `global.sqlite`）我**没有逐文件比对 mtime 归因**，也没跑一遍全量 125 个 spec 后再看家目录快照。目前结论是「三个已知向量都被挡住」，不是「已证明绝对无写入」。
4. **`test/contract/mcp.spec.ts` 未设 `SRELAY_REGISTRY_DIR`** 目前安全是靠 `maySpawn = !process.env.VITEST ...`。我确认 `VITEST` 会经 `{...process.env}` 传给子进程，但**没有实测**「跑一次 contract spec 然后看注册表 mtime 是否变化」（做了也只是弱证据，因为闸门在代码里）。
5. **`74dc0c4` 的「该不该并」含一点主观**：技术上它可作为「README 加一段 Qoder 提示」的素材；我判「不该并」是因为措辞已被取代。若你想要这段文档，正确做法是手写、不是合并 —— 这一点由你拍板。
6. **上游是否还会更新**：本地 `upstream/main` 停在 `05e7919`（提交于 2026-09-18），而今天是 2026-10-20 —— **一个月没动**。但 `.git/FETCH_HEAD` mtime 是今天 15:22，说明刚 fetch 过，所以「停更」这个判断基于刚取的数据，可信。

---

## 附：本次全部只读命令（可复核）

```bash
git remote -v                                              # origin=memrelay, upstream=EwanJasper/SessionRelay, fork=rui08984-dot/SessionRelay
git rev-parse --short HEAD                                 # 4fba407
git describe --tags                                        # v1.0.0-57-g4fba407
git rev-list --left-right --count HEAD...upstream/main     # 69  5
git log --oneline HEAD..upstream/main                      # 5 条
cat .git/shallow                                           # 74dc0c4...
git cat-file -p 74dc0c4                                    # parent d66f9dd（对象不存在）
git rev-list --max-parents=0 HEAD                          # 4fc676e（无父 → 独立根）
git merge-base --all HEAD upstream/main                    # 空，exit=1
git merge-tree --write-tree upstream/main HEAD             # fatal: refusing to merge unrelated histories
git diff --name-status upstream/main HEAD                  # 71 M / 4 only-upstream / 342 only-ours
git show SLOT_SHA --format='' | git apply --check          # 5 条全部 patch failed
git diff upstream/main -- docs/design-serve-resolve.md     # 空（逐字节相同）
git diff upstream/main -- test/mcp/serve-resolve.spec.ts   # 3 行（16→14）
git diff upstream/main -- test/smoke/dist.spec.ts          # 2 行（16→14）
npx vitest run test/mcp/serve-resolve.spec.ts              # 9 passed (9) 7.20s
grep -rn 'touchRegistry' src/                              # init:172 / watch:67,68 / server:812,879
grep -n 'maySpawn' src/mcp/server.ts                       # :886 = !VITEST && !NO_DAEMON_SPAWN
ls -la `/.sessionrelay-registry/                           # 10 条，0 Temp
```
