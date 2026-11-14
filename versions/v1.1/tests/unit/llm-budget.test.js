// tests/unit/llm-budget.test.js — 日预算单测（跨日重置 / 超限 blocked / 并发不丢 / 换算精度）
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readBudget, chargeBudget, isBlocked } from '../../src/llm/budget.js';

/** 每个用例独立的临时 memoHome */
function tmpHome(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'memo-budget-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** 固定时钟（返回 Date）：跨日测试的关键 */
const clockAt = (iso) => () => new Date(iso);

const POLICY = { llm: { dailyLimitCny: 1, price: { inPerM: 2, outPerM: 8 } } };

test('readBudget：文件不存在返回空预算（当日日期）', async (t) => {
  const home = tmpHome(t);
  const b = await readBudget(home, { clock: clockAt('2026-11-14T00:00:00Z') });
  assert.equal(b.date, '2026-11-14');
  assert.equal(b.spentCny, 0);
  assert.equal(b.calls, 0);
  assert.deepEqual(b.byPurpose, {});
});

test('chargeBudget：按 usage 与 price 换算 CNY，保留 4 位小数', async (t) => {
  const home = tmpHome(t);
  // 1000 in * 2/1M + 500 out * 8/1M = 0.002 + 0.004 = 0.006
  const r = await chargeBudget(home, {
    usage: { inTokens: 1000, outTokens: 500 },
    purpose: 'derive',
    policy: POLICY,
  }, { clock: clockAt('2026-11-14T00:00:00Z') });
  assert.equal(r.ok, true);
  assert.equal(r.spentCny, 0.006);
  const b = await readBudget(home, { clock: clockAt('2026-11-14T00:00:00Z') });
  assert.equal(b.spentCny, 0.006);
  assert.equal(b.calls, 1);
  assert.deepEqual(b.byPurpose.derive, { inTokens: 1000, outTokens: 500, calls: 1 });
});

test('chargeBudget：换算保留 4 位小数（非整除单价）', async (t) => {
  const home = tmpHome(t);
  // 3 in * 2/1M = 0.000006 → 四舍五入 4 位 = 0；再 1 out * 8/1M = 0.000008 → 0
  await chargeBudget(home, { usage: { inTokens: 3, outTokens: 0 }, purpose: 'derive', policy: POLICY }, { clock: clockAt('2026-11-14T00:00:00Z') });
  // 125000 in * 2/1M = 0.25
  const r = await chargeBudget(home, { usage: { inTokens: 125000, outTokens: 0 }, purpose: 'derive', policy: POLICY }, { clock: clockAt('2026-11-14T00:00:00Z') });
  assert.equal(r.ok, true);
  const b = await readBudget(home, { clock: clockAt('2026-11-14T00:00:00Z') });
  assert.equal(b.spentCny, 0.25);
});

test('预算跨日自动重置：昨天花了 0.9，今天从 0 开始', async (t) => {
  const home = tmpHome(t);
  const p1 = { usage: { inTokens: 450000, outTokens: 0 }, purpose: 'derive', policy: POLICY }; // 0.9 CNY
  await chargeBudget(home, p1, { clock: clockAt('2026-11-13T12:00:00Z') });
  assert.equal((await readBudget(home, { clock: clockAt('2026-11-13T12:00:00Z') })).spentCny, 0.9);
  // 跨日后：readBudget 视为空预算，charge 可继续
  const b2 = await readBudget(home, { clock: clockAt('2026-11-14T00:00:01Z') });
  assert.equal(b2.spentCny, 0);
  const r2 = await chargeBudget(home, p1, { clock: clockAt('2026-11-14T00:00:01Z') });
  assert.equal(r2.ok, true);
  assert.equal(r2.spentCny, 0.9); // 新的一天从零起算
  assert.equal((await readBudget(home, { clock: clockAt('2026-11-14T00:00:01Z') })).date, '2026-11-14');
});

test('超限：charge 返回 ok:false blocked:true 且不写入', async (t) => {
  const home = tmpHome(t);
  const big = { usage: { inTokens: 450000, outTokens: 0 }, purpose: 'derive', policy: POLICY }; // 0.9 CNY
  await chargeBudget(home, big, { clock: clockAt('2026-11-14T00:00:00Z') });
  const r = await chargeBudget(home, big, { clock: clockAt('2026-11-14T00:00:00Z') }); // 0.9+0.9 > 1
  assert.equal(r.ok, false);
  assert.equal(r.blocked, true);
  assert.equal(r.error.code, 'E_LLM_BUDGET_EXCEEDED');
  const b = await readBudget(home, { clock: clockAt('2026-11-14T00:00:00Z') });
  assert.equal(b.spentCny, 0.9); // 未写入超限部分
  assert.equal(b.calls, 1);
});

test('isBlocked：未超限 false，达到/超过限额 true', async (t) => {
  const home = tmpHome(t);
  const opts = { clock: clockAt('2026-11-14T00:00:00Z') };
  assert.equal(await isBlocked(home, { policy: POLICY, ...opts }), false);
  await chargeBudget(home, { usage: { inTokens: 500000, outTokens: 0 }, purpose: 'derive', policy: POLICY }, opts); // 恰好 1.0
  assert.equal(await isBlocked(home, { policy: POLICY, ...opts }), true);
});

test('isBlocked：dailyLimitCny 未配置或 <=0 时不封锁', async (t) => {
  const home = tmpHome(t);
  const opts = { clock: clockAt('2026-11-14T00:00:00Z') };
  await chargeBudget(home, { usage: { inTokens: 5000000, outTokens: 0 }, purpose: 'derive', policy: { llm: { dailyLimitCny: 0, price: { inPerM: 2, outPerM: 0 } } } }, opts);
  assert.equal(await isBlocked(home, { policy: { llm: { price: { inPerM: 2, outPerM: 0 } } }, ...opts }), false);
});

test('并发 10 次 charge：锁内串行，金额与笔数不丢', async (t) => {
  const home = tmpHome(t);
  const opts = { clock: clockAt('2026-11-14T00:00:00Z') };
  // 每次 0.2（100000 in * 2/1M），10 次 = 2.0
  const results = await Promise.all(Array.from({ length: 10 }, () => chargeBudget(home, {
    usage: { inTokens: 100000, outTokens: 0 },
    purpose: 'derive',
    policy: { llm: { dailyLimitCny: 100, price: { inPerM: 2, outPerM: 8 } } },
  }, opts)));
  assert.equal(results.every((r) => r.ok), true);
  const b = await readBudget(home, opts);
  assert.equal(b.calls, 10);
  assert.equal(Math.round(b.spentCny * 1e4) / 1e4, 2);
  assert.equal(b.byPurpose.derive.calls, 10);
});

test('并发不丢：文件内容为合法 JSON 且带末尾换行', async (t) => {
  const home = tmpHome(t);
  const opts = { clock: clockAt('2026-11-14T00:00:00Z') };
  await Promise.all(Array.from({ length: 5 }, () => chargeBudget(home, {
    usage: { inTokens: 10000, outTokens: 0 }, purpose: 'brief', policy: POLICY,
  }, opts)));
  const file = path.join(home, 'llm', 'budget.json');
  const text = readFileSync(file, 'utf8');
  assert.ok(text.endsWith('\n'));
  const data = JSON.parse(text);
  assert.equal(data.calls, 5);
  assert.equal(existsSync(path.join(home, 'llm', 'budget.lock')), false); // 锁用完即删
});

test('无锁竞争损坏防护：budget.json 不存在坏行时按空预算处理', async (t) => {
  const home = tmpHome(t);
  const { writeFileSync, mkdirSync } = await import('node:fs');
  mkdirSync(path.join(home, 'llm'), { recursive: true });
  writeFileSync(path.join(home, 'llm', 'budget.json'), '{broken json');
  const b = await readBudget(home, { clock: clockAt('2026-11-14T00:00:00Z') });
  assert.equal(b.spentCny, 0);
});
