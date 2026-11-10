// sedimem marketing cards renderer
// Node ESM, zero deps. Generates 6 1080x1440 PNGs via headless Chrome.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..'); // docs/
const outDir = path.join(import.meta.dirname, 'img');
fs.mkdirSync(outDir, { recursive: true });

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const W = 1080, H = 1440;

const baseCss = `
  * { margin:0; padding:0; box-sizing:border-box; }
  html,body { width:${W}px; height:${H}px; overflow:hidden; }
  body {
    font-family: system-ui, -apple-system, 'PingFang SC', 'Segoe UI', sans-serif;
    background:#0b1120; color:#e2e8f0;
    background-image:
      radial-gradient(ellipse 900px 600px at 85% -10%, rgba(56,189,248,.14), transparent 60%),
      radial-gradient(ellipse 700px 500px at -10% 110%, rgba(52,211,153,.10), transparent 60%);
    display:flex; flex-direction:column;
    position:relative;
  }
  .grid-bg { position:absolute; inset:0;
    background-image:linear-gradient(rgba(148,163,184,.05) 1px, transparent 1px),
                     linear-gradient(90deg, rgba(148,163,184,.05) 1px, transparent 1px);
    background-size:60px 60px; pointer-events:none; }
  .page { position:relative; z-index:1; display:flex; flex-direction:column;
    height:100%; padding:72px 72px 56px; }
  .brand { display:flex; align-items:center; gap:14px; margin-bottom:auto; }
  .brand .dot { width:14px; height:14px; border-radius:4px;
    background:linear-gradient(135deg,#38bdf8,#34d399); }
  .brand span { font-size:24px; font-weight:600; letter-spacing:.06em; color:#94a3b8; }
  .kicker { font-size:26px; font-weight:600; letter-spacing:.28em;
    color:#38bdf8; text-transform:uppercase; margin-bottom:22px; }
  h1 { font-size:88px; line-height:1.16; font-weight:700; letter-spacing:.01em; }
  h1 .accent { background:linear-gradient(90deg,#38bdf8,#34d399);
    -webkit-background-clip:text; background-clip:text; color:transparent; }
  h2 { font-size:64px; line-height:1.2; font-weight:700; margin-bottom:28px; }
  .sub { font-size:32px; line-height:1.65; color:#94a3b8; }
  .card { background:rgba(30,41,59,.65); border:1px solid rgba(148,163,184,.18);
    border-radius:20px; padding:32px 36px; }
  .pill { display:inline-flex; align-items:center; gap:10px;
    background:rgba(56,189,248,.10); border:1px solid rgba(56,189,248,.35);
    color:#7dd3fc; border-radius:999px; padding:10px 24px; font-size:26px; font-weight:500; }
  code, .mono { font-family: ui-monospace, 'SF Mono', Menlo, monospace; }
  .shot { border-radius:16px; border:1px solid rgba(148,163,184,.25);
    display:block; width:100%; object-fit:cover; object-position:top; }
  .foot { margin-top:auto; display:flex; justify-content:space-between;
    align-items:center; font-size:22px; color:#64748b; padding-top:32px; }
`;

const page = (body, extra = '') => `<!doctype html><html><head><meta charset="utf-8">
<style>${baseCss}${extra}</style></head><body><div class="grid-bg"></div>
<div class="page">${body}</div></body></html>`;

const brand = `<div class="brand"><div class="dot"></div><span>sedimem</span></div>`;
const foot = (n) => `<div class="foot"><span>github.com/Old-Friends-Gathering/sedimem</span><span>${n} / 6</span></div>`;

const img64 = (p) => `data:image/png;base64,${fs.readFileSync(path.join(root, 'marketing', 'shots', p)).toString('base64')}`;

