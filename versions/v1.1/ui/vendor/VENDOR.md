# vendor/ —— 第三方前端资产

本目录是**唯一**允许存放第三方前端代码的地方。运行时零 npm 依赖的纪律不变：
这些文件是随仓库提交的静态资产，不参与 `npm install`，也不需要构建步骤。

## 登记表

| 文件 | 上游 | 版本 | LICENSE | sha256 |
|---|---|---|---|---|
| `tabler.min.css` | https://github.com/tabler/tabler（`@tabler/core`） | 1.7.5 | MIT（见 `tabler.LICENSE`） | `d1708c69e6b07a5a3138b8549bf64e00cd9d18c130b9b2ba2d9e294956f7c564` |
| `uPlot.iife.min.js` | https://github.com/leeoniya/uPlot | 1.6.31 | MIT（见 `uPlot.LICENSE`） | `2d27e8ad3d228164525ce213f9dc716f39b4e3aee0cc773fb3491c96cf4921a2` |
| `uPlot.min.css` | https://github.com/leeoniya/uPlot | 1.6.31 | MIT（见 `uPlot.LICENSE`） | `df630c6a8d6f8eeaff264b50f73ce5b114f646ffd9a0bb74f049b0a00135fa04` |
| `force-graph.min.js` | https://github.com/vasturiano/force-graph | 1.52.0 | MIT（见 `force-graph.LICENSE`） | `f59db59ba92ff5a76ed93d7a4d77a703b176260e5d9cd29f4f8eb4f6c369a629` |

## 纪律

1. **禁 CDN**：所有资产必须自托管在本目录，`ui/**` 不得出现 `https://cdn.` / `unpkg` / `jsdelivr` 等外链（Q13 门禁）。
2. **升级必须同时改三处**：文件、本表 sha256、本表版本号。Q13 会校验 sha256 与本表一致。
3. **必须附 LICENSE**：每个上游一个 `*.LICENSE` 文件；Q13 校验存在性。
4. **不进构建**：这些是 IIFE / 纯 CSS，直接用 `<script src>` / `<link rel="stylesheet">` 引入，不打包、不转译。
5. **体积基线**：`tabler.min.css` 683KB（gzip ≈ 90KB）、`uPlot` 50KB、`force-graph` 173KB；S7 的 1MB 单文件上限仍适用。

## 为什么是这三个

- **Tabler CSS**：单文件、MIT、无 JS 依赖，能直接替换自研的 `style.css` 版式；不用它的 JS（避免引 jQuery 类依赖）。
- **uPlot**：45–50KB、Canvas 2D、原生支持 `null` 断点跳过（我们的检索指标按天可能为空），比 Chart.js / ECharts 小一个数量级。
- **force-graph**：173KB 的 2D 力导向，替代自研 3D canvas——自研版为了"3D"付了雾化/投影/遮挡的复杂度，而第三维只贡献视觉装饰（见 `docs/research/graph-library-2026-11.md`）。
