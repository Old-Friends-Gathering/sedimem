# ADR-101 · tokenizer 选型与计数口径（v2.0 规格草案）

> doc-kind: history
> doc-version: 2.0
> status: proposed

状态：**proposed**——随 [v2.0 规格包](README.md) 冻结转 accepted。来源：[v2.0-p1.md](../../plans/v2.0-p1.md) §2 冻结决策 6、§6 预研。

## 决策

1. **计数口径**：pilot 与首个正式效果实验的所有 token 指标（切段窗口、预算、§7.2 的 20% 中位数降幅）一律以 **DeepSeek-V3 tokenizer**（HF 公开 `tokenizer.json`，MIT 许可，数据文件 vendored 进 pilot 工具或可选 devDep，零内核依赖）计数。
2. **生成模型单独声明**：抽取实验的生成模型固定写入实验配置（当前为 GLM 托管 API，open.bigmodel.cn），与计数口径**分离**。
3. **跨模型限制**：效果实验结论限定「仅在该 tokenizer 计数口径下成立，不外推到真实部署窗口」；报告中所有 token 数字标注 `tokenizer: deepseek-v3`。
4. ADR 定稿前 pilot 切段一律标 `estimated`，不出正式成绩。

## 备选与被否理由

| 候选 | 精确性 | 裁定 | 理由 |
|---|---|---|---|
| GLM 托管 API 模型（glm-4.6/4.7/5 等）离线 tokenizer | **无公开离线实现** | 否（当前） | 2026-11-18 查证（§查证记录）：托管 API 系列无公开 tokenizer.json；仅有在线 tokenization 端点，不可 vendored、有网络与配额依赖，不满足「离线精确、可复现」 |
| GLM 开源权重模型 tokenizer（glm-4-9b-chat-hf 等，HF 公开） | 公开精确 | 保留备选 | 精确但对应**开源 9B 模型**，与托管 API 生成模型分词不保证一致；若未来实验切换为本地开源模型运行，可经本 ADR 修订切换计数口径 |
| tiktoken 系列 | 精确 | 否 | 不含 GLM/DeepSeek 词表，与目标模型不匹配 |
| DeepSeek-V3/R1 tokenizer | 公开精确 | **采用** | MIT、可 vendored、中英混合表现好；与生成模型不一致的代价由 §决策 3 限定 |

## 查证记录（2026-11-18，计划 §6 前置任务）

- zai-org/GLM-4 开源仓库提供 transformers tokenizer（`AutoTokenizer`，glm-4-9b-chat 及 `-hf` 转换版）——开源权重模型的精确 tokenizer 公开可获取。
- 托管 API（bigmodel.cn / Z.AI）侧：未检索到公开离线 tokenizer 数据文件；社区集成（zai-api skill 文档）使用**在线 tokenizer 端点**做精确计数——即 API 有计数字径但无离线可分发实现。
- 结论：计划 §6 表「GLM 系列：待查证，无公开精确 tokenizer 则不可用」→ 查证结果为**托管生成模型无离线公开 tokenizer**，推荐组合（DeepSeek 计数 + 生成模型声明）成立。

## 许可与分发

- DeepSeek tokenizer 数据文件：MIT（HuggingFace deepseek-ai/DeepSeek-V3 仓库）；vendored 副本带版本号与来源 URL，更新走本 ADR 修订。
- 运行时依赖：`@huggingface/tokenizers`（或等价 wasm 绑定）作为 **pilot 工具可选 devDep**（`pilot/p1a/tools/`，零 node_modules 运行时依赖纪律不适用于工具自身）；产品内核（versions/*/src）零依赖不变。
