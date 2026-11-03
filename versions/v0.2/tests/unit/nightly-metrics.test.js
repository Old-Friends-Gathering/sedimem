import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const NIGHTLY = join(here, '../../src/cli/nightly.js');
const NODE = process.execPath;

const date = new Date().toISOString().slice(0, 10);

async function runNightly(memoHome, scope) {
  const { stdout } = await run(NODE, [NIGHTLY, '--scope', scope], {
    env: { ...process.env, MEMO_HOME: memoHome },
  });
  return stdout;
}

describe('nightly metrics 文件名（裁决 31：按 scope 分文件）', () => {
  test('scopeKey 归一化：非法字符替换为 -，写 metrics/<date>.<scopeKey>.json', async () => {
    const memoHome = mkdtempSync(join(tmpdir(), 'memo-nightly-'));
    try {
      const stdout = await runNightly(memoHome, 'repo:night a/b');
      const file = join(memoHome, 'metrics', `${date}.repo-night-a-b.json`);
      assert.ok(existsSync(file), `expected ${file}`);
      assert.ok(!existsSync(join(memoHome, 'metrics', `${date}.json`)), '不得再写旧 <date>.json');
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      assert.equal(parsed.scope, 'repo:night a/b');
      assert.ok(stdout.includes(`${date}.repo-night-a-b.json`));
    } finally {
      rmSync(memoHome, { recursive: true, force: true });
    }
  });

  test('多 scope 同日隔离互不覆盖；同 scope 覆盖', async () => {
    const memoHome = mkdtempSync(join(tmpdir(), 'memo-nightly-'));
    try {
      await runNightly(memoHome, 'repo:alpha');
      await runNightly(memoHome, 'repo:beta');
      const fa = join(memoHome, 'metrics', `${date}.repo-alpha.json`);
      const fb = join(memoHome, 'metrics', `${date}.repo-beta.json`);
      assert.ok(existsSync(fa), 'alpha 文件存在');
      assert.ok(existsSync(fa) && existsSync(fb), '两个 scope 各自落盘');
      assert.equal(JSON.parse(readFileSync(fa, 'utf8')).scope, 'repo:alpha');
      assert.equal(JSON.parse(readFileSync(fb, 'utf8')).scope, 'repo:beta');
      // 同 scope 重跑：覆盖为最新快照（wx 失败回退覆盖路径）
      await runNightly(memoHome, 'repo:alpha');
      assert.equal(JSON.parse(readFileSync(fa, 'utf8')).scope, 'repo:alpha');
    } finally {
      rmSync(memoHome, { recursive: true, force: true });
    }
  });
});
