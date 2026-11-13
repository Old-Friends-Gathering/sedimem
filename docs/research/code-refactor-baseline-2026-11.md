# sedimem 1.0.0 重构基线测量（2026-11）

> 只测量与提方案，不改代码。被测版本：`versions/v0.6`。所有数字由 node 脚本（见文末复现命令）在本机实测。

## 1. 体量基线

```
TOTAL src lines: 12598 files: 60
== by dir ==
2845 src/cli      1686 src/api     1407 src/hygiene   1149 src/index
1038 src/mcp      1019 src/web      797 src/views      642 src/session
 623 src/render    478 src/core     372 src/capture    342 src/storage
 200 src/config
tests files: 100 lines: 11207    ui files: 11 lines: 2222    exports: 204
```

单文件 Top（>400 行者即重构候选 A 类）：

```
861 src/mcp/server.js      800 src/cli/memo.js      718 src/web/handlers.js
485 src/api/maintenance.js 479 src/hygiene/conflict.js 416 src/cli/nightly.js
```

## 2. 依赖关系（目录级 import 边，Top）

```
11 src/api -> src/hygiene   7 src/api -> src/core    4 src/cli -> src/core
 3 src/cli -> src/api       3 src/mcp -> src/session 3 src/session -> src/core
 2 src/render -> src/hygiene 2 src/web -> src/mcp    1 src/mcp -> src/cli
 1 src/session -> src/mcp   1 src/web -> src/api
```

**文件级循环（脚本 DFS 实测，5 条）**：

```
src/api/lifecycle -> src/api/service -> src/api/lifecycle
src/api/service -> src/api/write-path -> src/api/service
src/api/service -> src/api/search-path -> src/api/service
src/api/service -> src/api/maintenance -> src/api/service
src/config/policy -> src/config/policy   ← 自 import（坏味道，虽 ESM 可容）
```

**反向依赖（下层被上层穿透）**：
- `src/web/scopes.js:7` / `src/web/server.js:8`：`import { SCOPE_PATTERN } from '../mcp/scope-state.js'` —— web（服务层旁路）依赖 mcp（入口层）的常量。
- `src/mcp/server.js:26`：`import { PROMOTE_KINDS } from '../cli/session.js'` —— 两个入口层互相耦合。

## 3. 重构候选与证据

| # | 候选 | 证据 |
|---|---|---|
| A1 | `mcp/server.js` 861 行：工具 schema + 分发 + scope + 错误码全在一文件；且文档说入口层"只做参数解析" | 上文行数；`grep -c "" src/mcp/server.js` = 860 |
| A2 | `cli/memo.js` 800 行命令分发，直接摸文件系统绕过 service：`src/cli/memo.js:469-474` `readdirSync/readFileSync(path.join(memoHome, f))` | grep 输出（§2 命令片段） |
| A3 | `web/handlers.js` 718 行 + `api/maintenance.js` 485 行、`hygiene/conflict.js` 479 行均超 400 | Top 表 |
| B1 | **职责混杂**：`cli/backfill.js:11` 直接 `import { JsonlStore } from '../storage/jsonl-store.js'` —— CLI 绕过 MemoryService 摸 storage 具体实现 | grep 输出 |
| B2 | `cli/memo.js:669,680` 直接调 `api/retitle.js` 而非 service 门面 | grep 输出 |
| C1 | **重复实现：scope 概念散布 10 文件**（`core/scope.js`、`config/paths.js`、`mcp/scope-state.js`、`web/scopes.js`、`cli/memo.js`、`cli/nightly.js`、`cli/backfill.js`、`cli/capture.js`、`storage/jsonl-store.js`…），各自持有 `SCOPE_PATTERN`/scopeKey/scope 归一逻辑 | `grep -rln "resolveScope\|parseScope\|normalizeScope" src` 输出 |
| C2 | 时间解析分散：`api/search-path.js:36` 自做 `Date.parse(asOf)` 归一，`render/brief.js`、`cli/session.js`、`mcp/server.js` 各有相对时间/asOf 逻辑（未见统一 time 模块；`core/clock.js` 仅注入 now） | grep "asOf" 输出 |
| C3 | 文本归一化散布 8 文件（`capture/queue.js`、`capture/extract.js`、`hygiene/conflict.js`、`views/l2.js`、`views/l3.js`…各有 normalize） | `grep -rln "normalizeText\|normalize(" src` |

