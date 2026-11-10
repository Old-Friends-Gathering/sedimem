#!/usr/bin/env node
// tools/windows-smoke.mjs — Windows 回归冒烟（issue #62 第 1 步）
//
// 为什么是 smoke 而不是全量：全量测试里还有 13 条「POSIX 假设」用例在 Windows 上红
// （已登记独立 issue）。把它们塞进 CI 只会让 windows-latest 永久红，红久了就没人看；
// 本脚本只钉四件事，任何一件坏了都是 Windows 上会**静默丢数据**的真回归：
//   1. 写得进 —— 真相层文件名按 `config/paths.js` 取名（Windows 不含 `:`，不留 ADS）
//   2. 看得见 —— `listScopes` 能从文件名反解出 scope（否则分库下拉/统计全失真）
//   3. 压得动 —— `memo compact` 退出码 0（曾因 copyFile 落 ADS 报 EINVAL）
//   4. 跑得成 —— `nightly` 能写出 brief 快照与 metrics 快照
//
// 零依赖：只用 node 内置模块 + `versions/v0.3/src` 的公开模块。
// POSIX 上同样必须全绿（文件名是 `repo:smoke.jsonl`），所以本地就能先跑一遍；
// 断言一律经 `itemsFileName/briefFileName/metricsFileName` 取路径，绝不硬编码 `:`，
// 这样同一份脚本在两种平台都成立。

import { spawnSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { createMemoryService } from '../versions/v0.3/src/api/service.js';
import { itemsFileName, briefFileName, metricsFileName } from '../versions/v0.3/src/config/paths.js';
import { listScopes } from '../versions/v0.3/src/web/scopes.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const V03 = path.join(ROOT, 'versions', 'v0.3');
const MEMO_CLI = path.join(V03, 'src', 'cli', 'memo.js');
// nightly 是独立入口（`node src/cli/nightly.js`，docs/06 的 crontab 就这么跑），
// memo.js 没有 nightly 子命令——别在这里写成 `memo.js nightly`。
const NIGHTLY_CLI = path.join(V03, 'src', 'cli', 'nightly.js');
const SCOPE = 'repo:smoke';

let failed = 0;

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function pass(name, detail) {
  process.stdout.write(`PASS ${name}${detail ? ` — ${detail}` : ''}\n`);
}

function fail(name, err) {
  failed += 1;
  process.exitCode = 1;
  const msg = err && err.message ? err.message : String(err);
  process.stdout.write(`FAIL ${name} — ${msg}\n`);
}

/** 跑一个断言步骤：成功打 PASS，抛错打 FAIL（不中断后续步骤，CI 日志一次看全）。 */
async function step(name, fn) {
  try {
    pass(name, await fn());
    return true;
  } catch (err) {
    fail(name, err);
    return false;
  }
}

/** spawn 子进程并收集输出；cwd/子进程 env 都显式给，避免本机 ~/.memo 或别的 scope 串进来。 */
function runNode(entry, args, memoHome) {
  const r = spawnSync(process.execPath, [entry, ...args], {
    cwd: ROOT,
    env: { ...process.env, MEMO_HOME: memoHome, MEMO_SCOPE: SCOPE },
    encoding: 'utf8',
    windowsHide: true,
  });
  if (r.error) throw r.error;
  return r;
}

function exitDetail(r) {
  const stderr = (r.stderr ?? '').trim().split('\n').slice(0, 4).join(' | ');
  return `退出码 ${r.status}（signal=${r.signal ?? 'none'}）${stderr ? ` stderr: ${stderr}` : ''}`;
}

/** metrics 文件名带上当天日期；跨 UTC 零点时退化为按 scope 后缀找（避免秒级 flake）。 */
async function resolveMetricsFile(memoHome, expectedName) {
  const dir = path.join(memoHome, 'metrics');
  const exact = path.join(dir, expectedName);
  try {
    await fsp.stat(exact);
    return exact;
  } catch {
    /* 可能恰好跨了 UTC 零点，退化为目录扫描 */
  }
  let names = [];
  try {
    names = await fsp.readdir(dir);
  } catch {
    names = [];
  }
  const hit = names.find((n) => /^\d{4}-\d{2}-\d{2}\.repo-smoke\.json$/.test(n));
  assert(hit, `metrics 目录里没有 <date>.repo-smoke.json（实际：${names.join(', ') || '空'}）`);
  return path.join(dir, hit);
}

async function main() {
  const memoHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'sedimem-windows-smoke-'));
  const itemName = itemsFileName(SCOPE);
  const briefName = briefFileName(SCOPE);
  const date = new Date().toISOString().slice(0, 10);
  const metricsName = metricsFileName(date, SCOPE);

  process.stdout.write(
    `MEMO_HOME=${memoHome}\n` +
      `platform=${process.platform}  node=${process.version}\n` +
      `items 文件名=${itemName}  brief 文件名=${briefName}\n`
  );

  let service = null;
  try {
    await step('写入两条记忆（createMemoryService + write）', async () => {
      // 先钉命名契约（裁决 58）：Windows 上 `:` 会被写成 NTFS 备用数据流（readdir 看不见），
      // POSIX 上必须保持 `<scope>.jsonl` 字节不变。失败信息比「listScopes 0 条」直观。
      const sep = process.platform === 'win32' ? '+' : ':';
      assert(
        itemName === `${SCOPE.replaceAll(':', sep)}.jsonl`,
        `真相层文件名不符合契约（${process.platform}）：${itemName}`
      );
      service = await createMemoryService({ memoHome, scope: SCOPE, cwd: process.cwd() });
      const a = await service.write({
        kind: 'fact', subject: 'smoke', predicate: 'a', value: '1', text: 'smoke one',
        source: { agent: 'smoke' },
      });
      const b = await service.write({
        kind: 'fact', subject: 'smoke', predicate: 'b', value: '2', text: 'smoke two',
        source: { agent: 'smoke' },
      });
      // 两条都必须是 created：若变成 noop/supersede，后面「records=2」的断言会失去意义
      assert(a.action === 'created', `第一条 write 期望 created，实际 ${a.action}`);
      assert(b.action === 'created', `第二条 write 期望 created，实际 ${b.action}`);
      return `actions=${a.action},${b.action}`;
    });

    // 先关掉服务再 spawn：close 会 flushHits 并释放 scope 锁，避免子进程等锁超时
    if (service) {
      try {
        await service.close();
      } catch (err) {
        process.stdout.write(`WARN close 失败: ${err.message}\n`);
      }
      service = null;
    }

    // 断言 1：真相层是**普通文件**且非空 —— Windows 上若写成 ADS，stat 可能成功但 readdir 看不见
    await step(`真相层是普通文件 items/${itemName}`, async () => {
      const full = path.join(memoHome, 'items', itemName);
      const st = await fsp.stat(full);
      assert(st.isFile(), `不是普通文件（isFile()=false）：${full}`);
      assert(st.size > 0, `文件为空：${full}`);
      return `${full}（${st.size} bytes）`;
    });

    // 断言 2：分库枚举能从文件名反解 scope；records 必须是 2（不是 0，也不是一行一条的 4）
    await step(`listScopes 列出 ${SCOPE} 且 records=2`, async () => {
      const { scopes } = await listScopes(memoHome, SCOPE);
      const hit = scopes.find((s) => s.scope === SCOPE);
      const seen = scopes.map((s) => s.scope).join(', ') || '空';
      assert(hit, `listScopes 未列出 ${SCOPE}（实际：${seen}）`);
      assert(hit.records === 2, `records 期望 2，实际 ${hit.records}`);
      assert(hit.current === true, 'current 期望 true');
      return `records=${hit.records} bytes=${hit.bytes} 全部=${seen}`;
    });

    // 断言 3：compact 曾因 copyFile 目标落 ADS 直接 EINVAL —— 退出码 0 是这条回归的哨兵。
    // 注意 `--dry-run` 在 rewriteScope 之前就 return 了，碰不到 copyFile；所以先跑干跑
    // （CLI 契约），再真压一次（临时库可弃，备份/rename 才是 EINVAL 的真现场）。
    await step('memo compact --dry-run 退出码 0', async () => {
      const r = runNode(MEMO_CLI, ['compact', '--dry-run'], memoHome);
      assert(r.status === 0, `compact --dry-run 失败：${exitDetail(r)}`);
      const first = (r.stdout ?? '').trim().split('\n')[0] ?? '';
      return first || 'exit 0';
    });

    await step('memo compact（真压）退出码 0 且留下 .bak 备份', async () => {
      const r = runNode(MEMO_CLI, ['compact'], memoHome);
      assert(r.status === 0, `compact 失败：${exitDetail(r)}`);
      const items = await fsp.readdir(path.join(memoHome, 'items'));
      const bak = items.filter((n) => n.startsWith(`${itemName}.bak.`));
      assert(
        bak.length >= 1,
        `未生成 ${itemName}.bak.* 备份（实际：${items.join(', ') || '空'}）`
      );
      return `backup=${bak[0]}`;
    });

    // 断言 4：nightly 要落 brief 快照 + metrics 快照（两条写路径都走一遍）
    await step('nightly 退出码 0 且写出 brief + metrics', async () => {
      const r = runNode(NIGHTLY_CLI, [], memoHome);
      assert(r.status === 0, `nightly 失败：${exitDetail(r)}`);

      const briefPath = path.join(memoHome, 'brief', briefName);
      const bbuf = await fsp.readFile(briefPath); // 单次读，避免 stat→read 竞态
      assert(bbuf.length > 0, `brief 为空：${briefPath}`);

      const metricsPath = await resolveMetricsFile(memoHome, metricsName);
      // 只 readFile 一次：stat 之后再读是 TOCTOU（CodeQL js/file-system-race）
      const mbuf = await fsp.readFile(metricsPath);
      assert(mbuf.length > 0, `metrics 为空：${metricsPath}`);
      const snapshot = JSON.parse(mbuf.toString('utf8'));
      assert(snapshot.scope === SCOPE, `metrics.scope 期望 ${SCOPE}，实际 ${snapshot.scope}`);
      assert(snapshot.total === 2, `metrics.total 期望 2，实际 ${snapshot.total}`);
      return `brief=${briefName}（${bbuf.length} bytes） metrics=${path.basename(metricsPath)}`;
    });
  } finally {
    if (service) {
      try {
        await service.close();
      } catch {
        /* 主流程已失败，close 错误不覆盖原始失败原因 */
      }
    }
    try {
      // Windows 上杀毒/索引器偶尔短暂占用文件，maxRetries 让清理不 flake
      await fsp.rm(memoHome, { recursive: true, force: true, maxRetries: 3 });
      process.stdout.write(`已清理临时目录 ${memoHome}\n`);
    } catch (err) {
      // 清理失败不改变门禁结论，但要留痕：临时目录残留通常意味着句柄没释放
      process.stdout.write(`WARN 清理临时目录失败: ${err.message}\n`);
    }
  }

  process.stdout.write(
    failed === 0 ? 'windows-smoke: 全部 PASS\n' : `windows-smoke: ${failed} 项 FAIL\n`
  );
}

main().catch((err) => {
  process.stderr.write(`windows-smoke 崩了: ${err && err.stack ? err.stack : err}\n`);
  process.exitCode = 1;
});
