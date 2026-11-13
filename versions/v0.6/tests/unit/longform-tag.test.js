// tests/unit/longform-tag.test.js — 0.6.1 回归：long-form 只标记「太长」，不标记「缺 title」
//
// 背景：0.6.0 的 write-path 只要有任意 warning 就打 long-form，导致「10 字、只是缺 title」的普通
// 事实也被挂上 long-form。这个标签是给「超长需要拆条」用的，误标会污染 brief 的降级与统计。
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMemoryService } from '../../src/api/service.js';

test('缺 title 不打 long-form；超长才打（write 与 supersede 两条路径）', async () => {
  const memoHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'memo-longform-'));
  const svc = await createMemoryService({ memoHome, scope: 'repo:longform', cwd: memoHome });
  try {
    // ① 短文本 + 缺 title：只有 E_TITLE_MISSING，不该打 long-form
    const short = await svc.write({ text: '一条很短的普通事实', kind: 'fact', source: { agent: 'cli' } });
    assert.equal(short.action, 'created');
    assert.ok(short.warnings.some((w) => w.code === 'E_TITLE_MISSING'), `应出 E_TITLE_MISSING：${JSON.stringify(short.warnings)}`);
    assert.equal(short.record.tags.includes('long-form'), false, '缺 title 不该打 long-form');

    // ② 400 字 + 有 title：打 long-form
    const long = await svc.write({ text: '长'.repeat(400), kind: 'fact', title: '很长的事实', source: { agent: 'cli' } });
    assert.equal(long.record.tags.includes('long-form'), true, '超长要打 long-form');

    // ③ supersede 路径同规则：短文本缺 title → 不打
    const sup = await svc.write({ text: '旧值', kind: 'fact', title: '标题', subject: 'lf', predicate: 'p', source: { agent: 'cli' } });
    const supShort = await svc.supersede({ oldId: sup.record.id, value: '更短的旧值', source: { agent: 'cli' } });
    assert.equal(supShort.record.tags.includes('long-form'), false, 'supersede 短文本不该打 long-form');
  } finally {
    await svc.close();
  }
});