const cards = {
  cover: page(`
    ${brand}
    <div class="kicker">Local-first AI Memory</div>
    <h1>个人 AI 记忆<br><span class="accent">本地优先</span></h1>
    <p class="sub" style="margin-top:34px;max-width:820px;">
      append-only JSONL 真相层，每条记忆可 as-of 回查。<br>
      索引与摘要都是可重建的派生物 —— 数据只属于你。
    </p>
    <div style="display:flex;gap:18px;flex-wrap:wrap;margin-top:44px;">
      <span class="pill">零运行时依赖</span>
      <span class="pill">Node ≥ 22 · node:sqlite</span>
      <span class="pill">DSH / Codex / Claude Code</span>
    </div>
    ${foot(1)}
  `),

  pain: page(`
    ${brand}
    <div class="kicker">Pain</div>
    <h2>换会话就失忆，<br>越写越乱</h2>
    <div style="display:flex;flex-direction:column;gap:24px;margin-top:16px;">
      <div class="card">
        <div style="font-size:34px;font-weight:600;color:#f87171;margin-bottom:12px;">每个会话从零开始</div>
        <p class="sub" style="font-size:28px;">同一个项目聊过十次，Agent 仍然不记得上次的决策与踩坑。</p>
      </div>
      <div class="card">
        <div style="font-size:34px;font-weight:600;color:#f87171;margin-bottom:12px;">记忆只进不出</div>
        <p class="sub" style="font-size:28px;">重复、冲突、过期的记忆越积越多，检索质量持续劣化，最后没人敢信。</p>
      </div>
      <div class="card">
        <div style="font-size:34px;font-weight:600;color:#34d399;margin-bottom:12px;">sedimem：记得住，也收得掉</div>
        <p class="sub" style="font-size:28px;">写入门控 + 候选发现 + Agent 裁决 + 失效非删除，记忆卫生是一等公民。</p>
      </div>
    </div>
    ${foot(2)}
  `),

  architecture: page(`
    ${brand}
    <div class="kicker">Architecture</div>
    <h2 style="font-size:54px;">真相层 → 派生索引 → Agent 裁决</h2>
    <div style="display:flex;align-items:center;gap:16px;margin:6px 0 26px;font-size:26px;">
      <span class="pill" style="font-size:24px;">append-only JSONL</span><span style="color:#475569;">→</span>
      <span class="pill" style="font-size:24px;">可重建索引/摘要</span><span style="color:#475569;">→</span>
      <span class="pill" style="font-size:24px;">正在用的 Agent 当裁判</span>
    </div>
    <img class="shot" style="height:520px;border-radius:10px;" src="${img64('graph-demo.png')}" alt="3D memory graph">
    <p class="sub" style="margin-top:24px;font-size:26px;">观察台 3D 记忆图谱（本地 7788 实拍）：每条记忆可 as-of 回查，派生物随时可重建。</p>
    ${foot(3)}
  `),

  hygiene: page(`
    ${brand}
    <div class="kicker">Memory Hygiene</div>
    <h2 style="font-size:54px;">重复 / 冲突 / 过期，<br>看得见，也收得掉</h2>
    <img class="shot" style="width:100%;margin-top:10px;border-radius:10px;" src="${img64('hygiene-demo.png')}" alt="hygiene insight">
    <div style="display:flex;gap:16px;flex-wrap:wrap;margin-top:26px;">
      <span class="pill" style="font-size:23px;">写入门控 · 零误杀</span>
      <span class="pill" style="font-size:23px;">containment + 汉字二元组 Dice</span>
      <span class="pill" style="font-size:23px;">bi-temporal + tombstone</span>
      <span class="pill" style="font-size:23px;">0 API 成本</span>
    </div>
    ${foot(4)}
  `),

  deploy: page(`
    ${brand}
    <div class="kicker">Deploy</div>
    <h2 style="font-size:54px;">三端一条命令，<br>插件一键装</h2>
    <div style="display:flex;flex-direction:column;gap:20px;margin-top:14px;">
      <div class="card">
        <div style="font-size:28px;color:#7dd3fc;font-weight:600;margin-bottom:14px;">装 DSH 插件（一条命令）</div>
        <code style="font-size:26px;color:#e2e8f0;display:block;line-height:1.6;">dsh plugin install dsh-sedimem</code>
      </div>
      <div class="card">
        <div style="font-size:28px;color:#7dd3fc;font-weight:600;margin-bottom:14px;">三端各一条 MCP 配置</div>
        <code style="font-size:24px;color:#e2e8f0;display:block;line-height:1.7;">DSH&nbsp;&nbsp;&nbsp;&nbsp;dsh mcp add sedimem -- node mcp/server.js<br>Codex&nbsp;&nbsp;&nbsp;codex mcp add sedimem -- node mcp/server.js<br>Claude&nbsp;&nbsp;claude mcp add sedimem -- node mcp/server.js</code>
      </div>
      <div class="card" style="display:flex;gap:14px;flex-wrap:wrap;">
        <span class="pill" style="font-size:23px;">launchd 常驻</span>
        <span class="pill" style="font-size:23px;">nightly 03:30 自动整合</span>
        <span class="pill" style="font-size:23px;">10 个 memory_* 工具</span>
      </div>
    </div>
    ${foot(5)}
  `),

  numbers: page(`
    ${brand}
    <div class="kicker">Self-tested</div>
    <h2>用数字说话</h2>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-top:12px;">
      <div class="card" style="text-align:center;padding:44px 24px;">
        <div style="font-size:84px;font-weight:700;color:#38bdf8;">391</div>
        <div class="sub" style="font-size:26px;margin-top:8px;">tests 全绿</div>
      </div>
      <div class="card" style="text-align:center;padding:44px 24px;">
        <div style="font-size:84px;font-weight:700;color:#34d399;">36</div>
        <div class="sub" style="font-size:26px;margin-top:8px;">注入式评测 I1–I36</div>
      </div>
      <div class="card" style="text-align:center;padding:44px 24px;">
        <div style="font-size:84px;font-weight:700;color:#fbbf24;">9+9</div>
        <div class="sub" style="font-size:26px;margin-top:8px;">质量 + 安全门禁</div>
      </div>
      <div class="card" style="text-align:center;padding:44px 24px;">
        <div style="font-size:84px;font-weight:700;color:#f472b6;">0</div>
        <div class="sub" style="font-size:26px;margin-top:8px;">runtime 依赖</div>
      </div>
    </div>
    <div style="display:flex;gap:16px;flex-wrap:wrap;margin-top:28px;">
      <span class="pill" style="font-size:23px;">覆盖率 93% / 92%</span>
      <span class="pill" style="font-size:23px;">brief ≤ 80 行</span>
    </div>
    ${foot(6)}
  `),
};

