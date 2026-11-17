// tools/diagrams/i18n.mjs
// 示意图的英文词表：生成器先产出中文 HTML，再按最长匹配替换成英文。
// 为什么不用模板里逐句 t()：图多、句子长，词典集中在一处更好审；
// 生成器末尾调用 assertNoCjk()，漏译会直接构建失败，不会悄悄产出中英混排。

const DICT = {
  // ---------- 通用 ----------
  'sedimem v1.0': 'sedimem v1.4.0',
  'sedimem v1.0.1': 'sedimem v1.4.0',
  'v1.4.0 · 14 模块 · 0 运行时依赖': 'v1.4.0 · 14 modules · 0 runtime deps',
  '14 模块': '14 modules',
  '严格参数校验': 'strict argument validation',
  '只读 GET ×12 · 编辑走 token + If-Match': 'read-only GET ×12 · editing requires token + If-Match',
  '与 MCP 同一套 service 调用': 'same service calls as MCP',
  '¥/日': '¥/day',
  '客户端': 'Clients',

  // ---------- master-arch ----------
  '整系统架构：四个客户端 → 一个门面 → 一条真相链': 'Full architecture: four clients → one facade → one truth chain',
  '客户端 / 入口': 'Clients / entry points',
  '插件 dsh-sedimem · 侧边栏「记忆中心」· 每步注入（默认关）': 'dsh-sedimem plugin · Memory Center sidebar · injected per step (off by default)',
  'config.toml 配 stdio MCP': 'config.toml with stdio MCP',
  '浏览器 · 记忆中心': 'Browser · Memory Center',
  '九页只读为主；--write 才可编辑': 'Nine pages, read-only by default; --write to edit',
  '接口层（唯一缝）': 'Interface layer (the only seam)',
  '身份与分库': 'Identity & scopes',
  '常驻进程先 memory_scope 对齐': 'Long-lived clients align with memory_scope first',
  '12 个模块（依赖单向，core 在最底）': '14 modules (one-way deps, core at the bottom)',
  '写入 · hygiene': 'Write · hygiene',
  '四道门': 'four gates',
  '落盘前脱敏': 'redact before write',
  '去重/簇': 'dedupe / cluster',
  '裁决器': 'judge',
  '读取 · index / render': 'Read · index / render',
  '预注入': 'pre-inject',
  '组织 · views / capture': 'Organize · views / capture',
  '场景块': 'scene blocks',
  '画像': 'profile',
  '分歧视图': 'conflict view',
  '候选': 'candidates',
  '会话 · session': 'Session · session',
  '临时库': 'task store',
  '8 段': '8 sections',
  '读会话': 'read transcript',
  '交接文档': 'handoff doc',
  'LLM · llm（默认关）': 'LLM · llm (off by default)',
  '可插拔': 'pluggable',
  '出队': 'drain',
  '标题摘要': 'title / summary',
  '底座 · storage / core': 'Base · storage / core',
  '追加': 'append',
  '目录锁': 'dir lock',
  '不变式': 'invariants',
  '写入': 'WRITE',
  '读取': 'READ',
  '派生': 'DERIVE',
  '追加真相层': 'append to truth layer',
  'BM25 ± 语义': 'BM25 ± semantic',
  '写入即入队': 'enqueue on write',
  'LlmPort（可选）': 'LlmPort (optional)',
  '同步调用': 'sync call',
  '异步 / 可选': 'async / optional',
  '不可跨越的边界': 'uncrossable boundary',
  '真相层字节不变：派生只是旁路': 'Truth bytes never change: derivation is a side path',
  '数据层': 'Data layer',
  '真相层：只追加、永不原地改；as-of 可回查任意时点': 'Truth: append-only, never rewritten; as-of rewind at any time',
  '派生：FTS5 索引，删了重跑即重建': 'Derived: FTS5 index; delete and rebuild',
  '派生：L2 场景块 / L3 画像 / LLM 标题摘要': 'Derived: L2 scenes / L3 profile / LLM titles',
  '追加式审计流：每次写/命中/裁决一条': 'Append-only audit stream: one row per write / hit / verdict',
  '异步队列：LLM 派生待办 / 捕获候选待审': 'Async queues: LLM derive todo / capture candidates',
  '快照与交接文档': 'Snapshots & handoff docs',
  '外部 LLM（可选）': 'External LLM (optional)',
  'openai-compatible 端点；默认 provider=none，整层不存在': 'openai-compatible endpoint; default provider=none, the layer does not exist',
  '写入：A → B → C（四道门）→ D（追加一行）　·　读取：A → B → C（BM25 ± 语义 → RRF）→ D（只读）':
    'Write: A → B → C (four gates) → D (append one row)　·　Read: A → B → C (BM25 ± semantic → RRF) → D (read-only)',
  '边界：界面永不写真相层 · 派生层可随时删光重建 · LLM 失败只降级不阻塞':
    'Boundary: UI never writes truth · derived layers are disposable · LLM failure degrades, never blocks',
  'AI 会忘记你，它不会。': 'AI forgets you. It does not.',
  'AI 会忘记你，': 'AI forgets you. ',
  '它不会。': 'It does not.',
  '本地优先的个人记忆系统：真相层只追加、永不改写，索引/视图/派生全部可重建。DSH / Codex / Claude 三端共用同一个 MCP server。':
    'A local-first personal memory system: the truth layer is append-only, indexes/views/derived data are all rebuildable. DSH / Codex / Claude share one MCP server.',
  '0 运行时依赖': '0 runtime deps',
  '648 tests · I1–I50': '768 tests · I1–I56',
  'as-of 回查任意时点': 'as-of rewind',
  'MIT · 数据只在': 'MIT · data stays in',
  '运行时依赖': 'runtime deps',
  '数据只在': 'data stays in',
  '回查任意时点': 'rewind',

  // ---------- render: three layers ----------
  '三层单向：真相 → 派生 → 界面': 'Three layers, one direction: truth → derived → UI',
  '改任何一层都不用动它下面那层': 'Change any layer without touching the one below',
  '真相层': 'Truth layer',
  '每次写入追加一行，永不原地改。supersede 也只是追加一条新版本 + 老记录打 validTo。':
    'Every write appends a row, never rewrites. Supersede appends a new version and stamps validTo on the old one.',
  '契约（不可越界）': 'Contract (uncrossable)',
  '真相层 = 唯一事实来源 · 派生层可随时删光重建 · 界面永不写真相层':
    'Truth = single source of facts · derived layers are disposable · UI never writes truth',
  '派生层': 'Derived layer',
  '可重建': 'rebuildable',
  'FTS5 索引 · L2 场景块 · L3 画像 · LLM 标题摘要 · brief。删掉重跑即字节可复现。':
    'FTS5 index · L2 scenes · L3 profile · LLM titles · brief. Delete and rebuild byte-for-byte.',
  '可选：LLM 派生': 'Optional: LLM derivation',
  '默认关': 'off by default',
  '写 → outbox → LlmPort → derived sidecar。真相层字节不变，LLM 挂了只降级不阻塞写入。':
    'Write → outbox → LlmPort → derived sidecar. Truth bytes unchanged; LLM failure degrades without blocking writes.',
  '界面层': 'UI layer',
  '记忆中心九页（浏览器）· MCP 10+5 工具（DSH / Codex / Claude）· CLI':
    'Memory Center (9 pages) · MCP 17 tools (DSH / Codex / Claude) · CLI',
  '读路径': 'Read path',
  '每条结果带': 'Every hit carries',
  '；语义道不可用时显式': '; when the semantic lane is unavailable, an explicit',
  '，不装成功。': ', never a fake success.',
  '14 个模块 · 依赖单向': '14 modules · one-way deps',
  '依赖方向：api → hygiene/index/views/llm → storage → core；ui 不 import 任何 src/':
    'Deps: api → hygiene/index/views/llm → storage → core; ui imports nothing from src/',

  // ---------- render: write ----------
  '写入四道门：越往后越贵': 'Four write gates: each step costs more',
  '便宜的门先拦掉 90% 垃圾，贵的那道只在必要时出手': 'Cheap gates stop 90% of junk first; expensive ones act only when needed',
  '形状校验': 'shape validation',
  '脱敏': 'redact',
  '密钥 / 内网域名 / 私有路径 落盘前改成 [REDACTED:x]': 'secrets / internal hosts / private paths become [REDACTED:x] before write',
  '去重': 'dedupe',
  'contentHash → 实体键 → 二进制组 Dice（0.15 召回 / 0.85 判重）':
    'contentHash → entity key → bigram Dice (0.15 recall / 0.85 duplicate)',
  '冲突裁决': 'conflict verdict',
  '同 slot 值冲突 → disputed，或交给正在跑的 Agent 裁决': 'Same-slot conflict → disputed, or let the running agent decide',
  '仅在候选上跑': 'candidates only',
  '追加一行真相层': 'Append one truth row',
  '写完立刻可被检索。同时可选入 LLM 派生出队（默认关）。': 'Searchable immediately; optionally queued for LLM derivation (off by default).',
  '返回给人看的语义': 'Human-readable outcomes',
  '永远不做的三件事': 'Three things we never do',
  '原地改旧行 · 静默丢弃 · 把 LLM 结果写回真相层': 'Rewrite old rows · silently drop · write LLM output back to truth',
  '这些门被测到什么程度': 'How well these gates are tested',
  'I2 同值重复': 'I2 same-value duplicate',
  'I7 换措辞近重复': 'I7 paraphrase near-duplicate',
  'I8 10 进程并发': 'I8 10-process concurrency',
  'I13 投毒 10 变体': 'I13 10 poison variants',
  'I26 落盘前脱敏': 'I26 redact before write',
  'I27 冲突裁决': 'I27 conflict verdict',
  'I28 候选不直写': 'I28 candidates never auto-write',
  'I36 注入租界/预算': 'I36 injection fence / budget',
  'I45 任务 LLM 抽取': 'I45 task LLM extraction',
  'I1–I50 注入式评测：每条断言都能在 tests/injection/ 里找到同名用例':
    'I1–I56 injection eval: every assertion has a same-name case under tests/injection/',

  // ---------- render: llm ----------
  'LLM 只写派生层：真相层字节不变': 'LLM writes only derived layers: truth bytes unchanged',
  '默认关闭；开就是三行命令，关掉一切照旧': 'Off by default; enable with three commands, disable and nothing changes',
  '写入成功即返回，不等 LLM': 'Return on write; never wait for the LLM',
  '三个触发点': 'Three triggers',
  '空闲 30s': '30s idle',
  'nightly 兜底': 'nightly fallback',
  '可插拔': 'pluggable',
  '预算 ¥/日、超时、缓存、并发锁；': 'Daily budget, timeout, cache, concurrency lock;',
  '时整层不存在': 'means the layer does not exist',
  '只读投影，不进检索排序键。': 'Read-only projection; never a ranking key.',
  '读者看到的变化': 'What readers see',
  'brief / 图谱标签 / 搜索结果改用 LLM 标题，而不是「subject·predicate」拼接':
    'brief / graph labels / search use LLM titles instead of subject·predicate joins',
  '失败一律降级': 'Failures always degrade',
  '超时/额度/输出不可解析 → 记': 'Timeout / quota / unparsable output → record',
  '，标题回落原文，写入链路零影响': ', title falls back to source text; writes are unaffected',
  '成本量级': 'Cost scale',
  '33 条记忆全量重建 ≈ 1 分 50 秒、< ¥0.02（GLM-5.3-Flash）':
    'Full rebuild of 33 memories ≈ 1m50s, < ¥0.02 (GLM-5.3-Flash)',
  '三步开启': 'Enable in three steps',
  '写 key 到 ~/.config/sedimem/llm-key（chmod 600）': 'Write key to ~/.config/sedimem/llm-key (chmod 600)',
  'policy.llm.thinking 默认 disabled：GLM-4.5+ 的思考链会吃掉 max_tokens，content 变成空串（v1.0.1 修）':
    'policy.llm.thinking defaults to disabled: GLM-4.5+ reasoning eats max_tokens and returns empty content (fixed in v1.0.1)',

  // ---------- render: task store ----------
  '任务库：一个任务一条临时记忆': 'Task store: one temporary memory per task',
  '按任务分库（不按会话）· close 时只晋升值得留的，其余丢弃':
    'One store per task (not per chat) · close promotes only what is worth keeping',
  '按任务建库；': 'Create per task; ',
  '（任务过程不该沉淀世界事实）': ' (task process is not a world fact)',
  '8 段：intent / concepts / files / errorsAndFixes / pendingJobs / currentState / nextSteps / criticalContext':
    '8 sections: intent / concepts / files / errorsAndFixes / pendingJobs / currentState / nextSteps / criticalContext',
  '白名单晋升 → 其余 tombstone → 写交接文档': 'Whitelist promotion → tombstone the rest → write handoff doc',
  '晋升到主库': 'Promoted to main store',
  '打': 'Stamp',
  '标签，可追溯来源': 'tag for provenance',
  '六段：目标 / 做完了什么 / 卡在哪 / 下一步 / 关键文件 / 约束':
    'Six sections: goal / done / blocked / next / key files / constraints',
  '自动收尾': 'Auto cleanup',
  '扫僵尸任务（>14 天未关），只报告不自动删': 'sweep stale tasks (>14 days open); report only, never auto-delete',
  '可选用 LLM 压缩': 'Optional LLM compression',
  '读任务 transcript 抽 8 段；无 key 时自动回落规则抽取':
    'Read the task transcript and extract 8 sections; fall back to rules without a key',
  '五条命令': 'Five commands',
  'DSH / Codex / Claude 三端共用：临时库仍是同一个 MCP server':
    'Shared by DSH / Codex / Claude: the task store is still one MCP server',

  // ---------- render: read ----------
  '检索：永远有词法兜底，语义道是加分项': 'Retrieval: lexical always works; semantics is a bonus',
  '两路结果用 RRF 融合，每条都标注来源': 'Two lanes fused with RRF; every hit is labelled',
  'normalizeText（NFKC / 零宽 / CJK 空格）→ tokenize（汉字单字 + 英文词）':
    'normalizeText (NFKC / zero-width / CJK spaces) → tokenize (CJK unigrams + words)',
  '词法 BM25': 'Lexical BM25',
  'SQLite FTS5（默认）或内存倒排；单字切分对中文改写更稳': 'SQLite FTS5 (default) or in-memory inverted index; unigrams are more stable for Chinese rewrites',
  '语义（可选）': 'Semantic (optional)',
  'EmbedderPort + 向量 sidecar；未配就是': 'EmbedderPort + vector sidecar; unset means',
  'RRF 融合': 'RRF fusion',
  '不归一化 BM25 与余弦，避免两套分布互相污染': 'Never normalize BM25 with cosine; keep the two distributions separate',
  '每条结果都带出处': 'Every hit carries its basis',
  '读路径的三条纪律': 'Three read-path rules',
  '过期记录过滤（validTo）· suspicious 原文默认遮蔽（要': 'Filter expired rows (validTo) · mask suspicious text unless',
  '返回': 'return',
  '而不是静默降级': 'instead of silent degradation',
  '规模事实': 'Scale facts',
  '10k 条：search p95 85ms → 超过这个量必须切 FTS5 后端；50k/100k 基准在':
    '10k rows: search p95 85ms → beyond this, switch to the FTS5 backend; 50k/100k benchmarks in',
  '三个阈值，各有实测依据': 'Three thresholds, each measured',
  '在线近重复（宁漏不误杀）': 'online near-duplicate (prefer misses)',
  '候选扫描 containment（宁多不漏）': 'candidate scan containment (prefer recall)',
  '汉字二元组 Dice（无关中文误聚 1.4%）': 'CJK bigram Dice (1.4% false merge on unrelated text)',
  'RRF 平滑常数': 'RRF smoothing constant',
  '英文只用 containment：全字符二元组在英文无关句对上误聚 13.7%（实测 780 对）':
    'English uses containment only: character bigrams false-merge 13.7% on unrelated English pairs (780 pairs measured)',

  // ---------- render: gates ----------
  '五层门禁：自己会腐化，所以让机器盯着': 'Five gate layers: they rot, so machines watch them',
  '本地脚本 = CI 脚本，改阈值必须先改契约': 'Local scripts = CI scripts; change a threshold only by changing the contract',
  '质量 14 项': '15 quality checks',
  'Q1 零依赖 · Q2 规模 · Q3 测试清单 · Q4 评测对齐 · Q5 契约覆盖 · Q6 链接 · Q7 版本自包含 · Q8 编码 · Q9 Web 边界 · Q10 发布面 · Q11 写侧与任务库 · Q13 vendor · Q14 文档治理 · Q15 LLM 契约':
    'Q1 zero deps · Q2 scale · Q3 test list · Q4 eval alignment · Q5 contract coverage · Q6 links · Q7 version self-containment · Q8 encoding · Q9 web boundary · Q10 release surface · Q11 write path & task store · Q13 vendor · Q14 doc governance · Q15 LLM contract',
  '安全 9 项': '9 security checks',
  '无个人路径 · 无凭据/私钥 · 无内网域名 · 模板不含 home · .gitignore 覆盖 · LICENSE · 无超大文件 · 历史面轻扫 · 运行时回环断言':
    'No personal paths · no credentials/keys · no internal hosts · templates have no home · .gitignore covers · LICENSE · no oversized files · light history scan · loopback runtime assertion',
  '覆盖率门禁': 'Coverage gate',
  'lines ≥ 89% · functions ≥ 90% · branches ≥ 77%（低于阈值直接 fail，不看人）':
    'lines ≥ 85% · functions ≥ 90% · branches ≥ 70% (fail below, no exceptions)',
  '文档里的命令/路径/版本必须能被脚本验证存在，防「文档漂移」':
    'Commands / paths / versions in docs must be script-verifiable, preventing doc drift',
  '合并后校验线上项目站版本号已更新；不通过就是发布面漏了':
    'After merge, verify the live site version; failure means the release surface was missed',
  'CI 上的 12 个 job': 'CI jobs',
  'required checks 全绿 + strict 才允许合并；管理员也绕不过':
    'All required checks green + strict before merge; admins cannot bypass',
  '记忆中心九页（浏览器）· MCP 17 工具（DSH / Codex / Claude）· CLI': 'Memory Center (9 pages) · 17 MCP tools (DSH / Codex / Claude) · CLI',
  'BM25 → 可选语义 → RRF': 'BM25 → optional semantic → RRF',
  '基础类型/文本归一': 'types / text normalization',
  'JSONL+锁': 'JSONL + lock',
  'BM25/向量/RRF': 'BM25 / vector / RRF',
  'four gates+裁决': 'four gates + verdict',
  'brief/tier0/注入': 'brief / tier0 / inject',
  'L2 场景块/L3 画像': 'L2 scenes / L3 profile',
  'task store/交接': 'task store / handoff',
  'candidates队列': 'candidates queue',
  'port/outbox/派生': 'port / outbox / derive',
  '17 工具': '17 tools',
  '九页+只读 API': 'nine pages + read-only API',
  '命令面': 'command surface',
  '四道门+裁决': 'four gates + verdict',
  '临时库/交接': 'task store / handoff',
  '候选队列': 'candidates queue',
  '0 成本': 'zero cost',
  '时间戳': 'timestamp',
  '微秒级': 'microseconds',
  '注入式评测：每条断言都能在 tests/injection/ 里找到同名用例': 'injection eval: every assertion has a same-name case under tests/injection/',
  '里找到同名用例': 'has a same-name case under tests/injection/',
  'outbox，可死信重放': 'outbox, dead-letter replay',
  '本地端点': 'local endpoint',
  'title ≤40 字 · summary ≤80 字 · tags ≤5。': 'title ≤40 chars · summary ≤80 chars · tags ≤5.',
  '33 条记忆全量重建 ≈ 1 分 50 秒、< ¥0.02（GLM-5.3-Flash）': 'Full rebuild of 33 memories ≈ 1m50s, < ¥0.02 (GLM-5.3-Flash)',
  '条记忆全量重建 ≈ 1 分 50 秒': 'memories fully rebuilt in ≈ 1m50s',
  '禁写 fact': 'facts forbidden',
  '质量 15 项': '15 quality checks',
  '（低于阈值直接 fail，不看人）': ' (fail below, no exceptions)',
  'CI 上的 11 个 job': 'CI jobs',
};

const CJK = /[\u4e00-\u9fff]/;

const keys = Object.keys(DICT).sort((a, b) => b.length - a.length);
let cache = null;

export function dictFor(lang) {
  if (lang !== 'en') return null;
  if (!cache) cache = keys.map((k) => [k, DICT[k]]);
  return cache;
}

export function translateHtml(html, lang = 'zh') {
  if (lang !== 'en') return html;
  let out = html.replace(/<!--[\s\S]*?-->/g, '');
  for (const [zh, en] of dictFor(lang)) {
    if (out.includes(zh)) out = out.split(zh).join(en);
  }
  return out;
}

export function assertNoCjk(text, label = 'diagram') {
  const re = new RegExp(`.{0,30}${CJK.source}.{0,30}`, 'gu');
  const found = [...text.matchAll(re)].map((m) => m[0].trim());
  const uniq = [...new Set(found)];
  if (uniq.length) {
    throw new Error(`[${label}] ${uniq.length} untranslated CJK fragment(s):\n` + uniq.map((x) => `  ${JSON.stringify(x)}`).join('\n'));
  }
}
