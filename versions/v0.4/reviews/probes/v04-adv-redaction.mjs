// v0.4 对抗审核探针：入库脱敏（先脱敏再哈希）
//   1) text 干净、value 带密钥 → value 原样入库（脱敏只看 text，且只有 text.changed 才回写 value）
//   2) JSON 引号键 "password":"..." → assignment 正则要求 key 后紧跟冒号，漏检
//   3) DB_PASSWORD=... → \b 在 _ 后不成立，漏检
//   4) supersede 完全不走 redactText → 明文密钥入库
//   5) policy.redact.enabled=false 真的回退；恢复默认后新写入重新脱敏（旧记录保持明文）
//   6) 多行 / 幂等 / base64 / 超长：多行能脱敏、幂等无嵌套标记、base64 不检测
// 运行：node reviews/probes/v04-adv-redaction.mjs
import { mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

import { createMemoryService } from '../../src/api/service.js';
import { redactText } from '../../src/hygiene/redact.js';
import { defaultPolicy } from '../../src/config/policy.js';

const out = {};
const tmp = () => mkdtemp(path.join(tmpdir(), 'sedimem-adv-red-'));

// —— 1) value 与 text 分叉 ——
{
  const memoHome = await tmp();
  const svc = await createMemoryService({ memoHome, scope: 'repo:val' });
  const secret = 'password=Hunter2-Prod-Secret';
  const w = await svc.write({ text: '凭据见 value 字段', value: secret, subject: 'cred', predicate: 'value', source: { agent: 'probe' } });
  const rec = await svc.get(w.record.id);
  const items = await readFile(path.join(memoHome, 'items', 'repo:val.jsonl'), 'utf8');
  out.valueDivergence = {
    textStored: rec.text,
    valueStored: rec.value,
    valueIsRaw: rec.value === secret,
    tags: rec.tags,
    rawSecretInItemsFile: items.includes(secret),
  };
  await svc.close();
}

// —— 2) JSON 引号键 / 3) 下划线前缀 ——
{
  const memoHome = await tmp();
  const svc = await createMemoryService({ memoHome, scope: 'repo:json' });
  const cases = [
    '{"password":"hunter2secret"}',
    '{"password": "hunter2secret"}',
    'DB_PASSWORD=hunter2secret',
    'config: {"db": {"token": "abcdef123456"}}',
    'password=plainTextSecret1',
    'line1\npassword=multiLineSecret2\nline3',
  ];
  const rows = [];
  for (const [i, text] of cases.entries()) {
    const w = await svc.write({ text, subject: `c${i}`, predicate: 'x', source: { agent: 'probe' } });
    const rec = await svc.get(w.record.id);
    rows.push({ input: text, stored: rec.text, redacted: rec.text !== text, tags: rec.tags });
  }
  out.patterns = rows;
  await svc.close();
}

// —— 4) supersede 不脱敏 ——
{
  const memoHome = await tmp();
  const svc = await createMemoryService({ memoHome, scope: 'repo:sup' });
  const old = await svc.write({ text: '旧配置占位', subject: 'svc', predicate: 'cred', source: { agent: 'probe' } });
  const sup = await svc.supersede({
    oldId: old.record.id,
    value: 'password=Rotated-Prod-Secret',
    text: '新配置：password=Rotated-Prod-Secret',
    source: { agent: 'probe' },
  });
  const rec = await svc.get(sup.record.id);
  out.supersedeBypass = {
    newId: sup.record.id,
    textStored: rec.text,
    valueStored: rec.value,
    textRaw: rec.text.includes('Rotated-Prod-Secret'),
    valueRaw: rec.value.includes('Rotated-Prod-Secret'),
    tags: rec.tags,
  };
  await svc.close();
}

// —— 5) 关闭开关真的回退；恢复后新写入重新脱敏 ——
{
  const memoHome = await tmp();
  const off = await createMemoryService({ memoHome, scope: 'repo:off', policy: { redact: { enabled: false } } });
  const w1 = await off.write({ text: 'password=OffSwitchSecret', subject: 'a', predicate: 'b', source: { agent: 'probe' } });
  const r1 = await off.get(w1.record.id);
  await off.close();
  const on = await createMemoryService({ memoHome, scope: 'repo:off' });
  const w2 = await on.write({ text: 'password=BackOnSecret', subject: 'c', predicate: 'd', source: { agent: 'probe' } });
  const r2 = await on.get(w2.record.id);
  await on.close();
  out.disableSwitch = {
    off: { stored: r1.text, raw: r1.text.includes('OffSwitchSecret'), tags: r1.tags },
    backOn: { stored: r2.text, raw: r2.text.includes('BackOnSecret'), tags: r2.tags },
  };
}

// —— 6) 多行 / 幂等 / base64 / 超长 ——
{
  const policy = defaultPolicy;
  const multiline = redactText('部署说明\npassword=multiLineSecretXYZ\nend', { policy });
  const once = redactText('token=abcdef123456 and password=zzzzzz9999', { policy });
  const twice = redactText(once.text, { policy });
  const b64 = Buffer.from('password=Base64HiddenSecret', 'utf8').toString('base64');
  const b64res = redactText(`日志：${b64}`, { policy });
  const huge = redactText(`password=${'A'.repeat(5000)}`, { policy });
  out.helpers = {
    multiline: { text: multiline.text, changed: multiline.changed, redactions: multiline.redactions },
    idempotent: { once: once.text, twice: twice.text, same: once.text === twice.text, nestedMarker: twice.text.includes('[REDACTED:') && twice.text.includes('[REDACTED:assignment]') },
    base64: { b64, output: b64res.text, changed: b64res.changed },
    huge: { outputLength: huge.text.length, changed: huge.changed, redactions: huge.redactions },
  };
}

console.log(JSON.stringify(out, null, 2));