let total = 0;
for (const [name, html] of Object.entries(cards)) {
  const tmp = path.join(outDir, `${name}.html`);
  fs.writeFileSync(tmp, html);
  const out = path.join(outDir, `${name}.png`);
  execFileSync(CHROME, [
    '--headless=new', '--hide-scrollbars',
    `--screenshot=${out}`,
    `--window-size=${W},${H}`,
    pathToFileURL(tmp).href,
  ], { stdio: 'pipe' });
  const size = fs.statSync(out).size;
  total += size;
  console.log(`${name}.png  ${(size / 1024).toFixed(0)} KB`);
  fs.rmSync(tmp);
}
console.log(`TOTAL ${(total / 1024).toFixed(0)} KB`);

// ---------------------------------------------------------------- Twitter / X（1200×675 横图）
// X 的图片裁切偏好 16:9，这里单独出一套横图，不缩放竖版卡片（文字会糊）。

const TW_W = 1200, TW_H = 675;
const twDir = path.join(import.meta.dirname, 'img', 'twitter');
fs.mkdirSync(twDir, { recursive: true });

const twCss = `
  * { margin:0; padding:0; box-sizing:border-box; }
  html,body { width:${TW_W}px; height:${TW_H}px; overflow:hidden; }
  body {
    font-family: system-ui, -apple-system, 'SF Pro Display', 'PingFang SC', sans-serif;
    background:#0b1120; color:#e2e8f0; display:flex; flex-direction:column; justify-content:center;
    padding:56px 64px; position:relative;
    background-image:
      radial-gradient(ellipse 800px 500px at 88% -20%, rgba(56,189,248,.16), transparent 60%),
      radial-gradient(ellipse 600px 420px at -10% 120%, rgba(52,211,153,.12), transparent 60%);
  }
  .row { display:flex; align-items:center; gap:14px; }
  .dot { width:18px; height:18px; border-radius:6px; background:#2dd4bf; }
  .brand { font-size:26px; font-weight:600; color:#94a3b8; letter-spacing:.02em; }
  .kicker { font-size:22px; letter-spacing:.22em; text-transform:uppercase; color:#38bdf8; font-weight:600; margin-top:28px; }
  h1 { font-size:64px; line-height:1.18; margin-top:12px; letter-spacing:-.02em; }
  .hl { color:#2dd4bf; }
  .sub { font-size:27px; color:#94a3b8; margin-top:18px; line-height:1.5; }
  .pills { display:flex; gap:12px; flex-wrap:wrap; margin-top:30px; }
  .pill { font-size:22px; color:#bfdbfe; border:1px solid rgba(148,163,184,.34); border-radius:999px; padding:9px 18px; background:rgba(30,41,59,.6); }
  .stats { display:flex; gap:56px; margin-top:34px; }
  .stat b { font-size:62px; font-weight:700; display:block; }
  .stat span { font-size:21px; color:#94a3b8; }
  .foot { position:absolute; left:64px; right:64px; bottom:34px; display:flex; justify-content:space-between;
          font-size:19px; color:#64748b; }
`;

