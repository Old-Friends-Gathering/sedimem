# pilot/p1a — P1a pilot 评测工具轨

对应计划 [`docs/plans/v2.0-p1.md`](../../docs/plans/v2.0-p1.md)（issue #218）。规格见 [`docs/design/v2.0/`](../../docs/design/v2.0/README.md)。资产登记见 [`docs/12-data-map.md`](../../docs/12-data-map.md) §12.5。

## 布局

```
pilot/p1a/
├── corpus/    语料（合成脱敏；exit 批次 218 场景/347 gold/对抗 10 类 test 各 10）
├── config/    eval-manifest.json（冻结数字，改须版本化 diff+签署）
├── tools/     corpus-validate / baseline-runner / score / review / protocol-sim / split-corpus / annotation-pass / contract-guards / fix-r2-*
├── tests/     117 测试（TDD 先行）
└── out/       运行输出（gitignore，每次带 runId）
```

## 常用命令

```bash
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

# 双独立标注工作流（出口级 gold）：导出盲评包 → 第二标注人独立标注 → 导入校验 → 一致性 → 裁决工作表
node pilot/p1a/tools/annotation-pass.mjs export --corpus pilot/p1a/corpus --out pilot/p1a/out/blind
node pilot/p1a/tools/annotation-pass.mjs import --file pilot/p1a/out/blind/pass2.jsonl --package pilot/p1a/out/blind
node pilot/p1a/tools/annotation-pass.mjs compare --a pilot/p1a/out/blind/pass1.jsonl --b pilot/p1a/out/blind/pass2.jsonl
node pilot/p1a/tools/annotation-pass.mjs worksheet --a pilot/p1a/out/blind/pass1.jsonl --b pilot/p1a/out/blind/pass2.jsonl --out pilot/p1a/out/blind/adjudication.json
# 人工裁决 adjudication.json 的每行 resolution 后：
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
| contract-guards.mjs | 三项冻结守卫：双时间互斥/asOf 穿越、tokenizer 计数快照与声明、成本闸门 | 01 §5 / adr-101 / adr-102 |
| split-corpus.mjs | 家族分层 dev/test 切分 + 跨集近重复（Dice）校验 | 04-scoring-and-splits §1 |
| annotation-pass.mjs | 双独立标注工作流：盲评包/导入校验/一致性报告/裁决工作表/goldset 生成（fail-closed，未裁决一律拒绝）；不出 pass/fail | 06-annotation-spec §2 |

## 红线

- baseline-runner 绝不读 gold/adversarial/shouldReject 参与抽取（inputHash 只含事件文本）。
- 候选 workflow status 恒 `pending`；不写真相层；scope 恒 `pilot:synthetic`（scopeUnresolved=true）。
- `stage!=='exit'` 时评分器拒绝输出 pass/fail（04 §5 fail-closed）。
- 语料/门槛改动必须走版本化提交并在 REVIEW 留痕。
