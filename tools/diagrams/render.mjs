// tools/diagrams/render.mjs
// 生成 README / 项目站用的示意图（PNG）。
//
// 为什么自建而不用 mermaid：GitHub 的 mermaid 主题不可控、中文换行难看、宽度固定，
// 而项目站的 CSP 是 'self'（不能引 CDN 的 mermaid）。这里用「HTML + CSS 排版 → 无头 Chrome 截图」，
// 一套样式产出所有图，颜色与产品 UI 同源（accent #4d6bfe）。
//
// 用法：node tools/diagrams/render.mjs [--only arch]
// 输出：docs/shots/diagrams/<name>.png

import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const OUT = path.join(REPO, 'docs/shots/diagrams');
const CHROME = process.env.CHROME_PATH
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const CSS = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    width: 1600px; height: 560px; padding: 30px 48px;
    background: radial-gradient(1200px 600px at 15% -10%, #17213a 0%, #0b1020 55%, #080c17 100%);
    color: #e8edff; font-family: "PingFang SC", "Noto Sans CJK SC", -apple-system, sans-serif;
    display: flex; flex-direction: column; gap: 22px; overflow: hidden;
  }
  .head { display: flex; align-items: baseline; gap: 14px; }
  .eyebrow { font-size: 13px; letter-spacing: .22em; color: #4d6bfe; font-weight: 700; }
  h1 { font-size: 34px; letter-spacing: -.5px; }
  .sub { font-size: 15px; color: #8e9bbd; margin-left: auto; }
  .stage { flex: 0 0 auto; display: flex; gap: 18px; align-items: flex-start; min-height: 0; }
  .col { flex: 1; display: flex; flex-direction: column; gap: 12px; min-height: 0; }
  .card {
    background: #141a2c; border: 1px solid #263149; border-radius: 14px; padding: 14px 16px;
    display: flex; flex-direction: column; gap: 6px; min-height: 0;
  }
  .card.hl { border-color: #4d6bfe; box-shadow: 0 0 0 1px rgba(77,107,254,.35), 0 8px 30px rgba(77,107,254,.12); }
  .card.warn { border-color: #d98a4b; }
  .card.ok { border-color: #3fa96b; }
  .t { font-size: 16px; font-weight: 650; display: flex; align-items: center; gap: 8px; }
  .mono { font-family: "SF Mono", ui-monospace, monospace; font-size: 12.5px; color: #9fb0d9; }
  .d { font-size: 13px; color: #92a0c4; line-height: 1.5; }
  .tag { font-size: 11.5px; padding: 2px 8px; border-radius: 999px; background: #1d2740; color: #a9b8de; border: 1px solid #2b3752; }
  .tag.b { background: rgba(77,107,254,.16); border-color: rgba(77,107,254,.5); color: #a8b6ff; }
  .tag.g { background: rgba(63,169,107,.14); border-color: rgba(63,169,107,.45); color: #8fe0ae; }
  .tag.o { background: rgba(217,138,75,.14); border-color: rgba(217,138,75,.45); color: #f0bd8a; }
  .arrow { align-self: center; color: #4d6bfe; font-size: 22px; padding: 0 2px; }
  body { justify-content: flex-start; }
  .row { display: flex; gap: 12px; align-items: stretch; }
  .row > * { flex: 1; }
  .pill { display: inline-flex; gap: 8px; flex-wrap: wrap; }
  .num { font-size: 30px; font-weight: 700; color: #a8b6ff; }
  .foot { font-size: 12.5px; color: #6b7899; display: flex; gap: 16px; }
  .flowline { display: flex; align-items: center; gap: 10px; flex-wrap: nowrap; }
  .band { margin-top: 22px; display: flex; flex-direction: column; gap: 12px; }
  .chips { display: flex; flex-wrap: wrap; gap: 8px; }
  .chips .chip {
    font-size: 12.5px; padding: 6px 12px; border-radius: 9px; color: #b9c6e8;
    background: #131a2b; border: 1px solid #24304a;
  }
  .chips .chip b { color: #e8edff; font-weight: 600; }
  .band .label { font-size: 12px; letter-spacing: .18em; color: #4d6bfe; font-weight: 700; }
`;

const P = (body) => `<!doctype html><meta charset="utf-8"><style>${CSS}</style><body>${body}</body>`;

const head = (eyebrow, title, sub) => `
  <div class="head">
    <span class="eyebrow">${eyebrow}</span><h1>${title}</h1><span class="sub">${sub}</span>
  </div>`;

const foot = (left, right) => `<div class="foot"><span>${left}</span><span style="margin-left:auto">${right}</span></div>`;

const DIAGRAMS = {
  arch: () => P(`
    ${head('ARCHITECTURE', '三层单向：真相 → 派生 → 界面', '改任何一层都不用动它下面那层')}
    <div class="stage">
      <div class="col">
        <div class="card hl">
          <div class="t">① 真相层 <span class="tag b">append-only</span></div>
          <div class="mono">~/.memo/items/&lt;scope&gt;.jsonl</div>
          <div class="d">每次写入追加一行，永不原地改。supersede 也只是追加一条新版本 + 老记录打 validTo。</div>
        </div>
        <div class="card">
          <div class="t">契约（不可越界）</div>
          <div class="d">真相层 = 唯一事实来源 · 派生层可随时删光重建 · 界面永不写真相层</div>
        </div>
      </div>
      <div class="arrow">→</div>
      <div class="col">
        <div class="card">
          <div class="t">② 派生层 <span class="tag o">可重建</span></div>
          <div class="mono">index/ · views/ · derived/ · events.jsonl</div>
          <div class="d">FTS5 索引 · L2 场景块 · L3 画像 · LLM 标题摘要 · brief。删掉重跑即字节可复现。</div>
        </div>
        <div class="card ok">
          <div class="t">可选：LLM 派生 <span class="tag g">默认关</span></div>
          <div class="d">写 → outbox → LlmPort → derived sidecar。真相层字节不变，LLM 挂了只降级不阻塞写入。</div>
        </div>
      </div>
      <div class="arrow">→</div>
      <div class="col">
        <div class="card">
          <div class="t">③ 界面层</div>
          <div class="d">记忆中心九页（浏览器）· MCP 10+5 工具（DSH / Codex / Claude）· CLI</div>
        </div>
        <div class="card">
          <div class="t">读路径 <span class="tag">BM25 → 可选语义 → RRF</span></div>
          <div class="d">每条结果带 <span class="mono">basis</span>；语义道不可用时显式 <span class="mono">degraded</span>，不装成功。</div>
        </div>
      </div>
    </div>
    <div class="band">
      <div class="label">12 个模块 · 依赖单向</div>
      <div class="chips">
        ${['core 基础类型/文本归一', 'storage JSONL+锁', 'index BM25/向量/RRF', 'hygiene 四道门+裁决',
           'render brief/tier0/注入', 'views L2 场景块/L3 画像', 'session 临时库/交接', 'capture 候选队列',
           'llm port/outbox/派生', 'mcp 10+5 工具', 'web 九页+只读 API', 'cli 命令面']
          .map((x) => `<span class="chip"><b>${x.split(' ')[0]}</b> ${x.split(' ').slice(1).join(' ')}</span>`).join('')}
      </div>
    </div>
    ${foot('依赖方向：api → hygiene/index/views/llm → storage → core；ui 不 import 任何 src/', 'sedimem v1.0')}
  `),

  write: () => P(`
    ${head('WRITE PATH', '写入四道门：越往后越贵', '便宜的门先拦掉 90% 垃圾，贵的那道只在必要时出手')}
    <div class="stage">
      <div class="col">
        ${[
          ['① schema', 'kind/agent/时间戳 形状校验', '0 成本', 'tag'],
          ['② 脱敏', '密钥 / 内网域名 / 私有路径 落盘前改成 [REDACTED:x]', '0 成本', 'tag'],
          ['③ 去重', 'contentHash → 实体键 → 二进制组 Dice（0.15 召回 / 0.85 判重）', '微秒级', 'tag'],
          ['④ 冲突裁决', '同 slot 值冲突 → disputed，或交给正在跑的 Agent 裁决', '仅在候选上跑', 'tag o'],
        ].map(([t, d, cost, cls]) => `
          <div class="card"><div class="t">${t} <span class="${cls}">${cost}</span></div><div class="d">${d}</div></div>
        `).join('')}
      </div>
      <div class="arrow">→</div>
      <div class="col">
        <div class="card hl">
          <div class="t">追加一行真相层</div>
          <div class="mono">items/&lt;scope&gt;.jsonl ← {id, kind, text, validFrom, status:"active"}</div>
          <div class="d">写完立刻可被检索。同时可选入 LLM 派生出队（默认关）。</div>
        </div>
        <div class="card">
          <div class="t">返回给人看的语义</div>
          <div class="d pill">
            <span class="tag g">created</span><span class="tag">noop_same_value</span>
            <span class="tag">superseded</span><span class="tag o">disputed</span>
            <span class="tag b">near_duplicate</span>
          </div>
        </div>
        <div class="card">
          <div class="t">永远不做的三件事</div>
          <div class="d">原地改旧行 · 静默丢弃 · 把 LLM 结果写回真相层</div>
        </div>
      </div>
    </div>
    <div class="band">
      <div class="label">这些门被测到什么程度</div>
      <div class="chips">
        ${['I2 同值重复', 'I7 换措辞近重复', 'I8 10 进程并发', 'I13 投毒 10 变体',
           'I26 落盘前脱敏', 'I27 冲突裁决', 'I28 候选不直写', 'I36 注入租界/预算', 'I45 会话 LLM 抽取']
          .map((x) => `<span class="chip">${x}</span>`).join('')}
      </div>
    </div>
    ${foot('I1–I50 注入式评测：每条断言都能在 tests/injection/ 里找到同名用例', 'sedimem v1.0')}
  `),

  llm: () => P(`
    ${head('LLM LAYER', 'LLM 只写派生层：真相层字节不变', '默认关闭；开就是三行命令，关掉一切照旧')}
    <div class="stage">
      <div class="col" style="flex:1.15">
        <div class="card"><div class="t">memo write</div><div class="d">写入成功即返回，不等 LLM</div></div>
        <div class="arrow" style="align-self:flex-start;padding-left:18px">↓</div>
        <div class="card"><div class="t">derive-queue <span class="tag">outbox，可死信重放</span></div><div class="mono">$MEMO_HOME/derive-queue/&lt;scope&gt;.jsonl</div><div class="d">三个触发点：<span class="mono">memo derive --drain</span> · MCP 空闲 30s · nightly 兜底</div></div>
        <div class="arrow" style="align-self:flex-start;padding-left:18px">↓</div>
        <div class="card hl"><div class="t">LlmPort（可插拔）</div><div class="d">openai-compatible / 本地端点；预算 ¥/日、超时、缓存、并发锁；<span class="mono">provider:none</span> 时整层不存在</div></div>
      </div>
      <div class="arrow">→</div>
      <div class="col">
        <div class="card ok"><div class="t">derived sidecar</div><div class="mono">derived/&lt;scope&gt;.jsonl</div><div class="d">title ≤40 字 · summary ≤80 字 · tags ≤5。只读投影，不进检索排序键。</div></div>
        <div class="card"><div class="t">读者看到的变化</div><div class="d">brief / 图谱标签 / 搜索结果改用 LLM 标题，而不是「subject·predicate」拼接</div></div>
        <div class="card warn"><div class="t">失败一律降级</div><div class="d">超时/额度/输出不可解析 → 记 <span class="mono">deriveStatus:failed</span>，标题回落原文，写入链路零影响</div></div>
        <div class="card"><div class="t">成本量级</div><div class="d">33 条记忆全量重建 ≈ 1 分 50 秒、&lt; ¥0.02（GLM-5.3-Flash）</div></div>
      </div>
    </div>
    <div class="band">
      <div class="label">三步开启</div>
      <div class="chips">
        <span class="chip"><b>1</b> 写 key 到 ~/.config/sedimem/llm-key（chmod 600）</span>
        <span class="chip"><b>2</b> export MEMO_LLM_PROVIDER=openai-compatible</span>
        <span class="chip"><b>3</b> memo llm test &amp;&amp; memo derive --rebuild</span>
      </div>
    </div>
    ${foot('policy.llm.thinking 默认 disabled：GLM-4.5+ 的思考链会吃掉 max_tokens，content 变成空串（v1.0.1 修）', 'sedimem v1.0.1')}
  `),

  session: () => P(`
    ${head('SESSION MEMORY', '会话临时库：给一次任务用的一次性记忆', 'close 时把「值得留的」晋升进主库，其余随库丢弃')}
    <div class="stage">
      <div class="col">
        <div class="card"><div class="t">memo session start</div><div class="mono">scope = session:20261114-1030-ab12</div><div class="d">独立分库；<b>禁写 fact</b>（临时库不该沉淀世界事实）</div></div>
        <div class="arrow" style="align-self:flex-start;padding-left:18px">↓</div>
        <div class="card"><div class="t">checkpoint ×N</div><div class="d">8 段：intent / concepts / files / errorsAndFixes / pendingJobs / currentState / nextSteps / criticalContext</div></div>
        <div class="arrow" style="align-self:flex-start;padding-left:18px">↓</div>
        <div class="card hl"><div class="t">memo session close</div><div class="d">白名单晋升 → 其余 tombstone → 写交接文档</div></div>
      </div>
      <div class="arrow">→</div>
      <div class="col">
        <div class="card ok"><div class="t">晋升到主库</div><div class="d pill"><span class="tag g">decision</span><span class="tag g">gotcha</span></div><div class="d">打 <span class="mono">from-session:&lt;id&gt;</span> 标签，可追溯来源</div></div>
        <div class="card"><div class="t">交接文档</div><div class="mono">docs/handoffs/&lt;id&gt;.md</div><div class="d">六段：目标 / 做完了什么 / 卡在哪 / 下一步 / 关键文件 / 约束</div></div>
        <div class="card"><div class="t">自动收尾</div><div class="d"><span class="mono">memo session sweep</span> 扫僵尸会话（>14 天未关），只报告不自动删</div></div>
        <div class="card"><div class="t">可选用 LLM 压缩</div><div class="d"><span class="mono">--auto --llm</span>：读会话 transcript 抽 8 段；无 key 时自动回落规则抽取</div></div>
      </div>
    </div>
    <div class="band">
      <div class="label">五条命令</div>
      <div class="chips">
        ${['memo session start', 'memo session checkpoint --auto --llm', 'memo session status',
           'memo session close --compress', 'memo session sweep'].map((c) => `<span class="chip"><b class="mono">${c}</b></span>`).join('')}
      </div>
    </div>
    ${foot('DSH / Codex / Claude 三端共用：临时库仍是同一个 MCP server', 'sedimem v1.0')}
  `),

  read: () => P(`
    ${head('READ PATH', '检索：永远有词法兜底，语义道是加分项', '两路结果用 RRF 融合，每条都标注来源')}
    <div class="stage">
      <div class="col" style="flex:1.1">
        <div class="card"><div class="t">query</div><div class="d">normalizeText（NFKC / 零宽 / CJK 空格）→ tokenize（汉字单字 + 英文词）</div></div>
        <div class="arrow" style="align-self:flex-start;padding-left:18px">↓</div>
        <div class="row">
          <div class="card"><div class="t">词法 BM25</div><div class="d">SQLite FTS5（默认）或内存倒排；单字切分对中文改写更稳</div></div>
          <div class="card"><div class="t">语义（可选）</div><div class="d">EmbedderPort + 向量 sidecar；未配就是 <span class="mono">degraded:true</span></div></div>
        </div>
        <div class="arrow" style="align-self:flex-start;padding-left:18px">↓</div>
        <div class="card hl"><div class="t">RRF 融合 <span class="tag b">k = 60</span></div><div class="d">score = Σ 1/(k + rank)；不归一化 BM25 与余弦，避免两套分布互相污染</div></div>
      </div>
      <div class="arrow">→</div>
      <div class="col">
        <div class="card"><div class="t">每条结果都带出处</div><div class="d pill"><span class="tag">basis=bm25</span><span class="tag">basis=vector</span><span class="tag b">basis=bm25+vector</span></div></div>
        <div class="card"><div class="t">读路径的三条纪律</div><div class="d">过期记录过滤（validTo）· suspicious 原文默认遮蔽（要 <span class="mono">includeSuspicious</span>）· 返回 <span class="mono">degradedReason</span> 而不是静默降级</div></div>
        <div class="card"><div class="t">规模事实</div><div class="d">10k 条：search p95 85ms → 超过这个量必须切 FTS5 后端；50k/100k 基准在 <span class="mono">eval/bench-scale.mjs</span></div></div>
      </div>
    </div>
    <div class="band">
      <div class="label">三个阈值，各有实测依据</div>
      <div class="chips">
        <span class="chip"><b>0.85</b> 在线近重复（宁漏不误杀）</span>
        <span class="chip"><b>0.45</b> 候选扫描 containment（宁多不漏）</span>
        <span class="chip"><b>0.15</b> 汉字二元组 Dice（无关中文误聚 1.4%）</span>
        <span class="chip"><b>k=60</b> RRF 平滑常数</span>
      </div>
    </div>
    ${foot('英文只用 containment：全字符二元组在英文无关句对上误聚 13.7%（实测 780 对）', 'sedimem v1.0')}
  `),

  gates: () => P(`
    ${head('GATES', '五层门禁：自己会腐化，所以让机器盯着', '本地脚本 = CI 脚本，改阈值必须先改契约')}
    <div class="stage" style="flex-direction:column; gap:12px">
      ${[
        ['质量 14 项', 'Q1 零依赖 · Q2 规模 · Q3 测试清单 · Q4 评测对齐 · Q5 契约覆盖 · Q6 链接 · Q7 版本自包含 · Q8 编码 · Q9 Web 边界 · Q10 发布面 · Q11 写侧与会话 · Q13 vendor · Q14 文档治理 · Q15 LLM 契约', 'ok'],
        ['安全 9 项', '无个人路径 · 无凭据/私钥 · 无内网域名 · 模板不含 home · .gitignore 覆盖 · LICENSE · 无超大文件 · 历史面轻扫 · 运行时回环断言', 'ok'],
        ['覆盖率门禁', 'lines ≥ 89% · functions ≥ 90% · branches ≥ 77%（低于阈值直接 fail，不看人）', 'ok'],
        ['docs-drift', '文档里的命令/路径/版本必须能被脚本验证存在，防「文档漂移」', 'warn'],
        ['pages-verify', '合并后校验线上项目站版本号已更新；不通过就是发布面漏了', 'hl'],
      ].map(([t, d, cls]) => `<div class="card ${cls}"><div class="t">${t}</div><div class="d">${d}</div></div>`).join('')}
    </div>
    <div class="band">
      <div class="label">CI 上的 12 个 job</div>
      <div class="chips">
        ${['test (22)', 'test (24)', 'eval (I1–I50)', 'quality', 'security', 'CodeQL', 'codeql',
           'issue-link', 'ci-gate', 'pages', 'pages-verify', 'docs-drift'].map((j) => `<span class="chip">${j}</span>`).join('')}
      </div>
    </div>
    ${foot('required checks 全绿 + strict 才允许合并；管理员也绕不过', 'sedimem v1.0.1')}
  `),
};

mkdirSync(OUT, { recursive: true });
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
let n = 0;
for (const [name, build] of Object.entries(DIAGRAMS)) {
  if (only && only !== name) continue;
  const htmlPath = `/tmp/sedimem-diagram-${name}.html`;
  writeFileSync(htmlPath, build(), 'utf8');
  const png = path.join(OUT, `${name}.png`);
  execFileSync(CHROME, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=2',
    '--window-size=1600,560', `--screenshot=${png}`, `file://${htmlPath}`,
  ], { stdio: 'ignore' });
  n += 1;
  process.stdout.write(`✓ ${path.relative(REPO, png)}\n`);
}
process.stdout.write(`done ${n} 张\n`);
