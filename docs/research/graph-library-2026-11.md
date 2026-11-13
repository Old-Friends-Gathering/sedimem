# sedimem 图谱可视化选型（2026-11）

- 背景：`versions/v0.6/ui/graph.js`（599 行，实测 `wc -l`）+ `layout.js`（241 行）自研 3D 力导向（canvas），痛点：维护成本高、标签密集糊、布局质量一般。
- 硬约束：零构建（原生 ES modules + canvas）、禁 CDN、离线自托管、单文件 ≤600 行（Q9）、vendor 需过 Q13（见 `docs/plans/v0.7-ui-and-ecosystem.md:42,109`）。

## 1. 候选清单（版本/体积/license/是否需构建）

| 候选 | 版本 | min 体积 | gzip | license | 单文件自托管 |
|---|---|---|---|---|---|
| 3d-force-graph | 1.80.2 | 1,389,818 B（自带 three@0.18x 打包） | 365,288 B | MIT | ✅ 官方 UMD `dist/3d-force-graph.min.js` |
| force-graph（2D） | 1.52.0 | 173,081 B | 56,470 B | MIT | ✅ 官方 UMD `dist/force-graph.min.js` |
| vis-network | 10.1.5 | 653,713 B（standalone UMD） | 155,776 B | Apache-2.0 OR MIT | ✅ `standalone/umd/vis-network.min.js` |
| cytoscape | 3.35.0 | 441,440 B（`dist/cytoscape.umd.min.js`） | 138,280 B | MIT | ✅ UMD 单文件 |
| sigma + graphology | 4.0.6 / 0.26.0 | ~375,993 B + 66,395 B | ~96,891 + 12,824 B | MIT | ⚠️ sigma v4 仅 ESM 且强制 graphology，需 vendor 多文件 + import map，改动面大 |
| @antv/g6 | 5.1.1 | ~1,400,863 B | ~399,760 B | MIT | ❌ v5 ESM-only、无官方 UMD 单文件，多 entry，零构建自托管困难 |
| d3-force / d3-force-3d | 3.0.1 / 3.0.6 | 15,619 / 28,407 B | 5,811 / 9,063 B | ISC / MIT | ✅ ESM 单文件，但只做力模拟，渲染全自研 |

版本/license/发布日期来自 `registry.npmjs.org/<pkg>` dist-tags（2026-11-13 实测 curl）；体积为 jsdelivr 实际下载 `ls -l` + `gzip -c | wc -c` 实测；sigma/g6 为 bundlephobia.com API 数值（tree-shaken 估算，非单文件实测，**注意偏乐观**）。

## 2. 关键维度打分（5 分制）

| 维度 | 3d-force-graph | force-graph(2D) | vis-network | cytoscape | sigma+graphology | g6 | d3-force(-3d)+自研渲染 |
|---|---|---|---|---|---|---|---|
| 单文件自托管 | 5 | 5 | 5 | 5 | 2 | 1 | 5 |
| 体积（gzip） | 2（365KB） | 5（56KB） | 3（156KB） | 3（138KB） | 3（~110KB+） | 1（400KB） | 5（6–9KB） |
| 标签避让 | 2（three Sprite，密集糊，与现状同病） | 3（canvas 2D 文字清晰，`nodeCanvasObject` 自绘，可按缩放级显示/隐藏，无内置避让） | 4（内置 label + 布局级避让，效果一般） | 4（样式系统完善，`cose` 布局带节点不重叠） | 4（WebGL 标签渲染+视锥剔除，最专业） | 4（内置） | 2（继续自己写） |
| 3D 必要性 | — | 记忆图谱是数据浏览非空间数据，深度雾化已是遮羞布；2D+过滤更可读（定性判断） | 同左 | 同左 | 同左 | 同左 | — |
| 点击详情/边类型过滤/状态配色改造量 | 中（API 全，但 three 对象自定义繁琐） | 小（`nodeColor`/`linkColor`/`onNodeClick`/`linkVisibility` 直配） | 中 | 中（selector 体系强大但学习成本） | 大 | 大 | 0（已有）但标签/布局痛点不解决 |
| 维护活跃度（最近发布） | 2026-11-05 | 2026-09-28 | 2026-11-08 | 2026-11-10 | 2026-11-10 / 2025-01-26 | 2026-05-08 | 2026-11-03 / 2025-04-09（功能已稳定） |
| license | MIT ✅ | MIT ✅ | Apache-2.0 OR MIT ✅ | MIT ✅ | MIT ✅ | MIT ✅ | ISC/MIT ✅ |

AGPL：无一家是 AGPL，全部可 vendor。发布日期出处：npm registry `time[latest]`，2026-11-13 curl 实测。

## 3. 结论

- **主方案：force-graph@1.52.0（2D）**。理由：① 与 3d-force-graph 同作者同 API，现有「拖拽/缩放/点击」交互语义可平移；② 56KB gzip，是带渲染的候选里最小；③ canvas 2D 直接解决「标签糊」（文字按 devicePixelRatio 清晰渲染）；④ UMD 单文件落 `ui/vendor/` 零成本；⑤ MIT。放弃 3D：记忆图的第 3 维只贡献雾化装饰不贡献信息密度，且 365KB three 是最大的体积负担（定性判断，未做用户测试）。
- **备选：d3-force-3d@3.0.6 只换布局、保留自研渲染**（9KB gzip）。如果舍不得 3D 交互，这是最小改动路径——但「标签糊」（自绘 canvas 文字逻辑）与维护成本（840 行还在自己手里）不解决，只治「布局质量一般」一条。
- **「保留自研渲染 + 只换布局」是否更划算：不划算。** 痛点三条里它只解决布局一条，而 force-graph 一次解决维护成本（删 ~840 行）+ 标签清晰 + 布局（内置 d3-force 与 ngraph 布局引擎）三条，代价仅 56KB gzip 静态文件。
- 排除：g6（无 UMD、400KB）；3d-force-graph（体积/标签糊）；sigma（多文件 ESM vendor 复杂度不匹配零构建约束）；vis-network（无硬伤但 156KB 无对应收益）。

## 4. vendor 落地

1. 文件：`versions/v0.7/ui/vendor/force-graph.min.js`（1.52.0 UMD，173,081 B，jsdelivr 实测），同目录放 `LICENSE-force-graph.txt`（取 npm 包内 LICENSE，MIT）。
2. sha256 登记：`shasum -a 256 force-graph.min.js` 写入 `ui/vendor/VENDOR.md`（与既定 tabler.vendor 四件套同格式，见 `docs/plans/v0.7-ui-and-ecosystem.md:38-43`）；同时登记进 `security-allowlist.json`（S7 同款，`:111`）。
3. Q13 门禁**仍然需要**：sha256 一致 + LICENSE 存在 + `grep -c "<script src=\"http"` == 0。force-graph 以本地相对路径 `<script src="vendor/force-graph.min.js">` 引入，天然过 CDN 检查。vendor 不计 Q9 行数/体积（`:110`）。
4. 迁移注意：UMD 挂 `window.ForceGraph`，在自研模块里 `const ForceGraph = window.ForceGraph` 即可，不破坏 ES modules 结构。

## 未验证项

- force-graph 在 5k+ 节点下的 canvas 性能（当前记忆库量级未见性能数据，需 PoC 实测）。
- bundlephobia 对 sigma/g6 的体积为估算值，未下载实测单文件。
- 「3D 无必要」为定性判断，未做可用性对比测试。