## 4. 代码 vs 文档不一致（docs/01-architecture.md 声明为基准）

文档 `docs/01-architecture.md:26`：「`cli/` `mcp/` 不得含业务逻辑」「入口层只做参数解析与 JSON 编解码」：

1. ❌ `mcp/server.js` 含工具语义、scope 运行期切换、错误码策略（861 行）。
2. ❌ `cli/memo.js` 直接读 memoHome 文件（`:469-474`）并直接调 `api/retitle.js`（`:669,680`）。
3. ❌ `cli/backfill.js:11` 直接 import storage 具体实现 —— 违反「api/service.js 是唯一对外 API」（docs/01 §1 图）。
4. ❌ `web -> mcp`、`mcp -> cli` 两条依赖边违反「只允许向下依赖」（docs/01-architecture.md:3）。
5. ❌ `api/service ↔ write-path/search-path/maintenance/lifecycle` 四组循环 import，与「服务层编排、不含策略」的单向分层不符。
6. ✅ 一致项：`hygiene/` 确未 import storage（`src/hygiene/write-gate.js:2`「不 import storage」且 grep 无违规）。

docs/02（`02-data-model-and-contract.md:371`）称 scope-state 属 `memory_scope` 工具契约 —— 但 `web/` 复用其 `SCOPE_PATTERN`（`src/web/scopes.js:7`），契约已外溢至 web，文档未更新。

## 5. 1.0.0 目标模块图（11 模块，依赖只向下）

```
入口 cli          入口 mcp            入口 web(static)
   └───────┬──────────┴──────────┬──────┘
        service（编排门面，唯一 API；消灭 service↔path 循环：path 模块只导出纯函数，service 单向 import）
     ┌──────┼─────────┬──────────┐
  hygiene   storage   index    render/views（派生层）
     └──────┴─────────┴──────────┘
  core（scope·time·hash·record·ids 全部单点化，吸收 C1/C2/C3 重复）
  config（policy 单一来源；去掉 policy 自 import）
```

关键收敛：`core/scope.js` 成为 scope 唯一实现（SCOPE_PATTERN、scopeKey、运行期覆盖都搬进来）；新增 `core/time.js` 统一 asOf/相对时间解析。

## 6. 迁移顺序（先解耦、再拆文件、UI 后置）

1. **P0 死循环与反向边**（风险最低收益最大）：拆 `mcp -> cli`（PROMOTE_KINDS 搬 core/record）；`web` 改 import core/scope 的 SCOPE_PATTERN；`api/service` 改为单向消费 write-path/search-path/maintenance/lifecycle 的纯函数导出。
2. **P1 重复收敛**：scope 家族合入 `core/scope.js`；时间解析入 `core/time.js`；文本归一化入 `core/text.js`。
3. **P2 大文件拆分**：`mcp/server.js` → tools 注册表 + dispatcher；`cli/memo.js` → 每子命令一文件；`web/handlers.js` 按路由拆。
4. **后置**：ui/（2222 行，纯展示）、capture、session 细化——行为风险低，可放 1.0.x。

## 7. 怎么保证重构不改行为

- **单测门禁**：现有 100 个测试文件 / 11207 行（`npm test` = `node --test 'tests/**/*.test.js'`，package.json:15）全绿是每次迁移的合并条件。
- **评测兜底**：`npm run eval`（package.json:16，`eval/run.js` + `eval/cases/`）做重构前后对比，分数漂移即回归。
- **覆盖率**：`test:coverage` 已排除 `cli/memo.js`（package.json:18）——拆分 memo.js 后应移除此豁免，防拆完仍无覆盖。
- **探针**：对 §4 每条不一致先补「依赖方向探针」测试（用静态 import 扫描断言无 `web->mcp`、`mcp->cli`、`cli->storage` 边），把架构规则变成可执行断言（本报告的 scan 脚本即可改造入库）。
- 每步一个独立 commit，可单独 revert；循环依赖消除顺序按 §6 P0 固定。

## 复现命令

```bash
cd versions/v0.6
# 行数/目录分布/exports/依赖图/循环：node 脚本（walk src + matchAll import/require + DFS 找环）
grep -rln "resolveScope\|parseScope\|normalizeScope" src
grep -n "import" src/mcp/server.js | head -25
grep -rn "api/retitle\|jsonl-store" src/cli | head
```
