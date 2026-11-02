# 05 · 研发流程：文档先行 → TDD → 多 Agent 审核 → 门禁

## 1. 角色

| 角色 | 谁 | 职责 | 写权限（互不重叠） |
|---|---|---|---|
| Lead | 主代理 | 文档、契约、拆分任务、整合、门禁判定、最终验收 | `docs/`、`README.md`、`versions/*/docs/ACCEPTANCE.md` |
| impl-core | 实现员工 | `src/core/`、`src/storage/`、`src/index/`、`src/api/service.js` | 仅这四块 |
| impl-hygiene | 实现员工 | `src/hygiene/`、`src/render/` | 仅这两块 |
| impl-edge | 实现员工 | `src/cli/`、`src/mcp/`、`configs/`、迁移 | 仅这三块 |
| eval-qa | 测试员工 | `tests/`、`eval/` | 仅这两块 |
| review-arch | 审核员工 | 架构与可演化性审核报告 | `reviews/arch.md` |
| review-adv | 审核员工 | 对抗性/边界审核报告 + 复现脚本 | `reviews/adversarial.md`、`reviews/probes/` |

**写权限是硬边界**：任何员工不得修改别人 scope 的文件；发现契约错误只能写 issue 到 `reviews/` 并在消息里报给 Lead，由 Lead 改契约。

## 2. 时间线（v0.1）

```
T0  Lead 写完 docs/00–05 + 契约冻结
T1  eval-qa 先写测试（red）；同时 impl-core / impl-hygiene / impl-edge 按契约实现
T2  Lead 整合：跑 node --test + eval，修接口漂移（只由 Lead 动契约）
T3  review-arch + review-adv 并行审核（不得改业务代码）
T4  Lead 按审核意见派修复（原实现员工修自己 scope），复跑门禁
T5  Lead 打 tag、写 CHANGELOG、验收
```

## 3. TDD 的具体形状

- 测试文件名 `*.test.js`，用 `node:test` + `node:assert/strict`。
- 每个测试自己建临时 `MEMO_HOME`（`fs.mkdtempSync(os.tmpdir()+'/memo-')`），结束时 `fs.rmSync(...,{recursive:true,force:true})`；**禁止**写到真实 `~/.memo`。
- 单元测试覆盖每个导出（契约 §3 的每一节至少 1 个测试文件）。
- 注入式测试只通过 `MemoryService`，不复用单元测试的 helper 内部状态。

## 4. 审核清单（review 员工照此打分，不给通过就给具体到行的反例）

**架构（review-arch）**
1. 依赖方向是否单向？`hygiene/` 有没有偷偷 import storage 具体实现？
2. 六个 Port 是否真的可替换（找一个替换推演：换成 sqlite index 需要改哪些文件？>2 个即不合格）。
3. 有没有写死的策略常量散落在代码里（应该在 `config/policy.json`）？
4. 真相层是否真不可变（有没有任何 `writeFile` 覆盖 items.jsonl）？
5. `reindex` 是否会修改真相层？
6. 错误是否都被显式抛出（有没有空 catch）？

**对抗（review-adv）**：至少尝试 6 个攻击，每个给出可复现命令
1. 并发 10 个进程同时写同一条 → 是否重复/丢数据/JSON 行撕裂？
2. 写入超长文本（10k）与含控制字符/换行的文本 → 是否破坏 JSONL？
3. 伪造 `source.agent` / 缺 source → 是否被拒？
4. 用 `asOf` 越界（未来时间、极早时间）→ 是否崩溃？
5. 注入指令型记忆 → brief 是否被污染？
6. 手工把 `items/*.jsonl` 写坏一行 → `doctor` 是否能定位而不是崩？
7. `MEMO_HOME` 指向只读目录 / 磁盘满（模拟：目录权限 500）→ 是否 fail-loud？

## 5. 门禁（Lead 判定，缺一不放行）

```
G1  node --test tests/ 全绿
G2  node eval/run.js 六项全 PASS 且指标达标
G3  memo doctor 无 error
G4  两份审核报告无「阻断」级意见；阻断项全部修复或写 ADR 接受
G5  docs/02 契约与实现一致（Lead 逐条核对导出签名）
G6  CHANGELOG + 版本索引更新
```
