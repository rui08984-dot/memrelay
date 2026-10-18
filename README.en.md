# memrelay

[简体中文](./README.md) | English

> Repo name **memrelay** (memory + relay). The CLI is still `srelay` — historical naming, not worth churn.

![Node](https://img.shields.io/badge/Node-%E2%89%A522-339933)
![License](https://img.shields.io/badge/License-MIT-EAC435)

**A local memory layer for AI coding sessions.** It records what you and your agents actually decided, extracts the
structure (decisions, topics, touched files, open questions), and puts the relevant part back in front of the next session.

Local files only. No account, no server. One SQLite database per project, plus one global database for cross-project lessons.

---

## What it is not

| Not | Why |
|---|---|
| Not a cloud memory service | Two SQLite files are the entire state; nothing is uploaded |
| Not a vector database | Main path is FTS5 + Chinese tokenizer + length penalty. The semantic arm is optional and currently **off** (measured: 2.15× slower, no recall gain) |
| Not a transcript exporter | Export is a side effect; the value is the extracted structure being injected into the next session |
| Not a shared knowledge base | One database per project, never merged. `forget` deletes a project database; cross-project lessons survive |

---

## Quick start

```bash
npm install -g memrelay          # or: npx memrelay init
cd <your-project>
srelay init                      # creates .sessionrelay/ inside this project
srelay doctor                    # health check: sources, daemon, DB integrity, extractor version
srelay watch --install-service    # run the daemon as a user service (Windows Run key / launchd / systemd --user)
srelay brief                     # what the next session will actually see
```

---

## What is in the box

| Layer | Responsibility | Doc |
|---|---|---|
| Capture | Six clients, incremental cursors, rewrite detection, visible failures | [docs/CAPTURE.md](./docs/CAPTURE.md) |
| Extract | Decisions / topics / files / open questions, versioned and re-computable | [docs/EXTRACT.md](./docs/EXTRACT.md) |
| Store | Two databases, schema, FTS5, archive & rebuild | [docs/STORE.md](./docs/STORE.md) |
| Search | Four fused arms, length penalty, time decay, multi-DB merge | [docs/SEARCH.md](./docs/SEARCH.md) |
| Lifecycle | 11 independently scheduled stages | [docs/LIFECYCLE.md](./docs/LIFECYCLE.md) |
| Map | Structural source of truth for the plan: layers, dependency edges, reconciliation | [docs/MAP.md](./docs/MAP.md) |
| Interfaces | CLI, MCP server, DSH plugin, panel | [docs/INTERFACES.md](./docs/INTERFACES.md) |

Architecture overview: [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) (Chinese, with diagrams).

---

## Retrieval, measured honestly

305 questions over 105 sessions:

| Metric | Result |
|---|---|
| hit@1 | **11.5%** |
| hit@10 | **45.6%** |
| cluster-level 95% CI | ±3.85 pt |

The 34-point gap means **it finds the material but ranks it wrong**. Tried and rejected (all default-off, reasons recorded):
synonym expansion, question-shell stripping, pure RRF, and the semantic arm. The real bottleneck is query rewriting — turning
"that thing where the DB kept growing" into terms that appear in the transcripts.

Full method and per-arm numbers: [docs/EVALUATION.md](./docs/EVALUATION.md) and [the workbook](./docs/eval/memrelay-eval.xlsx).

---

## Known limitations

1. Ranking is unstable — hit@1 is 11.5%.
2. Map edges only grow from an explicit dependency column; code co-change cannot establish task order.
3. Extraction is rule-based, not semantic; half-sentences still slip through.
4. `aging` (the only lossy stage) deletes message bodies of old sessions — `pin` anything that matters.
5. Six config keys are frozen at daemon startup; restart is required.
6. Cross-project lessons are still thin.

---

## License

MIT, original copyright notices retained. See [LICENSE](./LICENSE).
Originated from [EwanJasper/SessionRelay](https://github.com/EwanJasper/SessionRelay); independently maintained since memrelay.
