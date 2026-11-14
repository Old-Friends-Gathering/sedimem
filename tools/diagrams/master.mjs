// tools/diagrams/master.mjs
// 全系统架构图（一张图看完整链路）+ 首屏 banner。
//
// 与 render.mjs 的分工：render.mjs 出「单点示意图」（写入四道门/读路径/…），
// 这里只出 README 顶部那张「整系统一张图」和 hero banner。
//
// 用法：node tools/diagrams/master.mjs [--only arch|hero]
// 输出：docs/shots/diagrams/master-arch.png、docs/shots/hero.png

import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const OUT = path.join(REPO, 'docs/shots');
const CHROME = process.env.CHROME_PATH
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const BASE = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg: #0a0f1c; --panel: #111827; --panel2: #161f33; --line: #24314d;
    --text: #e9eefc; --dim: #93a1c4; --accent: #4d6bfe; --accent2: #38bdf8;
    --ok: #3fa96b; --warn: #d98a4b; --danger: #e05c5c;
  }
  body {
    font-family: "PingFang SC", "Noto Sans CJK SC", -apple-system, "Segoe UI", sans-serif;
    background: radial-gradient(1200px 700px at 12% -12%, #16223c 0%, #0a0f1c 55%, #070b14 100%);
    color: var(--text); overflow: hidden;
  }
  .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 16px; }
  .panel-title { display: flex; align-items: center; gap: 8px; font-size: 15px; font-weight: 700; }
  .panel-title .kicker { font-size: 10.5px; letter-spacing: .16em; color: var(--accent); font-weight: 700; }
  .m { font-family: "SF Mono", ui-monospace, monospace; }
  .card {
    background: var(--panel2); border: 1px solid var(--line); border-radius: 11px;
    padding: 10px 12px; display: flex; flex-direction: column; gap: 3px;
  }
  .card b { font-size: 14px; font-weight: 650; }
  .card span { font-size: 11.5px; color: var(--dim); line-height: 1.35; }
  .card.hl { border-color: rgba(77,107,254,.75); box-shadow: 0 0 0 1px rgba(77,107,254,.28); }
  .card.truth { border-color: rgba(56,189,248,.7); background: #0f1e2e; }
  .chip {
    font-size: 11.5px; padding: 4px 9px; border-radius: 8px; color: #c3cfec;
    background: #131c2e; border: 1px solid #25324d; white-space: nowrap;
  }
  .chip b { color: var(--text); font-weight: 600; }
  .arrow { color: #4d6bfe; font-size: 26px; line-height: 1; flex: 0 0 auto; align-self: center; }
  .varlabel { font-size: 10.5px; color: #7f8db0; text-align: center; margin-top: 2px; }
`;

// ---------------------------------------------------------------- 全系统架构图

const ARCH_W = 1760;
const ARCH_H = 720;

const arch = () => `<!doctype html><meta charset="utf-8"><style>${BASE}
  body { width: ${ARCH_W}px; height: ${ARCH_H}px; padding: 26px 32px; display: flex; flex-direction: column; gap: 12px; }
  .head { display: flex; align-items: baseline; gap: 14px; flex: 0 0 auto; }
  .head .kicker { font-size: 12px; letter-spacing: .2em; color: var(--accent); font-weight: 700; }
  .head h1 { font-size: 30px; letter-spacing: -.4px; }
  .head .note { margin-left: auto; font-size: 13px; color: var(--dim); }
  .stage { flex: 0 0 auto; display: flex; gap: 12px; min-height: 0; align-items: flex-start; }
  .col { display: flex; flex-direction: column; gap: 10px; min-height: 0; }
  .col.a { flex: 0 0 244px; }
  .col.b { flex: 0 0 252px; }
  .col.c { flex: 1 1 auto; }
  .col.d { flex: 0 0 300px; }
  .panel.pad { padding: 12px 12px 10px; display: flex; flex-direction: column; gap: 8px; align-self: stretch; }
  .mods { display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: 8px 14px; }
  .mods .grp { row-gap: 6px; }
  .grp { display: flex; flex-direction: column; gap: 6px; }
  .grp > .g-title { font-size: 11px; letter-spacing: .1em; color: #7d8cb0; font-weight: 700; }
  .grp .chips { display: flex; flex-wrap: wrap; gap: 5px; }
  .mid { flex: 1 1 auto; }
  .svc { display: flex; align-items: center; gap: 10px; background: #101a2e; border: 1px solid rgba(77,107,254,.55); border-radius: 13px; padding: 10px 14px; }
  .svc b { font-size: 15px; }
  .svc span { font-size: 11.5px; color: var(--dim); }
  .flows { display: flex; flex-direction: column; gap: 6px; margin-top: 10px; padding-top: 9px; border-top: 1px dashed #24314d; }
  .flow { display: flex; align-items: center; gap: 7px; font-size: 11.5px; color: var(--dim); }
  .flow .n { width: 17px; height: 17px; border-radius: 5px; background: rgba(77,107,254,.18); color: #a8b6ff;
    display: inline-flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 700; }
  .flow .fname { width: 34px; font-weight: 650; color: #dbe4fb; }
  .flow .sep { color: #4d6bfe; }
  .flow .chip.hl2 { border-color: rgba(56,189,248,.5); color: #b6e6fb; }
  .legend { display: flex; gap: 16px; align-items: center; font-size: 11.5px; color: var(--dim); flex: 0 0 auto; }
  .legend i { display: inline-block; width: 22px; height: 0; border-top: 2px solid var(--accent); vertical-align: middle; margin-right: 6px; }
  .legend i.dash { border-top-style: dashed; border-color: var(--warn); }
  .legend i.red { border-color: var(--danger); }
</style><body>
  <div class="head">
    <span class="kicker">ARCHITECTURE</span>
    <h1>整系统架构：四个客户端 → 一个门面 → 一条真相链</h1>
    <span class="note">v1.0 · 12 模块 · 0 运行时依赖</span>
  </div>

  <div class="stage">
    <!-- A 客户端 -->
    <div class="col a">
      <div class="panel pad" style="align-self:stretch;">
        <div class="panel-title"><span class="kicker">A</span> 客户端 / 入口</div>
        <div class="card hl"><b>DSH</b><span>插件 dsh-sedimem · 侧边栏「记忆中心」· 每步注入（默认关）</span></div>
        <div class="card"><b>Codex CLI</b><span>config.toml 配 stdio MCP</span></div>
        <div class="card"><b>Claude Code</b><span>claude mcp add --scope user</span></div>
        <div class="card"><b>浏览器 · 记忆中心</b><span>九页只读为主；--write 才可编辑</span></div>
        <div class="card"><b>CLI memo</b><span>write / search / brief / session / derive / serve</span></div>
      </div>
    </div>

    <div class="arrow">→</div>

    <!-- B 接口层 -->
    <div class="col b">
      <div class="panel pad" style="align-self:stretch;">
        <div class="panel-title"><span class="kicker">B</span> 接口层（唯一缝）</div>
        <div class="card hl"><b>MCP server</b><span class="m">memory_* ×10 · memory_session_* ×5</span><span>stdio · JSON-RPC 2.0 · 严格参数校验</span></div>
        <div class="card"><b>Web API</b><span>只读 GET ×12 · 编辑走 token + If-Match</span></div>
        <div class="card"><b>CLI</b><span>与 MCP 同一套 service 调用</span></div>
        <div class="card truth"><b>身份与分库</b><span class="m">scope = repo:* / dir:* / session:*</span><span>常驻进程先 memory_scope 对齐</span></div>
      </div>
    </div>

    <div class="arrow">→</div>

    <!-- C 核心 -->
    <div class="col c">
      <div class="svc">
        <b>MemoryService</b>
        <span class="m">write · search · brief · get · supersede · forget · curate · dedupe · session · derive · doctor</span>
      </div>
      <div class="panel pad mid" style="justify-content:space-between">
        <div class="panel-title"><span class="kicker">C</span> 12 个模块（依赖单向，core 在最底）</div>
        <div class="mods">
          <div class="grp"><div class="g-title">写入 · hygiene</div><div class="chips">
            <span class="chip"><b>write-gate</b> 四道门</span><span class="chip"><b>redact</b> 落盘前脱敏</span>
            <span class="chip"><b>conflict</b> 去重/簇</span><span class="chip"><b>judge</b> 裁决器</span>
          </div></div>
          <div class="grp"><div class="g-title">读取 · index / render</div><div class="chips">
            <span class="chip"><b>inverted</b> BM25</span><span class="chip"><b>sqlite</b> FTS5</span>
            <span class="chip"><b>hybrid</b> RRF k=60</span><span class="chip"><b>vector</b> sidecar</span>
            <span class="chip"><b>brief</b> / tier0</span><span class="chip"><b>inject</b> 预注入</span>
          </div></div>
          <div class="grp"><div class="g-title">组织 · views / capture</div><div class="chips">
            <span class="chip"><b>l2</b> 场景块</span><span class="chip"><b>l3</b> 画像</span>
            <span class="chip"><b>conflicts</b> 分歧视图</span><span class="chip"><b>extract/queue</b> 候选</span>
          </div></div>
          <div class="grp"><div class="g-title">会话 · session</div><div class="chips">
            <span class="chip"><b>lifecycle</b> 临时库</span><span class="chip"><b>checkpoint</b> 8 段</span>
            <span class="chip"><b>transcript</b> 读会话</span><span class="chip"><b>handoff</b> 交接文档</span>
          </div></div>
          <div class="grp"><div class="g-title">LLM · llm（默认关）</div><div class="chips">
            <span class="chip"><b>port</b> 可插拔</span><span class="chip"><b>budget</b> ¥/日</span>
            <span class="chip"><b>outbox</b> 出队</span><span class="chip"><b>derive</b> 标题摘要</span>
          </div></div>
          <div class="grp"><div class="g-title">底座 · storage / core</div><div class="chips">
            <span class="chip"><b>jsonl-store</b> 追加</span><span class="chip"><b>lock</b> 目录锁</span>
            <span class="chip"><b>record</b> 不变式</span><span class="chip"><b>text/time/scope</b></span>
          </div></div>
        </div>
        <div class="flows">
          <div class="flow"><span class="n">①</span><span class="fname">写入</span>
            <span class="chip">客户端</span><span class="sep">→</span><span class="chip">MCP / CLI / Web</span><span class="sep">→</span>
            <span class="chip">四道门</span><span class="sep">→</span><span class="chip hl2">追加真相层</span></div>
          <div class="flow"><span class="n">②</span><span class="fname">读取</span>
            <span class="chip">query</span><span class="sep">→</span><span class="chip">BM25 ± 语义</span><span class="sep">→</span>
            <span class="chip">RRF k=60</span><span class="sep">→</span><span class="chip hl2">basis / degraded</span></div>
          <div class="flow"><span class="n">③</span><span class="fname">派生</span>
            <span class="chip">写入即入队</span><span class="sep">⇢</span><span class="chip">outbox</span><span class="sep">⇢</span>
            <span class="chip">LlmPort（可选）</span><span class="sep">⇢</span><span class="chip hl2">derived sidecar</span></div>
        </div>
        <div class="legend">
          <span><i></i>同步调用</span><span><i class="dash"></i>异步 / 可选</span><span><i class="red"></i>不可跨越的边界</span>
          <span style="margin-left:auto">真相层字节不变：派生只是旁路</span>
        </div>
      </div>
    </div>

    <div class="arrow">→</div>

    <!-- D 数据 -->
    <div class="col d">
      <div class="panel pad" style="align-self:stretch;">
        <div class="panel-title"><span class="kicker">D</span> 数据层 <span class="m" style="font-size:11px;color:#7f8db0">~/.memo/</span></div>
        <div class="card truth"><b>items/&lt;scope&gt;.jsonl</b><span>真相层：只追加、永不原地改；as-of 可回查任意时点</span></div>
        <div class="card"><b>index/&lt;key&gt;.sqlite</b><span>派生：FTS5 索引，删了重跑即重建</span></div>
        <div class="card"><b>views/ · derived/</b><span>派生：L2 场景块 / L3 画像 / LLM 标题摘要</span></div>
        <div class="card"><b>events.jsonl</b><span>追加式审计流：每次写/命中/裁决一条</span></div>
        <div class="card"><b>derive-queue/ · inbox/</b><span>异步队列：LLM 派生待办 / 捕获候选待审</span></div>
        <div class="card"><b>brief/ · metrics/ · handoffs/</b><span>快照与交接文档</span></div>
        <div class="card" style="border-style:dashed;border-color:rgba(217,138,75,.6)"><b>外部 LLM（可选）</b><span>openai-compatible 端点；默认 provider=none，整层不存在</span></div>
      </div>
    </div>
  </div>

  <div class="legend" style="justify-content:space-between">
    <span>写入：A → B → C（四道门）→ D（追加一行）　·　读取：A → B → C（BM25 ± 语义 → RRF）→ D（只读）</span>
    <span>边界：界面永不写真相层 · 派生层可随时删光重建 · LLM 失败只降级不阻塞</span>
  </div>
</body>`;

// ---------------------------------------------------------------- hero banner

const HERO_W = 1600;
const HERO_H = 420;

const hero = () => `<!doctype html><meta charset="utf-8"><style>${BASE}
  body { width: ${HERO_W}px; height: ${HERO_H}px; padding: 0; position: relative; overflow: hidden; }
  .glow { position: absolute; width: 900px; height: 900px; right: -260px; top: -420px; border-radius: 50%;
    background: radial-gradient(circle, rgba(77,107,254,.30) 0%, rgba(56,189,248,.10) 45%, transparent 70%); }
  .grid { position: absolute; inset: 0;
    background-image: linear-gradient(rgba(120,150,255,.07) 1px, transparent 1px),
                      linear-gradient(90deg, rgba(120,150,255,.07) 1px, transparent 1px);
    background-size: 48px 48px; mask-image: radial-gradient(700px 400px at 30% 50%, #000 40%, transparent 78%); }
  .in { position: absolute; inset: 0; padding: 54px 62px; display: flex; flex-direction: column; justify-content: center; gap: 14px; }
  .logo { display: flex; align-items: center; gap: 12px; }
  .mark { width: 34px; height: 34px; border-radius: 10px; background: linear-gradient(140deg, #4d6bfe, #38bdf8);
    box-shadow: 0 6px 22px rgba(77,107,254,.45); }
  .logo b { font-size: 26px; letter-spacing: -.3px; }
  h1 { font-size: 46px; line-height: 1.16; letter-spacing: -1px; max-width: 1080px; }
  h1 em { font-style: normal; color: #7fa0ff; }
  p { font-size: 17px; color: #9fb0d4; max-width: 1000px; line-height: 1.5; }
  .pills { display: flex; gap: 10px; margin-top: 6px; }
  .pill { font-size: 13px; padding: 6px 13px; border-radius: 999px; color: #c9d5f5;
    background: rgba(19,28,46,.9); border: 1px solid #2a3855; }
  .pill b { color: #fff; font-weight: 650; }
  .right { position: absolute; right: 58px; bottom: 44px; text-align: right; font-size: 12.5px; color: #6f7d9d; }
</style><body>
  <div class="glow"></div><div class="grid"></div>
  <div class="in">
    <div class="logo"><div class="mark"></div><b>sedimem</b></div>
    <h1>AI 会忘记你，<em>它不会。</em></h1>
    <p>本地优先的个人记忆系统：真相层只追加、永不改写，索引/视图/派生全部可重建。DSH / Codex / Claude 三端共用同一个 MCP server。</p>
    <div class="pills">
      <span class="pill"><b>0</b> 运行时依赖</span>
      <span class="pill"><b>648</b> tests · I1–I50</span>
      <span class="pill"><b>as-of</b> 回查任意时点</span>
      <span class="pill"><b>MIT</b> · 数据只在 <span class="m">~/.memo/</span></span>
    </div>
  </div>
  <div class="right">v1.0 · local-first · append-only truth layer</div>
</body>`;

mkdirSync(path.join(OUT, 'diagrams'), { recursive: true });
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
const jobs = [
  ['master-arch', arch, path.join(OUT, 'diagrams/master-arch.png'), ARCH_W, ARCH_H],
  ['hero', hero, path.join(OUT, 'hero.png'), HERO_W, HERO_H],
];
for (const [name, build, png, w, h] of jobs) {
  if (only && only !== name) continue;
  const html = `/tmp/sedimem-master-${name}.html`;
  writeFileSync(html, build(), 'utf8');
  execFileSync(CHROME, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=2',
    `--window-size=${w},${h}`, `--screenshot=${png}`, `file://${html}`,
  ], { stdio: 'ignore' });
  process.stdout.write(`✓ ${path.relative(REPO, png)}\n`);
}
