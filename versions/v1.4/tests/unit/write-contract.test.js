// tests/unit/write-contract.test.js — W1 写侧粒度契约（recordWarnings / 硬上限 / brief 行首）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRecord, recordWarnings } from '../../src/core/record.js';
import { renderBrief } from '../../src/render/brief.js';
import { defaultPolicy } from '../../src/config/policy.js';

const clock = { now: () => '2026-01-01T00:00:00Z', nowMs: () => 0 };
const base = { source: { agent: 'test' } };

test('300 字内且带 title：无警告', () => {
  const r = createRecord({ ...base, kind: 'fact', title: '短事实', text: 'x'.repeat(300) }, { clock });
  const w = recordWarnings(r);
  assert.deepEqual(w, []);
});

test('301 字：E_RECORD_LONG 且 splitSuggestion ≤3 段、每段 ≤300 字', () => {
  const r = createRecord({ ...base, kind: 'fact', title: '长文', text: `头。${'y'.repeat(320)}` }, { clock });
  const w = recordWarnings(r, defaultPolicy);
  const long = w.find((x) => x.code === 'E_RECORD_LONG');
  assert.ok(long, `应出 E_RECORD_LONG：${JSON.stringify(w.map((x) => x.code))}`);
  assert.ok(Array.isArray(long.splitSuggestion) && long.splitSuggestion.length >= 1);
  assert.ok(long.splitSuggestion.length <= 3);
  for (const seg of long.splitSuggestion) assert.ok(seg.length <= 300, `每段 ≤300，实际 ${seg.length}`);
  // 用真实句号文本再验一次切句语义（>300 字、四句以上只取前 3 段）
  const text = `第一句主题。${'a'.repeat(200)}。第二句内容。${'b'.repeat(150)}第三句尾巴。第四句多余。`;
  const w2 = recordWarnings({ ...r, text }, defaultPolicy);
  const long2 = w2.find((x) => x.code === 'E_RECORD_LONG');
  assert.equal(long2.splitSuggestion.length, 3, '四句以上只取前 3 段');
  assert.ok(long2.splitSuggestion.every((s) => s !== ''));
});

test('超硬上限 4000：createRecord 报错而非截断', () => {
  assert.throws(
    () => createRecord({ ...base, text: 'x'.repeat(5000) }, { clock }),
    (e) => e.code === 'E_INVALID_RECORD' && /textHardMaxChars/.test(e.message),
  );
});

test('fact 缺 title：E_TITLE_MISSING，message 含最小正确形状', () => {
  const r = createRecord({ ...base, kind: 'fact', text: '一条没有标题的事实' }, { clock });
  const w = recordWarnings(r, defaultPolicy);
  const miss = w.find((x) => x.code === 'E_TITLE_MISSING');
  assert.ok(miss, `应出 E_TITLE_MISSING：${JSON.stringify(w.map((x) => x.code))}`);
  assert.match(miss.message, /title/);
  assert.match(miss.message, /\{ text, kind: 'fact', title:/);
});

test('state kind：无 title 豁免', () => {
  const r = createRecord({ ...base, kind: 'state', text: '运行中状态' }, { clock });
  const w = recordWarnings(r, defaultPolicy);
  assert.equal(w.find((x) => x.code === 'E_TITLE_MISSING'), undefined);
});

test('brief 行：有 title 用 title，无 title 用 subject · predicate，不再退化为正文全文', () => {
  const withTitle = createRecord({ ...base, kind: 'fact', title: '标题在此', text: '正文不该出现在行首' }, { clock });
  const noTitle = createRecord({ ...base, kind: 'state', subject: 'svc', predicate: 'status', value: 'up', text: '正文全文不该出现' }, { clock });
  const out = renderBrief({ scope: 'repo:t', records: [withTitle, noTitle] });
  assert.match(out, /- \[fact\] 标题在此/);
  assert.match(out, /- \[state\] svc · status/);
  assert.ok(!out.includes('正文全文不该出现'), `正文不应整段进 brief：\n${out}`);
  assert.ok(!out.includes('正文不该出现在行首'));
});

// —— session 临时库 fact 写入门禁（v0.6 修复：assertWritableKind 接入 writeRecord）——
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryService } from '../../src/api/service.js';

test('session scope 写 fact（含 kind 缺省）→ E_SCRATCH_KIND_FORBIDDEN', async () => {
  const memoHome = mkdtempSync(join(tmpdir(), 'memo-wc-'));
  const svc = await createMemoryService({ memoHome, scope: 'session:wc-0001', clock });
  try {
    await assert.rejects(
      () => svc.write({ text: '临时库里的长期事实', title: '应被拒', kind: 'fact', source: { agent: 'test' } }),
      (e) => e.code === 'E_SCRATCH_KIND_FORBIDDEN',
    );
    // kind 缺省也按 fact 拒
    await assert.rejects(
      () => svc.write({ text: '缺省 kind 也算 fact', source: { agent: 'test' } }),
      (e) => e.code === 'E_SCRATCH_KIND_FORBIDDEN',
    );
    // 白名单 kind 不拦
    await svc.write({ text: 'decision 允许', kind: 'decision', source: { agent: 'test' } });
  } finally {
    await svc.close();
    rmSync(memoHome, { recursive: true, force: true });
  }
});

test('主库 scope 写 fact 不受门禁影响', async () => {
  const memoHome = mkdtempSync(join(tmpdir(), 'memo-wc-'));
  const svc = await createMemoryService({ memoHome, scope: 'repo:wc-main', clock });
  try {
    const w = await svc.write({ text: '主库 fact 正常', title: '正常', kind: 'fact', source: { agent: 'test' } });
    assert.equal(w.action, 'created');
  } finally {
    await svc.close();
    rmSync(memoHome, { recursive: true, force: true });
  }
});

