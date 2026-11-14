#!/usr/bin/env node
// tools/quality-check.mjs — 质量门禁（零依赖，本地与 CI 同源）
//
// 设计原则：每一条都是**可度量、可复现、能定位到文件行**的，不写"代码要优雅"这种没法判的条目。
// 阈值集中在下方 THRESHOLDS，调阈值 = 改一处 + 在 docs/07 记录理由。
//
// 用法：
//   node tools/quality-check.mjs            # 全量检查，退出码 0/1
//   node tools/quality-check.mjs --json     # 机器可读（CI 归档）
//   node tools/quality-check.mjs --quiet    # 只打印失败项

import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const THRESHOLDS = {
  /** 单文件源码上限（行）：超过说明职责没拆开。v0.1 现状 api/service.js 最大 868 行，
   *  已登记 v0.2 拆分项（quota / search / curate 三个子模块），暂以 900 为硬线防止继续膨胀。 */
  maxFileLines: 900,
  /** src 总行数上限：v0.1 约 4.7k，留一倍余量防无声膨胀 */
  // v0.3 调高到 9000：分层视图新增 4 个模块（views/l2 302 行、views/l3 272 行、
  // render/tier0 103 行、cli/view 177 行 = 854 行）。单文件 900 硬线不动 ——
  // 总量放大允许「多个小模块」，不允许「一个大文件」。改这条要同步 docs/07 基线表与 CHANGELOG。
  // v0.4 调高到 12000：竞品差距补齐新增 8 个模块（index/embedder 142 + vector-index 175 +
  // hybrid 85 + hybrid-index 210 + capture/extract 120 + capture/queue 200 + views/conflicts 200
  // + hygiene/redact 110 + render/inject 204 ≈ 1450 行）。单文件 900 硬线**不动** ——
  // 放宽总量是允许「多写几个职责单一的小模块」，不是允许「一个文件堆更多东西」。
  // v0.6 调高到 13000：会话临时库新增 src/session/*（lifecycle 190 + checkpoint 150 +
  // handoff 110 ≈ 450 行）+ cli/session 130 行 + core/record 的契约代码 ~60 行。
  // 单文件 900 硬线**不动**：放宽总量只允许「多几个职责单一的小模块」。
  // v1.0.1 调到 16000：W2 去重把三份重复实现收成 core/text.js + core/time.js（≈190 行，
  // 换掉 8+4 处散落实现，净增但可测），W4 会话 LLM 新增 session/transcript.js +
  // checkpoint-llm.js（≈400 行，有 I45 守着）。单文件 400 硬线仍然不动。
  maxTotalSrcLines: 16000,
  /** 单元测试文件数下限 */
  minTestFiles: 8,
  /** 契约文档对 src 导出名的覆盖率（%）；内部工具函数在 contract-exempt.json 里登记豁免 */
  minContractCoverage: 90,
};

const args = new Set(process.argv.slice(2));
const JSON_OUT = args.has('--json');
const QUIET = args.has('--quiet');

/** @type {{id: string, title: string, ok: boolean, detail: string[]}[]} */
const results = [];

function record(id, title, ok, detail = []) {
  results.push({ id, title, ok, detail });
  if (!JSON_OUT && (!ok || !QUIET)) {
    const mark = ok ? '✓' : '✗';
    console.log(`${mark} ${id} ${title}`);
    for (const d of detail) console.log(`    ${d}`);
  }
}

async function walk(dir, filter, out = []) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT') return out;
    throw e;
  }
  for (const ent of entries) {
    if (ent.name === 'node_modules' || ent.name === '.git') continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) await walk(full, filter, out);
    else if (filter(full)) out.push(full);
  }
  return out;
}

const rel = (p) => path.relative(ROOT, p);

/** 当前版本目录名（由 versions/CURRENT 决定）。Q2/Q3/Q5/Q9 只审「当前版本」：
 *  冻结版本（v0.1）保留是为了可查，不该被当前门禁倒逼改动。 */
let CURRENT = '';
const currentVersionDir = () => path.join(ROOT, 'versions', CURRENT);

/** 当前开发版本目录名（读 versions/CURRENT）。门禁关心的「当前版本」由这一个文件决定，
 *  这样大版本换目录（v0.1 → v0.2）不需要改门禁代码，也不会误把冻结版本当成目标。 */
async function readCurrentVersion() {
  const raw = await fsp.readFile(path.join(ROOT, 'versions', 'CURRENT'), 'utf8').catch(() => '');
  return raw.trim();
}
const readLines = async (p) => (await fsp.readFile(p, 'utf8')).split('\n');

