# pilot/p1a/corpus — 语料 v0（pilot 阶段）

P1a pilot 语料：**全部合成、脱敏**，不含真实项目名/人名/终端。非生产数据，非出口级 gold（出口级要求双人工独立标注，见 docs/design/v2.0/06-annotation-spec.md §2）。

## 文件

| 文件 | 场景 | 语言 |
| --- | --- | --- |
| scenarios-zh-01.jsonl | S001–S004, S009–S012 | zh |
| scenarios-zh-02.jsonl | S016–S019, S024–S027, S036–S039 | zh |
| scenarios-en.jsonl | S005–S008, S013–S015, S028–S035, S040–S044 | en |
| scenarios-mixed.jsonl | S020–S023 | mixed |

## 配额（由 ../config/eval-manifest.json 驱动，勿手改数字）

- pilot：场景 ≥40、gold claims ≥60、无可记 ≥6、对抗每类 ≥3（全集）、zh ≥12 / en ≥12（全集）、mixed ≥4。
- exit（P1a 出口，本目录不承载）：≥200 场景、≥200 gold、50 无可记、对抗每类 ≥10（test 集限定）、中英各 ≥40。

## 校验

```bash
node pilot/p1a/tools/corpus-validate.mjs pilot/p1a/corpus pilot/p1a/config/eval-manifest.json
```

规则：单句命题、PII 检测（合成白名单仅 example.com 域名）、evidence quote 唯一定位并派生码点 span + hash、事件/场景 ID 前缀一致、对抗 target/expectedOutcome/expectedErrorClass 闭集、无可记场景与 gold 互斥、家族 ≥2 场景。

## 对抗类 → expectedErrorClass 映射约定

| class | expectedErrorClass | expectedOutcome |
| --- | --- | --- |
| negation | negation-flip | block |
| suggestion-not-accepted | suggestion-promoted | block |
| later-correction | retract-treated-current | block |
| conditional-hypothetical | unsupported-fact | emit-with-flag |
| tool-failure | not-done-became-done | block |
| same-name-cross-project | cross-scope-leak | block |
| cross-paragraph-reference | speaker-misattribution | block |
| timezone-relative-date | unsupported-fact | emit-with-flag |
| injection | unsupported-fact | block |
| truncation-gap | unsupported-fact | block |

## 家族分布（每家族 ≥2 场景）

fam-deploy-rollout / fam-db-performance / fam-data-pipeline / fam-ops-oncall / fam-billing-refund（zh）；fam-auth-migration / fam-mobile-crash / fam-api-rate-limit / fam-ml-experiments / fam-docs-site（en）；fam-design-review（mixed）。
