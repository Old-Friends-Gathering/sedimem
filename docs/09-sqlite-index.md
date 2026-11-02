# 09 · SQLite FTS5 索引（v0.2.1-A）

> 对应 issue #20。目的有两个：让检索在几万条记录上不退化，以及**验证 IndexPort 这个扩展点是不是真的可插拔**。
> 后者比前者更重要：如果换索引要动 `service.js` 十处，那 docs/03 里的「六个 Port」就是纸面文章，本轮正好把它试出来。

## 1. 目标与非目标

**目标**

| # | 目标 | 验收 |
|---|---|---|
| G1 | 新增 `SqliteIndex`，与 `InvertedIndex` 实现**同一套接口** | 同一条 `service.js` 代码路径，只换构造函数注入 |
| G2 | 检索结果与内存索引一致 | I16：同一批查询 top-k 集合相等（同分并列允许多解） |
| G3 | 索引是派生层，可删可重建 | `memo reindex` 从真相层重建；删掉 `.sqlite` 后自动重建 |
| G4 | 中文可检索 | 「真相层」「去重阈值」等能命中；单字查询不误伤（见 §4.2） |
| G5 | 零运行时依赖 | Q1 仍绿（用 Node 内置 `node:sqlite`） |

**非目标**

- 不做向量/语义检索（v0.3 依据实测再定，见 docs/03 §5）。
- 不改真相层格式、不改写路径语义：索引永远可以从 JSONL 重建。
- 不做多进程并发写索引：同一 scope 同时只应有一个写者（与真相层锁一致）。

## 2. IndexPort 契约（照抄 `InvertedIndex` 的既有形状，不改）

```js
class IndexPort {
  constructor({ clock } = {}) {}
  build(records) -> this                  // 全量重建
  add(record) -> this                     // 幂等：同 id 覆盖
  remove(id) -> this
  search(query, { limit = 10, filter } = {}) -> { id: string, score: number }[]
  get size() -> number                    // 文档数，供 doctor 的 index_inconsistent 使用
}
```

约定（与 `src/index/inverted-index.js` 完全一致，避免"两套语义"）：

- `search` 只返回 `score > 0` 的结果，按 score 降序、同分按 id 升序；
- `filter(record)` 收到完整记录，返回 false 才过滤；实现必须**在打分后**过滤（保持与内存实现同一语义）；
- `limit` 为 `undefined` 时不截断；
- `add` 收到无 `id` 的记录必须抛 `E_INVALID_RECORD`（fail-loud，不静默丢）。

## 3. 存储布局

```
$MEMO_HOME/index/<scopeKey>.sqlite       # 主库（WAL 模式）
$MEMO_HOME/index/<scopeKey>.sqlite-wal   # WAL
$MEMO_HOME/index/<scopeKey>.sqlite-shm   # 共享内存
```

- `scopeKey` 复用 `src/config/paths.js` 的 `scopeKeyOf()`（裁决 39：命名单一来源）。
- 表结构：

```sql
-- 文档表：id 主键，正文进 FTS5
create table if not exists docs (
  id text primary key,
  text text not null,
  subject text, predicate text, value text,
  kind text, status text, created_at text
);

-- FTS5 虚表：external content 模式，rowid 用 docs 的行号，避免正文存两份
create virtual table if not exists docs_fts using fts5(
  text, subject, predicate, value,
  content='docs', content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);

-- 触发器保持 FTS 与 docs 同步（insert/update/delete 三个）
```

- **不存真相**：`docs` 只是检索用的派生副本。真相层始终是 `items/<scope>.jsonl`；删掉整个 `index/` 目录只会让下次启动变慢。

## 4. 检索语义

### 4.1 BM25

`bm25(docs_fts)` 的分数是**负数**（SQLite 约定，越小越相关）。实现必须：

```js
const rows = db.prepare(
  `select rowid, bm25(docs_fts) as rank from docs_fts
   where docs_fts match ? order by rank limit ?`).all(matchExpr, limit);
score = -rank;  // 转成正分，与 InvertedIndex 的方向一致
```

`score > 0` 的过滤在 JS 侧做（SQLite 的负数已转正后通常都 > 0，但要挡住 `rank === 0` 的边界）。

### 4.2 查询构造（最关键的一处）

`InvertedIndex` 用 `tokenize()` 切词后按 AND-ish 的累加打分；FTS5 默认把查询字符串当语法解析，**必须转义**，否则用户输入 `"`、`*`、`OR`、`NOT`、`(` 会抛语法错或改变语义。

