# 图

本目录的 PNG 全部由同目录的 `.mmd`（Mermaid 源码）渲染而来。改图改 `.mmd`，别抠 PNG。

| 文件 | 画的是什么 | 数据来源 |
|---|---|---|
| `layered.png` | 分层架构：源 → 适配器 → 项目库 / 全局库 → 注入层 | 手绘（设计图） |
| `session-flow.png` | 一次会话怎么进来：discover → 三重过滤 → 增量读 → upsert → 抽取 | 手绘（时序图） |
| `retrieval.png` | 一次查询走四条路 → 融合 → 排序（含实测数字） | 手绘（设计图） |
| `lifecycle.png` | 生命周期 11 个阶段的分组与节奏 | 手绘（设计图） |
| `map-real.png` | **真实**地图：agent1super 13 节点 / 6 层 / 17 条边 | `renderMapMermaid(root, [])` 直接导出 |
| `map-hatch.png` | 自动孵化：依赖列 → 拓扑分层 → 真边 | 手绘（贴 `src/map/plan-graph.ts` 实现） |

## 重新渲染

```bash
# 任意 .mmd → PNG（officecli 的 diagram 元素直接吃 Mermaid，layout=elk）
officecli create out.pptx
officecli add out.pptx / --type slide
officecli add out.pptx "/slide[1]" --type diagram \
  --prop src=docs/diagrams/layered.mmd --prop render=image --prop layout=elk --prop poster=true
officecli close out.pptx
unzip -o -p out.pptx ppt/media/image.png > docs/diagrams/layered.png
```

`map-real.mmd` 有一道额外工序：它的数据不是手写的，是**从项目地图导出**的。

```bash
cd core/SessionRelay
./node_modules/.bin/tsx -e "
  import { renderMapMermaid } from './src/map/bridge.js';
  process.stdout.write(renderMapMermaid('<项目根>', []).value);
" > /tmp/map.mmd
```

传空数组是有意的：`renderMapMermaid` 的第二个参数是**人写看板行**。传 `[]` 就只画地图本身（层 + 节点 + 真边），
不掺 `progress.md` 的任务流水。要看完整看板投影，去项目里的 `.sessionrelay/board/board.mmd`。

## 渲染时的两个坑（都踩过）

1. **`<small>` 不认**：内核导出的标签用 `<br/><small>状态</small>` 做第二行，渲染器不认这个标签，得先换成普通文本。
2. **平行四边形要闭合**：Mermaid 的平行四边形是 `[/"…"/]`。写成 `[/"…"]` 会 **Lexical error、整张图解析失败**。
   内核的 `shapeOf()`（`src/map/bridge.ts`）在 2026-10-18 之前就是这种写法——已修，`board.mmd` 里只要有「待办」节点就会踩到。
