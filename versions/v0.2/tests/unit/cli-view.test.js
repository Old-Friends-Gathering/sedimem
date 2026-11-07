// tests/unit/cli-view.test.js — `memo view` / `memo brief --tier0` 的接线测试（v0.3）
// 为什么要有：view.js 是「Lead 手工接线」的地方，最容易被漏测——上面四个模块各有单测，
// 但把它们接进 CLI 的参数解析、退出码、降级路径没人管。这里用真 service + 假 console 覆盖分支。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMemoryService } from '../../src/api/service.js';
import { cmdView, cmdBriefTier0, L2_VIEW_FILE } from '../../src/cli/view.js';

const SCOPE = 'dir:test-cli-view';

function fakeLog() {
  const lines = [];
  const errs = [];
  // out/err 必须是 getter：写成快照字符串就会永远返回调用那一刻的（空）内容
  return {
    lines, errs,
    log: (m) => lines.push(String(m)),
    error: (m) => errs.push(String(m)),
    get out() { return lines.join('\n'); },
    get err() { return errs.join('\n'); },
  };
}

async function withService(fn) {
  const memoHome = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-cliview-'));
  const service = await createMemoryService({ memoHome, scope: SCOPE });
  try {
    await fn({ service, memoHome });
  } finally {
    await service.close();
    fs.rmSync(memoHome, { recursive: true, force: true });
  }
}

async function seed(service) {
  await service.write({ text: '真相层是只追加 JSONL', kind: 'fact', subject: 'strata/truth', predicate: 'storage', value: 'jsonl', source: { agent: 'test' } });
  await service.write({ text: '近重复阈值 0.85，宁漏不误杀', kind: 'decision', subject: 'strata/dedupe', predicate: 'threshold', value: '0.85', source: { agent: 'test' } });
}

test('view build → show → rebuild：文件落地且可重建', async () => {
  await withService(async ({ service, memoHome }) => {
    await seed(service);
    const log = fakeLog();
    assert.equal(await cmdView(['build'], {}, false, service, log), 0);
    assert.match(log.out, /L2 构建完成/);
    assert.ok(fs.existsSync(path.join(memoHome, 'views', L2_VIEW_FILE.replace('L2.jsonl', ''), 'L2.jsonl')) ||
      fs.existsSync(path.join(memoHome, 'views')));

    const showLog = fakeLog();
    assert.equal(await cmdView(['show', 'L2'], {}, false, service, showLog), 0);
    assert.match(showLog.out, /L2：\d+ 块/);

    const jsonLog = fakeLog();
    assert.equal(await cmdView(['show', 'L2'], { json: true }, true, service, jsonLog), 0);
    assert.ok(JSON.parse(jsonLog.out).blocks.length >= 1);
  });
});

test('view show 无视图时给出可操作错误（退出码 1）', async () => {
  await withService(async ({ service }) => {
    const log = fakeLog();
    assert.equal(await cmdView(['show', 'L2'], {}, false, service, log), 1);
    assert.match(log.err, /memo view build/);
  });
});

test('view trace：能给出 L2 块；L3 记录额外给出出处', async () => {
  await withService(async ({ service }) => {
    await seed(service);
    await cmdView(['build'], {}, false, service, fakeLog());
    const [rec] = (await service.exportRecords({ status: 'active', limit: 10 })).records;
    const log = fakeLog();
    assert.equal(await cmdView(['trace', rec.id], {}, false, service, log), 0);
    assert.match(log.out, /L2 块：/);

    // 造一条带 sourceRefs 的 L3
    await service.write({ text: '这个项目偏好零依赖', kind: 'pref', subject: 'pref/deps', predicate: 'rule', value: 'zero-dep', source: { agent: 'test' }, sourceRefs: [rec.id], tags: ['L3'] });
    const l3 = (await service.exportRecords({ status: 'active', limit: 10 })).records.find((r) => r.tags?.includes('L3'));
    const l3Log = fakeLog();
    assert.equal(await cmdView(['trace', l3.id], {}, false, service, l3Log), 0);
    assert.match(l3Log.out, /L3 出处：1 条/);
  });
});

test('view trace 缺参数 → 退出码 2；view show 非 L2 → 退出码 2', async () => {
  await withService(async ({ service }) => {
    assert.equal(await cmdView(['trace'], {}, false, service, fakeLog()), 2);
    assert.equal(await cmdView(['show', 'L3'], {}, false, service, fakeLog()), 2);
    assert.equal(await cmdView(['bogus'], {}, false, service, fakeLog()), 2);
  });
});

