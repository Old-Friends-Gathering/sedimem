// tests/unit/nightly-math.test.js — W4「数学/金融三条」纯函数单测。
// 被测对象：src/cli/nightly.js 导出的 calibrateDecay / hysteresisState / tokenFootprint。
// 纪律：只报表不写 policy、零依赖（node 内置）、同输入必同输出。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { calibrateDecay, hysteresisState, tokenFootprint } from '../../src/cli/nightly.js';

const here = dirname(fileURLToPath(import.meta.url));

// ── 测试工具 ─────────────────────────────────────────────────────────────
/** 造一条 superseded 记录：validFrom 起始，存活 lifespanMs 后被取代。 */
function superseded(kind, lifespanMs, validFrom = '2026-01-01T00:00:00.000Z') {
  return {
    id: `t-${kind}-${Math.random().toString(36).slice(2, 8)}`,
    kind,
    status: 'superseded',
    validFrom,
    validTo: new Date(Date.parse(validFrom) + lifespanMs).toISOString(),
  };
}

// ── calibrateDecay ───────────────────────────────────────────────────────
describe('calibrateDecay（W4 任务 1：生存分析式半衰期估计，只报告）', () => {
  test('样本数 < minSamples → medianMs/suggestedHalfLifeMs 均为 null，note=insufficient-samples', () => {
    // 默认 minSamples=50，只给 3 条 → 不足
    const records = [superseded('fact', 1000), superseded('fact', 2000), superseded('fact', 3000)];
    const out = calibrateDecay({ records, policy: {} });
    assert.equal(out.length, 1);
    assert.equal(out[0].kind, 'fact');
    assert.equal(out[0].samples, 3);
    assert.equal(out[0].medianMs, null);
    assert.equal(out[0].suggestedHalfLifeMs, null);
    assert.equal(out[0].note, 'insufficient-samples');
  });

  test('中位数正确：奇数个样本取正中值', () => {
    const spans = [1000, 3000, 5000, 7000, 9000]; // 已乱序传入
    const records = [3000, 9000, 1000, 7000, 5000].map((ms) => superseded('fact', ms));
    const out = calibrateDecay({ records, policy: { math: { calibrateDecay: { minSamples: 5 } } } });
    assert.equal(out[0].samples, 5);
    assert.equal(out[0].medianMs, 5000);
    assert.ok(!('note' in out[0]), '样本充足时不带 note');
  });

  test('中位数正确：偶数个样本取中间两数均值', () => {
    // 4 样本 [1000,2000,3000,4000] → median = (2000+3000)/2 = 2500
    const records = [4000, 1000, 3000, 2000].map((ms) => superseded('pref', ms));
    const out = calibrateDecay({ records, policy: { math: { calibrateDecay: { minSamples: 4 } } } });
    assert.equal(out[0].medianMs, 2500);
  });

  test('ln2 换算：suggestedHalfLifeMs = round(medianMs × 0.693)', () => {
    // median=5000 → 5000×0.693 = 3465
    const records = [1000, 3000, 5000, 7000, 9000].map((ms) => superseded('fact', ms));
    const out = calibrateDecay({ records, policy: { math: { calibrateDecay: { minSamples: 5 } } } });
    assert.equal(out[0].suggestedHalfLifeMs, Math.round(5000 * 0.693));
    assert.equal(out[0].suggestedHalfLifeMs, 3465);
  });

  test('缺 policy/math 段兜底 minSamples=50；active 记录与非法时长不进样本', () => {
    // 50 条合法 + 1 条 active（删失）+ 1 条时钟回拨（to-from<=0）→ 样本仍只有 50 里合法的
    const records = Array.from({ length: 49 }, (_, i) => superseded('state', 1000 + i));
    records.push({ ...superseded('state', 5000), status: 'active', validTo: null }); // active：不计
    records.push(superseded('state', -100)); // 非正时长：不计
    // policy 完全缺 math 段 → minSamples 兜底 50，49 < 50 → 不足
    const out = calibrateDecay({ records, policy: undefined, now: Date.now() });
    assert.equal(out[0].samples, 49);
    assert.equal(out[0].note, 'insufficient-samples');
    // 补到 50 条合法 → 出数
    records.push(superseded('state', 5000));
    const out2 = calibrateDecay({ records, policy: {} });
    assert.equal(out2[0].samples, 50);
    assert.ok(out2[0].medianMs > 0);
  });

  test('按 kind 分桶：不同 kind 各自独立报告', () => {
    const records = [
      ...Array.from({ length: 3 }, () => superseded('fact', 1000)),
      ...Array.from({ length: 2 }, () => superseded('pref', 2000)),
    ];
    const out = calibrateDecay({ records, policy: { math: { calibrateDecay: { minSamples: 2 } } } });
    assert.equal(out.length, 2);
    const byKind = Object.fromEntries(out.map((c) => [c.kind, c]));
    assert.equal(byKind.fact.samples, 3);
    assert.equal(byKind.fact.medianMs, 1000);
    assert.equal(byKind.pref.samples, 2);
    assert.ok(!('note' in byKind.pref), 'pref 有 2 条 ≥ minSamples=2 → 有中位数');
  });
});

