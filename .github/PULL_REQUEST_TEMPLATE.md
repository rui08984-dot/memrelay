## 改了什么

## 为什么

## 验证方式

<!-- 别写「测试通过」。写跑了什么、看到什么结果。 -->

```bash
npx vitest run          # 913 条基线
node scripts/check-artifacts.mjs
```

## 有没有碰这些地方

- [ ] `src/db/` 或 schema（会影响存量库，需要迁移说明）
- [ ] `src/core/extract/`（改了要升 `EXTRACT_VERSION`，否则存量不重算）
- [ ] `src/map/`（地图不变式：边必须严格跨层向下）
- [ ] `integrations/dsh/`（改完要重新 vendor，否则插件自测跑的是旧副本）