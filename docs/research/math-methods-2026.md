# sedimem 数学方法调研：方向(1)原子化记忆 与 方向(2)临时会话记忆库

日期：2026-11-13。范围：信息论 / 组合优化 / 决策论。每条按「公式 / 优化什么变量 / 标定数据 / 能否机械验收」四要素写，变量名对齐 `config/policy.json`（`brief.lines=80`、`brief.tier0Chars=800`、`brief.totalChars=8000`、`quota.maxActive=5000`、`dedupe.nearDupThreshold=0.85`、`decay.halfLifeMs`）。

## 1. 信息论基线

### 1.1 率失真 R(D)：给「压缩到 N 字符」一条实测曲线

- 公式：`R(D) = min_{p(x̂|x): E[d(x,x̂)]≤D} I(X;X̂)`。离散近似：固定码率（`brief.tier0Chars` 字符预算）下，遍历不同压缩强度 s，测 `D(s) = 抽检事实丢失率`，得到经验 R⁻¹(D) 曲线。
- 优化变量：`text` 的长度上限（原子化方向(1)的核心参数，候选 80/160/240 字符）对信息保留率 D 的 trade-off。
- 标定数据：`~/.memo/items/<scope>.jsonl` 里每条 `text`，用「可抽取 SPO 三元组数」做信息内容单位：原文抽 k 个事实，压缩到 N 字符后能恢复 j 个，`D = 1 - j/k`。
- 机械验收：✅ 能。脚本批处理 500 条记忆 → LLM 抽事实 → 压缩 → 重抽 → 算召回率，全程无人工。曲线拐点即为最优 `tier0Chars`。
- 风险：D 的度量依赖同一个 LLM 抽事实，有自证偏差；交叉验证用两个不同模型抽。

### 1.2 MDL / 逐条 surprisal：这条记忆值不值得留

- 公式：`s(m) = -log p(text_m)`，p 用全库字符 n-gram（或词频）分布估计；`留的价值 = s(m) × P(未来检索)`，其中 `P(未来检索)` 用 `hits` 历史拟合成 recall hazard（见 §4）。MDL 视角：库总描述长度 = Σ len(m) + 检索失败代价，`quota.maxActive` 是显式约束。
- 优化变量：写入时的门槛（`confidence` 加权的信息量）与 `decay.halfLifeMs` 的淘汰联合目标。
- 标定数据：`~/.memo/events.jsonl` 的 `op=hit` 与 `op=write`；`items/*.jsonl` 的 `hits` 字段。
- 机械验收：✅。回放 30 天 events，对比「surprisal×hazard 排序淘汰」vs「现行 decay」在 `searchCount/noHitRate` 上的差异（metrics 日已有）。
- 参考：MDL 原始思想见 Rissanen（无 arXiv，1978；未读原文，教科书级结论）。

### 1.3 Information Bottleneck：压缩 X 保 I(X;Y)

- 公式：`min I(X;T) - β·I(T;Y)`，Y = 「该记忆未来 30 天内被 hit」。T 是注入 brief 的摘要。
- 优化变量：`brief.quota={L2:0.25,L3:0.15}` 的分层配比——哪些记忆值得进 tier0。
- 标定数据：需要 (记忆, 未来是否被检索) 标签，`events.jsonl` 的 hit 序列恰好提供（这就是免费监督信号）。
- 机械验收：⚠️ 半机械。IB 本身要训一个编码器，成本超一周；但它的退化形式（用 `P(hit|记忆特征)` 直接排序）可机械验收，等价于 §1.2。
- 参考：Tishby IB，arXiv:physics/0004057（读过摘要；对本项目的可操作结论就是「以未来检索为 Y 做监督排序」，不必真解 IB）。

## 2. 预算下的选择（brief 注入 = 约束选择问题）

统一写法：`max_{S⊆M} Σ_{m∈S} u(m)  s.t.  Σ_{m∈S} tokens(m) ≤ brief.totalChars`（或行数 `brief.lines`）。`u(m) = w_kind·kinds[m.kind].weight × recency(m) × P(hit|m)`。

### 2.1 0/1 背包（精确基线）

- tokens 为容量，u 为价值；条目数 ≤ 5000（`quota.maxActive`），DP 太重但按 tier 分块后每层 <100 条，DP 可跑（`O(n·W)`，W≈8000 字符）。
- 机械验收：✅，与贪心对比即知 gap。
- 结论：作为 ground truth 给 2.2/2.3 打分，不进生产路径。

### 2.2 子模最大化 + 贪心 1-1/e

