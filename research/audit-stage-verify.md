# audit 阶段实跑验证（2026-10-19）

## 一句话

审计阶段（生命周期第 12 个）已能真跑：0.56 秒、10 个项目、P0 1 项 / P1 14 项，并在输出里直接打印 P0 告警。

## 命令与输出

```bash
cd D:/agent1super
node "D:/dsh插件  记忆/core/SessionRelay/dist/srelay.js" lifecycle --force --only audit
```

输出（尾部）：

```
⚠ 审计 P0：32 条归档会话仍有未决
❌ 审计契约（六项只读检查）：审计 10 个项目 · P0 1 项 · P1 14 项 · 跳过 0 项
══ 第 445 轮完成（10 个项目）══
```

耗时：real 0.56s。

## 已验证

| 项 | 结果 |
|---|---|
| 阶段存在且可单独跑 | ✅ `--only audit` 认这个 id |
| P0 告警可见 | ✅ 输出 `⚠ 审计 P0：32 条归档会话仍有未决` |
| 检查项齐全 | ✅ 六项均有 status（P0 1 / P1 14 / 跳过 0） |
| 退出码语义 | ✅ 有 P0 → 非 0（设计如此） |
| 跨项目 | ✅ 一次检查 10 个项目 |

## 未验证（留给下一轮）

- 幂等：去掉 `--force` 后同日再跑是否跳过；
- 无 P0 时静默：需构造一个没有归档未决的库；
- 不写业务表：本轮没对比跑前后业务表行数。

## 一个必须记下来的坑

`srelay brief` 和 `srelay export`（HANDOFF.md）是两条独立渲染路径：

- `brief` → `src/cli/brief.ts` → `core/brief/*`
- `export` → `src/relay/handoff-md.ts`

会话卡（`buildSessionCardFromStored` + `card-text.ts`）当时只接进了 export 那条，所以日常 `srelay brief` 里看不到卡片。接线时认准 `src/cli/brief.ts`。
