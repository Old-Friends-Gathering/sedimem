// tests/unit/ledger.test.js — B1 段存储（versions/v1.2/src/session/ledger.js）
// 覆盖：append×2 后 index 正确 / 重叠抛 E_ALREADY_CAPTURED / 坏行容错 /
//       rebuildIndex 逐字节确定 / archive 整目录移动。

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  appendSegment, archiveTask, coveredSeqs, readIndex, readSegments, rebuildIndex, segmentsFile,
} from '../../src/session/ledger.js';
import { newId } from '../../src/core/ids.js';

/** 固定时钟：index 的 builtAt 可预测，验证「内容不写 Date.now」 */
const FIXED_MS = Date.UTC(2026, 2, 1, 0, 0, 0);
const FIXED_ISO = new Date(FIXED_MS).toISOString();

function fixedClock(ms = FIXED_MS) {
  return { nowMs: () => ms, now: () => new Date(ms).toISOString() };
}

const at = (ms) => ({ nowMs: () => ms, now: () => new Date(ms).toISOString() });

let home;
let anchorPath;
let seqCounter = 0;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'memo-ledger-'));
  anchorPath = join(home, 'anchor.jsonl');
  writeFileSync(anchorPath, '{"seq":1}\n');
  seqCounter = 0;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/** 合法段 fixture（anchor 指向真实文件；区间由调用方指定） */
function makeSegment(fromSeq, toSeq, over = {}) {
  seqCounter += 1;
  return {
    id: newId(FIXED_MS + seqCounter),
    taskId: 'task-1',
    fromSeq,
    toSeq,
    createdAt: FIXED_ISO,
    source: { kind: 'dsh', path: anchorPath, sessionId: 'sess-1', frames: 1 },
    anchor: { path: anchorPath, fromSeq, toSeq },
    summary: `段 [${fromSeq}, ${toSeq}) 摘要`,
    facts: [],
    decisions: [],
    gotchas: [],
    pendingJobs: [],
    files: [],
    nextSteps: [],
    tokens: 7,
    trust: 'T1',
    taint: [],
    quarantined: false,
    mode: 'rules',
    ...over,
  };
}

async function append(fromSeq, toSeq, over = {}) {
  return appendSegment({
    memoHome: home, taskId: 'task-1', segment: makeSegment(fromSeq, toSeq, over), clock: fixedClock(),
  });
}

const indexPath = () => join(home, 'sessions', 'task-1', 'index.json');

describe('ledger: appendSegment + index', () => {
  test('append ×2 后 segments.jsonl 两行、index 结构与 coveredSeqs 正确', async () => {
    await append(1, 3);
    await append(3, 5, { mode: 'llm', quarantined: true, taint: ['suspicious'] });

    const file = segmentsFile(home, 'task-1');
    const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '');
    assert.equal(lines.length, 2, 'append-only：每次追加恰好一行');

    const { segments, badLines } = readSegments({ memoHome: home, taskId: 'task-1' });
    assert.equal(badLines, 0);
    assert.equal(segments.length, 2);
    assert.deepEqual(segments.map((s) => [s.fromSeq, s.toSeq]), [[1, 3], [3, 5]]);

    const index = readIndex({ memoHome: home, taskId: 'task-1' });
    assert.ok(index, 'append 后 index.json 必须存在');
    assert.equal(index.version, 1);
    assert.equal(index.builtAt, FIXED_ISO, 'builtAt 来自注入的 clock，不是 Date.now');
    assert.equal(index.segments.length, 2);
    assert.deepEqual(Object.keys(index.segments[0]).sort(),
      ['createdAt', 'fromSeq', 'id', 'mode', 'quarantined', 'toSeq']);
    assert.equal(index.segments[1].mode, 'llm');
    assert.equal(index.segments[1].quarantined, true);
    // 相邻区间合并：[[1,3),[3,5)] → [[1,5)]
    assert.deepEqual(index.coveredSeqs, [[1, 5]]);
    assert.deepEqual(coveredSeqs({ memoHome: home, taskId: 'task-1' }), [[1, 5]]);
  });

  test('重叠区间抛 E_ALREADY_CAPTURED，message 带两个区间，且零写入', async () => {
    await append(1, 3);
    const before = readFileSync(segmentsFile(home, 'task-1'), 'utf8');

    await assert.rejects(
      () => append(2, 5),
      (err) => {
        assert.equal(err.code, 'E_ALREADY_CAPTURED');
        assert.match(err.message, /\[1, 3\)/);
        assert.match(err.message, /\[2, 5\)/);
        return true;
      },
    );

    assert.equal(readFileSync(segmentsFile(home, 'task-1'), 'utf8'), before, '拒绝时不得写盘');
    const index = readIndex({ memoHome: home, taskId: 'task-1' });
    assert.equal(index.segments.length, 1);
  });

  test('adjacent 区间允许（半开 [1,3) 与 [3,5) 不相交）', async () => {
    await append(1, 3);
    await append(3, 5);
    assert.deepEqual(coveredSeqs({ memoHome: home, taskId: 'task-1' }), [[1, 5]]);
  });

  test('coveredSeqs 多段乱序追加也合并排序', async () => {
    await append(10, 12);
    await append(1, 3);
    await append(5, 6);
    assert.deepEqual(coveredSeqs({ memoHome: home, taskId: 'task-1' }), [[1, 3], [5, 6], [10, 12]]);
    assert.deepEqual(readIndex({ memoHome: home, taskId: 'task-1' }).coveredSeqs,
      [[1, 3], [5, 6], [10, 12]]);
  });

  test('readSegments 缺文件 / readIndex 缺文件 → 空账本 / null', () => {
    assert.deepEqual(readSegments({ memoHome: home, taskId: 'nope' }), { segments: [], badLines: 0 });
    assert.equal(readIndex({ memoHome: home, taskId: 'nope' }), null);
  });

  test('appendSegment 结构性校验：区间倒置 / anchor 缺失 → E_INVALID_ARG', async () => {
    await assert.rejects(
      () => appendSegment({
        memoHome: home, taskId: 'task-1', segment: makeSegment(5, 5), clock: fixedClock(),
      }),
      { code: 'E_INVALID_ARG' },
    );
    const noAnchor = makeSegment(1, 2);
    delete noAnchor.anchor;
    await assert.rejects(
      () => appendSegment({ memoHome: home, taskId: 'task-1', segment: noAnchor, clock: fixedClock() }),
      { code: 'E_INVALID_ARG' },
    );
  });
});

