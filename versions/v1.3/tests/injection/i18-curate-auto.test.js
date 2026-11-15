import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMemoryService } from '../../src/api/service.js';
import { curateAuto } from '../../src/api/maintenance.js';
import { curateAutoCli } from '../../src/cli/curate.js';

// I18（车道 C，issue #34；裁决 50）：curateAuto 一条命令完成 scan → 判 → apply。
// 3 组中文改写（每组 2 条、全部 strong 候选）→ ruleJudge 按 createdAt 判定 →
// active 收敛 ≤3、真相层只增不减（非破坏）、重跑 applied=0（幂等）、dryRun 不落盘。

// 三组改写的相似度依据（§3.5 实测口径）：1/2 组 containment 0.55–0.67，
// 3 组连接池改写 token 重叠度高（共享「数据/据库/库连/连接/接池/20」），均为 strong。
const GROUPS = [
  ['部署脚本在 scripts/deploy.sh', '上线脚本位于 scripts/deploy.sh'],
  ['缓存命中率低于 60% 要报警', '缓存命中率不足 60% 时触发告警'],
  ['数据库连接池上限是 20', '数据库连接池最大 20 个连接'],
];

// 步进时钟：每次 now() 前进 1ms，保证 createdAt 严格有序（否则同毫秒写入会让
// ruleJudge 落到 keep_both+equal，收敛断言变成碰运气的 flaky 测试）。
function stepClock() {
  let ms = Date.parse('2026-11-06T10:00:00.000Z');
  return {
    now() { ms += 1; return new Date(ms).toISOString(); },
    nowMs() { ms += 1; return ms; },
  };
}

function itemsFile(memoHome) {
  const dir = join(memoHome, 'items');
  const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  assert.equal(files.length, 1, '测试分库只应有一个 items 文件');
  return join(dir, files[0]);
}

function lineCount(p) {
  return readFileSync(p, 'utf8').split('\n').filter((l) => l.trim() !== '').length;
}

test('I18 curateAuto：3 组中文改写一次收敛 + 幂等 + dryRun 只读', async () => {
  const memoHome = mkdtempSync(join(tmpdir(), 'memo-'));
  let svc;
  try {
    svc = await createMemoryService({ memoHome, scope: 'repo:eval-i18', clock: stepClock() });

    // 1. 造 3 组中文改写（6 条全部 created）
    for (const [a, b] of GROUPS) {
      await svc.write({ text: a, source: { agent: 'test' } });
      await svc.write({ text: b, source: { agent: 'test' } });
    }
    assert.equal((await svc.stats()).active, 6);

    // 2. dryRun：返回决策但不落盘，真相层一字不动
    const itemsPath = itemsFile(memoHome);
    const linesBefore = lineCount(itemsPath);
    const dry = await curateAuto(svc, { dryRun: true });
    assert.equal(dry.dryRun, true);
    assert.ok(dry.pairs >= 3, `至少召回 3 对 strong 候选，实际 ${dry.pairs}`);
    assert.equal(dry.applied, 0, 'dryRun 不得落盘');
    assert.ok(dry.decisions.length >= 3, 'dryRun 也要给出全部决策');
    assert.equal(lineCount(itemsPath), linesBefore, 'dryRun 后真相层行数不变');
    assert.equal((await svc.stats()).active, 6, 'dryRun 后 active 不变');

    // 3. 正式跑：每对 strong+同 slot（unstructured text/text）→ hits 打平 → 早者胜
    const out = await curateAuto(svc, {});
    assert.ok(out.applied >= 3, `应至少落盘 3 条裁决，实际 ${out.applied}`);
    assert.ok(out.decisions.every((d) => ['a_wins', 'b_wins', 'keep_both'].includes(d.decision)));
    assert.ok(out.decisions.every((d) => d.note.startsWith('rule:')), 'note 必须写明依据');

    // 4. 收敛 + 非破坏：active ≤3；真相层行数只增不减
    const stats = await svc.stats();
    assert.ok(stats.active <= 3, `3 组各留 1 条，active 应 ≤3，实际 ${stats.active}`);
    assert.ok(lineCount(itemsPath) > linesBefore, '裁决必须以追加快照落盘（真相层不减少）');

    // 5. 幂等：再跑一次 applied=0（败者已 superseded，不再进候选；keep_both 命中幂等）
    const again = await curateAuto(svc, {});
    assert.equal(again.applied, 0, `重跑必须零落盘，实际 applied=${again.applied}`);
    assert.equal((await svc.stats()).active, stats.active, '重跑后 active 不变');

    // 6. CLI 入口只透传：JSON 字段与 service 返回一致
    const cliJson = await capture(async () => curateAutoCli(svc, { limit: 20, dryRun: true, json: true }));
    const parsed = JSON.parse(cliJson);
    for (const k of ['clusters', 'pairs', 'decisions', 'applied', 'skipped', 'dryRun']) {
      assert.ok(k in parsed, `CLI JSON 必须含 ${k}`);
    }
    assert.equal(parsed.dryRun, true);
  } finally {
    if (svc) await svc.close();
    rmSync(memoHome, { recursive: true, force: true });
  }
});

/** 捕获 stdout 的单行 JSON / 摘要（不吞异步异常） */
async function capture(fn) {
  const orig = process.stdout.write.bind(process.stdout);
  let buf = '';
  process.stdout.write = (s) => { buf += s; return true; };
  try {
    await fn();
  } finally {
    process.stdout.write = orig;
  }
  return buf;
}
