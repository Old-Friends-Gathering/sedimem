// v0.4 架构审核探针：脱敏是否覆盖 value 与 supersede 路径。
// 只读源码 + 临时 MEMO_HOME，不写仓库数据。
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createMemoryService } from '../../src/api/service.js';

const memoHome = await mkdtemp(path.join(tmpdir(), 'sedimem-v04-redact-'));
const scope = 'repo:probe';
const svc = await createMemoryService({ memoHome, scope, policy: { redact: { enabled: true } } });
const itemsPath = path.join(memoHome, 'items', `${scope}.jsonl`);

// 1) text 干净、value 含密钥：契约 63 要求 text 与 value 都脱敏。
const a = await svc.write({
  text: '部署说明见 README',
  value: 'password=hunter2',
  source: { agent: 'probe' },
});

// 2) text === value 都含密钥：text 会被脱敏，value 是否跟着脱敏？
const secret = 'api_key=sk-abcdefghijklmnopqrstuvwxyz';
const b = await svc.write({ text: secret, value: secret, source: { agent: 'probe' } });

// 3) supersede 路径完全跳过 redactText（源码 write-path.js:119-144）。
const c = await svc.write({ text: 'token-later', subject: 'svc.token', predicate: 'value', source: { agent: 'probe' } });
const d = await svc.supersede({
  oldId: c.record.id,
  text: 'token=ghp_abcdefghijklmnopqrstuvwxyz0123',
  value: 'ghp_abcdefghijklmnopqrstuvwxyz0123',
  source: { agent: 'probe' },
});

// 4) title 也是落盘字段且注入会优先渲染 title；它不经 redactText。
const e = await svc.write({ text: '标题里放了密钥', title: 'token=ghp_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', source: { agent: 'probe' } });

const raw = await readFile(itemsPath, 'utf8');
const lines = raw.trim().split('\n').map((l) => JSON.parse(l));
const last = (id) => lines.filter((r) => r.id === id).at(-1);

let leaked = 0;
for (const needle of ['hunter2', 'sk-abcdefghijklmnopqrstuvwxyz', 'ghp_abcdefghijklmnopqrstuvwxyz0123', 'ghp_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb']) {
  if (raw.includes(needle)) leaked++;
}

console.log(JSON.stringify({
  case1_value_only_secret: {
    action: a.action,
    text: last(a.record.id)?.text,
    value: last(a.record.id)?.value,
    tags: last(a.record.id)?.tags,
  },
  case2_text_eq_value: {
    action: b.action,
    text: last(b.record.id)?.text,
    value: last(b.record.id)?.value,
    value_leaks_secret: String(last(b.record.id)?.value).includes('sk-'),
  },
  case3_supersede: {
    action: d.record.action,
    text: last(d.record.id)?.text,
    value: last(d.record.id)?.value,
    text_leaks_token: String(last(d.record.id)?.text).includes('ghp_'),
  },
  case4_title: {
    action: e.action,
    title: last(e.record.id)?.title,
    title_leaks_token: String(last(e.record.id)?.title).includes('ghp_bbbb'),
  },
  secrets_found_in_truth_file: leaked,
  truth_file: itemsPath,
}, null, 2));

await svc.close();