describe('ledger: 坏行容错', () => {
  test('坏行计入 badLines 并跳过，好段照常返回；index 只含好段', async () => {
    await append(1, 3);
    await append(3, 5);

    // 手工注入：非 JSON 行 + JSON 但形状不合法（fromSeq>=toSeq）行
    const file = segmentsFile(home, 'task-1');
    appendFileSync(file, '这不是 JSON\n');
    appendFileSync(file, '{"fromSeq":9,"toSeq":9}\n');

    const { segments, badLines } = readSegments({ memoHome: home, taskId: 'task-1' });
    assert.equal(badLines, 2, '两类坏行各计一行');
    assert.equal(segments.length, 2, '好段不受坏行影响');

    const index = rebuildIndex({ memoHome: home, taskId: 'task-1', clock: fixedClock() });
    assert.equal(index.segments.length, 2);
    assert.deepEqual(index.coveredSeqs, [[1, 5]]);
  });

  test('index.json 损坏 → readIndex 返回 null，rebuildIndex 可恢复', async () => {
    await append(1, 3);
    writeFileSync(indexPath(), '{ 这不是合法 json');
    assert.equal(readIndex({ memoHome: home, taskId: 'task-1' }), null);
    const index = rebuildIndex({ memoHome: home, taskId: 'task-1', clock: fixedClock() });
    assert.equal(index.segments.length, 1);
    assert.deepEqual(readIndex({ memoHome: home, taskId: 'task-1' }), index);
  });
});

describe('ledger: rebuildIndex 确定性', () => {
  test('两次 rebuild 逐字节相同（同段集合 + 同 clock）', async () => {
    await append(1, 3);
    await append(3, 4);
    await append(7, 9);

    rebuildIndex({ memoHome: home, taskId: 'task-1', clock: fixedClock() });
    const first = readFileSync(indexPath());

    rebuildIndex({ memoHome: home, taskId: 'task-1', clock: fixedClock() });
    const second = readFileSync(indexPath());

    assert.equal(Buffer.compare(first, second), 0, 'index.json 必须逐字节可重建');
    // 删掉再从段文件重建，仍逐字节相同
    rmSync(indexPath());
    rebuildIndex({ memoHome: home, taskId: 'task-1', clock: fixedClock() });
    assert.equal(Buffer.compare(first, readFileSync(indexPath())), 0);
    assert.equal(existsSync(indexPath()), true);
  });

  test('不同 clock → 仅 builtAt 变化', async () => {
    await append(1, 2);
    rebuildIndex({ memoHome: home, taskId: 'task-1', clock: fixedClock() });
    const a = JSON.parse(readFileSync(indexPath(), 'utf8'));
    rebuildIndex({ memoHome: home, taskId: 'task-1', clock: at(FIXED_MS + 86_400_000) });
    const b = JSON.parse(readFileSync(indexPath(), 'utf8'));
    assert.equal(a.builtAt, FIXED_ISO);
    assert.notEqual(a.builtAt, b.builtAt);
    assert.deepEqual(a.segments, b.segments);
    assert.deepEqual(a.coveredSeqs, b.coveredSeqs);
  });
});

