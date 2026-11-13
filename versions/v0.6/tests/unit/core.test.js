import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createClock, systemClock } from '../../src/core/clock.js';
import { newId, isId } from '../../src/core/ids.js';
import { normalizeText, contentHash, tokenize } from '../../src/core/hash.js';
import { resolveScope } from '../../src/core/scope.js';
import { createRecord, validateRecord, withPatch } from '../../src/core/record.js';

describe('core/clock', () => {
  test('createClock 固定时间：now() 为 ISO、nowMs() 原值', () => {
    const c = createClock({ now: 1770000000000 });
    assert.equal(c.nowMs(), 1770000000000);
    assert.equal(c.now(), new Date(1770000000000).toISOString());
  });

  test('createClock 缺省 now 使用系统时间；systemClock 可用', () => {
    const before = Date.now();
    const c = createClock({});
    assert.ok(Math.abs(c.nowMs() - before) < 5000);
    assert.ok(!Number.isNaN(Date.parse(c.now())));
    assert.ok(!Number.isNaN(Date.parse(systemClock.now())));
    assert.ok(typeof systemClock.nowMs() === 'number');
  });
});

describe('core/ids', () => {
  test('newId 生成 26 位 Crockford base32（大写、无 I L O U）', () => {
    const id = newId();
    assert.match(id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  test('newId 单调递增（同源毫秒内亦有序）且唯一', () => {
    const t = 1770000000000;
    const ids = Array.from({ length: 1000 }, (_, i) => newId(t + i));
    for (let i = 1; i < ids.length; i++) {
      assert.ok(ids[i - 1] < ids[i], `ULID 应按时间单调：${ids[i - 1]} < ${ids[i]}`);
    }
    assert.equal(new Set(ids).size, ids.length, '1000 个 id 应唯一');
  });

  test('isId：合法 id 为 true，非法形态为 false', () => {
    assert.equal(isId(newId()), true);
    assert.equal(isId(''), false);
    assert.equal(isId('01A'), false); // 太短
    assert.equal(isId(newId().toLowerCase()), false); // 小写非法
    assert.equal(isId('I'.repeat(26).replace(/I/g, 'A') + 'I'), false); // 含解码字符 I（长度错开）
    assert.equal(isId('01AI0000000000000000000000'.slice(0, 26)), false); // 含 I
    assert.equal(isId(42), false);
  });
});

describe('core/hash', () => {
  test('normalizeText：小写、全角→半角、去多余空白、去标点', () => {
    assert.equal(normalizeText('ＡＢＣ'), 'abc');
    assert.equal(normalizeText('  a   b  '), 'a b');
    assert.ok(!normalizeText('Hello, world!').match(/[,!]/), '标点应被去除');
    assert.equal(normalizeText('Hello, World!'), 'hello world');
    // 中文保留
    assert.ok(normalizeText('部署分支').includes('部署'));
  });

  test('contentHash：sha256:<64hex>，确定性，字段敏感', () => {
    const input = { text: '报名截止 3/1', subject: 'course.signup', predicate: 'deadline', value: '2026-03-01' };
    const h1 = contentHash(input);
    const h2 = contentHash({ ...input });
    assert.match(h1, /^sha256:[0-9a-f]{64}$/);
    assert.equal(h1, h2, '相同输入哈希一致');
    assert.notEqual(h1, contentHash({ ...input, value: '2026-04-01' }), 'value 变化应改变哈希');
    assert.notEqual(h1, contentHash({ ...input, text: '报名截止 4/1' }), 'text 变化应改变哈希');
  });

  test('tokenize：英文按词+小写、去停用词；中文按 2-gram', () => {
    const en = tokenize('Deploy the Release branch NOW');
    assert.ok(en.includes('deploy'));
    assert.ok(en.includes('release'));
    assert.ok(!en.includes('the'), '停用词应被去除');
    const zh = tokenize('部署分支');
    assert.ok(zh.includes('部署'), '中文应切出 2-gram');
    assert.ok(zh.includes('分支'), '中文应切出 2-gram（含尾 gram）');
  });
});

describe('core/scope', () => {
  test('MEMO_SCOPE 优先', () => {
    const r = resolveScope({ cwd: '/any/where', env: { MEMO_SCOPE: 'repo:x' } });
    assert.equal(r.scope, 'repo:x');
    assert.equal(r.root, '/any/where');
  });

  test('向上找 .git → repo:<目录名>', () => {
    const base = mkdtempSync(join(tmpdir(), 'memo-'));
    const inner = join(base, 'proj', 'sub');
    mkdirSync(inner, { recursive: true });
    mkdirSync(join(base, 'proj', '.git'));
    try {
      const r = resolveScope({ cwd: inner, env: {} });
      assert.equal(r.scope, 'repo:proj');
      assert.equal(r.root, join(base, 'proj'));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('无 .git 兜底 dir:<目录名>', () => {
    const base = mkdtempSync(join(tmpdir(), 'memo-'));
    const inner = join(base, 'plain');
    mkdirSync(inner);
    try {
      const r = resolveScope({ cwd: inner, env: {} });
      assert.equal(r.scope, `dir:plain`);
      assert.equal(r.root, inner);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('core/record', () => {
  const clock = createClock({ now: 1770000000000 });
  const baseInput = {
    text: '推荐用 Node 18',
    kind: 'fact',
    subject: 'toolchain.node',
    predicate: 'version',
    value: 'v18',
    source: { agent: 'test' },
  };

  test('createRecord：默认值齐全且合法', () => {
    const r = createRecord(baseInput, { clock });
    assert.match(r.id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.equal(r.v, 1);
    assert.equal(r.status, 'active');
    assert.equal(r.validTo, null);
    assert.equal(r.confidence, 0.8);
    assert.equal(r.privacy, 'private');
    assert.equal(r.hits, 0);
    assert.deepEqual(r.tags, []);
    assert.equal(r.validFrom, clock.now());
    assert.match(r.contentHash, /^sha256:/);
    const v = validateRecord(r);
    assert.ok(v.ok, `默认记录应合法：${JSON.stringify(v.errors)}`);
  });

  test('createRecord：text 超硬上限报错（W1 不再静默截断）', () => {
    assert.throws(
      () => createRecord({ ...baseInput, text: 'x'.repeat(5000) }, { clock }),
      (e) => e.code === 'E_INVALID_RECORD' && /textHardMaxChars/.test(e.message),
    );
  });

  test('validateRecord：逐条不变式', () => {
    const good = createRecord(baseInput, { clock });
    // 1 非法 id
    assert.equal(validateRecord({ ...good, id: 'abc' }).ok, false);
    // 2 source.agent 缺失 / 非白名单
    assert.equal(validateRecord({ ...good, source: {} }).ok, false);
    // 裁决 25：agent 是自由标签（不收窄枚举），但保留名与非法格式必须拒
    assert.equal(validateRecord({ ...good, source: { agent: 'root' } }).ok, false);
    assert.equal(validateRecord({ ...good, source: { agent: 'BAD AGENT' } }).ok, false);
    assert.equal(validateRecord({ ...good, source: { agent: 'grok' } }).ok, true);
    // 3 active 但 validTo 非空
    assert.equal(validateRecord({ ...good, validTo: good.validFrom }).ok, false);
    // validFrom > validTo
    assert.equal(
      validateRecord({ ...good, status: 'superseded', validFrom: '9999-01-01T00:00:00.000Z', validTo: '2000-01-01T00:00:00.000Z' }).ok,
      false,
    );
    // 4 superseded 但 validTo 为空
    assert.equal(validateRecord({ ...good, status: 'superseded' }).ok, false);
    // 5 contentHash 前缀错误
    assert.equal(validateRecord({ ...good, contentHash: 'md5:abcd' }).ok, false);
    // 6 v<1 / confidence 越界
    assert.equal(validateRecord({ ...good, v: 0 }).ok, false);
    assert.equal(validateRecord({ ...good, confidence: 1.5 }).ok, false);
    assert.equal(validateRecord({ ...good, confidence: -0.1 }).ok, false);
    // 7 text 为空
    assert.equal(validateRecord({ ...good, text: '' }).ok, false);
    // 错误应带信息
    const bad = validateRecord({ ...good, id: 'abc' });
    assert.ok(Array.isArray(bad.errors) && bad.errors.length >= 1, 'errors 应为非空数组');
  });

  test('withPatch：v+1、纯函数不改入参', () => {
    const r = createRecord(baseInput, { clock });
    const snapshot = JSON.parse(JSON.stringify(r));
    const r2 = withPatch(r, { status: 'superseded', validTo: clock.now() });
    assert.notEqual(r2, r, '应返回新对象');
    assert.equal(r2.v, r.v + 1, '版本号 +1');
    assert.equal(r2.status, 'superseded');
    assert.deepEqual(r, snapshot, '入参不得被修改');
  });
});
