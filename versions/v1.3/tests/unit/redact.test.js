import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { redactText, REDACT_KINDS } from '../../src/hygiene/redact.js';

describe('hygiene/redact.js（D7 入库脱敏）', () => {
  test('REDACT_KINDS 导出七类', () => {
    assert.deepEqual([...REDACT_KINDS].sort(), [
      'api_key', 'assignment', 'aws_key', 'github_token',
      'internal_host', 'jwt', 'private_key',
    ]);
  });

  test('api_key：sk- 长 token 命中', () => {
    const r = redactText('key 是 sk-abcDEF1234567890ghijKL，别外泄');
    assert.equal(r.text, 'key 是 [REDACTED:api_key]，别外泄');
    assert.deepEqual(r.redactions, [{ kind: 'api_key', count: 1 }]);
    assert.equal(r.changed, true);
  });

  test('github_token：ghp_ + 20 位命中；ghr_ 亦命中', () => {
    const a = redactText('ghp_' + 'a1B2c3D4e5F6g7H8i9J0');
    assert.equal(a.text, '[REDACTED:github_token]');
    const b = redactText('token 在 ghr_zzzzzzzzzzzzzzzzzzzz 处');
    assert.equal(b.text, 'token 在 [REDACTED:github_token] 处');
    assert.equal(b.redactions[0].kind, 'github_token');
  });

  test('aws_key：AKIA + 16 位命中', () => {
    const r = redactText('AKIAIOSFODNN7EXAMPLE');
    assert.equal(r.text, '[REDACTED:aws_key]');
    assert.equal(r.changed, true);
  });

  test('jwt：eyJ 三段点分命中（Bearer 场景）', () => {
    const r = redactText('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4');
    assert.ok(r.text.startsWith('Authorization: Bearer [REDACTED:jwt]'));
    assert.deepEqual(r.redactions, [{ kind: 'jwt', count: 1 }]);
  });

  test('private_key：整块 PEM 命中（含 BEGIN/END）', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA7x\n-----END RSA PRIVATE KEY-----';
    const r = redactText(`签名用 ${pem} 别提交`);
    assert.equal(r.text, '签名用 [REDACTED:private_key] 别提交');
  });

  test('assignment：key=value 只遮值，key 与分隔符保留', () => {
    for (const [k, sep] of [['password', ':'], ['passwd', '='], ['pwd', ':'], ['secret', '='], ['token', ':'], ['api_key', '=']]) {
      const r = redactText(`${k}${sep}${sep === '=' ? 'S3cretValue' : ' myS3cretValue'}!`);
      assert.ok(r.text.includes(`${k}${sep}${sep === '=' ? '' : ' '}[REDACTED:assignment]`), r.text);
      assert.deepEqual(r.redactions, [{ kind: 'assignment', count: 1 }]);
    }
  });

  test('internal_host：三类内网段命中，可带端口', () => {
    assert.equal(redactText('连 10.1.2.3').text, '连 [REDACTED:internal_host]');
    assert.equal(redactText('db 在 192.168.0.5:5432/postgres').text, 'db 在 [REDACTED:internal_host]/postgres');
    assert.equal(redactText('192.168.1.10:8080 上线').text, '[REDACTED:internal_host] 上线');
    const r = redactText('跳板 172.16.31.255 与 172.32.1.1');
    // 172.16-31 命中；172.32 不属于私网段不命中
    assert.ok(r.text.includes('[REDACTED:internal_host]'));
    assert.ok(r.text.includes('172.32.1.1'));
  });

  test('幂等：对已脱敏文本再跑一遍输出不变', () => {
    const src = 'sk-abcdef1234567890abcd 与 password=hunter2secret，内网 10.0.0.1:22';
    const once = redactText(src);
    const twice = redactText(once.text);
    assert.equal(twice.text, once.text);
    assert.deepEqual(twice.redactions, [], '第二遍不得再命中');
    assert.equal(twice.changed, false);
    assert.ok(once.changed);
  });

  test('幂等：占位符片段不被 assignment 二次吞掉', () => {
    const once = redactText('token=sk-abcdef1234567890abcd');
    // api_key 先行：值已变占位符，assignment 不得再把占位符当值遮一遍
    assert.equal(once.text, 'token=[REDACTED:api_key]');
    const twice = redactText(once.text);
    assert.equal(twice.text, once.text);
  });

  test('反例：ULID/UUID/普通中文/sk-learn 不误伤', () => {
    const src = 'ULID 01ARZ3NDEKTSV4RRFFQ69G5FAV，UUID 550e8400-e29b-41d4-a716-446655440000，装 sk-learn 库，普通中文内容。';
    const r = redactText(src);
    assert.equal(r.text, src);
    assert.deepEqual(r.redactions, []);
    assert.equal(r.changed, false);
  });

  test('count 计数与 changed：同类多处累计', () => {
    const r = redactText('AKIAIOSFODNN7EXAMPLE 和 AKIAIOSFODNN7EXAMPLE 与 10.0.0.9');
    assert.deepEqual(r.redactions, [
      { kind: 'aws_key', count: 2 },
      { kind: 'internal_host', count: 1 },
    ]);
    assert.equal(r.changed, true);
  });

  test('参数校验：非字符串 text 抛 E_INVALID_ARG', () => {
    assert.throws(() => redactText(123), (e) => e.code === 'E_INVALID_ARG');
    assert.throws(() => redactText(null), (e) => e.code === 'E_INVALID_ARG');
  });

  test('policy.redact.kinds 白名单生效且未知类别报错', () => {
    const r = redactText('sk-abcdef1234567890abcd 和 10.0.0.9', { policy: { redact: { kinds: ['internal_host'] } } });
    assert.ok(r.text.includes('sk-abcdef1234567890abcd'), '白名单外的 kind 不得脱敏');
    assert.ok(!r.text.includes('10.0.0.9'));
    assert.throws(
      () => redactText('x', { policy: { redact: { kinds: ['nope'] } } }),
      (e) => e.code === 'E_INVALID_ARG',
    );
  });

  test('无命中：text 原样返回', () => {
    const r = redactText('数据库端口是 5432，默认分支 main');
    assert.equal(r.text, '数据库端口是 5432，默认分支 main');
    assert.equal(r.changed, false);
  });
});
