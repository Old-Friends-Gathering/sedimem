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
  maxTotalSrcLines: 8000,
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

async function versionDirs() {
  const base = path.join(ROOT, 'versions');
  return (await fsp.readdir(base, { withFileTypes: true }))
    .filter((d) => d.isDirectory()).map((d) => path.join(base, d.name));
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
      ...await walk(uiDir, (p) => /\.(js|mjs|html)$/.test(p)),
      ...await walk(webDir, (p) => /\.(js|mjs)$/.test(p)),
    ];
    for (const f of boundaryFiles) {
      const text = await fsp.readFile(f, 'utf8');
      for (const m of text.matchAll(/['"](\.\.\/(?:hygiene|storage|index)\/[^'"]*)['"]/g)) {
        const line = text.slice(0, m.index).split('\n').length;
        problems.push(`${rel(f)}:${line} → import "${m[1]}"（Web 层禁止触碰 hygiene/storage/index）`);
      }
    }
    // ui/ 专属规则
    const uiSrcs = await walk(uiDir, (p) => /\.(js|mjs|html|css)$/.test(p));
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
    //    单文件 ≤ 600 行、ui/ 总量 ≤ 2500 行、无 package.json/node_modules/构建产物
    const UI_MAX_FILE_LINES = 600;
    const UI_MAX_TOTAL_LINES = 2500;
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
  record('Q9', `Web UI 层边界（ui ${uiFiles} 文件：无越界 import/外链/innerHTML/eval，零构建 + 单文件≤600 行 + 总量≤2500 行，static 白名单）`,
    problems.length === 0, problems.slice(0, 12));
}

CURRENT = await readCurrentVersion();

const CHECKS = [q1ZeroDependencies, q2SourceSize, q3TestInventory, q4EvalAlignment,
  q5ContractCoverage, q6DocLinks, q7VersionIntegrity, q8Encoding, q9WebUiBoundary];

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
