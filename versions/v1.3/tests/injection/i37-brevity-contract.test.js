// I37 — 写侧粒度契约（v0.6 W1）
// 钉三件事：① 超硬上限报错而不是静默截断；② 超软线只警告 + long-form 标记，写入照常成功；
// ③ brief 行首优先 title，长文不再糊进 brief。
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMemoryService } from '../../src/api/service.js';

const SRC = { agent: 'test' };

test('I37 粒度契约：软线警告、硬线报错、brief 用 title', async () => {
  const memoHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'memo-i37-'));
  const service = await createMemoryService({ memoHome, scope: 'repo:i37', cwd: memoHome });
  try {
    // ① 301 字 value：成功 + E_RECORD_LONG 警告 + long-form tag
    const long = 'x'.repeat(301);
    const r1 = await service.write({ text: '长值测试', title: '长值', kind: 'fact', subject: 'granularity', predicate: 'long', value: long, source: SRC });
    assert.equal(r1.action, 'created');
    assert.ok(Array.isArray(r1.warnings) && r1.warnings.length > 0, '应返回 warnings');
    assert.equal(r1.warnings[0].code, 'E_RECORD_LONG');
    assert.ok(Array.isArray(r1.warnings[0].splitSuggestion), '应给可直接重放的 splitSuggestion');
    assert.ok(r1.warnings[0].splitSuggestion.length <= 3);
    assert.ok(r1.record.tags.includes('long-form'), '应打 long-form 标签');

    // ② 短值：无警告
    const r2 = await service.write({ text: '短值', title: '短值', kind: 'fact', subject: 'granularity', predicate: 'short', value: 'ok', source: SRC });
    assert.deepEqual(r2.warnings, [], '短记录不应有 warnings');
    assert.ok(!(r2.record.tags ?? []).includes('long-form'));

    // ③ 超硬上限：报错，不落库
    await assert.rejects(
      () => service.write({ text: 'y'.repeat(5001), title: '超长', kind: 'fact', subject: 'granularity', predicate: 'huge', source: SRC }),
      (e) => e.code === 'E_INVALID_RECORD' && /textHardMaxChars|4000/.test(e.message),
      '超硬上限必须报错（不再静默截断）',
    );

    // ④ 缺 title：默认只是警告（titleEnforce=false），开硬约束后被拒
    const soft = await service.write({ text: '没有标题', title: '', kind: 'fact', subject: 'granularity', predicate: 'notitle', value: 'v', source: SRC });
    assert.ok(soft.warnings.some((w) => w.code === 'E_TITLE_MISSING'), '缺 title 默认给 E_TITLE_MISSING 警告');

    const { loadPolicy } = await import('../../src/config/policy.js');
    const base = loadPolicy();
    const strict = await createMemoryService({
      memoHome, scope: 'repo:i37-strict', cwd: memoHome,
      policy: { write: { ...base.write, titleEnforce: true } },
    });
    try {
      await assert.rejects(
        () => strict.write({ text: '没有标题', kind: 'fact', subject: 'granularity', predicate: 'notitle', value: 'v', source: SRC }),
        (e) => e.code === 'E_INVALID_RECORD' && /title/.test(e.message),
        'titleEnforce=true 时缺 title 必须被拒',
      );
    } finally {
      await strict.close();
    }

    // ⑤ brief 行首用 title，长正文不糊进来
    const brief = await service.brief({});
    assert.ok(brief.includes('长值'), 'brief 应出现 title');
    assert.ok(!brief.includes('x'.repeat(80)), 'brief 不应糊长正文');
  } finally {
    await service.close();
  }
});
