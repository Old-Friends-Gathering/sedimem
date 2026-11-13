# sedimem UI 模板选型 + 全站改版方案（2026-11）

硬约束：零构建（禁 npm/打包）、零运行时依赖、离线可用、localhost 只读。所有第三方资产以「单文件自托管」形式进入 `ui/vendor/`。体积为 min+gzip 近似值，来源见各行链接；标注「未验证」= 调研时未能打开权威页面。

## 1. 候选模板 / 框架对比

| 模板 | 许可证 | CSS gzip | 需构建 | 单文件自托管 | 深浅色 | 组件齐全度 | 侧边栏+内容区布局 |
|---|---|---|---|---|---|---|---|
| [Tabler (@tabler/core)](https://github.com/tabler/tabler) | MIT | ~90KB（未压缩 min ~694KB） | 否 | 是（tabler.min.css 一张） | 是（data-bs-theme 同源） | 高：表格/卡/标签/表单/导航全有 | 是：官方 layout demo 可直接照抄 |
| [Pico.css](https://github.com/picocss/pico) | MIT | 5.6KB | 否 | 是 | 是（prefers-color-scheme） | 低：仅语义元素 | 否：需自己写侧边栏 |
| [Simple.css](https://github.com/kevquirk/simple.css) | MIT | ~4KB | 否 | 是 | 是 | 低（classless） | 否 |
| [MVP.css](https://github.com/andybrewer/mvp) | MIT | ~7KB | 否 | 是 | 弱 | 低（classless） | 否 |
| [Bulma](https://github.com/jgthms/bulma) | MIT | ~27KB | 否 | 是（bulma.min.css） | 是（.theme-dark，0.9.x+） | 中高 | 是（hero+section 组合，略繁） |
| [Bootstrap 5](https://github.com/twbs/bootstrap) | MIT | ~23KB | 否 | 是 | 是（data-bs-theme） | 高 | 是（offcanvas/navbar） |
| [DaisyUI](https://github.com/saadeghi/daisyui) | MIT | ~30KB | **是**（Tailwind 编译产物需 CLI 生成） | 可用预编译 CDN 文件但定制需构建 | 是 | 高 | 是 |
| [UnoCSS](https://github.com/unocss/unocss) | MIT | 按需 | **是**（核心是构建期原子 CSS） | 否 | - | - | - |
| [shadcn/ui](https://github.com/shadcn-ui/ui) | MIT | - | **是**（React + Tailwind） | 否 | 是 | 高 | 是 |
| [Tremor](https://github.com/tremorlabs/tremor) | MIT | - | **是**（React） | 否 | 是 | 中（图表向） | 是 |

结论：零构建硬指标直接淘汰 DaisyUI/UnoCSS/shadcn/Tremor；classless 三家（Pico/Simple/MVP）组件太薄，做不动「图谱工具栏 + 编辑表单 + 簇列表」这类管理界面。Tabler（组件最全、CSS-only 可用、菜单用 `<details>`/`<dialog>` 原生实现）与 Bootstrap 5（生态熟、体积更小）二选一。Bulma 居中但深色模式支持晚且布局组件弱于前两者。

## 2. 图表库

| 库 | 许可证 | 体积 | 构建 | script 引入 | 多序列折线 | 空值跳过 |
|---|---|---|---|---|---|---|
| [uPlot](https://github.com/leeoniya/uPlot) | MIT | ~40KB min | 否 | 是（uplot.iife.min.js + uplot.min.css） | 是 | 是（null spanGaps:false） |
| [Chart.js](https://github.com/chartjs/Chart.js) | MIT | ~65KB | 否 | 是（UMD） | 是 | 是（spanGaps） |
| [ECharts](https://github.com/apache/echarts) | Apache-2.0 | ~350KB min | 否 | 是 | 是 | 是（connectNulls:false） |
| [ApexCharts](https://github.com/apexcharts/apexcharts.js) | MIT | ~140KB | 否 | 是 | 是 | 是 | 
| [Frappe Charts](https://github.com/frappe/charts) | MIT | ~60KB | 否 | 是 | 是 | 弱 | 
| [Tinyplot](https://github.com/tinylibs/tinyplot) | MIT | ~10KB（未验证） | 否 | 是（ESM） | 基础 | 未知（未验证） |

结论：uPlot——最小、最快（150k 点 135ms）、canvas 2D 与现有手写渲染模型同构，替换手写 charts.js 198 行的心智成本最低。ApexCharts 注意：Tabler dist/libs 捆绑的 ApexCharts 5.x 已非纯 MIT（双许可），不要顺手引入。

## 3. 图谱可视化：换库 vs 保留自研

| 库 | 许可证 | 体积 | 无构建引入 | 点节点详情/边开关/缩放旋转 |
|---|---|---|---|---|
| [3d-force-graph](https://github.com/vasturiano/3d-force-graph)（依赖 three） | MIT（依赖链 MIT/ISC/BSD-3，无 copyleft） | bundle ~1.5MB+（three 占大头） | 是（standalone UMD） | 全支持，3D 原生 |
| [force-graph (2D)](https://github.com/vasturiano/force-graph) | MIT | ~350KB | 是 | 支持，无 3D 旋转 |
| [cytoscape.js](https://github.com/cytoscape/cytoscape.js) | MIT | ~400KB min | 是（cytoscape.umd.js） | 支持；3D 无 |
| [sigma.js](https://github.com/jacomyal/sigma.js) | Apache-2.0（依赖 AVL-Tree 等，未验证全链） | ~200KB+graphology | 是（UMD） | 支持；大图 WebGL 优 |
| [vis-network](https://github.com/vis-net/vis-network) | MIT/Apache-2.0 双许可 | ~600KB | 是（UMD） | 支持，含内置物理布局 |

评估（数据）：自研 graph.js 599 行 + graph-style/layout/toolbar 共 ~960 行，功能已覆盖缩放/旋转（3D 投影）/点选详情/边类型开关，零额外字节；换 3d-force-graph 代价是引入 ~1.5MB（为当前全部 UI 资产体积的数倍）换取更顺的惯性旋转与 hover。单机只读观察台节点量在 10²–10⁴ 级，自研 canvas 完全扛得住。**结论：保留自研**，仅借鉴 vasturiano 的 d3-force-3d（MIT，单文件 ~30KB）替换自研 layout.js 力导向部分即可显著改善收敛质量；若未来节点 >50k 再引入 sigma.js（WebGL）。

## 4. 人类编辑入口：从只读到可编辑的安全升级

参考：[Obsidian Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api)（Bearer API key + 仅监听 127.0.0.1，HTTPS 可选）、basic-memory 的 MCP write 工具（写前校验、原子落盘）、Logseq（文件即真相，UI 是视图）、本地 admin 面板惯例（只绑回环 + 启动时生成一次性 token）。

- **localhost 鉴权**：服务仍只 bind 127.0.0.1（DNS rebinding 防护：校验 Host 头为 localhost）；写接口要求 `Authorization: Bearer <token>`，token 由 sedimem server 启动时生成并打印到 stdout/文件，与只读 GET 分离。CSRF：写操作只接受 `application/json` + 自定义头（如 `X-Sedimem-Write`），浏览器表单无法跨站伪造；再加 Origin 校验白名单 `http://127.0.0.1:*`。
- **并发冲突**：所有记录带 `rev`（版本号）。写请求带 `If-Match: <rev>`；不匹配返回 409，前端展示 diff 让人裁决——因为真相层是 append-only，冲突只是「双方各追加了一条」，无损。
- **审计**：每条写记录 source 标记 `human:<备注>`（vs `agent:<name>`），时间线天然展示「谁改了什么」；UI 编辑表单必填一句 reason。
- **编辑 = 追加 + supersede 而非原地改**：与 append-only 真相层一致（人类改错可回滚到 superseded 版本）；supersede 链在 UI 上呈现为「版本历史」；避免原地改是因为它会破坏「记忆是历史事实流」的模型，也会让 agent 侧缓存/引用失效。删除 = tombstone（UI 提供「恢复」）。

## 5. 导入器：源格式 → sedimem 映射

| 源 | 格式要点 | 映射 | 坑 |
|---|---|---|---|
| CLAUDE.md / AGENTS.md | 长指令 Markdown | 按 `##` 段落拆，每段 → kind=decision/pref（`必须/never/优先` 句式 → decision），subject=段标题，tags=[imported, instructions] | **是长指令不是事实集合**：整段导入为 decision 而非拆成多条 fact；禁止把祈使句当 predicate/value 三元组 |
| [basic-memory](https://github.com/basicmachines-co/basic-memory) | md + YAML frontmatter + `- [category] value` Observations + `relation [[Target]]` | frontmatter title/type/tags → 标题/subject/tags；Observation 行 → 单条 fact（predicate=category, value=文本）；显式 relation → 边（predicate=relation_type） | checkbox/todo/裸 wikilink 不是 Observation（官方解析器明确排除）；`#bm:links_to` 强制隐式边；permalink 大小写敏感 |
| Obsidian vault | md + `[[wikilink]]` | 每文件 → 记录；wikilink → links_to 边；frontmatter tags → tags | wikilink 带 `\|别名` 与 `#标题锚点`；未解析链接（目标文件不存在）只能成悬空节点 |
| [mem0 导出 JSON](https://docs.mem0.ai/platform/features/memory-export) | `{memories:[{id,text,metadata,...}]}` | text → text，metadata/user_id → subject/tags，时间 → valid_from | 平台导出需 export 权限；自托管版字段名略有差异（未验证全字段） |
| [Cline memory-bank](https://docs.cline.bot/best-practices/memory-bank) | 六个固定 md（projectbrief/productContext/activeContext/systemPatterns/techContext/progress） | 每文件一条 kind=state（或 decision），scope=该 project；文件内小节不拆 | 是「当前状态快照」不是事实，activeContext/progress 高频过时——导入后建议标 TTL 或定期重导 supersede |

## 6. 推荐组合

**Tabler CSS（单文件自托管）+ uPlot + 保留自研图谱（借 d3-force-3d）+ Lucide SVG sprite + system-ui 字体。**

| 维度 | 选择 | 理由 |
|---|---|---|
| 模板 | Tabler（tabler.min.css，不用其 JS） | 组件最全、CSS-only、MIT、官方布局可抄 |
| 图表 | uPlot（iife + css） | 40KB 最快，null 跳过原生 |
| 图谱 | 保留自研 + d3-force-3d | 省 1.5MB，功能已够 |
| 图标 | Lucide 手拷常用 ~20 个成 SVG sprite | 零依赖；不用其 npm 包 |
| 字体 | system-ui 栈 | 离线 |

预计：index.html 90→~160 行（+侧边栏/编辑模态/导入页挂载点）；style.css 136→~250 行（仅覆盖变量与图谱面板）。新增前端文件：`vendor/tabler.min.css`、`vendor/uplot.iife.min.js`、`vendor/uplot.min.css`、`vendor/lucide-sprite.svg`、`vendor/d3-force-3d.min.js`、`edit.js`（编辑表单+If-Match）、`import.js`（导入向导）、`session-view.js`（临时库/会话视图）、`handover.js`（交接文档渲染）。

## 迁移步骤（5 步）

1. vendor/ 落 Tabler+uPlot+Lucide+d3-force-3d 四件套（含 LICENSE 文件）。
2. index.html 换 Tabler 侧边栏布局骨架，四个页面迁入，charts.js 折线换 uPlot。
3. 服务端加写 API：Bearer token + If-Match + append/supersede，UI 加 edit.js 表单与版本历史。
4. import.js 实现五源导入器（先 basic-memory 与 CLAUDE.md）。
5. session-view.js / handover.js 补会话视图与交接文档页；删除被替代的手写折线代码。

## 未验证清单

- Tinyplot 体积与空值行为；sigma.js 依赖链完整许可证；mem0 自托管导出字段全集。
- Tabler 最新版 gzip 后精确 KB（仅核到未压缩 694KB / MIT）。
- d3-force-3d 单文件 UMD 是否可直接 script 引入（其 dist 面向 ESM，可能需手工包一层或换 three-forcegraph 内嵌版）。