// —— v0.6 审核写侧阻断项修复（B-01 / B2+S-01 / S-03）——
import { normalizeTitle, validateRecord } from '../../src/core/record.js';

test('B-01：value 超 write.valueHardMaxChars（默认 2000）→ E_INVALID_RECORD', () => {
  const long = 'v'.repeat(2001);
  assert.throws(
    () => createRecord({ text: '短文本', value: long, kind: 'fact', source: { agent: 'test' } }),
    (e) => e.code === 'E_INVALID_RECORD' && /valueHardMaxChars/.test(e.message),
  );
  // 恰好 2000 不报错
  const ok = createRecord({ text: '短文本', value: 'v'.repeat(2000), kind: 'fact', source: { agent: 'test' } });
  assert.equal(ok.value.length, 2000);
  // validateRecord 同样卡 value 面（B-01 + arch ④：上限读 policy 且只能调小）
  const vBad = validateRecord({ ...ok, value: 'v'.repeat(2001) });
  assert.equal(vBad.ok, false);
  assert.ok(vBad.errors.some((e) => e.includes('value: length')));
  // policy 调小生效、调大被内建天花板 2000 压回
  const tighter = { ...defaultPolicy, write: { ...(defaultPolicy.write ?? {}), valueHardMaxChars: 100 } };
  assert.throws(
    () => createRecord({ text: '短文本', value: 'v'.repeat(101), kind: 'fact', source: { agent: 'test' } }, { policy: tighter }),
    (e) => e.code === 'E_INVALID_RECORD',
  );
  const looser = { ...defaultPolicy, write: { ...(defaultPolicy.write ?? {}), valueHardMaxChars: 99999 } };
  assert.throws(
    () => createRecord({ text: '短文本', value: 'v'.repeat(2001), kind: 'fact', source: { agent: 'test' } }, { policy: looser }),
    (e) => e.code === 'E_INVALID_RECORD' && /2000/.test(e.message),
  );
});

test('B2/S-01：supersede 继承旧记录 title 并透传 policy', async () => {
  const memoHome = mkdtempSync(join(tmpdir(), 'memo-wc-sup-'));
  const svc = await createMemoryService({ memoHome, scope: 'repo:wc-sup', clock });
  try {
    const w = await svc.write({ text: 'v1 灰度 10%', title: '灰度比例', kind: 'decision', source: { agent: 'test' } });
    const r = await svc.supersede({ oldId: w.record.id, value: 'v2 灰度 50%', source: { agent: 'test' } });
    assert.equal(r.record.title, '灰度比例', '未传 title 时应继承旧记录 title');
    // 显式传 title 则以新值为准
    const r2 = await svc.supersede({ oldId: r.record.id, value: 'v3 灰度 100%', title: '灰度全量', source: { agent: 'test' } });
    assert.equal(r2.record.title, '灰度全量');
  } finally {
    await svc.close();
    rmSync(memoHome, { recursive: true, force: true });
  }
});

test('B2/S-01：supersede 超长 value 打 long-form 标记并返回 warnings', async () => {
  const memoHome = mkdtempSync(join(tmpdir(), 'memo-wc-sup2-'));
  const svc = await createMemoryService({ memoHome, scope: 'repo:wc-sup2', clock });
  try {
    const w = await svc.write({ text: 'v1 短', title: '主题', kind: 'fact', source: { agent: 'test' } });
    const r = await svc.supersede({ oldId: w.record.id, value: 'x'.repeat(400), source: { agent: 'test' } });
    assert.ok(r.record.tags.includes('long-form'), '超 valueRecommendChars 应打 long-form');
    assert.ok(Array.isArray(r.warnings) && r.warnings.some((x) => x.code === 'E_RECORD_LONG'));
    // 契约透传：自定义更严 policy 下 supersede 也被硬限拦截
    const strict = JSON.parse(JSON.stringify(defaultPolicy));
    strict.write = { ...(strict.write ?? {}), textHardMaxChars: 50 };
    const memoHome2 = mkdtempSync(join(tmpdir(), 'memo-wc-sup3-'));
    const svc2 = await createMemoryService({ memoHome: memoHome2, scope: 'repo:wc-sup3', clock, policy: strict });
    try {
      const w2 = await svc2.write({ text: 'seed', title: 't', kind: 'fact', source: { agent: 'test' } });
      await assert.rejects(
        () => svc2.supersede({ oldId: w2.record.id, value: 'y'.repeat(300), source: { agent: 'test' } }),
        (e) => e.code === 'E_INVALID_RECORD' && /valueHardMaxChars|textHardMaxChars/.test(e.message),
      );
    } finally {
      await svc2.close();
      rmSync(memoHome2, { recursive: true, force: true });
    }
  } finally {
    await svc.close();
    rmSync(memoHome, { recursive: true, force: true });
  }
});

test('S-03：title 中零宽/方向控制字符被剔除后再折空白', () => {
  // 零宽空格 + 双向覆盖控制：视觉上与干净标题无法区分，必须剔除
  assert.equal(normalizeTitle('灰\u200B度\u202E比例\uFEFF'), '灰度比例');
  assert.equal(normalizeTitle('a\u2060\n\u200Db'), 'a b');
  // 干净标题不受影响
  assert.equal(normalizeTitle('正常标题'), '正常标题');
});

