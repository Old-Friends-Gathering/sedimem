// tests/unit/web-task-api.test.js — 任务账本 HTTP 端点（v1.2 A1/A2）
// 契约：versions/v1.2/docs/SEGMENT-SPEC.md §5/§7（briefJson / 错误码）+ A1/A2 端点形状。
// 覆盖：三个 GET 的形状/排序/asOf/maxChars、400 分支（缺参/非法 task/非法 asOf/非法 maxChars）、
// 404 分支（任务不存在）、只读模式两个写端点 → 403 E_READ_ONLY、可写模式 capture 落段 + task_capture 事件、
// archive 只回归档目录名（不含绝对路径）。

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import zlib from 'node:zlib';

import { appendSegment } from '../../src/session/ledger.js';
import { cwdToSessionSlug } from '../../src/session/transcript.js';
import { createWebServer } from '../../src/web/server.js';

const TASK = '20261115-1000-abcd'; // 预置 2 段
const TASK_CAP = '20261115-1010-cafe'; // capture 目标（只有 meta）
const TASK_ARC = '20261115-1020-face'; // archive 目标（只有 meta）
const MISSING = '20261115-9999-dead';

const SEG1_AT = '2026-11-15T01:00:00.000Z';
const SEG2_AT = '2026-11-15T02:00:00.000Z';

const AS_OF_MID = '2026-11-15T01:30:00.000Z'; // 晚于 seg1、早于 seg2

