# audit 阶段实跑验证（2026-10-19）

## 一句话

审计阶段（生命周期第 12 个）已能真跑：0.56 秒、10 个项目、P0 1 项 / P1 14 项，P0 直接进简报首行；业务表零写入；同日重复跑会被 24h 节奏跳过。

## 命令与输出

```bash
cd D:/agent1super
node "D:/dsh插件  记忆/core/SessionRelay/dist/srelay.js" lifecycle --force --only audit
```

输出（尾部）：

```
⚠ 审计 P0：32 条归档会话仍有未决
❌ 审计契约（六项只读检查）：审计 10 个项目 · P0 1 项 · P1 14 项 · 跳过 0 项
══ 第 460 轮完成（10 个项目）══
```

耗时：real 0.56s（冷跑）；阶段自报 213ms。

## 已验证

| 项 | 结果 |
|---|---|
| 阶段存在且可单独跑 | ✅ `--only audit` 认这个 id |
| P0 告警可见 | ✅ 输出 `⚠ 审计 P0：32 条归档会话仍有未决`，并进简报首行 |
| 检查项齐全 | ✅ 六项均有 status（P0 1 / P1 14 / 跳过 0） |
| 退出码语义 | ✅ 有 P0 → 非 0（设计如此） |
| 跨项目 | ✅ 一次检查 10 个项目 |
| **不写业务表** | ✅ 跑前跑后 sessions/messages/cleanup_log/compress_log/compact_log/forget_log 行数**逐项相同** |
| **24h 幂等** | ✅ 同日第二次 `lifecycle --light` 后，lifecycle 里 audit 的 `at` **未变**（仍 15:23:57）⇒ 被节奏跳过 |

## 口径注意

`--only audit` 会**绕过** 24h 节奏（显式点名阶段 = 我要它现在跑）。验证幂等必须用不带 `--only` 的 `lifecycle` 或 `lifecycle --light`。

## 一个必须记下来的坑

`srelay brief` 和 `srelay export`（HANDOFF.md）是两条独立渲染路径：

- `brief` → `src/cli/brief.ts` → `src/cli/brief-cards.ts`
- `export` → `src/relay/handoff-md.ts`

会话卡两条都接了（10-19 收口）。接线时认准 `src/cli/brief.ts`。