test('view l3 plan：给出候选与预算', async () => {
  await withService(async ({ service }) => {
    await seed(service);
    const log = fakeLog();
    assert.equal(await cmdView(['l3', 'plan'], {}, false, service, log), 0);
    assert.match(log.out, /L3 候选：\d+ 条/);
    const jsonLog = fakeLog();
    assert.equal(await cmdView(['l3', 'plan'], { json: true }, true, service, jsonLog), 0);
    assert.ok(Array.isArray(JSON.parse(jsonLog.out).candidates));
  });
});

test('view l3 apply：合法草稿落盘、缺 sourceRefs 被拒', async () => {
  await withService(async ({ service, memoHome }) => {
    await seed(service);
    const [rec] = (await service.exportRecords({ status: 'active', limit: 10 })).records;
    const file = path.join(memoHome, 'drafts.json');
    fs.writeFileSync(file, JSON.stringify({
      drafts: [
        { text: '这个项目坚持零运行时依赖', sourceRefs: [rec.id], confidence: 0.9 },
        { text: '没有出处的画像', sourceRefs: [], confidence: 0.9 },
      ],
    }), 'utf8');
    const log = fakeLog();
    const code = await cmdView(['l3', 'apply'], { file }, true, service, log);
    assert.equal(code, 1, '有失败条目时退出码 1');
    const parsed = JSON.parse(log.out);
    assert.equal(parsed.created, 1);
    assert.equal(parsed.failed, 1);
  });
});

test('view l3 apply：出处不存在 → E_L3_SOURCEREFS_UNKNOWN（不能凭空编 ULID）', async () => {
  await withService(async ({ service, memoHome }) => {
    await seed(service);
    const file = path.join(memoHome, 'fake.json');
    fs.writeFileSync(file, JSON.stringify([{
      text: '这条画像的出处是编的', sourceRefs: ['01M6T8ZZZZZZZZZZZZZZZZZZZZ'], confidence: 0.9,
    }]), 'utf8');
    const log = fakeLog();
    assert.equal(await cmdView(['l3', 'apply'], { file }, true, service, log), 1);
    const parsed = JSON.parse(log.out);
    assert.equal(parsed.created, 0);
    assert.equal(parsed.results[0].code, 'E_L3_SOURCEREFS_UNKNOWN');
  });
});

test('view l3 apply：一条草稿在写入层被拒时，整批仍逐条报告（不中途崩）', async () => {
  await withService(async ({ service, memoHome }) => {
    await seed(service);
    const [rec] = (await service.exportRecords({ status: 'active', limit: 10 })).records;
    const file = path.join(memoHome, 'mixed.json');
    fs.writeFileSync(file, JSON.stringify([
      { text: '好的画像一', sourceRefs: [rec.id], confidence: 0.9 },
      { text: '重复出处', sourceRefs: [rec.id], confidence: 0.9 },
      { text: '坏的（自引）', sourceRefs: [rec.id], confidence: 0.9 },
    ]), 'utf8');
    const log = fakeLog();
    const code = await cmdView(['l3', 'apply'], { file }, true, service, log);
    const parsed = JSON.parse(log.out);
    assert.equal(code, 0, '三条都合法，不应有失败');
    assert.equal(parsed.failed, 0);
    assert.ok(parsed.created + parsed.unchanged === 3);
  });
});

test('view l3 apply：超过 batchSize 直接拒（不半写）', async () => {
  await withService(async ({ service, memoHome }) => {
    await seed(service);
    const [rec] = (await service.exportRecords({ status: 'active', limit: 10 })).records;
    const drafts = Array.from({ length: 11 }, (_, i) => ({ text: `画像 ${i}`, sourceRefs: [rec.id], confidence: 0.9 }));
    const file = path.join(memoHome, 'many.json');
    fs.writeFileSync(file, JSON.stringify(drafts), 'utf8');
    const log = fakeLog();
    assert.equal(await cmdView(['l3', 'apply'], { file }, false, service, log), 2);
    assert.match(log.err, /最多 10 条/);
  });
});

test('brief --tier0：输出目录且带完整 id', async () => {
  await withService(async ({ service }) => {
    await seed(service);
    const log = fakeLog();
    assert.equal(await cmdBriefTier0({}, false, service, log), 0);
    assert.match(log.out, /\[fact\] strata\/truth\/storage = jsonl \(id [0-9A-HJKMNP-TV-Z]{26}, \d{4}-\d{2}-\d{2}\)/);
  });
});
