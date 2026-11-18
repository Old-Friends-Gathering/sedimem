# 03 · 信任提升路径（v2.0 规格草案）

> doc-kind: contract
> doc-version: 2.0
> status: planned

状态：**planned**——冻结前允许修订。来源：[future-architecture.md](../../plans/future-architecture.md) §3.3 防线⑤/⑥；施工映射 [v2.0-p1.md](../../plans/v2.0-p1.md) §2 冻结决策 5。

## 1. 两道独立动作（核心不变式）

```
人工 accept ──▶ 候选转 accepted、写入真相层 references 区，trust = T2（不变）
人工 trust promote ──▶ 已 accepted 记录提升 T0/T1，进入可信 facts 读取面
```

- **accept ≠ promote**：两道动作必须分别显式调用；不存在「accept 时顺便提升」的组合参数。
- **promote 前置**：目标必须是 accepted 态候选写入的记录；pending/rejected 不可 promote。
- **promote 必带理由**：无理由的 promote 调用拒绝（参数缺失即报错，不给默认理由）。
- P0b 行为探针（普通写自报 T0 仍落 T2、唯一提升入口=trust promote）在 v2.0 语义下复验，防绕过。

## 2. 批量复核的人机界面约束

- 批量复核**逐条展示**；禁止默认勾选、禁止「全选 accept」作为初始状态。
- 每条 accept 独立产生 opId 与收据（[01-candidate-schema.md](01-candidate-schema.md) §3）；批量操作是 N 次独立事务，不是一次批量事务——部分失败不回滚已成功条目。
- 复核界面必须显示：claim 原文、证据 span 跳转、speaker/speechAct、双时间、冲突提示（与既有记录 contradicts 的显式标记）。

## 3. 传播控制（防线⑥）

- **摘要继承最低信任**：从记录派生的摘要/索引条目继承来源记录集中**最低**的 trust 级；T0 记录的摘要不高于 T2……依此类推。摘要不独立提升信任。
- **纠正后缓存失效**：记录被 supersede/纠错时，其全部派生缓存（旧候选、摘要索引、向量、P1c 的 pack 缓存）标记失效；失效条目不进入新装配。
- 传播规则机读化：派生条目携带 `derivedFrom` 集合，失效判定按集合遍历。

## 4. 验收

1. 保护测试（pilot 阶段最小版）：accept 后查 trust=T2 且落 references；trust promote 独立调用带理由才生效；批量 UI 约束以 protocol-sim 的调用序列约束表达（逐条 opId）。
2. 本文件冻结后，P1b 施工不得在写路径增加第三种信任变化入口；发现需求走本文件修订。
