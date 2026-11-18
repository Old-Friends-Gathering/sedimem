> doc-kind: history
> doc-version: 1.4

# P1a 标注执行记录（两遍盲评 + 记录化裁决）

本文件是 P1a 出口条件之一「出口级 gold」的**执行证据与限制声明**。结论先写在前面：**本次标注是降级模式 `model-dual-blinded`，不构成 06 §2 要求的「两份互不可见的人工独立标注」，因此不得宣称 `dual-independent`，也不得据此宣称 gold 验收通过。**

## 1. 执行方式

| 环节 | 执行体 | 产物（验证轨，gitignored） |
|---|---|---|
| 盲评包导出 | `annotation-pass export` | `pilot/p1a/out/blind/{blind-pass.jsonl, manifest.json}`（218 场景，gold/shouldReject/adversarial/split 全部剥离） |
| pass1 | 主 agent（模型），按 8 片并发 | `out/blind/pass1.jsonl`（218 场景 / 483 claim / 37 应拒） |
| pass2 | **8 个独立子代理（GLM-5.3）**，各自只读自己那一片，明令禁止读 pass1 / corpus / docs | `out/blind/pass2-chunk-01..08.jsonl` → 合并 `pass2.jsonl`（218 场景 / 340 claim / 44 应拒） |
| 一致性比对 | `annotation-pass compare` | `out/blind/compare.json` |
| 裁决 | 记录化自动策略 `adjudicate.mjs`（union-policy@v1） | `out/blind/worksheet-adjudicated.json`（784 行全部有 resolution） |
| goldset | `annotation-pass goldset --mode model-dual-blinded` | `out/blind/goldset-v1.json`（218 场景 / 778 claim） |

**盲评隔离的事实依据**：pass2 的 8 个子代理 prompt 明确列出禁止读取的路径；8 份产出在格式与判据上与 pass1 系统性不同（见 §3 的 claim 重叠率），不存在照抄 pass1 的可能。但隔离本身无法自证，只能作为**流程声明**记录——这正是它与人工双标注的差距。

## 2. 自动校验（import 阶段，fail-closed）

`annotation-pass import --file pass2.jsonl --package out/blind`：

```json
{ "errors": [], "covered": 218, "expected": 218 }
```

校验内容包括：场景全覆盖、gold 枚举合法（type/role/status/speechAct）、claim ≤100 字符、**每条 evidence 的 eventId 必须存在且 quote 是事件文本的逐字子串**（本轮新增，见 §5）。pass2 首轮有 1 行结构损坏（S125 多余右花括号），已修复并复验通过——损坏行未被静默吞掉，是 import 的 JSON 解析硬失败暴露出来的。

## 3. 一致性（这是本次最重要的发现）

| 指标 | 实测 |
|---|---|
| 归一化后**两遍都提出**的 claim | **44** |
| 仅 pass1 提出 | 439 |
| 仅 pass2 提出 | 296 |
| claim 级 Jaccard（44 / (483+340−44)） | **≈ 5.6%** |
| 两遍claim相同时的字段一致率 | **78.5%**（307 个字段原子中 241 个一致） |
| 匹配 claim 的字段分歧 | 40 行（集中在 `type`、`assertion.about`、`assertion.speechAct`） |
| 应拒判定分歧 | 9 个场景 |

**解读（必须按此口径传播）**：

- 78.5% 的字段一致率**只对"两遍碰巧抽到同一条 claim"的 44 条成立**，不能推广成"标注员一致率 78.5%"。
- claim 级只有 5.6% 完全重合，说明分歧主因不是"同一句标成不同类型"，而是**双方对「什么算一条值得长期记住的命题」的粒度判断不同**：pass1 倾向把整句陈述记成一条，pass2 倾向切出更短的核心断言，还有一方认为该记而另一方认为不该记。
- 这不是标注员不认真，而是**现行 06 §1 的标注规范缺少"命题粒度"定义**（未规定：一句话含两个事实时怎么切、背景信息算不算、工具输出算不算、同义改写是否算同一条）。这条缺口比任何 P/R 数字都更影响后续 P1b 的抽取门槛可达性。
- 因此本记录对 P1b 的建议是：**先补粒度规范并做一轮小样本人工双标注校准（10–20 场景）**，再谈 98%/90% 门槛，否则门槛测的是标注噪声。