// ── hysteresisState ──────────────────────────────────────────────────────
describe('hysteresisState（W4 任务 2：滞回三态防抖，纯函数）', () => {
  test('ratio ≥ enterRatio(0.8) → on；ratio ≤ exitRatio(0.6) → off；中间保持 prev', () => {
    // 上阈值：进入 on
    assert.equal(hysteresisState({ ratio: 0.8, prev: 'off' }), 'on');
    assert.equal(hysteresisState({ ratio: 0.95, prev: 'off' }), 'on');
    // 下阈值：退回 off
    assert.equal(hysteresisState({ ratio: 0.6, prev: 'on' }), 'off');
    assert.equal(hysteresisState({ ratio: 0.1, prev: 'on' }), 'off');
    // 中间带：保持 prev
    assert.equal(hysteresisState({ ratio: 0.7, prev: 'on' }), 'on');
    assert.equal(hysteresisState({ ratio: 0.7, prev: 'off' }), 'off');
  });

  test('prev 缺省默认 off；policy.math 缺段时阈值兜底 0.8/0.6', () => {
    assert.equal(hysteresisState({ ratio: 0.7 }), 'off'); // 无 prev → 默认 off
    assert.equal(hysteresisState({ ratio: 0.79, prev: 'off', policy: {} }), 'off'); // 0.79 < 0.8 兜底阈值
    assert.equal(hysteresisState({ ratio: 0.61, prev: 'on', policy: undefined }), 'on'); // 0.61 > 0.6 → 保持
    // 自定义 policy 阈值生效
    const policy = { math: { hysteresis: { enterRatio: 0.5, exitRatio: 0.3 } } };
    assert.equal(hysteresisState({ ratio: 0.5, prev: 'off', policy }), 'on');
    assert.equal(hysteresisState({ ratio: 0.31, prev: 'on', policy }), 'on');
    assert.equal(hysteresisState({ ratio: 0.3, prev: 'on', policy }), 'off');
  });
});

// ── tokenFootprint ───────────────────────────────────────────────────────
describe('tokenFootprint（W4 任务 3：注入足迹计数）', () => {
  test('字符/行计数正确：行数 = split(\\n).length，字符 = length（含换行）', () => {
    const brief = '第一行\n第二行\n第三行'; // 3 行
    const tier0 = 'a\nb\n\nc'; // 4 行（含空行）
    const fp = tokenFootprint({ brief, tier0 });
    assert.equal(fp.briefChars, brief.length);
    assert.equal(fp.briefLines, 3);
    assert.equal(fp.tier0Chars, tier0.length);
    assert.equal(fp.tier0Lines, 4);
  });

  test('null/undefined 计 0（brief 可能不存在）', () => {
    const fp = tokenFootprint({ brief: null, tier0: undefined });
    assert.deepEqual(fp, { briefChars: 0, briefLines: 0, tier0Chars: 0, tier0Lines: 0 });
  });
});

// ── 夜跑接线冒烟：metrics 新列真实落盘 ────────────────────────────────────
describe('nightly 接线：metrics 落盘 briefChars/decayCalibration（子进程冒烟）', () => {
  test('CLI 子进程跑完后 metrics 快照含四个足迹列与 decayCalibration 数组', async () => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { itemsFileName } = await import('../../src/config/paths.js');
    const run = promisify(execFile);
    const memoHome = mkdtempSync(join(tmpdir(), 'memo-nightly-math-'));
    try {
      // 预置一条 superseded 记录：让 decayCalibration 有内容可报
      const scope = 'repo:calib';
      const itemsDir = join(memoHome, 'items');
      mkdirSync(itemsDir, { recursive: true });
      const line = {
        id: '01JTESTSUPERSeded0000000000',
        kind: 'fact',
        title: 't', text: 't', subject: 's', predicate: 'p', value: 'v',
        confidence: 0.9, privacy: 'shared',
        status: 'superseded',
        validFrom: '2026-01-01T00:00:00.000Z',
        validTo: '2026-01-01T02:00:00.000Z',
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T02:00:00.000Z',
        hits: 0, agent: 'test', source: {},
      };
      writeFileSync(join(itemsDir, itemsFileName(scope)), JSON.stringify(line) + '\n');
      const { stdout } = await run(process.execPath, [join(here, '../../src/cli/nightly.js'), '--scope', scope], {
        env: { ...process.env, MEMO_HOME: memoHome },
      });
      assert.ok(stdout.includes('半衰期校准'), '人类可读输出应含校准行');
      const date = new Date().toISOString().slice(0, 10);
      const file = join(memoHome, 'metrics', `${date}.repo-calib.json`);
      assert.ok(existsSync(file), `metrics 应落盘 ${file}`);
      const m = JSON.parse(readFileSync(file, 'utf8'));
      // 四个新列必须是数字（brief 至少 1 行）
      for (const k of ['briefChars', 'briefLines', 'tier0Chars', 'tier0Lines']) {
        assert.equal(typeof m[k], 'number', `metrics.${k} 应为数字`);
      }
      // decayCalibration 是数组（样本不足时该 kind 报 insufficient-samples，但形状必须在）
      assert.ok(Array.isArray(m.decayCalibration));
      const fact = m.decayCalibration.find((c) => c.kind === 'fact');
      assert.ok(fact, '预置的 fact superseded 记录应出现在校准报告');
      assert.equal(fact.note, 'insufficient-samples'); // 1 条 < 50
    } finally {
      rmSync(memoHome, { recursive: true, force: true });
    }
  });
});
