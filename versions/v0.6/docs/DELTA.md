# v0.6 · 版本说明（DELTA）

本版把三条用户抱怨落地：**记忆点更明确**（写侧粒度契约）、**开发临时记忆库**（session scope）、**切页不丢分库**（UI 分库粘性）。施工图 `docs/plans/v0.6-memory-quality-and-session.md`；契约裁决 71–76 见 `docs/02` §3.17。

## 本版做了什么

1. **写侧粒度契约（方向 A）**：`policy.write` 段（`textHardMaxChars=4000` 硬报错 /
   `valueRecommendChars=300` 软警告 + `splitSuggestion` / `titleRequiredKinds` /
   `titleEnforce` 默认 false）。超硬上限从「静默截断」改为 `E_INVALID_RECORD` 报错；
   brief 渲染结构化记录优先 `title`，长文记录只出一行。
2. **会话临时记忆库（方向 B）**：`session:<id>` scope + `memo session
   start|checkpoint|status|close|sweep` 五命令 + MCP `memory_session_*` 五工具；
   8 段 checkpoint 模板冻结；`--from-summary` 直接吃 DSH `compaction/summary` 事件；
   close 只晋升 `decision`/`gotcha` 回主库（带 `from-session:<id>` 标签），
   `nextSteps` 写成 handoff state，交接文档落 `<memoHome>/handoffs/<id>.md`，重复 close 幂等。
3. **UI 分库粘性（方向 C）**：`ui/scope.js` 的 `resolveScope()`（hash > localStorage >
   服务端默认 > 首个可用，四级回落）与 `hrefFor()` 统一出口；选中分库持久化在
   `localStorage['sedimem.scope']`，切 tab / 搜索 / 图谱跳转不再丢库。
4. **数学三条（零新依赖）**：nightly 的 `calibrateDecay()`（生存分析估 halfLife，只报告不改
   policy）、checkpoint 提示的滞回双阈值（enter 0.8 / exit 0.6）、brief/checkpoint 字符数进 metrics。
5. **门禁与评测**：Q11「写侧粒度与会话库契约」；eval 增 I37–I40（共 40 个注入用例）；
   Q2 总量上限 12000 → 13000（session 模块）；447 tests / 11 门禁 / 安全 9/9 全绿。

## 刻意不做

1. **不自动触发**：不自动建库、不自动压缩、不自动 close——会话库的价值是「我知道自己在做什么」，
   自动化的边界只到「提示」（`session.hintTokens` 默认 30000，只提示不动作）。
2. **不接 LLM / embedding**：裁决仍走确定性规则；语义道维持 v0.4 起的可选关闭状态，
   成本调研已备（`docs/research/llm-cost-optimal-2026.md`），留 v0.7 按需开启。
3. **不做跨机同步**：`session:<id>` 库只在本地 `MEMO_HOME`；跨设备一致性是新需求，先提 issue。
4. **不做自动总结**：checkpoint 由 agent 或人填，`parseDshSummary` 只抽草稿、缺字段留空、不编造。

## 与最初认知的差异

1. **读侧早就够了，短板在写侧**：调研（`memory-brevity-2026.md`）发现三级披露 / 分层注入这些
   读侧机制已对齐竞品，真正缺的是「一条记录 = 一个可判断的事实」的写侧纪律——所以本版重心从
   「怎么读得更好」转到「怎么写得粒度对」。
2. **临时库必须禁 fact**：最初设计 session 库只是「另一个可写的库」；实际不定禁令的话，agent 会把
   长期事实写进临时库，close 时全部 tombstone——临时库会变成第二个（更差的）主库。
   `E_SCRATCH_KIND_FORBIDDEN` 是本版最重要的一个错误码。
3. **分库是全局状态，不是页面参数**：切页丢库的根因不是「忘了带 `?scope=`」，而是把分库当成
   URL 参数——正确模型是全局状态 + URL 只做显式覆盖，所以解法是 `resolveScope` 四级回落 +
   localStorage 粘性，而不是在每处跳转补参数。

## v0.6.1 – v0.7 入口

- `titleEnforce` 观察期数据：`E_TITLE_MISSING` 警告的实际发生率（nightly metrics）决定何时默认开启；
- CLAUDE.md / AGENTS.md 导入器（迁移成本是采纳门槛里最便宜能拆的一堵墙）；
- 会话库的 UI 投影：观察台按 `session:` 前缀分组展示 + handoff 文档入口；
- 语义道回填进 nightly、注入可解释性（注入了哪些记录写进 events）——见 `docs/plans/v0.7-ui-and-ecosystem.md`。