describe('web 任务账本 API（A1 只读 + A2 写）', () => {
  let home;
  let anchor;
  let readOnly;
  let writable;
  const savedEnv = { HOME: process.env.HOME, MEMO_WRITE: process.env.MEMO_WRITE };

  /** GET 便捷封装：返回 {status, body} */
  async function get(srv, path) {
    const res = await fetch(`${srv.url}api/${path}`);
    return { status: res.status, body: await res.json() };
  }

  /** POST 便捷封装（与 UI 同款：JSON body、无 Origin） */
  async function post(srv, path, payload) {
    const res = await fetch(`${srv.url}api/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload ?? {}),
    });
    return { status: res.status, body: await res.json() };
  }

  function writeMeta(taskId, title, extra = {}) {
    mkdirSync(join(home, 'sessions', taskId), { recursive: true });
    writeFileSync(
      join(home, 'sessions', taskId, 'meta.json'),
      JSON.stringify({ taskId, title, status: 'open', startedAt: SEG1_AT, ...extra }),
    );
  }

  before(async () => {
    home = mkdtempSync(join(tmpdir(), 'memo-task-api-'));
    anchor = join(home, 'anchor.jsonl');
    writeFileSync(anchor, '{"seq":1}\n');
    writeMeta(TASK, '联调任务');
    writeMeta(TASK_CAP, '捕获任务');
    writeMeta(TASK_ARC, '归档任务');

    await appendSegment({
      memoHome: home,
      taskId: TASK,
      segment: {
        id: 'seg_a', taskId: TASK, fromSeq: 0, toSeq: 2, createdAt: SEG1_AT,
        anchor: { path: anchor, fromSeq: 0, toSeq: 2 },
        summary: '第一段：读 spec 并定路由',
        decisions: ['用精确匹配 Map 而不是参数路由'],
        gotchas: ['Map 不是参数路由'],
        pendingJobs: ['补单元测试'],
        files: ['src/web/handlers.js'],
        mode: 'rules',
      },
    });
    await appendSegment({
      memoHome: home,
      taskId: TASK,
      segment: {
        id: 'seg_b', taskId: TASK, fromSeq: 2, toSeq: 4, createdAt: SEG2_AT,
        anchor: { path: anchor, fromSeq: 2, toSeq: 4 },
        summary: '第二段：写端点与事件留痕',
        decisions: ['任务端点忽略 ?scope='],
        files: ['src/web/api/write.js'],
        mode: 'rules',
      },
    });

    // 只读服务先起（此时 MEMO_WRITE 还没被可写服务改脏）；显式 writeEnabled:false 才能覆盖环境变量
    readOnly = await createWebServer({ memoHome: home, port: 0, includeUi: false, writeEnabled: false, write: false });
    writable = await createWebServer({ memoHome: home, port: 0, includeUi: false, writeEnabled: true });
  });

  after(async () => {
    if (readOnly) await readOnly.close();
    if (writable) await writable.close();
    process.env.HOME = savedEnv.HOME;
    if (savedEnv.MEMO_WRITE === undefined) delete process.env.MEMO_WRITE;
    else process.env.MEMO_WRITE = savedEnv.MEMO_WRITE;
    if (home) rmSync(home, { recursive: true, force: true });
  });

  test('GET /api/task-context：顶栏摘要形状（task 字符串、segments 是数字）', async () => {
    const { status, body } = await get(writable, `task-context?task=${TASK}`);
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.ok, true);
    assert.equal(body.task, TASK);
    assert.equal(body.meta.title, '联调任务');
    assert.equal(body.segments, 2);
    // 相邻段 [0,2)+[2,4) 在 coveredSeqs 里合并成一段 [0,4)
    assert.deepEqual(body.covered, [[0, 4]]);
    assert.ok(body.briefChars > 0, 'briefChars 应为简报预算已用量');
    assert.equal(body.lastCapturedAt, SEG2_AT);
  });

  test('GET /api/task-segments：完整段记录、fromSeq 升序、badLines/index', async () => {
    const { status, body } = await get(writable, `task-segments?task=${TASK}`);
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.ok, true);
    assert.equal(body.task, TASK);
    assert.deepEqual(body.segments.map((s) => s.id), ['seg_a', 'seg_b']);
    assert.deepEqual(body.segments.map((s) => [s.fromSeq, s.toSeq]), [[0, 2], [2, 4]]);
    assert.equal(body.segments[0].summary, '第一段：读 spec 并定路由');
    assert.equal(body.segments[0].mode, 'rules');
    assert.equal(body.badLines, 0);
    assert.ok(body.index && Array.isArray(body.index.segments), 'index 应为 readIndex 的原始对象');
    assert.equal(body.index.segments.length, 2);
  });

  test('GET /api/task-brief：briefJson 展开在顶层（task 是对象），asOf/maxChars 生效', async () => {
    const full = await get(writable, `task-brief?task=${TASK}`);
    assert.equal(full.status, 200, JSON.stringify(full.body));
    assert.equal(full.body.ok, true);
    assert.deepEqual(full.body.task, { id: TASK, title: '联调任务', state: 'open' });
    assert.equal(full.body.budget.maxChars, 2200);
    assert.equal(full.body.segments.total, 2);
    assert.equal(full.body.segments.used, 2);
    assert.ok(full.body.summary.includes('第二段'));
    assert.deepEqual(full.body.decisions.map((d) => d.text), ['用精确匹配 Map 而不是参数路由', '任务端点忽略 ?scope=']);

    const frozen = await get(writable, `task-brief?task=${TASK}&asOf=${encodeURIComponent(AS_OF_MID)}`);
    assert.equal(frozen.status, 200, JSON.stringify(frozen.body));
    assert.equal(frozen.body.segments.used, 1, 'asOf 之后的段必须排除');
    assert.equal(frozen.body.decisions.length, 1);

    const tiny = await get(writable, `task-brief?task=${TASK}&maxChars=40`);
    assert.equal(tiny.status, 200, JSON.stringify(tiny.body));
    assert.equal(tiny.body.budget.maxChars, 40);
    assert.equal(tiny.body.budget.truncated, true);
    assert.ok(tiny.body.budget.usedChars <= 40);
  });

  test('400 分支：缺 task / task 非法 / asOf 非法 / maxChars 非法', async () => {
    for (const path of [
      'task-context',
      `task-context?task=${encodeURIComponent('../etc/passwd')}`,
      `task-context?task=${encodeURIComponent('TASK-UPPER')}`,
    ]) {
      const { status, body } = await get(writable, path);
      assert.equal(status, 400, `${path} → ${JSON.stringify(body)}`);
      assert.equal(body.code, 'E_INVALID_ARG');
    }
    for (const path of [
      `task-brief?task=${TASK}&asOf=not-a-time`,
      `task-brief?task=${TASK}&maxChars=0`,
      `task-brief?task=${TASK}&maxChars=999999`,
    ]) {
      const { status, body } = await get(writable, path);
      assert.equal(status, 400, `${path} → ${JSON.stringify(body)}`);
      assert.equal(body.code, 'E_INVALID_ARG');
    }
  });

  test('404 分支：task 合法但任务不存在（三条 GET 都 404）', async () => {
    for (const path of ['task-context', 'task-segments', 'task-brief']) {
      const { status, body } = await get(writable, `${path}?task=${MISSING}`);
      assert.equal(status, 404, `${path} → ${JSON.stringify(body)}`);
      assert.equal(body.code, 'E_NOT_FOUND');
    }
  });

  test('?scope= 被忽略：带任意合法分库 scope 结果不变', async () => {
    const plain = await get(writable, `task-context?task=${TASK}`);
    const withScope = await get(writable, `task-context?task=${TASK}&scope=${encodeURIComponent('repo:some-other')}`);
    assert.equal(withScope.status, 200, JSON.stringify(withScope.body));
    assert.deepEqual(withScope.body, plain.body);
  });

  test('只读模式：capture / archive → 403 E_READ_ONLY', async () => {
    const cap = await post(readOnly, 'tasks/capture', { task: TASK_CAP });
    assert.equal(cap.status, 403, JSON.stringify(cap.body));
    assert.equal(cap.body.code, 'E_READ_ONLY');
    const arc = await post(readOnly, 'tasks/archive', { task: TASK_ARC });
    assert.equal(arc.status, 403, JSON.stringify(arc.body));
    assert.equal(arc.body.code, 'E_READ_ONLY');
  });

  test('可写模式：capture 落段并写 task_capture 事件（cwd 指向伪造的 DSH 转录）', async () => {
    const projDir = join(home, 'proj');
    const fakeHome = join(home, 'fake-home');
    const ts = join(fakeHome, '.dsh', 'sessions', cwdToSessionSlug(projDir), 'sess-1');
    mkdirSync(ts, { recursive: true });
    const lines = [
      { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: '实现 task-context 端点' }] } },
      { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '先读 SEGMENT-SPEC 第 5 节' }] } } },
      { seq: 3, type: 'user/message', data: { content: [{ type: 'text', text: '再跑 tests/unit/web-task-api.test.js' }] } },
      { seq: 4, type: 'assistant/message', data: { content: [{ type: 'text', text: '测试跑绿，提交 src/web/api/task-ledger.js' }] } },
    ];
    const raw = Buffer.from(lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    writeFileSync(join(ts, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(raw));

    process.env.HOME = fakeHome;
    try {
      const { status, body } = await post(writable, 'tasks/capture', {
        task: TASK_CAP,
        mode: 'rules',
        cwd: projDir,
      });
      assert.equal(status, 200, JSON.stringify(body));
      assert.equal(body.ok, true);
      assert.equal(body.created, 1);
      assert.equal(body.skipped, 0);
      assert.equal(body.segments.length, 1);
      assert.equal(body.segments[0].taskId, TASK_CAP);

      // 再捕一次：幂等（无新 turn → skipped）
      const again = await post(writable, 'tasks/capture', { task: TASK_CAP, cwd: projDir });
      assert.equal(again.status, 200, JSON.stringify(again.body));
      assert.equal(again.body.created, 0);
      assert.equal(again.body.skipped, 1);

      // 事件留痕：op=task_capture、scope=session:<task>、detail 三字段
      const events = readFileSync(join(home, 'events.jsonl'), 'utf8')
        .split('\n').filter(Boolean).map((l) => JSON.parse(l));
      const hits = events.filter((e) => e.op === 'task_capture' && e.scope === `session:${TASK_CAP}`);
      assert.equal(hits.length, 2, '两次 capture 各留一条事件');
      assert.deepEqual(hits[0].detail, { created: 1, skipped: 0, mode: 'rules' });
      assert.deepEqual(hits[1].detail, { created: 0, skipped: 1, mode: 'rules' });
      assert.equal(typeof hits[0].ts, 'string');
    } finally {
      process.env.HOME = savedEnv.HOME;
    }
  });

  test('可写模式：archive 只回归档目录名（不含绝对路径）且目录已移动', async () => {
    const { status, body } = await post(writable, 'tasks/archive', { task: TASK_ARC });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.ok, true);
    assert.equal(typeof body.movedTo, 'string');
    assert.ok(!body.movedTo.includes(home), `movedTo 不能含绝对路径: ${body.movedTo}`);
    assert.match(body.movedTo, new RegExp(`^${TASK_ARC}-\\d{8}-\\d{6}$`));
    assert.equal(existsSync(join(home, 'sessions', TASK_ARC)), false);
    assert.equal(existsSync(join(home, 'archive', body.movedTo)), true);

    // 归档后再读 → 404（任务已不在 sessions/）
    const after = await get(writable, `task-context?task=${TASK_ARC}`);
    assert.equal(after.status, 404);
  });
});
