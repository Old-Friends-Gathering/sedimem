#!/usr/bin/env node
/**
 * pages-verify.mjs —— 校验 GitHub Pages 上的项目站是否已经是当前版本。
 *
 * 起因（2026-11-10）：Q10 只在合并前检查「仓库里」的 README 与 docs/index.html，
 * 但 Pages 是合并之后由 GitHub 异步构建的 —— 构建失败、构建落后、或有人把 Pages
 * 源改成别处，仓库里一切绿灯，线上仍是旧版本，没人知道。
 *
 * 这个脚本做一件事：抓线上首页，确认它出现在当前版本号 vX.Y.Z，并抽查三张截图能不能取到。
 * 构建需要几分钟，所以默认重试 20 次 × 15s（≈5 分钟），超时才算失败。
 *
 * 用法：
 *   node tools/pages-verify.mjs                     # 默认查线上首页 vs versions/CURRENT
 *   node tools/pages-verify.mjs --expect v0.5.0     # 指定版本
 *   node tools/pages-verify.mjs --url http://127.0.0.1:7800/ --attempts 1   # 本地试用
 *   node tools/pages-verify.mjs --json              # 机器可读（CI 用）
 *
 * 退出码：0 = 线上与当前版本一致；1 = 不一致 / 取不到 / 资产 404；2 = 用法错误。
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_URL = 'https://old-friends-gathering.github.io/sedimem/';
/** 抽查的静态资产：它们 404 说明站点是半坏的 */
export const DEFAULT_ASSETS = ['assets/today.png', 'assets/graph.png', 'assets/hygiene.png'];

/**
 * 从 versions/CURRENT 读当前版本号。
 * @returns {Promise<{version: string, dir: string}>}
 */
export async function currentVersion({ root = ROOT } = {}) {
  const name = (await fsp.readFile(path.join(root, 'versions', 'CURRENT'), 'utf8')).trim();
  if (!name) throw new Error('versions/CURRENT 是空的');
  const dir = path.join(root, 'versions', name);
  const pkg = JSON.parse(await fsp.readFile(path.join(dir, 'package.json'), 'utf8'));
  const version = String(pkg.version ?? '');
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`${path.join(dir, 'package.json')} 的 version 不是 X.Y.Z：${JSON.stringify(version)}`);
  }
  return { version, dir };
}

/**
 * 答案：站点 HTML 里是否出现这个版本号（`v0.5.0`）。
 * 只做子串匹配 —— 页面里版本号出现在时间线与安装片段，匹配到即说明构建用了新内容。
 * @param {string} html
 * @param {string} version 形如 `0.5.0`
 */
export function htmlMentionsVersion(html, version) {
  const needle = `v${version}`;
  return typeof html === 'string' && html.includes(needle);
}

/**
 * 单次检查（不重试）。纯函数式：fetch 与 sleep 都可注入，便于单测。
 * @param {{
 *   url?: string,
 *   version: string,
 *   assets?: string[],
 *   fetchImpl?: typeof fetch,
 *   checkAssets?: boolean,
 * }} opts
 * @returns {Promise<{ok: boolean, reason: string, detail: object}>}
 */
export async function verifyOnce(opts) {
  const {
    url = DEFAULT_URL,
    version,
    assets = DEFAULT_ASSETS,
    fetchImpl = globalThis.fetch,
    checkAssets = true,
  } = opts;
  const base = url.endsWith('/') ? url : `${url}/`;

  let res;
  try {
    res = await fetchImpl(base, { redirect: 'follow' });
  } catch (e) {
    return { ok: false, reason: 'fetch-failed', detail: { url: base, error: String(e?.message ?? e) } };
  }
  if (!res.ok) {
    return { ok: false, reason: 'http-error', detail: { url: base, status: res.status } };
  }
  const html = await res.text();
  if (!htmlMentionsVersion(html, version)) {
    return { ok: false, reason: 'version-mismatch', detail: { url: base, expect: `v${version}`, bytes: html.length } };
  }
  const missing = [];
  if (checkAssets) {
    for (const a of assets) {
      try {
        const r = await fetchImpl(`${base}${a}`, { method: 'GET' });
        if (!r.ok) missing.push({ asset: a, status: r.status });
      } catch {
        missing.push({ asset: a, status: 0 });
      }
    }
  }
  if (missing.length > 0) {
    return { ok: false, reason: 'asset-missing', detail: { url: base, missing } };
  }
  return { ok: true, reason: 'ok', detail: { url: base, version: `v${version}`, bytes: html.length } };
}

