#!/usr/bin/env node
// tools/security-check.mjs — 安全门禁（零依赖，本地与 CI 同源）
//
// 覆盖"仓库里不该出现的东西"这一类可机检风险：
//   个人路径 / 凭据 / 内部域名 / 内网地址 / 生成物入库 / 许可证缺失 / 超大文件。
// 供应链层面本项目零依赖（Q1 保证），因此不需要 npm audit；但 CI 里另跑 CodeQL + gitleaks 兜底历史。
//
// 用法：node tools/security-check.mjs [--json] [--quiet]

import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const JSON_OUT = args.has('--json');
const QUIET = args.has('--quiet');

const results = [];
function record(id, title, ok, detail = []) {
  results.push({ id, title, ok, detail });
  if (!JSON_OUT && (!ok || !QUIET)) {
    console.log(`${ok ? '✓' : '✗'} ${id} ${title}`);
    for (const d of detail) console.log(`    ${d}`);
  }
}

/** 优先用 git 跟踪清单（避免扫到未跟踪的本地垃圾），无 git 时退化为目录遍历 */
export async function listFiles() {
  try {
    const { stdout } = await execFileAsync('git', ['ls-files', '-z'], { cwd: ROOT, maxBuffer: 32 * 1024 * 1024 });
    const files = stdout.split('\0').filter(Boolean).map((f) => path.join(ROOT, f));
    if (files.length > 0) return { files, source: 'git ls-files' };
  } catch { /* 无 git 或非仓库：退化 */ }
  const out = [];
  async function walk(dir) {
    for (const ent of await fsp.readdir(dir, { withFileTypes: true })) {
      if (['node_modules', '.git'].includes(ent.name)) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) await walk(full);
      else out.push(full);
    }
  }
  await walk(ROOT);
  return { files: out, source: 'fs walk' };
}

const rel = (p) => path.relative(ROOT, p);
const TEXT_EXT = /\.(js|mjs|cjs|json|md|markdown|yml|yaml|toml|sh|bash|txt|html|css|ts|tsx)$/;

const RULES = [
  {
    id: 'S1', title: '无个人绝对路径（/Users/<name>、/home/<name>、C:\\Users\\）',
    pattern: /(?:\/Users\/[A-Za-z0-9._-]+|\/home\/[A-Za-z0-9._-]+|[A-Za-z]:\\\\?Users\\\\?[A-Za-z0-9._-]+)/g,
    // 调研快照里可能出现上游文档的相对链接（如 /home/overview），非本机路径
    allowFiles: ['docs/research/readmes/'],
  },
  {
    id: 'S2', title: '无凭据/私钥（GH PAT、sk-、AKIA、PEM、Slack token）',
    pattern: /(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|gho_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN (?:RSA |OPENSSH |EC |PGP )?PRIVATE KEY-----)/g,
    allowFiles: [],
  },
  {
    id: 'S3', title: '无公司内部域名/内网地址（addx.live、gitlab.addx.ai、10./192.168./172.16-31.）',
    pattern: /(?:[a-z0-9-]+\.)?addx\.live|(?:10|192\.168|172\.(?:1[6-9]|2[0-9]|3[01]))\.\d{1,3}\.\d{1,3}/g,
    allowFiles: ['docs/research/'], // 调研快照可能引用公开来源，人工确认为公开信息
  },
  {
    id: 'S4', title: '无真实 home 路径残留在客户端配置模板里',
    pattern: /\/(?:Users|home)\/[A-Za-z0-9._-]+\//g,
    allowFiles: [],
    onlyUnder: ['versions/'], // 只看版本目录内的模板
  },
];

async function scanPatterns() {
  const { files, source } = await listFiles();
  const targets = files.filter((f) => TEXT_EXT.test(f));
  for (const rule of RULES) {
    const hits = [];
    for (const f of targets) {
      const r = rel(f);
      if (rule.allowFiles.some((a) => r.startsWith(a))) continue;
      if (rule.onlyUnder && !rule.onlyUnder.some((p) => r.startsWith(p))) continue;
      let text;
      try { text = await fsp.readFile(f, 'utf8'); } catch { continue; }
      // 本脚本自身与 CI 配置里出现模式串是正常的
      if (r === 'tools/security-check.mjs' || r.startsWith('.github/')) continue;
      for (const m of text.matchAll(rule.pattern)) {
        const line = text.slice(0, m.index).split('\n').length;
        hits.push(`${r}:${line} → ${m[0].slice(0, 60)}`);
      }
    }
    record(rule.id, `${rule.title}（扫描 ${targets.length} 个文本文件，来源 ${source}）`, hits.length === 0, hits.slice(0, 12));
  }
}