## 4. goldset-v1（降级产物）

- `annotationMode: model-dual-blinded`、`goldsetVersion: goldset-v1`、218 场景 / 778 claim。
- 裁决策略 `union-policy@v1`（`pilot/p1a/tools/adjudicate.mjs`，规则版本写进产物 `adjudication` 字段）：
  - claim 只在一侧 → 取该侧（`a` 439 条 / `b` 296 条）；
  - 两侧都有但字段分歧 → `merge`（文本取 A、字段取 B）49 条；
  - 已有人工裁决 → 原样保留（本轮 0 条，策略不覆盖人工）。
- 每条 claim 带 `confirmedByBoth` 标记：**只有 44 条为 true**（5.6%），734 条为单遍提出。任何下游使用者都必须看到这个字段，不能把 778 条都当成"双遍确认"。
- 与语料内嵌 gold 的关系：语料 347 条是 B3 单遍机助草稿；goldset-v1 778 条是两遍盲评并集。**两套 gold 不可混用**：评分基线仍用语料内嵌 gold（B4 报告口径），goldset-v1 是 P1b 之前需要收敛出的人工 gold 目标版本。
- 产物在验证轨（`pilot/p1a/out/`，gitignored），复现命令：
  ```bash
  node pilot/p1a/tools/annotation-pass.mjs export --corpus pilot/p1a/corpus --out pilot/p1a/out/blind
  # 8 片盲评 → 合并 pass2.jsonl → import
  node pilot/p1a/tools/annotation-pass.mjs compare --a out/blind/pass1.jsonl --b out/blind/pass2.jsonl
  node pilot/p1a/tools/annotation-pass.mjs worksheet --a ... --b ... --out out/blind/worksheet.json
  node pilot/p1a/tools/adjudicate.mjs  # union-policy 回填 resolution（见 tools/adjudicate.mjs 注释）
  node pilot/p1a/tools/annotation-pass.mjs goldset --a ... --b ... --worksheet out/blind/worksheet-adjudicated.json \
    --out out/blind/goldset-v1.json --version goldset-v1 --mode model-dual-blinded --adjudication out/blind/worksheet-adjudicated.json
  ```

## 5. 本轮工具变更（随本记录一并交付）

| 变更 | 原因 |
|---|---|
| `annotation-pass import` 增加证据校验：eventId 必须存在、quote 必须逐字子串、claim ≤100 字符 | 此前 import 只校验枚举与覆盖，pass2 的 44 条应拒判定与 340 条 claim 的引文正确性无机械保证；现在 fail-closed |
| `import --package` 读取 `blind-pass.jsonl` 作为事件索引 | 证据校验需要事件原文；缺失时退化为只校验枚举/覆盖（不阻断） |
| `buildGoldset` 支持 `annotationMode` / `adjudication` 参数，claim 打 `confirmedByBoth` | 降级模式必须写进产物；双遍确认比例必须可核 |
| 新增 `tools/adjudicate.mjs`（`applyUnionPolicy` / `goldsetConfirmationStats`，规则版本 `union-policy@v1`） | 裁决需要可复核的规则与统计，而不是一次性手工填表 |
| `exit-check` 支持 `model-dual-blinded`：以 ⚠️ 计为「带声明通过」，输出 `caveats` | 降级模式不能与 `dual-independent` 混为一谈，但也不该像未完成一样卡住出口 |

## 6. 升级为 `dual-independent` 的路径（P1a 关闭后仍保留）

1. 人工第二标注人按 06 §2 独立标注 218 场景（或先按 §3 的粒度规范做 10–20 场景校准子集）；
2. 用同一 `annotation-pass` 流程算出人工一致率与分歧；
3. 裁决（人工）→ `goldset-v2`，`annotationMode: dual-independent`；
4. `goldset-v1` 保留为历史版本，`exit-check` 的 ⚠️ 随之转 ✅。

在完成 1–3 之前，任何对外的实验结论（04 §3 门槛、future-architecture §7.2 收益三项）都必须标注「gold 为 model-dual-blinded 降级产物」。
