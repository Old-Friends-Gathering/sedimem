#!/usr/bin/env node
/**
 * tools/shots.mjs —— 可重复生成英文 UI 截图（不手改 PNG）。
 *
 * 做法：临时 MEMO_HOME → 写入一组英文 demo 记录 → 建一个任务库并追加 checkpoint
 * → 起 `memo serve` → 无头 Chrome 截 today/graph/hygiene/session 四页 → 停服务。
 *
 * 用法：
 *   node tools/shots.mjs                 # 写到 docs/shots/ui-*-en.png
 *   node tools/shots.mjs --keep          # 保留临时 MEMO_HOME，便于排查
 *   CHROME="/path/to/Chrome" node tools/shots.mjs
 *
 * 只依赖 node:child_process 与本机 Chrome；不访问外网。
 */
import { execFileSync, spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const CURRENT = fs.readFileSync(path.join(ROOT, 'versions/CURRENT'), 'utf8').trim();
const CLI = path.join(ROOT, 'versions', CURRENT, 'src/cli/memo.js');
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(process.env.PORT ?? 7799);
const OUT = path.join(ROOT, 'docs/shots');
const KEEP = process.argv.includes('--keep');

const RECORDS = [
  ['decision', 'Truth layer is append-only JSONL; never rewrite history in place.', 'architecture,storage'],
  ['decision', 'MCP surface is 17 tools; the default surface will shrink to core in v1.4.', 'mcp'],
  ['gotcha', 'Do not put secrets in environment variables: child processes can read them.', 'security'],
  ['fact', 'English diagrams are generated with --lang en from the same HTML source.', 'docs'],
  ['fact', 'A task store is a temporary memory bound to session:<task-id>.', 'session'],
  ['decision', 'Prefer a deterministic nonce derived from contentHash + asOf.', 'injection'],
  ['gotcha', 'Always verify the live site version after merge.', 'release'],
  ['pref', 'Keep the observatory read-only by default; editing needs --write.', 'ui'],
];

const CHECKPOINT = {
  intent: 'Ship English documentation and screenshots for the project site.',
  concepts: ['DOM-layer i18n', 'deterministic diagrams', 'English demo data'],
  files: ['README.en.md', 'docs/en/index.html', 'tools/diagrams/i18n.mjs', 'ui/i18n.js'],
  errorsAndFixes: ['Diagram height clipped the session footer → per-diagram height'],
  pendingJobs: ['wire English screenshots', 'run gates'],
  currentState: 'Schematics are English; UI pages are translated at runtime; screenshots pending.',
  nextSteps: ['copy screenshots', 'update references', 'run gates'],
  criticalContext: 'Translate chrome and fixed labels only; never translate user data.',
};

function run(args, env) {
  return execFileSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    env: { ...process.env, MEMO_HOME: env.memoHome },
    encoding: 'utf8',
  });
}

async function waitFor(url, attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server did not become ready: ${url}`);
}

async function shot(name, hash, outFile) {
  const url = `http://127.0.0.1:${PORT}/?lang=en#${hash}`;
  execFileSync(CHROME, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
    '--force-device-scale-factor=2', '--window-size=1440,900',
    '--virtual-time-budget=6000', `--screenshot=${outFile}`, url,
  ], { stdio: 'ignore' });
  process.stdout.write(`✓ ${path.relative(ROOT, outFile)}\n`);
}

const memoHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'sedimem-shots-'));
const env = { memoHome };
let server;
try {
  await fsp.mkdir(path.join(memoHome, 'sessions'), { recursive: true });
  for (const [kind, text, tags] of RECORDS) {
    run(['write', '--scope', 'repo:sedimem', '--kind', kind, '--tags', tags, '--text', text], env);
  }
  const start = run(['session', 'start', '--title', 'Localize English docs'], env);
  const scope = /session:[a-z0-9-]+/i.exec(start)?.[0];
  if (!scope) throw new Error(`session start did not return a scope: ${start}`);
  const cpFile = path.join(memoHome, 'checkpoint.json');
  await fsp.writeFile(cpFile, JSON.stringify(CHECKPOINT));
  run(['session', 'checkpoint', '--scope', scope, '--file', cpFile], env);

  server = spawn(process.execPath, [CLI, 'serve', '--port', String(PORT)], {
    cwd: ROOT,
    env: { ...process.env, MEMO_HOME: memoHome },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  await waitFor(`http://127.0.0.1:${PORT}/api/summary`);
  await fsp.mkdir(OUT, { recursive: true });
  await shot('today', 'today', path.join(OUT, 'ui-today-en.png'));
  await shot('graph', 'graph', path.join(OUT, 'ui-graph-en.png'));
  await shot('hygiene', 'hygiene', path.join(OUT, 'ui-hygiene-en.png'));
  await shot('session', 'session', path.join(OUT, 'ui-session-en.png'));
} finally {
  server?.kill('SIGTERM');
  if (KEEP) process.stdout.write(`kept MEMO_HOME=${memoHome}\n`);
  else await fsp.rm(memoHome, { recursive: true, force: true });
}
