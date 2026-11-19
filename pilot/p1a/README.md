# pilot/p1a — P1a pilot 评测工具轨

对应计划 [`docs/plans/v2.0-p1.md`](../../docs/plans/v2.0-p1.md)（issue #218）。规格见 [`docs/design/v2.0/`](../../docs/design/v2.0/README.md)。资产登记见 [`docs/12-data-map.md`](../../docs/12-data-map.md) §12.5。

> 当前策略r2：[自动记忆与历史纠正](../../docs/design/v2.0/08-auto-memory-and-correction.md)。取消人工标注/复核前置；下列双遍工具仍复用，模型参考只标来源。exit-check只核P1a资产，不证明r2生产实现或语义真值；旧模拟器仍为r1资产。

## 布局

```
pilot/p1a/
├── corpus/    语料（合成脱敏；exit 批次 218 场景/347 gold/对抗 10 类 test 各 10）
├── config/    eval-manifest.json（冻结数字，改须版本化 diff+签署）
├── tools/     corpus-validate / baseline-runner / score / review / protocol-sim / split-corpus / annotation-pass / contract-guards / exit-check / adjudicate / fix-r2-*
├── tests/     139 测试（TDD 先行）
└── out/       运行输出（gitignore，每次带 runId）
```

## 常用命令

```bash
# 出口核验（一条命令看 P1a 放行条件是否齐备）
node pilot/p1a/tools/exit-check.mjs .
# 语料校验（配额全读 config/eval-manifest.json）
node pilot/p1a/tools/corpus-validate.mjs pilot/p1a/corpus pilot/p1a/config/eval-manifest.json

# 跑基线（确定性规则抽取，无 LLM，不读 gold）
node pilot/p1a/tools/baseline-runner.mjs pilot/p1a/corpus
# → pilot/p1a/out/baseline/<runId>/{candidates.jsonl,meta.json}

# 评分（pilot 阶段 fail-closed：只报指标不出 pass/fail）
node pilot/p1a/tools/score.mjs pilot/p1a/out/baseline/<runId>/candidates.jsonl pilot/p1a/corpus

# 切分：按家族分层分配 dev/test（--check 校验配额/家族两端/跨集近重复）
node pilot/p1a/tools/split-corpus.mjs pilot/p1a/corpus pilot/p1a/config/eval-manifest.json --check
node pilot/p1a/tools/split-corpus.mjs pilot/p1a/corpus pilot/p1a/config/eval-manifest.json --apply --seed 20261118

# 自动双遍盲评参考工作流（标来源）：导出盲评包 → 第二个模型执行体独立标注 → 导入校验 → 一致性 → 裁决工作表
node pilot/p1a/tools/annotation-pass.mjs export --corpus pilot/p1a/corpus --out pilot/p1a/out/blind
node pilot/p1a/tools/annotation-pass.mjs import --file pilot/p1a/out/blind/pass2.jsonl --package pilot/p1a/out/blind
# 命题粒度校准（granularity@v1）
node pilot/p1a/tools/granularity-check.mjs pilot/p1a/granularity/calibration.jsonl

node pilot/p1a/tools/annotation-pass.mjs compare --a pilot/p1a/out/blind/pass1.jsonl --b pilot/p1a/out/blind/pass2.jsonl
node pilot/p1a/tools/annotation-pass.mjs worksheet --a pilot/p1a/out/blind/pass1.jsonl --b pilot/p1a/out/blind/pass2.jsonl --out pilot/p1a/out/blind/adjudication.json
# 自动版本化裁决策略填充 adjudication.json 的 resolution 后：
node pilot/p1a/tools/annotation-pass.mjs goldset --a pilot/p1a/out/blind/pass1.jsonl --b pilot/p1a/out/blind/pass2.jsonl --worksheet pilot/p1a/out/blind/adjudication.json --out pilot/p1a/out/blind/goldset-v1.json

# 复核骨架（只读；accept/reject 属 P1b）
node pilot/p1a/tools/review.mjs list pilot/p1a/out/baseline/<runId>/candidates.jsonl [--status s] [--scope sc]
node pilot/p1a/tools/review.mjs show pilot/p1a/out/baseline/<runId>/candidates.jsonl <candidateId>
```

## 工具定位

| 工具 | 职责 | 依据 |
| --- | --- | --- |
| corpus-validate.mjs | 语料静态校验：单句/PII/span+hash/闭集/配额 | 06-annotation-spec |
| protocol-sim.mjs | 候选协议内存模拟：幂等/CAS/收据/提交点/恢复（不写真相层） | 01-candidate-schema §3 |
| baseline-runner.mjs | 规则地板基线：证明评测管线可算 P/R 与七类严重错误 | 计划 D4 |
| score.mjs | TP/FP/FN 一对一、子命题=FP+FN、mixed 双组、severe 计数；置信区间主口径=bootstrapCI（家族聚类 2000 次/95%/seed 可复现），Wilson 仅描述性；`stage!=='exit'` 时 verdict=null | 04-scoring-and-splits §3 |
| review.mjs | 复核骨架（只读 list/show） | 计划 §8 |
| exit-check.mjs | P1a 出口机算核验：语料/拆分/配额/冻结/双标注逐项判定（pending 与失败分开，输出阻塞项） | plans/v2.0-p1 §0.2/§7.1 + design/v2.0/README 冻结表 |
| adjudicate.mjs | 裁决表的记录化策略（union-policy@v1）：单侧 claim 取该侧、字段分歧 merge、不覆盖人工裁决；输出双遍确认统计 | 06-annotation-spec §3.1 |
| contract-guards.mjs | 三项冻结守卫：双时间互斥/asOf 穿越、tokenizer 计数快照与声明、成本闸门 | 01 §5 / adr-101 / adr-102 |
| split-corpus.mjs | 家族分层 dev/test 切分 + 跨集近重复（Dice）校验 | 04-scoring-and-splits §1 |
| granularity-check.mjs | 命题粒度规则 granularity@v1：原子性/拆分规则/同一性判定 + 12 场景校准集校验 | 06-annotation-spec §1.1 |
| annotation-pass.mjs | 双遍盲评**自动参考**工作流：盲评包/导入校验/一致性报告/裁决工作表/goldset 生成（fail-closed，未裁决一律拒绝）；不出 pass/fail；不再要求人工标注 | 06-annotation-spec §2/§3 |

## 红线

- baseline-runner 绝不读 gold/adversarial/shouldReject 参与抽取（inputHash 只含事件文本）。
- 候选 workflow status 恒 `pending`；不写真相层；scope 恒 `pilot:synthetic`（scopeUnresolved=true）。
- `stage!=='exit'` 时评分器拒绝输出 pass/fail（04 §5 fail-closed）。
- 语料/门槛改动必须走版本化提交并在 REVIEW 留痕。
