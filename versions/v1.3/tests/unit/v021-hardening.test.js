// tests/unit/v021-hardening.test.js — v0.2.1 双审核后的加固断言
// 覆盖：facade 方法集合、JudgePort 注入、scope 路径穿越、--json 旗标、kinds 权重真正生效。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createMemoryService, MemoryService } from '../../src/api/service.js';
import { JsonlStore, isSafeScopeName } from '../../src/storage/jsonl-store.js';
import { loadPolicy } from '../../src/config/policy.js';

const execFileP = promisify(execFile);
const VER_DIR = fileURLToPath(new URL('../..', import.meta.url));
const CLI = join(VER_DIR, 'src', 'cli', 'memo.js');

function withHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'memo-v021-'));
  return Promise.resolve(fn(home)).finally(() => rmSync(home, { recursive: true, force: true }));
}

test('facade：拆分后 MemoryService 的公开方法集合不变（裁决 48）', () => {
  const names = Object.getOwnPropertyNames(MemoryService.prototype).filter((n) => n !== 'constructor').sort();
  const expected = [
    '_applyIdsDecision', '_commit', '_commitPairVerdict', '_corruptIssue', '_ensureOpen', '_enforceQuota',
    '_event', '_init', '_maskSuspicious', '_nowIso', '_parseCorruptLocation', '_refreshIncremental', '_reload',
    '_statusOk', '_withExtraHits',
    'brief', 'close', 'compact', 'curateApply', 'curateAuto', 'curateExport', 'dedupeScan', 'doctor', 'events',
    'enforceQuota', 'exportRecords', 'flushHits', 'forget', 'get', 'reindex', 'refreshView', 'search', 'stats',
    'supersede', 'write',
    // v1.0 W3（裁决 83–88）：LLM 派生层对外方法
    '_loadDerived', 'derivedFor', 'drainDerive', 'enqueueDeriveFor', 'rebuildDerived',
  ].sort();
  assert.deepEqual(names, expected, '方法集合必须与契约登记一致（v0.2.1 新增 compact/curateAuto；v1.0 新增派生层四方法 + 私有 _loadDerived）');
});

test('JudgePort：注入的裁决器必须真的被用（裁决 50；审核 S1）', () => withHome(async (memoHome) => {
  let calls = 0;
  const judge = {
    name: 'custom-test',
    decide: () => { calls += 1; return { decision: 'keep_both', note: 'CUSTOM-JUDGE-USED' }; },
  };
  const svc = await createMemoryService({ memoHome, scope: 'repo:judge', judge });
  try {
    await svc.write({ text: '去重阈值只用来找候选，最终判决交给正在跑的 Agent', subject: 'text', predicate: 'text', source: { agent: 'test' } });
    await svc.write({ text: '去重的阈值只负责召回候选，不该由它做判决，判决交给 Agent', subject: 'text', predicate: 'text', source: { agent: 'test' } });
    const out = await svc.curateAuto({ dryRun: true });
    assert.ok(out.decisions.length >= 1, '应产出决策');
    assert.ok(calls >= 1, '自定义 judge 必须被调用（旧实现读 svc._judge 永远是 undefined）');
    assert.equal(out.decisions[0].note, 'CUSTOM-JUDGE-USED');
  } finally { await svc.close(); }
}));

test('scope 文件名安全：路径穿越被拒（对抗审核 ③）', () => withHome(async (memoHome) => {
  const store = new JsonlStore({ memoHome });
  for (const bad of ['../ESCAPED', 'a/b', '/abs', '.hidden', '', 'x'.repeat(200)]) {
    assert.equal(isSafeScopeName(bad), false, `${JSON.stringify(bad)} 必须判不安全`);
    await assert.rejects(() => store.loadScope(bad), /invalid scope|E_INVALID_ARG/, `${JSON.stringify(bad)} 必须被拒`);
  }
  // 带空格与冒号的真实目录名必须仍然可用
  assert.equal(isSafeScopeName('dir:my project'), true);
  const ok = await store.loadScope('dir:my project');
  assert.deepEqual(ok, []);
}));

test('CLI --json 真的输出 JSON（审核 B1：asJson/json 键名不一致）', () => withHome(async (memoHome) => {
  const env = { ...process.env, MEMO_HOME: memoHome, MEMO_SCOPE: 'repo:cli-json' };
  await execFileP(process.execPath, [CLI, 'write', '--kind', 'fact', '--text', '缓存命中率百分位口径', '--agent', 'test'], { env });
  const a = await execFileP(process.execPath, [CLI, 'curate', 'auto', '--dry-run', '--json'], { env });
  assert.doesNotThrow(() => JSON.parse(a.stdout), `curate auto --json 必须是 JSON，实际：${a.stdout}`);
  const b = await execFileP(process.execPath, [CLI, 'compact', '--dry-run', '--json'], { env });
  const parsed = JSON.parse(b.stdout);
  assert.equal(typeof parsed.purged, 'number');
}));

test('kinds 是唯一真相：新增 kind 的 weight/halfLife 必须真的生效（裁决 49；审核 S2）', () => {
  const policy = loadPolicy({ kinds: {
    fact: { halfLifeMs: 1000, weight: 2.5, color: '#111111' },
    pitfall: { halfLifeMs: 2000, weight: 9.0, color: '#222222' },
  } });
  // loadPolicy 是「深合并 overrides 到默认策略」：kinds 是**增量**合并，默认 5 个 kind 仍在，
  // 覆盖的同名 kind 用新值，新增的 kind 直接进来 —— kind 清单由数据决定，不是代码。
  assert.equal(policy.kinds.fact.weight, 2.5);
  assert.equal(policy.kinds.fact.halfLifeMs, 1000);
  assert.equal(policy.kinds.pitfall.halfLifeMs, 2000);
  assert.equal(policy.kinds.state.weight, 0.6, '未被覆盖的 kind 应保留默认值');
  assert.deepEqual(Object.keys(policy.kinds).sort(), ['decision', 'fact', 'gotcha', 'pitfall', 'pref', 'state']);
});

test('kinds 段类型严格：字符串数字不能被静默接受（审核建议 2）', () => {
  assert.throws(() => loadPolicy({ kinds: { fact: { halfLifeMs: '1000', weight: 1, color: '#111111' } } }), /E_POLICY|kinds\.fact/);
  assert.throws(() => loadPolicy({ kinds: { fact: { halfLifeMs: 1000, weight: '1.3', color: '#111111' } } }), /E_POLICY|kinds\.fact/);
  assert.throws(() => loadPolicy({ kinds: { fact: { halfLifeMs: 1000, weight: 1, color: 'red' } } }), /E_POLICY|kinds\.fact/);
});
