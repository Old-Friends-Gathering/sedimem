import { test } from 'node:test';
import { itemsFileName } from '../../src/config/paths.js';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

const CASE = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../eval/cases/i8-concurrent.json'), 'utf8'),
);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const SERVICE_URL = pathToFileURL(join(ROOT, 'src/api/service.js')).href;

/** 子进程写入脚本：独立进程各自 createMemoryService → write → close（模拟 CLI/MCP 多进程并发） */
const CHILD_SCRIPT = `
import { createMemoryService } from ${JSON.stringify(SERVICE_URL)};
// node -e 模式下 process.argv = [execPath, ...参数]（无脚本文件占位），过滤 '--' 后取第 1 位起
const [memoHome, scope, text, subject, predicate, value] = process.argv.filter((a) => a !== '--').slice(1);
const svc = await createMemoryService({ memoHome, scope });
try {
  const res = await svc.write({ text, subject, predicate, value, source: { agent: 'test' } });
  await svc.close();
  process.stdout.write(JSON.stringify({ action: res.action, id: res.record.id }));
} catch (e) {
  process.stderr.write(String(e && e.stack || e));
  process.exit(1);
}
`;

function spawnWriter(memoHome, scope, w) {
  return new Promise((resolve, reject) => {
    const p = spawn(
      process.execPath,
      ['--input-type=module', '-e', CHILD_SCRIPT, '--', memoHome, scope, w.text, w.subject, w.predicate, w.value],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(`子进程退出码 ${code}: ${err}`));
      try { resolve(JSON.parse(out)); } catch (e) { reject(new Error(`子进程输出不可解析: ${out}`)); }
    });
  });
}

test('I8 跨进程并发：10 个 node 子进程同时写同一文本 → active=1、dupRatio=0、jsonl 无坏行', async () => {
  const memoHome = mkdtempSync(join(tmpdir(), 'memo-i8-'));
  const scope = 'repo:eval-i8';
  const itemsPath = join(memoHome, 'items', itemsFileName(scope));
  const { createMemoryService } = await import(SERVICE_URL);
  let verifier;
  try {
    // 同时起 10 个进程写同一文本（裁决 13：读-判-写必须在同一把 scope 锁内）
    const results = await Promise.all(
      Array.from({ length: CASE.processes }, () => spawnWriter(memoHome, scope, CASE.write)),
    );
    for (const r of results) {
      assert.ok(typeof r.action === 'string', '每个子进程写操作必返回 action');
    }
    const createdCount = results.filter((r) => r.action === 'created').length;
    assert.equal(createdCount, 1, `并发写同一事实只允许 1 条 created，实际 ${createdCount}（${JSON.stringify(results)}）`);

    // 新进程验收（CLI 每命令一进程的形态）
    verifier = await createMemoryService({ memoHome, scope });
    const stats = await verifier.stats();
    assert.equal(stats.active, 1, `最终 active 必须为 1，实际 ${stats.active}`);
    assert.equal(stats.dupRatio, 0, `dupRatio 必须为 0，实际 ${stats.dupRatio}`);

    const s = await verifier.search(CASE.query);
    const texts = s.items.map((it) => it.record.text);
    assert.equal(texts.filter((t) => t === CASE.write.text).length, 1, 'search 不得返回重复记录');

    // items.jsonl 无坏行：逐行 JSON.parse 全部成功，且无 .lock 残留
    assert.ok(existsSync(itemsPath), '真相层文件应存在');
    const lines = readFileSync(itemsPath, 'utf8').split('\n').filter((l) => l.trim());
    assert.ok(lines.length >= 1, '至少应有一行');
    const ids = new Set();
    for (let i = 0; i < lines.length; i++) {
      let rec;
      try {
        rec = JSON.parse(lines[i]);
      } catch (e) {
        assert.fail(`items.jsonl 第 ${i + 1} 行是坏行: ${e.message}`);
      }
      assert.equal(typeof rec.id, 'string', `第 ${i + 1} 行缺 id`);
      ids.add(rec.id);
    }
    assert.equal(ids.size, 1, `折叠前不同 id 应只有 1 个，实际 ${ids.size}`);
    assert.ok(!existsSync(join(memoHome, '.lock')), '并发结束后不得残留 .lock');
  } finally {
    if (verifier) await verifier.close().catch(() => {});
    rmSync(memoHome, { recursive: true, force: true });
  }
});