function twPage(body, n) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>${twCss}</style></head>
<body>${body}<div class="foot"><span>github.com/Old-Friends-Gathering/sedimem</span><span>${n}/3</span></div></body></html>`;
}

const twCards = {
  'hook': twPage(`
    <div class="row"><span class="dot"></span><span class="brand">sedimem</span></div>
    <div class="kicker">Local-first memory</div>
    <h1>Your AI forgets you<br>every session. <span class="hl">Mine doesn't.</span></h1>
    <div class="sub">Append-only truth layer + agent-as-judge dedupe.<br>Runs locally, zero runtime deps, one MCP server for 3 CLIs.</div>
    <div class="pills"><span class="pill">no cloud</span><span class="pill">no team tier</span><span class="pill">auditable as-of</span></div>
  `, 1),

  'architecture': twPage(`
    <div class="row"><span class="dot"></span><span class="brand">sedimem</span></div>
    <div class="kicker">How it works</div>
    <h1>Truth layer → derived index → <span class="hl">agent verdict</span></h1>
    <div class="pills">
      <span class="pill">append-only JSONL</span>
      <span class="pill">rebuildable index / brief</span>
      <span class="pill">the agent you already run is the judge</span>
      <span class="pill">bi-temporal, never destructive</span>
    </div>
    <div class="sub">Duplicates, conflicts and stale facts get flagged, not silently overwritten.</div>
  `, 2),

  'numbers': twPage(`
    <div class="row"><span class="dot"></span><span class="brand">sedimem</span></div>
    <div class="kicker">Self-tested</div>
    <div class="stats">
      <div class="stat"><b style="color:#38bdf8;">391</b><span>tests green</span></div>
      <div class="stat"><b style="color:#34d399;">36</b><span>injection evals</span></div>
      <div class="stat"><b style="color:#fbbf24;">9+9</b><span>quality + security gates</span></div>
      <div class="stat"><b style="color:#f472b6;">0</b><span>runtime deps</span></div>
    </div>
    <div class="pills"><span class="pill">Node ≥ 22 · node:sqlite</span><span class="pill">coverage 93% / 92%</span></div>
  `, 3),
};

for (const [name, html] of Object.entries(twCards)) {
  const tmp = path.join(twDir, `${name}.html`);
  fs.writeFileSync(tmp, html);
  const out = path.join(twDir, `${name}.png`);
  execFileSync(CHROME, [
    '--headless=new', '--hide-scrollbars',
    `--screenshot=${out}`,
    `--window-size=${TW_W},${TW_H}`,
    pathToFileURL(tmp).href,
  ], { stdio: 'pipe' });
  console.log(`twitter/${name}.png  ${(fs.statSync(out).size / 1024).toFixed(0)} KB`);
  fs.rmSync(tmp);
}