async function s5Gitignore() {
  const required = ['.memo/', 'node_modules/', '.DS_Store', '*.log', '.env'];
  let text = '';
  try { text = await fsp.readFile(path.join(ROOT, '.gitignore'), 'utf8'); } catch { /* 缺失下面报 */ }
  const missing = required.filter((p) => !text.includes(p));
  record('S5', `.gitignore 覆盖生成物与敏感文件（${required.join(' ')}）`, missing.length === 0 && text !== '',
    text === '' ? ['.gitignore 不存在'] : missing.map((m) => `.gitignore 缺少：${m}`));
}

async function s6License() {
  const problems = [];
  const license = await fsp.readFile(path.join(ROOT, 'LICENSE'), 'utf8').catch(() => '');
  if (!license) problems.push('缺少 LICENSE');
  else if (!/MIT License/i.test(license)) problems.push('LICENSE 不是 MIT（若改协议需同步 README/package.json）');
  else if (!/Copyright \(c\) 2026 Old Friends Gathering/i.test(license)) problems.push('LICENSE 版权行不符合预期');
  const pkgs = [path.join(ROOT, 'versions', 'v0.1', 'package.json')];
  for (const p of pkgs) {
    const pkg = JSON.parse(await fsp.readFile(p, 'utf8').catch(() => '{}'));
    if (pkg.license !== 'MIT') problems.push(`${rel(p)}: license 字段应为 MIT（实际 ${pkg.license ?? '缺失'}）`);
    if (!pkg.repository?.url) problems.push(`${rel(p)}: 缺少 repository.url（可追溯性）`);
  }
  record('S6', '许可证与包元数据（MIT + repository）', problems.length === 0, problems);
}

async function s7LargeOrBinary() {
  const { files } = await listFiles();
  const allowedBinary = /\.(png|jpe?g|gif|svg|ico|pdf|webp)$/i;
  const problems = [];
  for (const f of files) {
    // 只读一次再从 buffer 判断大小/二进制：先 stat 再 read 会构成 TOCTOU（CodeQL js/file-system-race）
    const buf = await fsp.readFile(f).catch(() => null);
    if (!buf) continue;
    if (buf.length > 1024 * 1024) problems.push(`${rel(f)}: ${(buf.length / 1048576).toFixed(2)} MB > 1 MB（大文件走 release/LFS）`);
    if (!allowedBinary.test(f) && !TEXT_EXT.test(f)) {
      if (buf.subarray(0, 8000).includes(0x00)) problems.push(`${rel(f)}: 疑似二进制文件入库（未在白名单）`);
    }
  }
  record('S7', '无超大/意外二进制文件（>1MB、含 NUL 字节且非图片）', problems.length === 0, problems.slice(0, 10));
}

