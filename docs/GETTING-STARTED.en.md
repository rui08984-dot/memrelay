# Getting started

This is for your first run. If you already know what you want, the [README](../README.en.md) is the shorter path.

Three commands, five minutes. There is one point in the middle where you will think it is broken — section 5 exists for that.

> **Note on language:** the CLI prints its output in Chinese. Commands, flags, file layout and exit codes are the same for everyone; only the human-readable text is Chinese. Numbers and paths are unaffected.

---

## 1. Check that you have Node

Open a terminal — PowerShell or CMD on Windows, Terminal on macOS/Linux — and run:

```bash
node -v
```

If you see `v22.x` or higher, continue. Three cases:

| What you see | Meaning | What to do |
|---|---|---|
| `v22.11.0` | Fine | Continue |
| `v20.x` or lower | Too old | Install LTS from [nodejs.org](https://nodejs.org/) |
| `command not found` | Not installed | Install LTS from [nodejs.org](https://nodejs.org/), then **reopen the terminal** |

> If you skip reopening the terminal, `node` stays missing. That is PATH refresh, not a bug.

---

## 2. Install

One command:

```bash
npm install -g https://github.com/rui08984-dot/memrelay/releases/download/v1.0.0/memrelay-1.0.0.tgz
```

No account, no registry signup. Verify:

```bash
srelay --version
```

`1.0.0` means you are done with this step.

> If `srelay` is not found, close and reopen the terminal. npm adds global binaries to PATH, and the current shell does not pick that up.

---

## 3. Initialize inside your project

**cd into the project you want to record first**, then:

```bash
cd path/to/your/project
srelay init
```

It adds exactly three things:

- `.sessionrelay/` — the memory store itself (one SQLite file)
- `.sessionrelayignore` — which projects should stay untracked
- `progress.md` — a human-maintained board; srelay reads it but never rewrites your lines

**Your source code and git history are not touched.**

---

## 4. Confirm it is alive

```bash
srelay doctor
```

It runs 23 checks and prints one line per item, ending with a summary such as `23 项检查：16 通过 · 7 提示 · 0 失败` (23 checks: 16 passed, 7 notes, 0 failed).

How to read it:

| Mark | Meaning | Action |
|---|---|---|
| ✅ | Healthy | Nothing |
| ⚠️ | Optional, works without it | Read the text after `→`, it usually says what to do |
| ❌ | Real problem | This one you must fix |

**Only the last line matters.** `0 failed` means you are fine. The 7 notes are normal — for example, a note about Claude Code simply means you do not use Claude Code.

---

## 5. Why it is empty right now (important)

This is where most people conclude it is broken.

```bash
srelay brief
```

You will likely see zero decisions, zero open questions, and three cross-project lessons.

**That is correct behaviour.** Two reasons:

**① It is project-scoped.** You have not talked to an AI agent *inside this directory* yet, so there is nothing to capture. Conversations from other projects do not leak in — that isolation is deliberate, otherwise every project would inherit everyone else’s context.

**② Those three lessons are global.** The lessons store is cross-project on purpose. Seeing them in a brand-new project is evidence that things are working, not evidence of a bug.

Think of it this way: the project store is *this project’s conversation log*, the global store is *what you learned across all projects*. A new project has no log yet, but the lessons are already yours.

---

## 6. How to get data in

Two options, pick one.

**Option A: let the daemon run (recommended)**

```bash
srelay watch --install-service
```

Registers a background service that starts with your machine. From then on you do not think about it — it periodically scans your AI tool session directories and pulls in what belongs to this project.

**Option B: run it manually**

```bash
srelay sync
```

Then **go use an AI tool in this project for a few turns** — say something with a conclusion in it ("let’s go with option B", "don’t touch that again") — and run:

```bash
srelay sync
srelay brief
```

Now `brief` has content. Rows are extracted from those turns, not generated:

```
决策 8 条 · 未决 0 条 · 最近在动 3 个
  🗂 db.ts（16 场）
  🗂 index.js（14 场）
  2026-10-17 ✗ 换成我们的了
  2026-10-17 ✓ 决定加载的是 cordis.yml
```

`✗` marks a decision you rejected, `✓` one you settled on. The file names are the ones that kept coming up.

---

## 7. Which AI tools it reads

Six adapters ship in the box:

| Tool | Where it looks |
|---|---|
| Claude Code | `~/.claude/projects/` |
| Codex | `~/.codex/` |
| ZCode | `~/.zcode/cli/db/db.sqlite` |
| DSH | session files per workspace |
| Qoder | Qoder session directory |
| Trae | Trae session directory |

Tools you do not have are skipped. `doctor` shows `未检测到（未安装可忽略）` — not detected, safe to ignore. **That is not an error.**

---

## 8. FAQ

<details>
<summary><b><code>srelay</code> is not found after install</b></summary>

Close and reopen the terminal. npm installs global binaries; the current shell will not see them until PATH refreshes.

</details>

<details>
<summary><b><code>brief</code> stays empty</b></summary>

In order:

1. `srelay doctor` — is the last line `0 failed`?
2. Are you in the directory where you actually talked to an AI agent?
3. Run `srelay sync` — is the discovered count zero?
4. If yes, those sessions belong to a different project. Try from that project’s directory.

</details>

<details>
<summary><b>Does it upload my code anywhere</b></summary>

No. Everything is written to one SQLite file on your disk: `.sessionrelay/relay.sqlite`. No account, no server, no telemetry. It works with the network unplugged.

</details>

<details>
<summary><b>Does it modify my files</b></summary>

It only creates `.sessionrelay/`, `.sessionrelayignore`, and `progress.md`. Source files and git history are untouched.

</details>

<details>
<summary><b>I do not want a particular project recorded</b></summary>

Add rules to that project’s `.sessionrelayignore`, or simply do not run `srelay init` there.

</details>

<details>
<summary><b>How do I remove it completely</b></summary>

From the project directory:

```bash
rm -rf .sessionrelay          # Windows: rmdir /s .sessionrelay
```

That removes this project’s memory. **Cross-project lessons survive** — they live in the global store elsewhere.

To wipe the lessons too, use `srelay forget --all --confirm <projectId> --yes` (`srelay status` prints the id).

To remove the command itself:

```bash
npm uninstall -g memrelay
```

</details>

---

## 9. Where to go next

| Want to know | Read |
|---|---|
| Every command and flag | [user-guide.md](./user-guide.md) |
| How it works internally | [ARCHITECTURE.md](./ARCHITECTURE.md) |
| How good retrieval actually is | [EVALUATION.md](./EVALUATION.md) |
| The map and board layers | [MAP.md](./MAP.md) |