- 公式：facility location `f(S) = Σ_q max_{m∈S} sim(q,m)`（q 为历史 search query，来自 `events.jsonl` 的 `qHash`+命中集）；f 单调子模，贪心解 ≥ (1-1/e)·OPT ≈ 63%。
- 优化变量：brief 里放哪 L2/L3 条目，天然惩罚「三条记忆说同一件事」——冗余条目边际增益趋 0。
- 标定数据：30 天 `events.jsonl` 的 (qHash, hits[]) 对，用现成 `search.embedder` 算 sim。
- 机械验收：✅。离线回放：给定 qHash 集，贪心选 S，看 S 覆盖的查询比例 vs 现行 top-k 按 score 排序的覆盖比例。
- 参考：Nemhauser et al. 1978（无 arXiv；1-1/e 结论为经典，未读原文）。

### 2.3 DPP（行列式点过程）去冗余

- 公式：`P(S) ∝ det(L_S)`，L = Gram 矩阵 `L_ij = u_i·sim_ij·u_j`，贪心 MAP 近似 O(N·k³)。
- 优化变量：与 2.2 同（多样性选择），区别是 DPP 显式惩罚相似度（sim 高 → 行列式小 → 共选概率降），比 facility location 更贴 `dedupe.nearDupThreshold` 的语义。
- 机械验收：✅ 同 2.2 回放框架，直接换选择器。
- 参考：Kulesza & Taskar, arXiv:1207.3434（读过摘要与 greedy MAP 部分）。

**2.2/2.3 二选一做**，回放胜者进生产；facloc 语义直观、DPP 有现成库（`dppy` 库，pip 装），倾向 DPP。

## 3. 压缩触发：最优停止 / 有限期 MDP

方向(2)「每约 30k token 压缩一次」的「约」可以变成推导量。

- 建模：状态 `s_t = (已用token u_t, 增量信息密度 ρ_t)`；动作 a∈{继续, 压缩}；成本 `c = p_tok·u_t(继续累积) + λ·信息损失(压缩时发生)`。目标 `min E[总成本]`。
- 阈值形式：单调问题时值函数 V(u) 凸，最优策略为 `压缩 ⟺ u_t ≥ u*`，u* 满足边际条件 `p_tok = λ·∂(信息损失)/∂u`（信息损失随 u 增大——等待越久被压掉的越多）。**何时不是阈值**：若压缩质量依赖内容相位（代码块中途/引用边界），状态需加离散变量，退化为 (u, phase) 上的查表策略，不再单阈值。
- 标定数据：本会话自身的 ACP 数据（`compress` 前后 token、后续是否 decompress 回读）+ `events.jsonl` 的 `op=compact`。关键可测量：压缩后 30 分钟内发生 decompress 的概率 = 信息损失代理。
- 机械验收：✅ 离线回放可行。扫不同阈值 u* ∈ {20k,30k,40k}，回放真实会话算总成本曲线，取最小值。不需要真解 MDP——单参数扫描等价于解出阈值。
- 参考：最优停止经典教材 Chow-Robbins-Siegmund（无 arXiv，未读）；上下文压缩经验研究见 LLMLingua, arXiv:2310.05736（读过摘要）。

## 4. 去重/冲突阈值：贝叶斯 + ROC，不用「感觉」

### 4.1 Bayes factor 决定 merge

- 公式：对候选对 (a,b)，`BF = P(sim(a,b) | H_same) / P(sim | H_diff)`。两个似然从数据拟合：H_same 的 sim 分布用已被 `curate_apply` 判 merge 的对拟合，H_diff 用判 keep_both 的对拟合。`BF > 10 → 自动 merge；1<BF<10 → 进人工队列`。
- 优化变量：`dedupe.scanThreshold=0.45` 与 `nearDupThreshold=0.85` 从「拍脑袋」变为似然比对应的操作点。
- 标定数据：`events.jsonl` 里全部 `curate_apply` 记录（每次裁决就是一条标注）。不足 100 对前不自动 merge。
- 机械验收：✅。留出法：最后 20% 裁决做测试集，报混淆矩阵。

### 4.2 阈值 = ROC 操作点

- 把 scanThreshold 的选择写成：扫阈值画 ROC/PR，按目标（自动裁决零误合并，即 merge 精率 ≥ 0.99）反查阈值。PR 曲线比 ROC 合适（正例稀少）。
- 机械验收：✅，纯脚本。产出物：`dedupe.scanThreshold` 的建议值 + 证据曲线，直接进 policy 调参 PR。

## 5. 简洁度指标（方向(1)的验收口径）