/**
 * 带重试的检查：Pages 构建是异步的，合并后立刻抓往往是旧内容。
 * @param {{
 *   url?: string, version: string, attempts?: number, intervalMs?: number,
 *   fetchImpl?: typeof fetch, sleep?: (ms:number)=>Promise<void>, log?: (s:string)=>void,
 *   checkAssets?: boolean,
 * }} opts
 */
export async function verifyWithRetry(opts) {
  const {
    attempts = 20,
    intervalMs = 15000,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    log = () => {},
    ...rest
  } = opts;
  let last = { ok: false, reason: 'not-run', detail: {} };
  for (let i = 1; i <= attempts; i += 1) {
    last = await verifyOnce(rest);
    if (last.ok) {
      log(`第 ${i}/${attempts} 次：通过（${last.detail.version}）`);
      return { ...last, attempts: i };
    }
    // 版本不一致 / 资产缺失都有可能是"构建还没跑完"，继续等；HTTP 5xx 也可能瞬时
    log(`第 ${i}/${attempts} 次：${last.reason}`);
    if (i < attempts) await sleep(intervalMs);
  }
  return { ...last, attempts };
}

function parseArgs(argv) {
  const out = { json: false, attempts: undefined, intervalMs: undefined, url: undefined, expect: undefined, checkAssets: true };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--no-assets') out.checkAssets = false;
    else if (a === '--url') out.url = argv[++i];
    else if (a === '--expect') out.expect = argv[++i];
    else if (a === '--attempts') out.attempts = Number(argv[++i]);
    else if (a === '--interval-ms') out.intervalMs = Number(argv[++i]);
    else if (a === '--help' || a === '-h') out.help = true;
    else {
      out.error = `未知参数：${a}`;
      break;
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) {
    console.error(args.error);
    process.exit(2);
  }
  if (args.help) {
    console.log('用法：node tools/pages-verify.mjs [--url <url>] [--expect vX.Y.Z] [--attempts N] [--interval-ms M] [--no-assets] [--json]');
    return;
  }
  let version;
  if (args.expect) {
    const m = String(args.expect).match(/^v?(\d+\.\d+\.\d+)$/);
    if (!m) {
      console.error(`--expect 需要形如 v0.5.0，收到 ${args.expect}`);
      process.exit(2);
    }
    version = m[1];
  } else {
    ({ version } = await currentVersion());
  }

  const result = await verifyWithRetry({
    url: args.url,
    version,
    attempts: args.attempts,
    intervalMs: args.intervalMs,
    checkAssets: args.checkAssets,
    log: args.json ? () => {} : (s) => console.error(s),
  });
  if (args.json) {
    console.log(JSON.stringify({ ok: result.ok, reason: result.reason, expect: `v${version}`, ...result.detail, attempts: result.attempts }, null, 2));
  } else if (result.ok) {
    console.log(`PASS  ${result.detail.url} 已是 v${version}（${result.detail.bytes} 字节，${result.attempts} 次内确认）`);
  } else {
    console.error(`FAIL  ${result.reason}`);
    console.error(JSON.stringify(result.detail, null, 2));
  }
  process.exit(result.ok ? 0 : 1);
}

// 只在直接执行时跑 main（被 import 时保持纯函数）
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`pages-verify 自身异常：${e?.message ?? e}`);
    process.exit(2);
  });
}