describe('ledger: archiveTask', () => {
  test('整目录移到 archive/<taskId>-<yyyymmdd-HHMMSS>/，原目录消失，归档内有 meta+segments', async () => {
    await append(1, 3);
    await append(3, 6);
    const metaFile = join(home, 'sessions', 'task-1.json');
    writeFileSync(metaFile, JSON.stringify({ taskId: 'task-1', createdAt: FIXED_ISO }) + '\n');
    const taskDir = join(home, 'sessions', 'task-1');

    const res = await archiveTask({ memoHome: home, taskId: 'task-1', clock: fixedClock() });

    assert.equal(existsSync(taskDir), false, '归档后原任务目录必须消失');
    assert.equal(existsSync(metaFile), false, 'meta 也要移走（不留悬空记录）');
    assert.match(res.name, /^task-1-\d{8}-\d{6}$/, '归档目录名 = <taskId>-<yyyymmdd-HHMMSS>');
    assert.equal(res.movedTo, join(home, 'archive', res.name));

    for (const f of ['meta.json', 'segments.jsonl', 'index.json']) {
      assert.equal(existsSync(join(res.movedTo, f)), true, `归档内应有 ${f}`);
    }
    const { segments } = readSegments({ memoHome: home, taskId: 'task-1' });
    // 原 taskId 路径已无段文件；归档目录里的段内容原样保留
    assert.equal(segments.length, 0);
    const archived = readFileSync(join(res.movedTo, 'segments.jsonl'), 'utf8')
      .split('\n').filter((l) => l.trim() !== '');
    assert.equal(archived.length, 2, '归档保留全部段（不删除历史）');
    assert.deepEqual(JSON.parse(readFileSync(join(res.movedTo, 'meta.json'), 'utf8')).taskId, 'task-1');
  });

  test('任务不存在 → E_NOT_FOUND；二次归档 → E_NOT_FOUND', async () => {
    await assert.rejects(
      () => archiveTask({ memoHome: home, taskId: 'ghost', clock: fixedClock() }),
      { code: 'E_NOT_FOUND' },
    );
    await append(1, 2);
    await archiveTask({ memoHome: home, taskId: 'task-1', clock: fixedClock() });
    await assert.rejects(
      () => archiveTask({ memoHome: home, taskId: 'task-1', clock: fixedClock() }),
      { code: 'E_NOT_FOUND' },
    );
  });

  test('只有 meta 没有目录也能归档', async () => {
    mkdirSync(join(home, 'sessions'), { recursive: true });
    writeFileSync(join(home, 'sessions', 'meta-only.json'), '{"taskId":"meta-only"}\n');
    const res = await archiveTask({ memoHome: home, taskId: 'meta-only', clock: fixedClock() });
    assert.equal(existsSync(join(res.movedTo, 'meta.json')), true);
  });
});

describe('ledger: 段文件是覆盖区间的唯一真相', () => {
  test('段文件被删但 index 还在 → coveredSeqs 归零（不得静默跳过重新捕获）', async () => {
    await append(1, 10);
    assert.deepEqual(coveredSeqs({ memoHome: home, taskId: 'task-1' }), [[1, 10]]);
    // 手动删掉段文件（保留 index.json）
    rmSync(segmentsFile(home, 'task-1'));
    assert.deepEqual(coveredSeqs({ memoHome: home, taskId: 'task-1' }), [], '段文件没了就必须回到「未覆盖」');
  });

  test('coveredSeqs(anchorPath)：只合并锚在该转录上的段（换转录不继承旧覆盖）', async () => {
    await append(1, 3); // anchor.path = anchorPath（A 转录）
    const otherPath = join(home, 'other.jsonl');
    writeFileSync(otherPath, '{"seq":1}\n');
    await append(1, 4, {
      anchor: { path: otherPath, fromSeq: 1, toSeq: 4 },
      source: { kind: 'dsh', path: otherPath, sessionId: 'sess-2', frames: 1 },
    });

    // 不带 anchorPath → 任务级合并（旧行为不变）
    assert.deepEqual(coveredSeqs({ memoHome: home, taskId: 'task-1' }), [[1, 4]]);
    // 带 anchorPath → 只看锚在该转录上的段
    assert.deepEqual(coveredSeqs({ memoHome: home, taskId: 'task-1', anchorPath }),
      [[1, 3]], 'A 转录只被 [1,3) 覆盖');
    assert.deepEqual(coveredSeqs({ memoHome: home, taskId: 'task-1', anchorPath: otherPath }),
      [[1, 4]], 'B 转录只被自己的段覆盖');
    assert.deepEqual(coveredSeqs({ memoHome: home, taskId: 'task-1', anchorPath: join(home, 'never.jsonl') }),
      [], '没锚过的转录 = 未覆盖');
  });
});