- 定义：`信息密度 = 抽检事实数 / tokens(text)`；`压缩率 = 摘要 tokens / 原文 tokens`；主指标 `密度 = 保留率 / 压缩率`（保留率来自 §1.1 的重抽流程）。
- 防作弊约束：单独优化密度会鼓励截断（砍掉事实密度低但关键的限定词）。所以必须**双目标**：密度是分母约束下的保留率最大化，即 `max 保留率 s.t. tokens ≤ N`，两者同时上报，任何只报其一的改动不予合入。
- 机械验收：✅。CI 里跑固定 200 条种子集，密度下降超 10% 或保留率下降超 5% 即 fail。

## 6. 估算脚本伪代码（≤40 行，可跑骨架）

```python
# calibrate.py — 用 ~/.memo 真实数据标定 brief 选择与去重阈值
import json, glob, math
from collections import Counter

def load_events(path="~/.memo/events.jsonl"):
    pairs, queries = [], []   # pairs: (sim, verdict) ; queries: (q, hit_ids)
    for line in open(path):
        e = json.loads(line)
        if e["op"] == "curate_apply": pairs.append(e["detail"])
        if e["op"] == "search": queries.append(e["detail"])
    return pairs, queries

def fit_distributions(pairs):          # §4.1: 似然拟合
    same  = [p["sim"] for p in pairs if p["decision"]=="merge"]
    diff  = [p["sim"] for p in pairs if p["decision"]=="keep_both"]
    return histogram_kde(same), histogram_kde(diff)

def bayes_factor(sim, k_same, k_diff): # BF>10 自动 merge
    return k_same(sim) / max(k_diff(sim), 1e-9)

def sweep_thresholds(pairs):           # §4.2: PR 曲线反查 scanThreshold
    for th in [x/100 for x in range(30, 96, 5)]:
        tp = sum(p["decision"]=="merge" and p["sim"]>=th for p in pairs)
        fp = sum(p["decision"]=="keep_both" and p["sim"]>=th for p in pairs)
        yield th, tp/max(tp+fp,1)      # 精率
    # 取满足 precision>=0.99 的最小 th 为 scanThreshold

def dpp_select(cands, budget, sim_fn): # §2.3: 贪心 MAP DPP
    S = []
    while budget > 0:
        best = max(cands, key=lambda m:
            math.prod(sim_fn(m, s) for s in S) ** 2 * u(m) if S else u(m))
        if tokens(best) > budget: cands.remove(best); continue
        S.append(best); budget -= tokens(best); cands.remove(best)
    return S

def replay(queries, selector):         # 统一验收：覆盖率为北极星
    covered = sum(1 for q in queries if selector_covers(selector, q))
    return covered / len(queries)
```

## 诚实评估

### 推荐实施 3 条（成本 < 一周、收益可测）

1. **§4 去重阈值标定**（2 天）：数据现成（`curate_apply` 记录）、脚本最短、直接产出 `dedupe.*` 新默认值，PR 可附 PR 曲线作证据。
2. **§2.3 DPP brief 选择 + 回放验收**（3 天）：`events.jsonl` 的 qHash 提供免费评测集，替换现行按 score top-k，覆盖率提升可量化。
3. **§5+§1.1 密度/保留率双指标 + R(D) 曲线**（4 天）：一次搭好后成为方向(1)的永久验收门禁，顺便定 `tier0Chars` 的数据支撑值。

### 明确不做（学术自嗨）

- **真·Information Bottleneck 求解**：需训练编码器、标签量要求高，其可操作结论（按 P(hit) 排序）已被 §1.2 用一行公式拿到。
- **背包精确 DP 进生产**：5000 条规模下相对贪心/DPP 的增益 < 单条 u(m) 估计误差，只留作离线 ground truth。
- **显式 MDP 求解器（值迭代/策略梯度）**：单变量阈值问题，参数扫描即精确解；上求解器是为方法而方法。

### 未验证清单

- §1.1 的「事实抽取」稳定性未测（同模型两次抽取的一致率需 > 0.9 才可用）。
- §3 的 λ（token 单价 vs 信息损失）没有公度尺度，需先跑 3 个阈值的真实会话对照才有数据。
- §2.3 的 u(m) 中 `P(hit|m)` 的 hazard 模型形式（指数 vs Weibull）未选型，用 `decay.halfLifeMs` 对应的指数族先跑。
- `events.jsonl` 中 `curate_apply` 样本量是否够拟合双似然（<100 对时 §4.1 降级为只调 scanThreshold）。
