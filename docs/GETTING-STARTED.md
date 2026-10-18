# 从零开始

这份是给第一次用的人看的。已经懂了的人可以直接看 [README](../README.md)。

全程三条命令，五分钟。中间有个地方会让你以为坏了——第 5 节专门讲那个。

---

## 1. 先确认你有 Node

打开终端（Windows 用 PowerShell 或 CMD，Mac/Linux 用终端），敲：

```bash
node -v
```

看到 `v22.x` 或更高的版本号就往下走。三种情况：

| 你看到 | 说明 | 怎么办 |
|---|---|---|
| `v22.11.0` 这种 | 可以 | 继续 |
| `v20.x` 或更低 | 版本不够 | 去 [nodejs.org](https://nodejs.org/) 装 LTS |
| 报错 `不是内部或外部命令` | 没装 | 去 [nodejs.org](https://nodejs.org/) 装 LTS，装完**重开终端** |

> 装完不重开终端，`node` 会一直找不到。这不是 bug，是 PATH 没刷新。

---

## 2. 安装

一条命令：

```bash
npm install -g https://github.com/rui08984-dot/memrelay/releases/download/v1.0.0/memrelay-1.0.0.tgz
```

不用注册任何账号。装完验证：

```bash
srelay --version
```

输出 `1.0.0` 就对了。

> 如果 `srelay` 报「不是内部或外部命令」，把终端关掉重开一次。npm 装全局命令后要重开才认。

---

## 3. 在你的项目里初始化

**先进到你想记录的那个项目目录**，再敲：

```bash
cd 你的项目路径
srelay init
```

正常会长这样：

```
✓ 已初始化 <你的项目>\.sessionrelay
  来源: zcode, dsh, codex
  模式: full
✓ 已生成看板初稿 <你的项目>\progress.md（1 行）
✓ 回填最近 30 天：发现 0 会话 · 新入库 0 · 消息 0
```

它在项目里只加了三样东西：

- `.sessionrelay/` —— 记忆库本体（一个 SQLite 文件）
- `.sessionrelayignore` —— 哪些项目不要被记录
- `progress.md` —— 人写的看板，它只读不改

**不会动你的代码，不会动你的 git。**

---

## 4. 确认它活了

```bash
srelay doctor
```

它会逐项体检，输出类似：

```
✅ Node 运行时           v24.19.0
✅ SQLite FTS5        可用
✅ 中文分词 (jieba)       正常
⚠️  Claude Code 源目录    不存在  → 未安装/未使用 Claude Code 可忽略
✅ ZCode 库（只读探测）      C:\Users\你\.zcode\cli\db\db.sqlite
✅ relay.sqlite 完整性   ok
⚠️  守护进程               未运行  → srelay watch --install-service
...
23 项检查：16 通过 · 7 提示 · 0 失败
```

**怎么读这个结果**：

| 符号 | 意思 | 要做什么 |
|---|---|---|
| ✅ | 正常 | 不用管 |
| ⚠️ | 可选项，没有也能用 | 看 `→` 后面那句话，通常写明了怎么办 |
| ❌ | 真有问题 | 这个必须处理 |

**只关心最后一行**：`0 失败` 就没问题。7 个提示是正常的——比如你没装 Claude Code，那一条提示跟它对应，跟你无关。

---

## 5. 为什么现在是空的（重要）

这一步大多数人会以为坏了。

```bash
srelay brief
```

你可能看到：

```
决策 0 条 · 未决 0 条 · 最近在动 0 个
  经验 3 条（会自动注入新对话）：
  · ...
```

**这不是坏了。** 两个原因：

**① 它是按项目隔离的。** 你在这个目录下**还没有用 AI 工具聊过天**，所以没有可采的东西。你在别的项目里聊过的内容，不会跑到这个项目来——这是故意的，不然每个项目的记忆都会互相串。

**② 那 3 条经验是跨项目的。** 经验库是全局的，跟项目无关。所以新项目里看到 3 条经验，恰恰说明它是正常的。

打个比方：项目库是「这个项目的聊天记录」，全局库是「你从所有项目里总结出的经验」。新项目没有聊天记录，但经验是通用的。

---

## 6. 怎么让它有数据

两条路，选一条。

**路 A：让守护在后台跑（推荐）**

```bash
srelay watch --install-service
```

注册成开机自启的后台服务，之后你不用管它。它会定时扫你的 AI 工具会话目录，把属于这个项目的对话收进来。

**路 B：手动跑一次**

```bash
srelay sync
```

然后**去这个项目里正常用 AI 工具聊几句**（说点有结论的话，比如「就用方案 B 吧」「这个坑别踩」），再跑一次：

```bash
srelay sync
srelay brief
```

这次 `brief` 里应该有内容了。它长这样：

```
决策 8 条 · 未决 0 条 · 最近在动 3 个
  🗂 db.ts（16 场）
  🗂 index.js（14 场）
  2026-10-17 ✗ 换成我们的了
  2026-10-17 ✓ 决定加载的是 cordis.yml
  经验 3 条（会自动注入新对话）：
  · ...
```

**每一行都是从那几句对话里抽出来的**，不是模型编的。`✗` 是你否掉的方案，`✓` 是你定的。

---

## 7. 它支持哪些 AI 工具

装完就在盯着这六个的会话目录：

| 工具 | 数据在哪 |
|---|---|
| Claude Code | `~/.claude/projects/` |
| Codex | `~/.codex/` |
| ZCode | `~/.zcode/cli/db/db.sqlite` |
| DSH | 各工作区的会话文件 |
| Qoder | Qoder 的会话目录 |
| Trae | Trae 的会话目录 |

没装的会自动跳过，`doctor` 里显示「未检测到（未安装可忽略）」——**这不是错误**。

---

## 8. 常见问题

<details>
<summary><b>装完 srelay 命令找不到</b></summary>

关掉终端重开。npm 装全局命令后，当前终端的 PATH 不会自动刷新。

</details>

<details>
<summary><b>brief 一直是空的</b></summary>

按顺序查：

1. `srelay doctor`，看最后一行是不是 `0 失败`
2. 确认你**在这个项目目录下**跟 AI 聊过（不是别的项目）
3. `srelay sync` 手动跑一次，看「发现 N」是不是 0
4. 如果发现是 0，说明会话确实不属于这个项目——换个项目目录试试

</details>

<details>
<summary><b>会不会把我的代码传到网上</b></summary>

不会。全部内容只写进你磁盘上的一个 SQLite 文件（`.sessionrelay/relay.sqlite`）。没有账号、没有服务器、没有遥测。断网也能用。

</details>

<details>
<summary><b>它会不会改我的文件</b></summary>

只会新增三样：`.sessionrelay/`、`.sessionrelayignore`、`progress.md`。你的源码和 git 历史一个字都不动。

</details>

<details>
<summary><b>我不想让它记某个项目</b></summary>

在那个项目的 `.sessionrelayignore` 里写规则，或者干脆不跑 `srelay init`。

</details>

<details>
<summary><b>怎么彻底删掉</b></summary>

在项目目录里直接删掉那个文件夹：

```bash
rm -rf .sessionrelay     # Windows: rmdir /s .sessionrelay
```

删完这个项目的记忆就没了，**跨项目经验库还在**（那是全局的，放在别处）。

想连经验库一起清空，用 `srelay forget --all --confirm <项目id> --yes`（`srelay status` 里能看到项目 id）。

卸载命令本身：

```bash
npm uninstall -g memrelay
```

</details>

---

## 9. 接着往下看

| 想知道什么 | 去哪 |
|---|---|
| 所有命令怎么用 | [user-guide.md](./user-guide.md) |
| 它内部怎么跑的 | [ARCHITECTURE.md](./ARCHITECTURE.md) |
| 检索准不准 | [EVALUATION.md](./EVALUATION.md) |
| 地图 / 看板怎么用 | [MAP.md](./MAP.md) |