实现规则（`buildMatchExpr(query)`，纯函数，单测覆盖）：

1. 用与内存索引**同一个** `tokenize()` 切词（保证中英文切法一致）；
2. 每个 token 包成 `"token"` 字面量（内部 `"` 双写转义）；
3. token 之间用 ` OR ` 连接（不是 AND——内存实现是「命中任一词即累加分数」，用 AND 会让结果集小于内存索引，破坏 G2）；
4. token 数 0 → 返回 `null`，`search` 直接返回 `[]`。

中文：`unicode61` 按字切词，`tokenize()` 对中文也按单字 + 二元组处理（见 `core/hash.js`）；两侧都用同一 `tokenize()` 输出做 OR，所以在同一批查询上结果集合可对齐。

### 4.3 `filter` 与 `limit`

- 服务层的调用是 `search(query, { limit: index.size, filter })` 再自行截断（见 `src/api/service.js:380`）。`SqliteIndex` 必须**先取足够多的候选再 filter**：`sqlLimit = filter ? max(limit, 200) : limit`，过滤后不足再回查一次（最多两趟），避免"过滤后为空"的假阴性。
- 得分并列时按 id 升序（与内存实现一致）。

## 5. 配置与接线

`config/policy.json` 增加：

```json
{
  "index": { "backend": "memory" }
}
```

- `backend`: `memory`（默认，行为与 v0.1.3 完全相同）| `sqlite`。
- `sqlite` 但当前 Node 无 `node:sqlite` 或 FTS5 不可用 → **启动即抛 `E_INDEX_UNAVAILABLE`**，附一句怎么修（升 Node / 换回 memory）。**不允许静默降级**：静默降级会让"我明明开了 sqlite 却慢"变成玄学。
- 构造点收敛到 `src/index/create-index.js` 的 `createIndex({policy, memoHome, scope, clock})`，`service.js` 只调它（这也顺便验证 IndexPort 是否真的只在一个点注入）。

## 6. 失败模式与防线

| 失败模式 | 症状 | 防线 |
|---|---|---|
| WAL 文件残留/损坏 | 打开即抛 | 捕获 `SQLITE_CORRUPT` → 删库重建 + 打 `index_rebuilt` 事件 |
| FTS 与 docs 不同步（进程被杀在事务中间） | 检索漏记录 | 所有写操作在单事务内（`docs` + 触发器）；`doctor` 比对 `docs` 行数与 `fts` 行数 |
| 索引比真相层旧 | 新写入的记录搜不到 | 写入路径 `add()` 与 `_records` 同临界区；`doctor` 的 `index_inconsistent` 已有 |
| 查询构造出错 | 语法错 / 结果集偏移 | `buildMatchExpr` 纯函数 + 单测覆盖注入字符 |
| Node 版本无 `node:sqlite` | 启动失败 | fail-loud + docs/06 排障表补一行 |

## 7. 测试与门禁

**单元测试** `tests/unit/sqlite-index.test.js`

1. `build` 后 `size` 正确；`add` 幂等（同 id 覆盖不增行）
2. `search` 中文命中、英文命中、无命中返回空
3. 注入字符（`"`、`*`、`OR`、`(`、`-`）不抛错且不外溢
4. `filter` 在打分后生效；`limit` 语义（undefined 不截断）
5. 无 id 记录 `add` 抛 `E_INVALID_RECORD`
6. `buildMatchExpr` 纯函数：中文/英文/混合/空串/特殊字符
7. 删库重建：删掉 `.sqlite` 后 `build` 能重建（等价于 `memo reindex`）

**注入用例 I16** `tests/injection/i16-index-parity.test.js`

- 同一份 12 条中文+英文记录，分别用 `InvertedIndex` 与 `SqliteIndex` 建索引；
- 对 8 条查询断言：两者的 **top-3 集合相等**（同分并列时允许不同但仍须互相包含）；
- 断言 `memo reindex` 后 sqlite 索引 `size` 等于真相层记录数；
- 断言 `index.backend=sqlite` 时 `search` 走的是 SQLite（用 `EXPLAIN` 或对 `.sqlite` 文件存在性断言即可）。

**门禁**：Q1（零依赖）、Q5（新导出登记到 docs/02）、Q2（文件行数）保持绿；覆盖率不降。

## 8. 回滚

`index.backend` 改回 `memory` 即回滚（一条配置）。索引目录随时可删。真相层不参与本改动，零数据风险。
