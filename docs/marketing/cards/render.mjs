/**
 * render.mjs —— 小红书图卡渲染器（1080×1440，3:4）
 *
 * 为什么不用项目截图：封面决定点击率（业内经验：封面 ≈60%、标题 ≈15%）。
 * 截图信息密度高、缩略图下不可读；卡片只承载**一个钩子**，缩到 1/4 大小也能读。
 *
 * 用法：
 *   node docs/marketing/cards/render.mjs            # 全部
 *   node docs/marketing/cards/render.mjs cover data # 指定
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE);
const W = 1080;
const H = 1440;

const C = {
  bg: '#0B0E1A',
  bg2: '#111528',
  ink: '#F5F7FF',
  dim: '#98A2C0',
  gold: '#F5C451',
  gold2: '#FFDD8A',
  mint: '#5FE3A1',
  rose: '#FF6B81',
  blue: '#6C8CFF',
  line: 'rgba(245,196,81,.28)',
};

const CSS = `
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{width:${W}px;height:${H}px}
  body{
    background:
      radial-gradient(900px 620px at 82% 6%, rgba(245,196,81,.16), transparent 62%),
      radial-gradient(760px 520px at 6% 96%, rgba(108,140,255,.16), transparent 60%),
      ${C.bg};
    color:${C.ink};
    font-family:"PingFang SC","Noto Sans SC","Hiragino Sans GB",system-ui,sans-serif;
    padding:78px 76px 70px;
    display:flex;flex-direction:column;
    overflow:hidden;position:relative;
  }
  .grid{position:absolute;inset:0;background-image:
    linear-gradient(rgba(255,255,255,.028) 1px,transparent 1px),
    linear-gradient(90deg,rgba(255,255,255,.028) 1px,transparent 1px);
    background-size:60px 60px;pointer-events:none}
  .top{display:flex;align-items:center;gap:14px;font-size:26px;color:${C.dim};letter-spacing:.5px}
  .dot{width:16px;height:16px;border-radius:5px;background:${C.gold};box-shadow:0 0 26px rgba(245,196,81,.75)}
  .top b{color:${C.ink};font-weight:700;letter-spacing:.3px}
  .kicker{margin-top:44px;font-size:30px;letter-spacing:8px;color:${C.gold};font-weight:700}
  h1{margin-top:26px;font-size:104px;line-height:1.14;font-weight:900;letter-spacing:-1px}
  h1 em{font-style:normal;color:${C.gold}}
  .sub{margin-top:30px;font-size:40px;line-height:1.55;color:#C9D2EA;font-weight:500}
  .spacer{flex:1}
  .chips{display:flex;flex-wrap:wrap;gap:16px;margin-top:38px}
  .chip{font-size:28px;padding:15px 26px;border-radius:999px;border:1px solid rgba(255,255,255,.16);
    background:rgba(255,255,255,.05);color:#DDE4F7;font-weight:600}
  .chip.gold{border-color:rgba(245,196,81,.5);color:${C.gold2};background:rgba(245,196,81,.11)}
  .foot{display:flex;justify-content:space-between;align-items:center;font-size:26px;color:${C.dim};
    border-top:1px solid rgba(255,255,255,.1);padding-top:26px;margin-top:40px}
  .foot b{color:${C.gold};font-weight:700}
  .num{font-variant-numeric:tabular-nums}

  /* 对比卡 */
  .vs{display:grid;grid-template-columns:1fr 1fr;gap:26px;margin-top:46px}
  .pane{border-radius:28px;padding:38px 32px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.04)}
  .pane.bad{border-color:rgba(255,107,129,.42);background:rgba(255,107,129,.09)}
  .pane.good{border-color:rgba(95,227,161,.42);background:rgba(95,227,161,.09)}
  .pane h3{font-size:34px;margin-bottom:22px;letter-spacing:.5px}
  .pane.bad h3{color:${C.rose}}
  .pane.good h3{color:${C.mint}}
  .pane li{list-style:none;font-size:29px;line-height:1.6;color:#C9D2EA;padding-left:34px;position:relative;margin-bottom:14px}
  .pane li::before{content:"·";position:absolute;left:8px;color:${C.dim};font-weight:900}

  /* 机制卡（三层） */
  .stack{display:flex;flex-direction:column;gap:20px;margin-top:46px}
  .layer{border-radius:26px;padding:26px 30px;border:1px solid rgba(255,255,255,.12);
    background:linear-gradient(90deg,rgba(255,255,255,.06),rgba(255,255,255,.02))}
  .layer .t{display:flex;align-items:center;gap:16px;font-size:34px;font-weight:800}
  .layer .t span.tagn{font-size:22px;font-weight:700;padding:7px 16px;border-radius:999px;
    background:rgba(245,196,81,.16);color:${C.gold2};border:1px solid rgba(245,196,81,.4)}
  .layer .d{margin-top:14px;font-size:28px;line-height:1.55;color:#B9C3DE}
  .layer.truth{border-color:rgba(245,196,81,.55);background:rgba(245,196,81,.1)}
  .layer.derived{border-color:rgba(108,140,255,.4);background:rgba(108,140,255,.09)}
  .layer.ui{border-color:rgba(95,227,161,.38);background:rgba(95,227,161,.08)}
  .arrowd{align-self:center;font-size:34px;color:${C.gold};opacity:.85}

  /* 任务库卡 */
  .agents{display:flex;gap:18px;margin-top:40px;flex-wrap:wrap}
  .agent{flex:1;min-width:0;border-radius:22px;padding:26px 18px;text-align:center;
    border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.05)}
  .agent .n{font-size:30px;font-weight:800}
  .agent .r{font-size:23px;color:${C.dim};margin-top:8px}
  .join{text-align:center;font-size:40px;color:${C.gold};margin:26px 0 8px}
  .task{border-radius:26px;padding:34px;border:1px solid rgba(245,196,81,.5);background:rgba(245,196,81,.1)}
  .task .h{font-size:34px;font-weight:800;color:${C.gold2}}
  .task .b{margin-top:14px;font-size:28px;line-height:1.6;color:#C9D2EA}
  .task .tags{display:flex;gap:14px;margin-top:22px}
  .task .tags i{font-style:normal;font-size:24px;padding:9px 18px;border-radius:999px;
    background:rgba(95,227,161,.16);color:${C.mint};border:1px solid rgba(95,227,161,.42)}

  /* 数据卡 */
  .figs{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-top:34px}
  .fig{border-radius:26px;padding:30px 28px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.045)}
  .fig .v{font-size:80px;font-weight:900;letter-spacing:-1px;line-height:1;
    font-variant-numeric:tabular-nums}
  .fig .k{margin-top:16px;font-size:27px;color:#B9C3DE;line-height:1.45}
  .fig.a .v{color:${C.gold}}
  .fig.b .v{color:${C.mint}}
  .fig.c .v{color:${C.blue}}
  .fig.d .v{color:#C9A6FF}

  /* 记录条（真实之一行） */
  .rec{margin-top:34px;border-radius:22px;border:1px solid rgba(255,255,255,.13);
    background:rgba(8,11,22,.72);padding:26px 26px 26px 30px;position:relative;overflow:hidden}
  .rec::before{content:"";position:absolute;left:0;top:0;bottom:0;width:6px;background:${C.gold}}
  .rec .ln{font-family:"SF Mono",ui-monospace,Menlo,monospace;font-size:23px;line-height:1.75;color:#B9C3DE;
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .rec .ln b{color:${C.gold2};font-weight:600}
  .rec .ln i{color:${C.mint};font-style:normal}
  .rec .cap{margin-top:14px;font-size:22px;color:${C.dim};letter-spacing:.4px}

  /* 三步上手 */
  .steps{display:flex;flex-direction:column;gap:14px;margin-top:30px}
  .st{display:flex;align-items:center;gap:18px}
  .st .n{width:46px;height:46px;border-radius:14px;flex:none;display:flex;align-items:center;justify-content:center;
    font-size:26px;font-weight:900;color:#0B0E1A;background:${C.gold}}
  .st b{font-size:32px;color:${C.ink}}
  .st i{font-style:normal;font-size:26px;color:${C.dim};margin-left:14px}

  /* CTA */
  .cta{margin-top:46px;border-radius:28px;padding:40px;border:1px dashed rgba(245,196,81,.55);
    background:rgba(245,196,81,.07)}
  .cta .h{font-size:40px;font-weight:900;color:${C.gold2};line-height:1.4}
  .cta .b{margin-top:16px;font-size:30px;line-height:1.6;color:#C9D2EA}
  .url{margin-top:26px;font-size:30px;font-family:"SF Mono",ui-monospace,Menlo,monospace;color:${C.ink}}
`;

function page(body, { foot = 'sedimem · 本地优先的 AI 记忆库' } = {}) {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><style>${CSS}</style></head>
<body><div class="grid"></div>${body}
<div class="foot"><span>${foot}</span><span><b>sedimem</b></span></div>
</body></html>`;
}

const top = (kicker = 'LOCAL-FIRST MEMORY') => `
  <div class="top"><span class="dot"></span><b>sedimem</b><span>· 记忆观测台</span></div>
  <div class="kicker">${kicker}</div>`;

const CARDS = {
  /* 1 封面：只讲一个钩子 */
  cover: () =>
    page(`
    ${top('AI 记忆 · 开源')}
    <h1 style="font-size:118px;line-height:1.1">AI 每次都<br/><em>把我忘了</em></h1>
    <div class="sub" style="font-size:44px;margin-top:34px">所以我给它装了一块<br/><b style="color:#F5F7FF">只增不灭的记忆盘</b></div>
    <div class="rec" style="margin-top:44px">
      <div class="ln"><b>gotcha</b>  · DSH 常驻进程 cwd 固定，先对齐分库</div>
      <div class="ln"><b>decision</b> · 版本目录 X.Y 换、X.Y.Z 同目录</div>
      <div class="ln"><b>fact</b>  · 真相层只追加，索引可重建</div>
      <div class="cap">一行一条 · 只追加 · 永不原地改写</div>
    </div>
    <div class="steps">
      <div class="st"><span class="n">1</span><div><b>装</b><i>一条命令接进三个客户端</i></div></div>
      <div class="st"><span class="n">2</span><div><b>用</b><i>它干活时自己记，收工自己整理</i></div></div>
      <div class="st"><span class="n">3</span><div><b>忘掉它</b><i>下次开窗口，它自己带着记忆来</i></div></div>
    </div>
    <div class="chips">
      <span class="chip gold">0 运行时依赖</span>
      <span class="chip">数据只在本机</span>
      <span class="chip">3 端共用</span>
    </div>`),

  /* 2 痛点对比 */
  pain: () =>
    page(`
    ${top('BEFORE / AFTER')}
    <h1 style="font-size:86px">用 AI 写代码<br/>最烦的两件事</h1>
    <div class="vs">
      <div class="pane bad">
        <h3>以前</h3>
        <li>新开窗口，全部重讲</li>
        <li>CLAUDE.md 越写越长</li>
        <li>让它记住 → 结果记错</li>
        <li>换工具，白教一遍</li>
      </div>
      <div class="pane good">
        <h3>现在</h3>
        <li>开窗口先读记忆</li>
        <li>一条一事，可回溯</li>
        <li>它自己记录、自己整理</li>
        <li>三个客户端共用一份</li>
      </div>
    </div>
    <div class="spacer"></div>
    <div class="rec" style="margin-top:0">
      <div class="ln"><b>gotcha</b> · DSH 常驻进程 cwd 固定，先 memory_scope 对齐分库</div>
      <div class="ln"><b>decision</b> · 版本目录规则：X.Y 换目录，X.Y.Z 同目录补丁</div>
      <div class="ln"><b>fact</b> · 真相层只追加，索引与 brief 都是派生层</div>
      <div class="cap">它记的是这种一句话事实 —— 不是聊天记录</div>
    </div>
    <div class="sub" style="font-size:32px;margin-top:30px">不是让它「记得更多」，是让它<b style="color:#F5C451">下次别再问一遍</b>。</div>`),

  /* 3 机制：三层 */
  arch: () =>
    page(`
    ${top('HOW IT WORKS')}
    <h1 style="font-size:78px">为什么它<br/>不会记乱</h1>
    <div class="stack" style="gap:12px;margin-top:34px">
      <div class="layer truth">
        <div class="t">真相层 <span class="tagn">只追加</span></div>
        <div class="d">一行一条 JSONL，永不原地改；改主意也只是追加新版本 + 给旧的打失效标记</div>
      </div>
      <div class="arrowd" style="font-size:26px">↓</div>
      <div class="layer derived">
        <div class="t">派生层 <span class="tagn">可重建</span></div>
        <div class="d">索引 / 图谱 / 摘要全是派生物，删光重跑一遍就回来了</div>
      </div>
      <div class="arrowd" style="font-size:26px">↓</div>
      <div class="layer ui">
        <div class="t">界面层 <span class="tagn">只读</span></div>
        <div class="d">九页观测台；写操作永远走命令行，页面改不了你的库</div>
      </div>
    </div>
    <div class="rec" style="margin-top:22px;padding:20px 22px 20px 26px">
      <div class="ln">$ <b>rm -rf ~/.memo/index/*.sqlite</b>  → 索引重建 11ms</div>
      <div class="ln">$ <b>memo view build L2</b>          → 场景块重算</div>
      <div class="ln">$ <b>memo derive --rebuild</b>       → LLM 摘要重跑</div>
    </div>`),

  /* 4 任务库：多 agent 接力 */
  task: () =>
    page(`
    ${top('TASK, NOT SESSION')}
    <h1 style="font-size:80px">一个任务<br/>三个 AI 接力</h1>
    <div class="agents">
      <div class="agent"><div class="n">DSH</div><div class="r">写接口</div></div>
      <div class="agent"><div class="n">Codex</div><div class="r">补测试</div></div>
      <div class="agent"><div class="n">Claude</div><div class="r">改文档</div></div>
    </div>
    <div class="join">↓ 都写进同一条任务</div>
    <div class="task">
      <div class="h">任务：加语义检索</div>
      <div class="b">做到第 3 步 · 卡在锁文件 · 下一步跑回归</div>
      <div class="tags"><i>decision 晋升</i><i>gotcha 晋升</i><i>其余丢弃</i></div>
    </div>
    <div class="rec" style="margin-top:30px">
      <div class="ln"><b># 交接</b> · 加语义检索（第 1 天 → 第 3 天）</div>
      <div class="ln"><b>卡点</b> · lock 文件未释放，i8 并发用例偶发红</div>
      <div class="ln"><b>下一步</b> · 跑 eval I45–I50 再合并</div>
      <div class="cap">close 时自动写这份交接文档 —— 下一个 agent 直接接</div>
    </div>
    <div class="sub" style="font-size:30px;margin-top:26px">按<b style="color:#F5C451">任务</b>分库，不按会话——交接的是任务，不是聊天记录。</div>`),

  /* 5 数据卡 */
  data: () =>
    page(`
    ${top('SELF-TESTED')}
    <h1 style="font-size:84px">自己先用<br/>再开源</h1>
    <div class="figs">
      <div class="fig a"><div class="v">651</div><div class="k">自动化测试<br/>全绿才允许合并</div></div>
      <div class="fig b"><div class="v">0</div><div class="k">运行时依赖<br/>不加 npm 包</div></div>
      <div class="fig c"><div class="v">33→30</div><div class="k">LLM 体检出的<br/>重复与垃圾记忆</div></div>
      <div class="fig d"><div class="v">9</div><div class="k">记忆观测台页面<br/>全部只读</div></div>
    </div>
    <div class="rec" style="margin-top:0">
      <div class="ln">$ <b>node --test 'tests/**/*.test.js'</b>   → 651 pass / 0 fail</div>
      <div class="ln">$ <b>node tools/quality-check.mjs</b>      → 14/14 通过</div>
      <div class="ln">$ <b>node tools/security-check.mjs</b>     → 9/9 通过</div>
    </div>
    <div class="sub" style="font-size:32px;margin-top:30px">这周两个真 bug，都是<b style="color:#F5C451">自己用出来的</b>，不是测出来的。</div>`),

  /* 6 CTA */
  cta: () =>
    page(`
    ${top('OPEN SOURCE · MIT')}
    <h1 style="font-size:88px">想请你<br/><em>帮我用坏它</em></h1>
    <div class="cta">
      <div class="h">哪里看不懂 · 哪里反直觉 · 哪里报错</div>
      <div class="b">提 issue 就行，我基本当天修。<br/>一个人自测盲区太多，真实使用才见真章。</div>
      <div class="url">github.com/Old-Friends-Gathering/sedimem</div>
    </div>
    <div class="steps" style="margin-top:34px">
      <div class="st"><span class="n">1</span><div><b>装</b><i>接进 DSH / Codex / Claude Code</i></div></div>
      <div class="st"><span class="n">2</span><div><b>用</b><i>干活时它自己记，收工自己整理</i></div></div>
      <div class="st"><span class="n">3</span><div><b>看</b><i>浏览器打开观测台：今天记了什么</i></div></div>
    </div>
    <div class="spacer"></div>
    <div class="chips">
      <span class="chip gold">DSH / Codex / Claude Code</span>
      <span class="chip">macOS · Linux · Windows</span>
    </div>`),
};

const only = process.argv.slice(2);
const names = only.length ? only : Object.keys(CARDS);

for (const name of names) {
  const build = CARDS[name];
  if (!build) throw new Error(`unknown card: ${name}`);
  const dir = mkdtempSync(join(tmpdir(), 'sedimem-card-'));
  const html = join(dir, `${name}.html`);
  writeFileSync(html, build());
  const out = join(OUT, `${name}.png`);
  try {
    execFileSync(
      process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      [
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        '--force-device-scale-factor=2',
        `--window-size=${W},${H}`,
        `--screenshot=${out}`,
        `file://${html}`,
      ],
      { stdio: 'pipe' },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(`✓ ${name}.png`);
}