// ── Q1 零运行时依赖 ────────────────────────────────────────────────
async function q1ZeroDependencies() {
  const problems = [];
  const pkgs = await walk(ROOT, (p) => p.endsWith('package.json') && !p.includes('node_modules'));
  if (pkgs.length === 0) problems.push('未找到任何 package.json');
  for (const p of pkgs) {
    const pkg = JSON.parse(await fsp.readFile(p, 'utf8'));
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      const deps = pkg[field] ?? {};
      const names = Object.keys(deps);
      if (names.length > 0) problems.push(`${rel(p)}: ${field} 非空（${names.join(', ')}）——本项目必须零依赖`);
    }
    if (pkg.type !== 'module') problems.push(`${rel(p)}: type 必须为 "module"`);
    if (!pkg.engines?.node) problems.push(`${rel(p)}: 缺少 engines.node 声明`);
  }
  // 源码不得 import 任何非 node:/相对路径的模块
  const srcs = await walk(ROOT, (p) => /\/src\/.*\.js$/.test(p) && !p.includes('node_modules'));
  for (const s of srcs) {
    const text = await fsp.readFile(s, 'utf8');
    const specs = [...text.matchAll(/(?:^|\n)\s*(?:import|export)[^;\n]*?from\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
    for (const spec of specs) {
      if (spec.startsWith('node:') || spec.startsWith('.') || spec.startsWith('/')) continue;
      problems.push(`${rel(s)}: 外部依赖 import "${spec}"`);
    }
  }
  record('Q1', '零运行时依赖（只用 node: 内置模块）', problems.length === 0, problems);
}

// ── Q2 源码规模 ───────────────────────────────────────────────────
async function q2SourceSize() {
  const srcs = await walk(currentVersionDir(), (p) => /\/src\/.*\.js$/.test(p));
  if (srcs.length === 0) return record('Q2', '源码规模（单文件/总量）', false, ['未找到 src/**/*.js']);
  const problems = [];
  let total = 0;
  const sizes = [];
  for (const s of srcs) {
    const n = (await readLines(s)).length;
    total += n;
    sizes.push([rel(s), n]);
    if (n > THRESHOLDS.maxFileLines) {
      problems.push(`${rel(s)}: ${n} 行 > ${THRESHOLDS.maxFileLines}（拆分职责或记录 ADR 豁免）`);
    }
  }
  if (total > THRESHOLDS.maxTotalSrcLines) {
    problems.push(`src 总量 ${total} 行 > ${THRESHOLDS.maxTotalSrcLines}`);
  }
  sizes.sort((a, b) => b[1] - a[1]);
  const top = sizes.slice(0, 3).map(([f, n]) => `最大：${f} ${n} 行`).join('；');
  record('Q2', `源码规模（${srcs.length} 文件 / ${total} 行，上限 ${THRESHOLDS.maxTotalSrcLines}）`,
    problems.length === 0, [...problems, top].filter(Boolean));
}

// ── Q3 测试规模 ───────────────────────────────────────────────────
async function q3TestInventory() {
  const tests = await walk(currentVersionDir(), (p) => /\/tests\/.*\.test\.js$/.test(p));
  const injections = tests.filter((p) => p.includes('/injection/'));
  const units = tests.filter((p) => p.includes('/unit/'));
  const problems = [];
  if (tests.length < THRESHOLDS.minTestFiles) {
    problems.push(`测试文件 ${tests.length} < ${THRESHOLDS.minTestFiles}`);
  }
  if (injections.length === 0) problems.push('缺少 tests/injection/ 注入式回归');
  if (units.length === 0) problems.push('缺少 tests/unit/ 单元测试');
  record('Q3', `测试清单（${units.length} 单元 + ${injections.length} 注入）`, problems.length === 0, problems);
}

// ── Q4 评测用例与实际测试文件对齐 ──────────────────────────────────
async function q4EvalAlignment() {
  const problems = [];
  const current = await readCurrentVersion();
  const runnerPath = path.join(ROOT, 'versions', current, 'eval', 'run.js');
  // 先读、失败再回退：避免「先 stat 再 read」的 TOCTOU（js/file-system-race）
  let runner = runnerPath;
  let runnerText;
  try {
    runnerText = await fsp.readFile(runnerPath, 'utf8');
  } catch {
    runner = (await walk(ROOT, (p) => /\/eval\/run\.js$/.test(p)))[0];
    if (!runner) return record('Q4', '评测用例 ↔ 注入测试对齐', false, ['未找到 eval/run.js']);
    runnerText = await fsp.readFile(runner, 'utf8');
  }
  const declared = [...runnerText.matchAll(/\[['"]([^'"]+)['"],\s*['"]([^'"]+\.test\.js)['"]\]/g)]
    .map((m) => ({ id: m[1], file: m[2] }));
  if (declared.length === 0) problems.push('eval/run.js 的 CASE_FILES 解析为空（格式需为 [["I1","i1-*.test.js"], ...]）');
  const ids = declared.map((d) => d.id);
  if (new Set(ids).size !== ids.length) problems.push(`CASE_FILES 里存在重复用例 id：${ids.join(', ')}`);

  const injectionDir = path.join(path.dirname(runner), '..', 'tests', 'injection');
  for (const { id, file } of declared) {
    const hit = await walk(injectionDir, (p) => p.endsWith(file));
    if (hit.length === 0) problems.push(`用例 ${id} 的注入测试 ${file} 不存在`);
  }

  // 用例数据种子（I1/I2/I7 等从 eval/cases/*.json 读数据）：声明了就必须存在
  const casesDir = path.join(path.dirname(runner), 'cases');
  const seedRefs = [...runnerText.matchAll(/join\(CASES_DIR,\s*['"]([^'"]+\.json)['"]\)/g)].map((m) => m[1]);
  for (const name of new Set(seedRefs)) {
    const exists = await fsp.readFile(path.join(casesDir, name), 'utf8').then(() => true, () => false);
    if (!exists) problems.push(`eval/cases/${name} 被 run.js 引用但不存在`);
  }
  record('Q4', `评测用例对齐（${declared.length} 个 I 用例的注入测试 + ${new Set(seedRefs).size} 份数据种子）`,
    problems.length === 0, problems);
}

// ── Q5 契约覆盖：src 的公开导出必须能在 docs/ 里找到 ────────────────
// 豁免清单：内部工具函数（不构成对外契约）在 tools/contract-exempt.json 登记，必须写理由。
async function loadContractExempt() {
  try {
    const raw = JSON.parse(await fsp.readFile(path.join(ROOT, 'tools', 'contract-exempt.json'), 'utf8'));
    const map = new Map();
    for (const [name, reason] of Object.entries(raw.exempt ?? {})) map.set(name, reason);
    return map;
  } catch {
    return new Map();
  }
}

async function q5ContractCoverage() {
  const exempt = await loadContractExempt();
  const contractFiles = await walk(path.join(ROOT, 'docs'), (p) => p.endsWith('.md') && !p.includes('/research/'));
  const contractText = (await Promise.all(contractFiles.map((f) => fsp.readFile(f, 'utf8')))).join('\n');
  const srcs = await walk(currentVersionDir(), (p) => /\/src\/.*\.js$/.test(p));
  const missing = [];
  let exempted = 0;
  const seen = new Set();
  for (const s of srcs) {
    const text = await fsp.readFile(s, 'utf8');
    for (const m of text.matchAll(/^export\s+(?:async\s+)?(?:function|class|const|let)\s+([A-Za-z_$][\w$]*)/gm)) {
      const name = m[1];
      if (seen.has(name)) continue;
      seen.add(name);
      if (contractText.includes(name)) continue;
      if (exempt.has(name)) { exempted++; continue; }
      missing.push(`${rel(s)}: export ${name} 未在 docs/ 契约中登记（也不在 contract-exempt.json）`);
    }
  }
  const total = seen.size;
  const covered = total - missing.length;
  const pct = total === 0 ? 100 : (covered / total) * 100;
  const ok = pct >= THRESHOLDS.minContractCoverage;
  record('Q5', `契约覆盖 ${pct.toFixed(1)}%（${covered}/${total} 导出名，其中豁免 ${exempted}，下限 ${THRESHOLDS.minContractCoverage}%）`,
    ok, missing.slice(0, 12));
}

// ── Q6 文档站内链接 ───────────────────────────────────────────────
async function q6DocLinks() {
  const docs = await walk(path.join(ROOT, 'docs'), (p) => p.endsWith('.md'));
  const rootReadme = path.join(ROOT, 'README.md');
  const files = [rootReadme, path.join(ROOT, 'CONTRIBUTING.md'), path.join(ROOT, 'SECURITY.md'), ...docs]
    .filter((p) => !p.includes('/research/readmes/')); // 快照里的上游链接不校验
  const broken = [];
  for (const f of files) {
    let text;
    try { text = await fsp.readFile(f, 'utf8'); } catch { continue; }
    for (const m of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
      const target = m[1];
      if (/^(https?:|mailto:|#)/.test(target)) continue;
      const clean = target.split('#')[0];
      if (!clean) continue;
      const abs = path.resolve(path.dirname(f), clean);
      const ok = await fsp.stat(abs).catch(() => null);
      if (!ok) broken.push(`${rel(f)} → ${target}`);
    }
  }
  record('Q6', '文档站内链接可达（不含 research/readmes 快照）', broken.length === 0, broken.slice(0, 15));
}

// ── Q7 版本自包含与版本号一致性 ────────────────────────────────────
async function q7VersionIntegrity() {
  const problems = [];
  const versionsDir = path.join(ROOT, 'versions');
  const versions = (await fsp.readdir(versionsDir, { withFileTypes: true }))
    .filter((d) => d.isDirectory()).map((d) => d.name);
  const current = await readCurrentVersion();
  if (versions.length === 0) problems.push('versions/ 下没有任何版本目录');
  if (!current) problems.push('versions/CURRENT 缺失或为空（必须写明当前开发版本，如 v0.2）');
  else if (!versions.includes(current)) problems.push(`versions/CURRENT 指向不存在的目录：${current}`);
  for (const v of versions) {
    const base = path.join(versionsDir, v);
    for (const required of ['src', 'tests', 'eval', 'config', 'docs/DELTA.md', 'CHANGELOG.md', 'package.json']) {
      const st = await fsp.stat(path.join(base, required)).catch(() => null);
      if (!st) problems.push(`${v}: 缺少 ${required}（版本目录必须自包含）`);
    }
    const pkgPath = path.join(base, 'package.json');
    const changelogPath = path.join(base, 'CHANGELOG.md');
    const pkg = JSON.parse(await fsp.readFile(pkgPath, 'utf8').catch(() => '{}'));
    const chl = await fsp.readFile(changelogPath, 'utf8').catch(() => '');
    const firstVersion = chl.match(/^##\s*\[?([0-9]+\.[0-9]+\.[0-9]+)\]?/m)?.[1];
    if (!firstVersion) problems.push(`${v}: CHANGELOG 缺少 "## [x.y.z]" 版本段`);
    else if (pkg.version !== firstVersion) {
      problems.push(`${v}: package.json ${pkg.version} ≠ CHANGELOG 最新段 ${firstVersion}`);
    }
  }
  record('Q7', `版本自包含 + 版本号一致（当前 ${current || '?'}；目录 ${versions.join(', ')}）`, problems.length === 0, problems);
}

// ── Q8 文件编码卫生 ───────────────────────────────────────────────
async function q8Encoding() {
  const files = await walk(ROOT, (p) => /\.(js|mjs|json|md|yml|yaml|toml|sh)$/.test(p) && !p.includes('node_modules'));
  const problems = [];
  for (const f of files) {
    const buf = await fsp.readFile(f);
    if (buf.includes(0x0d)) problems.push(`${rel(f)}: 含 CRLF`);
    if (buf.length > 0 && buf[buf.length - 1] !== 0x0a) problems.push(`${rel(f)}: 文件末尾缺换行`);
  }
  record('Q8', `编码卫生（${files.length} 文件无 CRLF、末尾有换行）`, problems.length === 0, problems.slice(0, 10));
}

// ── Q9 Web UI 层边界 ──────────────────────────────────────────────
// 裁决来源：docs/08-web-ui.md（只读 Web 层契约）。ui/ 与 src/web/ 只能读，
// 不得触碰 hygiene/storage/index 内部模块；ui/ 不得外链、不得 innerHTML 拼数据、不得 eval。
// 行级白名单：行内出现 `// q9-allow` 注释即跳过该行（须在 PR 里说明理由）。

/** 去掉块注释（保持行结构，便于报行号） */
function stripBlockComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, (s) => s.replace(/[^\n]/g, ' '));
}

/** 取一行的"代码部分"：截掉 // 行注释（仅当 token 出现在 // 之后才算注释里） */
function codePartOfLine(line) {
  const i = line.indexOf('//');
  return i === -1 ? line : line.slice(0, i);
}

async function q9WebUiBoundary() {
  const problems = [];
  const versions = [currentVersionDir()];
  let uiFiles = 0;
  for (const v of versions) {
    const uiDir = path.join(v, 'ui');
    const webDir = path.join(v, 'src', 'web');
    // 1) ui/ 与 src/web/ 不得 import ../hygiene/、../storage/、../index/
    const boundaryFiles = [
      ...await walk(uiDir, (p) => /\.(js|mjs|html)$/.test(p) && !p.includes(`${path.sep}vendor${path.sep}`)),
      ...await walk(webDir, (p) => /\.(js|mjs)$/.test(p)),
    ];
    for (const f of boundaryFiles) {
      const text = await fsp.readFile(f, 'utf8');
      for (const m of text.matchAll(/['"](\.\.\/(?:hygiene|storage|index)\/[^'"]*)['"]/g)) {
        const line = text.slice(0, m.index).split('\n').length;
        problems.push(`${rel(f)}:${line} → import "${m[1]}"（Web 层禁止触碰 hygiene/storage/index）`);
      }
    }
    // ui/ 专属规则（**排除 vendor/**：第三方自托管资产不是我们维护的源码，
    //  它们的体积/风格由 VENDOR.md 与 Q13 管，Q9 只管我们自己的 ui/*.js|html|css）
    const uiSrcs = await walk(uiDir, (p) => /\.(js|mjs|html|css)$/.test(p) && !p.includes(`${path.sep}vendor${path.sep}`));
    uiFiles += uiSrcs.length;
    for (const f of uiSrcs) {
      const raw = await fsp.readFile(f, 'utf8');
      const text = stripBlockComments(raw);
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const ln = i + 1;
        const rawLine = raw.split('\n')[i] ?? '';
        if (rawLine.includes('q9-allow')) {
          // 审核 B6：白名单必须带理由（`// q9-allow: <理由>`），否则等于无条件豁免
          const m = /q9-allow\s*:\s*(\S.{2,})/.exec(rawLine);
          if (!m) problems.push(`${rel(f)}:${ln} → q9-allow 缺少理由（写成 // q9-allow: 为什么这一行必须例外）`);
          continue;
        }
        const code = codePartOfLine(lines[i]);
        // 2) 不得出现 http:// 或 https:// 外链（注释/纯文本同样拦截，故用原始行）
        for (const m of rawLine.matchAll(/https?:\/\//g)) {
          problems.push(`${rel(f)}:${ln} → 外链 "${m[0]}"（ui/ 禁止外链，确需请加 // q9-allow 并说明）`);
        }
        // 3) 不得用 innerHTML/outerHTML/insertAdjacentHTML
        for (const m of code.matchAll(/(?:innerHTML|outerHTML|insertAdjacentHTML)/g)) {
          problems.push(`${rel(f)}:${ln} → 使用 "${m[0]}"（数据必须走 textContent/DOM API）`);
        }
        // 4) 不得 eval( / new Function(
        for (const m of code.matchAll(/eval\(|new Function\(/g)) {
          problems.push(`${rel(f)}:${ln} → 使用 "${m[0].slice(0, -1)}("（ui/ 禁止动态代码执行）`);
        }
      }
    }
    // 5) 零构建 + 规模阈值（docs/08 §8 声明的 Q9 语义，之前只写在文档里没实现）：
    //    单文件 ≤ 600 行、ui/ 总量 ≤ 3700 行、无 package.json/node_modules/构建产物
    //    3700（v1.0.1）：新增侧边栏+顶栏布局与图谱工具栏样式约 130 行 CSS；
    //    同时删掉自研 3D 布局 layout.js（241 行）——净增是「换库后的一次性样式成本」。
    const UI_MAX_FILE_LINES = 600;
    const UI_MAX_TOTAL_LINES = 3700;
    let uiTotalLines = 0;
    for (const f of uiSrcs) {
      const n = (await fsp.readFile(f, 'utf8')).split('\n').length;
      uiTotalLines += n;
      if (n > UI_MAX_FILE_LINES) {
        problems.push(`${rel(f)}: ${n} 行 > ${UI_MAX_FILE_LINES}（Q9 单文件上限，拆模块而不是放宽阈值）`);
      }
    }
    if (uiTotalLines > UI_MAX_TOTAL_LINES) {
      problems.push(`${rel(uiDir)}: ui/ 共 ${uiTotalLines} 行 > ${UI_MAX_TOTAL_LINES}（Q9 总量上限）`);
    }
    for (const banned of ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock',
      'node_modules', 'dist', 'build', '.vite', '.cache']) {
      const hit = await fsp.stat(path.join(uiDir, banned)).catch(() => null);
      if (hit) problems.push(`${rel(path.join(uiDir, banned))}: ui/ 必须零构建（不允许 ${banned}）`);
    }
    // HTML 的 <script src> / <link href> 只允许相对路径（不许 / 开头或协议相对）
    for (const f of uiSrcs.filter((p) => p.endsWith('.html'))) {
      const text = await fsp.readFile(f, 'utf8');
      for (const m of text.matchAll(/<(?:script|link)\b[^>]*?(?:src|href)\s*=\s*"([^"]*)"/g)) {
        const ref = m[1];
        if (/^(?:[a-z]+:|\/\/|\/)/i.test(ref)) {
          const line = text.slice(0, m.index).split('\n').length;
          problems.push(`${rel(f)}:${line} → 资源 "${ref}" 不是相对路径（ui/ 只能引用自身）`);
        }
      }
    }

    // 6) 静态资源白名单：src/web/static.js 必须存在且只服务 ui 目录（存在性 + 关键字）
    const staticPath = path.join(webDir, 'static.js');
    // 直接读，不做 stat→read 两步（避免 TOCTOU 告警；ENOENT 即视为缺失）
    let staticText = null;
    try {
      staticText = await fsp.readFile(staticPath, 'utf8');
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    if (staticText === null) {
      problems.push(`${rel(v)}: 缺少 src/web/static.js（静态资源必须经白名单 handler 服务）`);
    } else if (!/createStaticHandler/.test(staticText) || !/uiDir/.test(staticText) || !/path\.resolve/.test(staticText)) {
      problems.push(`${rel(staticPath)}: 未识别"只服务 ui 目录"的解析逻辑（需 createStaticHandler + uiDir + path.resolve）`);
    }
  }
  record('Q9', `Web UI 层边界（ui ${uiFiles} 文件：无越界 import/外链/innerHTML/eval，零构建 + 单文件≤600 行 + 总量≤3700 行，static 白名单）`,
    problems.length === 0, problems.slice(0, 12));
}

CURRENT = await readCurrentVersion();


// ── Q10 发布面同步 ────────────────────────────────────────────────
// 起因（2026-11-10）：v0.4 上线后 README 与项目站仍停在 v0.3 —— 数字、"新增能力"、
// 安装路径、CI 检查名全都过期，但没有任何门禁拦。发布面是给人看的唯一入口，
// 它一旦落后就等于对外撒谎，所以必须有机械检查。
//
// 三条断言（都是"改了就忘"的高频漂移点）：
//   1. README 版本表必须出现当前版本号 vX.Y.Z；
//   2. docs/index.html 必须出现当前 X.Y.Z（项目站的时间线/门禁数字跟着走）；
//   3. ci.yml 的 eval job 名必须与 eval/run.js 的用例数一致（改名忘了同步分支保护会卡死 PR）。
async function q10ReleaseSurface() {
  const problems = [];
  const versionDir = currentVersionDir();
  const pkgPath = path.join(versionDir, 'package.json');
  const pkg = JSON.parse(await fsp.readFile(pkgPath, 'utf8'));
  const version = String(pkg.version ?? '');
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    problems.push(`${rel(pkgPath)}: version 不是 X.Y.Z（实际 ${JSON.stringify(version)}）`);
  }

  // 1) README 版本表
  const readme = await fsp.readFile(path.join(ROOT, 'README.md'), 'utf8');
  if (version && !readme.includes(`v${version}`)) {
    problems.push(`README.md: 版本表没有当前版本 v${version}（发版必须同步 README）`);
  }

  // 2) 项目站
  const pagePath = path.join(ROOT, 'docs', 'index.html');
  const page = await fsp.readFile(pagePath, 'utf8');
  if (version && !page.includes(version)) {
    problems.push(`${rel(pagePath)}: 没有当前版本号 ${version}（发版必须同步项目站时间线）`);
  }

  // 3) CI eval job 名 vs 评测用例数
  const ci = await fsp.readFile(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  const evalRun = await fsp.readFile(path.join(versionDir, 'eval', 'run.js'), 'utf8');
  const caseCount = (evalRun.match(/^\s*\['I\d+'/gm) ?? []).length;
  const m = ci.match(/name:\s*eval \(I1–I(\d+)\)/);
  if (!m) {
    problems.push('.github/workflows/ci.yml: eval job 名不是 `eval (I1–IN)` 形状');
  } else if (caseCount && Number(m[1]) !== caseCount) {
    problems.push(`.github/workflows/ci.yml: eval job 名写 I1–I${m[1]}，但 eval/run.js 有 ${caseCount} 个用例（改名后记得同步分支保护 required checks）`);
  }

  record('Q10', `发布面同步（README 版本表 / 项目站 / CI eval 用例区间，当前 v${version || '?'}）`, problems.length === 0, problems);
}

// ── Q11 写侧粒度与会话库契约（v0.6）───────────────────────────────
// 起因：v0.6 把「一个记录 = 一个可判断的事实」写进契约，并新增会话临时库。
// 这两件事都很容易被后续改动悄悄退化（例如把 MAX_TEXT 静默截断改回去、
// 或者把 session 的 fact 禁令删掉），所以用机械检查钉住结构性事实。
async function q11WriteAndSessionContract() {
  const problems = [];
  const versionDir = currentVersionDir();
  const policyPath = path.join(versionDir, 'config', 'policy.json');
  const policy = JSON.parse(await fsp.readFile(policyPath, 'utf8'));

  // 1) write 段必须是数据（阈值可在配置里调，不是散在代码里的常量）
  const write = policy.write;
  if (!write || typeof write !== 'object') {
    problems.push(`${rel(policyPath)}: 缺 write 段（写侧粒度契约必须可配置）`);
  } else {
    if (!Number.isFinite(write.textHardMaxChars) || write.textHardMaxChars <= 0) problems.push(`${rel(policyPath)}: write.textHardMaxChars 必须是正数`);
    if (!Number.isFinite(write.valueRecommendChars) || write.valueRecommendChars <= 0) problems.push(`${rel(policyPath)}: write.valueRecommendChars 必须是正数`);
    if (!Array.isArray(write.titleRequiredKinds) || write.titleRequiredKinds.length === 0) problems.push(`${rel(policyPath)}: write.titleRequiredKinds 不能为空`);
  }

  // 2) record.js 不得把硬上限做成静默截断（老实现是 text.slice(0, MAX_TEXT-1) + '…'）
  const recordPath = path.join(versionDir, 'src', 'core', 'record.js');
  const recordSrc = await fsp.readFile(recordPath, 'utf8');
  if (!/textHardMaxChars/.test(recordSrc)) problems.push(`${rel(recordPath)}: 没读到 write.textHardMaxChars（硬上限必须来自 policy）`);
  if (/slice\(\s*0\s*,\s*MAX_TEXT\s*-\s*1\s*\)/.test(recordSrc)) problems.push(`${rel(recordPath)}: 又出现了 MAX_TEXT 静默截断（契约要求超硬上限报错）`);

  // 3) 会话库：fact 禁令必须在写路径上生效
  const lifecyclePath = path.join(versionDir, 'src', 'session', 'lifecycle.js');
  let lifecycleSrc = '';
  try {
    lifecycleSrc = await fsp.readFile(lifecyclePath, 'utf8');
  } catch {
    problems.push(`${rel(lifecyclePath)}: 不存在（v0.6 的会话库实现缺失）`);
  }
  if (lifecycleSrc && !/E_SCRATCH_KIND_FORBIDDEN/.test(lifecycleSrc)) problems.push(`${rel(lifecyclePath)}: 没有 E_SCRATCH_KIND_FORBIDDEN（临时库必须拒绝 fact）`);
  const writePathSrc = await fsp.readFile(path.join(versionDir, 'src', 'api', 'write-path.js'), 'utf8');
  if (!/assertWritableKind|E_SCRATCH_KIND_FORBIDDEN|startsWith\(\s*['"]session:/.test(writePathSrc)) {
    problems.push(`${rel(path.join(versionDir, 'src', 'api', 'write-path.js'))}: 写路径没有会话库 kind 校验（禁令只写在注释里等于没有）`);
  }

  // 4) 这两条契约必须有注入式评测兜底
  const evalSrc = await fsp.readFile(path.join(versionDir, 'eval', 'run.js'), 'utf8');
  for (const id of ['I37', 'I38', 'I39']) {
    // 用 includes 而不是 new RegExp：正则里的 ['I37' 会被解析成字符类开头（Unterminated character class）
    if (!evalSrc.includes(`['${id}'`)) {
      problems.push(`${rel(path.join(versionDir, 'eval', 'run.js'))}: 缺少 ${id} 用例登记（写侧/会话库契约必须有端到端评测）`);
    }
  }

  record('Q11', '写侧粒度与会话库契约（policy.write 可配置 / 无静默截断 / session 禁 fact / I37–I39 在册）', problems.length === 0, problems);
}


// ── Q15 LLM 派生层契约（v1.0）───────────────────────────────
// 起因：v1.0 引入 LLM 总结层（派生 title/summary）。它必须永远是**可丢弃的投影**：
//   - llm 层不得 import storage/**（否则派生读取会绕开真相层的锁与增量水位）；
//   - llm 层源码不得出现 items/ 真相层写入（派生写真相层 = I44「字节不变」直接失效）；
//   - policy.llm 必须存在且 egress 有明确取值（隐私默认值不能被删）；
//   - 派生提示版本必须是常量（幂等键 (id, validFrom, promptVersion) 依赖它）。
async function q15LlmDeriveContract() {
  const problems = [];
  const versionDir = currentVersionDir();

  // 1) policy.llm / derive 段存在且关键字段有值
  const policyPath = path.join(versionDir, 'config', 'policy.json');
  const policy = JSON.parse(await fsp.readFile(policyPath, 'utf8'));
  if (!policy.llm || typeof policy.llm !== 'object') {
    problems.push(`${rel(policyPath)}: 缺 llm 段（LLM 端口必须可配置，默认 provider=none）`);
  } else {
    if (typeof policy.llm.provider !== 'string') problems.push(`${rel(policyPath)}: llm.provider 必须是字符串`);
    if (!['local-only', 'allowed'].includes(policy.llm.egress)) problems.push(`${rel(policyPath)}: llm.egress 必须是 local-only 或 allowed`);
    if (!Number.isFinite(policy.llm.dailyLimitCny)) problems.push(`${rel(policyPath)}: llm.dailyLimitCny 必须是数字（成本护栏）`);
  }
  if (!policy.derive || typeof policy.derive.promptVersion !== 'string') {
    problems.push(`${rel(policyPath)}: 缺 derive.promptVersion（幂等键依赖提示版本）`);
  }

  // 2) llm 层不得依赖 storage 层（Q15 核心：派生层与真相层解耦）
  const llmDir = path.join(versionDir, 'src', 'llm');
  let files = [];
  try {
    files = (await fsp.readdir(llmDir)).filter((f) => f.endsWith('.js'));
  } catch {
    problems.push(`${rel(llmDir)}: 不存在（v1.0 LLM 层缺失）`);
  }
  for (const f of files) {
    const p = path.join(llmDir, f);
    const src = await fsp.readFile(p, 'utf8');
    if (/from\s+['"][^'"]*\/storage\//.test(src) || /import\(\s*['"][^'"]*\/storage\//.test(src)) {
      problems.push(`${rel(p)}: llm 层不得 import storage/**（派生层必须与真相层解耦）`);
    }
    // 真相层文件名只能在注释里被提及，不能出现在可执行代码里
    const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    if (/itemsFileName\s*\(|['"]items['"]\s*,/.test(codeOnly)) {
      problems.push(`${rel(p)}: llm 层不得写 items/ 真相层（I44 要求派生前后真相层字节不变）`);
    }
  }

  // 3) 派生提示版本是导出常量
  const derivePath = path.join(llmDir, 'derive.js');
  try {
    const src = await fsp.readFile(derivePath, 'utf8');
    if (!/export\s+const\s+DERIVE_PROMPT_VERSION/.test(src)) {
      problems.push(`${rel(derivePath)}: 必须导出 DERIVE_PROMPT_VERSION 常量`);
    }
  } catch {
    problems.push(`${rel(derivePath)}: 不存在（派生逻辑缺失）`);
  }

  // 4) 派生层必须有注入式评测兜底
  const evalSrc = await fsp.readFile(path.join(versionDir, 'eval', 'run.js'), 'utf8');
  for (const id of ['I41', 'I42', 'I43', 'I44', 'I45', 'I46']) {
    if (!evalSrc.includes(`['${id}'`)) {
      problems.push(`${rel(path.join(versionDir, 'eval', 'run.js'))}: 缺少 ${id} 用例登记（派生层契约必须有端到端评测）`);
    }
  }

  record('Q15', 'LLM 派生层契约（policy.llm 可配置 / llm 不碰 storage 与真相层 / 提示版本常量 / I41–I46 在册）', problems.length === 0, problems);
}


// ── Q13 vendor 资产登记（v1.0 W6）───────────────────────────────
// 起因：UI 重做允许自托管第三方资产（Tabler/uPlot/force-graph），但必须可复现、可审计：
//   - 每个文件都在 VENDOR.md 登记了版本/上游/LICENSE/sha256；
//   - 磁盘上的 sha256 与登记值一致（防止被悄悄替换）；
//   - 登记了的 LICENSE 文件真的存在；
//   - ui/** 不得引用任何 CDN（禁外链，离线可用）。
async function q13VendorAssets() {
  const problems = [];
  const versionDir = currentVersionDir();
  const vendorDir = path.join(versionDir, 'ui', 'vendor');
  const manifestPath = path.join(vendorDir, 'VENDOR.md');

  let manifest = '';
  try {
    manifest = await fsp.readFile(manifestPath, 'utf8');
  } catch {
    record('Q13', 'vendor 资产登记（VENDOR.md sha256 / LICENSE / 禁 CDN）', true, []);
    return; // 没有 vendor 目录即视为本版本未引入第三方资产
  }

  const registered = new Map(); // 文件名 -> sha256
  for (const line of manifest.split('\n')) {
    const m = /^\|\s*`([^`]+)`\s*\|.*\|\s*`([0-9a-f]{64})`\s*\|\s*$/.exec(line);
    if (m) registered.set(m[1], m[2]);
  }
  if (registered.size === 0) problems.push(`${rel(manifestPath)}: 没有解析到任何登记行（表格格式：| \`file\` | 上游 | 版本 | LICENSE | \`sha256\` |）`);

  const files = (await fsp.readdir(vendorDir)).filter((f) => /\.(js|css)$/.test(f));
  const crypto = await import('node:crypto');
  for (const f of files) {
    if (!registered.has(f)) {
      problems.push(`${rel(path.join(vendorDir, f))}: 未在 VENDOR.md 登记（第三方资产必须可追溯）`);
      continue;
    }
    const buf = await fsp.readFile(path.join(vendorDir, f));
    const actual = crypto.createHash('sha256').update(buf).digest('hex');
    if (actual !== registered.get(f)) {
      problems.push(`${rel(path.join(vendorDir, f))}: sha256 不匹配（登记 ${registered.get(f).slice(0, 12)}… 实际 ${actual.slice(0, 12)}…）`);
    }
  }
  // LICENSE 存在性：每个登记的上游必须有对应 *.LICENSE
  const licenses = (await fsp.readdir(vendorDir)).filter((f) => f.endsWith('.LICENSE'));
  if (licenses.length === 0) problems.push(`${rel(vendorDir)}: 缺少 *.LICENSE（第三方资产必须随附许可证）`);

  // 禁 CDN：ui/** 不得出现外链（vendor 自身文件除外）
  const uiFiles = await walk(path.join(versionDir, 'ui'), (p) => /\.(js|mjs|html|css)$/.test(p) && !p.includes(`${path.sep}vendor${path.sep}`));
  for (const f of uiFiles) {
    const text = await fsp.readFile(f, 'utf8');
    for (const m of text.matchAll(/https?:\/\/(?:cdn\.|unpkg|cdnjs|jsdelivr)[^\s'"`)]*/g)) {
      problems.push(`${rel(f)}: 引用了 CDN "${m[0]}"（必须自托管到 ui/vendor 并在 VENDOR.md 登记）`);
    }
  }

  record('Q13', `vendor 资产登记（${registered.size} 个文件 sha256 / LICENSE / 禁 CDN）`, problems.length === 0, problems);
}

async function q14DocsGovernance() {
  const { checkDocs } = await import('./docs-drift-check.mjs');
  const report = await checkDocs({ root: ROOT });
  const problems = report.findings.map(
    (f) => `${f.file}${f.line ? ':' + f.line : ''} [${f.rule}] ${f.message}`,
  );
  record('Q14', `文档治理（头部元信息 / 版本一致 / 无旧路径 / 测试数与 I 区间 / 门禁项数；脚本 tools/docs-drift-check.mjs）`,
    problems.length === 0, problems);
}

const CHECKS = [q1ZeroDependencies, q2SourceSize, q3TestInventory, q4EvalAlignment,
  q5ContractCoverage, q6DocLinks, q7VersionIntegrity, q8Encoding, q9WebUiBoundary, q10ReleaseSurface, q11WriteAndSessionContract, q14DocsGovernance, q15LlmDeriveContract, q13VendorAssets];

for (const check of CHECKS) {
  try {
    await check();
  } catch (e) {
    record(check.name.toUpperCase(), `检查自身异常：${e.message}`, false, [String(e.stack ?? '').split('\n')[1] ?? '']);
  }
}

const failed = results.filter((r) => !r.ok);
if (JSON_OUT) {
  console.log(JSON.stringify({
    thresholds: THRESHOLDS, ok: failed.length === 0, total: results.length,
    failed: failed.length, checks: results,
  }, null, 2));
} else {
  console.log('');
  console.log(failed.length === 0
    ? `质量门禁通过：${results.length}/${results.length}`
    : `质量门禁失败：${failed.length}/${results.length} 项不达标（${failed.map((r) => r.id).join(', ')}）`);
}
process.exit(failed.length === 0 ? 0 : 1);