async function s8GitHistorySecrets() {
  // 轻量历史扫描：只查"曾经提交过、现在已删"的密钥模式（完整扫描交给 CI 的 gitleaks）
  let hits = [];
  try {
    const { stdout } = await execFileAsync('git', ['log', '-p', '--all', '--no-color', '--', '.'],
      { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
    const pat = /(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|-----BEGIN (?:RSA |OPENSSH )?PRIVATE KEY-----)/g;
    hits = [...new Set([...stdout.matchAll(pat)].map((m) => m[0].slice(0, 24) + '…'))];
  } catch {
    hits = [];
  }
  record('S8', 'git 历史面扫描（当前提交）', hits.length === 0, hits.slice(0, 5));
}

// ── S9 部署面安全（Web 只读服务） ──────────────────────────────────
// 裁决来源：docs/08-web-ui.md、docs/02 §3.9。Web 层必须：默认回环绑定、无写端点、
// 前端只 fetch /api 相对路径、生成物不入库。
async function s9DeploymentSurface() {
  const problems = [];
  // 只审当前版本（versions/CURRENT）：冻结版本没有 Web 层，不该被当前部署面规则倒逼改动
  const current = await fsp.readFile(path.join(ROOT, 'versions', 'CURRENT'), 'utf8').catch(() => '');
  const name = current.trim();
  const versionsDir = path.join(ROOT, 'versions');
  const versions = name
    ? [path.join(versionsDir, name)]
    : (await fsp.readdir(versionsDir, { withFileTypes: true }))
      .filter((d) => d.isDirectory()).map((d) => path.join(versionsDir, d.name));
  for (const v of versions) {
    // 1) server.js 默认 host 必须是 127.0.0.1
    const serverPath = path.join(v, 'src', 'web', 'server.js');
    const serverText = await fsp.readFile(serverPath, 'utf8').catch(() => null);
    if (serverText === null) {
      problems.push(`${rel(v)}: 缺少 src/web/server.js`);
    } else {
      const lines = serverText.split('\n');
      let found = false;
      lines.forEach((line, i) => {
        const m = line.match(/host\s*=\s*['"]([^'"]+)['"]/);
        if (!m) return;
        found = true;
        if (m[1] === '0.0.0.0' || m[1] === '::' || m[1] !== '127.0.0.1') {
          problems.push(`${rel(serverPath)}:${i + 1} → 默认 host "${m[1]}"（必须是 127.0.0.1 回环绑定）`);
        }
      });
      if (!found) problems.push(`${rel(serverPath)}: 未找到 host 默认值声明（需 host = '127.0.0.1'）`);
    }
    // 2) src/web/** 不得出现写端点调用
    const webFiles = await (async () => {
      const out = [];
      async function w(dir) {
        for (const ent of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
          const full = path.join(dir, ent.name);
          if (ent.isDirectory()) await w(full);
          else if (/\.js$/.test(ent.name)) out.push(full);
        }
      }
      await w(path.join(v, 'src', 'web'));
      return out;
    })();
    const WRITE_CALLS = ['service.write(', 'service.forget(', 'service.supersede(', 'service.curateApply(', 'appendEvent('];
    for (const f of webFiles) {
      const lines = (await fsp.readFile(f, 'utf8').catch(() => '')).split('\n');
      lines.forEach((line, i) => {
        for (const kw of WRITE_CALLS) {
          if (line.includes(kw)) problems.push(`${rel(f)}:${i + 1} → 写调用 "${kw.slice(0, -1)}("（Web 层只读，契约见 docs/08）`);
        }
      });
    }
    // 3) ui/** 不得 fetch 到非 /api 相对路径（fetch("http… / fetch("//…）
    const uiDir = path.join(v, 'ui');
    const uiFiles = await (async () => {
      const out = [];
      async function w(dir) {
        for (const ent of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
          const full = path.join(dir, ent.name);
          if (ent.isDirectory()) await w(full);
          else if (/\.js$/.test(ent.name)) out.push(full);
        }
      }
      await w(uiDir);
      return out;
    })();
    for (const f of uiFiles) {
      const text = await fsp.readFile(f, 'utf8').catch(() => '');
      const lines = text.split('\n');
      lines.forEach((line, i) => {
        for (const m of line.matchAll(/fetch\(\s*['"`]([^'"`]{0,80})/g)) {
          const t = m[1];
          if (/^https?:\/\//.test(t) || /^\/\//.test(t)) {
            problems.push(`${rel(f)}:${i + 1} → fetch "${t}"（只允许 /api 相对路径）`);
          }
        }
      });
    }
  }
  // 4) .gitignore 含 .memo/ 与 node_modules/
  const gi = await fsp.readFile(path.join(ROOT, '.gitignore'), 'utf8').catch(() => '');
  for (const need of ['.memo/', 'node_modules/']) {
    if (!gi.includes(need)) problems.push(`.gitignore 缺少：${need}`);
  }
  record('S9', '部署面安全（Web 默认回环、无写端点、ui 只 fetch /api、.memo/ 不入库）',
    problems.length === 0, problems.slice(0, 12));
}

const CHECKS = [scanPatterns, s5Gitignore, s6License, s7LargeOrBinary, s8GitHistorySecrets, s9DeploymentSurface];
for (const check of CHECKS) {
  try { await check(); } catch (e) {
    record(check.name.toUpperCase(), `检查自身异常：${e.message}`, false, []);
  }
}

const failed = results.filter((r) => !r.ok);
if (JSON_OUT) {
  console.log(JSON.stringify({ ok: failed.length === 0, total: results.length, failed: failed.length, checks: results }, null, 2));
} else {
  console.log('');
  console.log(failed.length === 0 ? `安全门禁通过：${results.length}/${results.length}`
    : `安全门禁失败：${failed.length}/${results.length} 项不达标（${failed.map((r) => r.id).join(', ')}）`);
}
process.exit(failed.length === 0 ? 0 : 1);
