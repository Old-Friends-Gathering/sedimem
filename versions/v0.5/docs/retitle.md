# memo retitle

把没有 `title` 的旧记录回填成一句人能读的短标题（≤24 字符，超长截断加 `…`）：
subject 的下划线/连字符折成空格、去掉日期 slug（`20261103` / `2026-11-03`）、折成单行；已有 `title` 一律不动。

为什么不原地改：`items/<scope>.jsonl` 是 append-only 真相层，改字段只能追加一条同 id 的补丁行（`v+1`）；
原行永久保留，as-of 回查与审计都靠它——行数只增不减。

用法：`memo retitle --dry-run` 只统计并给最多 5 条样例，不写盘；`memo retitle` 逐条追加补丁行 + `op:"retitle"`
审计事件，返回 `{total, changed, failed, samples}`。回填走跨进程写锁且锁内增量重读，别人刚写的 title 不会被覆盖。
幂等：已有 title 直接跳过，再跑 `changed` 必为 0；`--limit N` 可分批。

回填后：web/图谱 label 优先显示 `title`（24 字内，不再被显示层截），不再挤 `subject/predicate` 长串；
brief 的正文行仍取 `text`，不受影响——title 是显示名，不是摘要。
