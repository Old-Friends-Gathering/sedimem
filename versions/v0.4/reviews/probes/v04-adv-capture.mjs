// v0.4 对抗审核探针：半自动捕获（候选 → inbox → accept）
//   1) 候选只进 inbox，不进真相层；只有 accept 才经 service.write 落库（正向确认）
//   2) inbox 出现一行坏 JSON → add/list/accept/reject 全部永久 E_CORRUPT_JSONL，doctor 不覆盖 inbox
//   3) 重复 accept（顺序）不产生第二条记录，第二次返回 already accepted（正向确认）
//   4) 并发 accept（两个队列实例）不产生第二条记录（正向确认）
//   5) 跨线程并发 add：readFileSync→writeFileSync 无锁，丢更新（真实复现）
// 运行：node reviews/probes/v04-adv-capture.mjs
import { mkdtemp, readFile, appendFile, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Worker } from 'node:worker_threads';

import { createMemoryService } from '../../src/api/service.js';
import { createCaptureQueue } from '../../src/capture/queue.js';

const out = {};
const tmp = () => mkdtemp(path.join(tmpdir(), 'sedimem-adv-cap-'));
const queueMod = new URL('../../src/capture/queue.js', import.meta.url).href;

// —— 1) 候选不落真相层，accept 才落 ——
{
  const memoHome = await tmp();
  const scope = 'repo:cap';
  const svc = await createMemoryService({ memoHome, scope });
  const q = createCaptureQueue({ memoHome, scope });
  const added = q.add([{ text: '记住：发布前必须跑 eval', kind: 'fact', reason: 'probe' }], { by: 'probe' });
  const before = { added: added.length, inbox: q.list().length, records: svc._records.size, search: (await svc.search('发布前必须跑 eval')).items.length };
  // 直接写真相层当然可以（那是 memo write 的正当入口），但捕获路径本身没有旁路
  const accepted = await q.accept([q.list()[0].id], { service: svc, by: 'probe' });
  const after = { accepted, records: svc._records.size, search: (await svc.search('发布前必须跑 eval')).items.length };
  await svc.close();
  out.acceptGate = { before, after };
}

// —— 2) 坏行永久阻断 ——
{
  const memoHome = await tmp();
  const scope = 'repo:bad';
  const svc = await createMemoryService({ memoHome, scope });
  const q = createCaptureQueue({ memoHome, scope });
  q.add([{ text: '正常候选', kind: 'fact' }]);
  await appendFile(q._file, '{"id":"broken" this is not json\n');
  const err = (fn) => { try { fn(); return null; } catch (e) { return `${e.code}: ${e.message}`; } };
  const during = {
    list: err(() => q.list()),
    add: err(() => q.add([{ text: '新候选' }])),
    accept: err(() => { throw new Error('unreachable'); }),
  };
  try { await q.accept([q.list && 'x'], { service: svc }); } catch (e) { during.accept = `${e.code}: ${e.message}`; }
  const doctor = await svc.doctor();
  const doctorMentionsInbox = JSON.stringify(doctor).includes('inbox') || JSON.stringify(doctor).includes('capture');
  await svc.close();
  out.badLineBlocks = { inboxFile: q._file, during, doctorIssues: doctor.issues ?? doctor, doctorMentionsInbox };
}

// —— 3) 重复 accept（顺序） ——
{
  const memoHome = await tmp();
  const scope = 'repo:dup';
  const svc = await createMemoryService({ memoHome, scope });
  const q = createCaptureQueue({ memoHome, scope });
  q.add([{ text: '重复 accept 的候选', kind: 'fact' }]);
  const id = q.list()[0].id;
  const first = await q.accept([id], { service: svc, by: 'probe' });
  const second = await q.accept([id], { service: svc, by: 'probe' });
  out.duplicateAccept = {
    first, second,
    recordCount: svc._records.size,
    inbox: q.list().map((r) => ({ id: r.id, status: r.status })),
  };
  await svc.close();
}

// —— 4) 并发 accept（同一候选，两个队列实例） ——
{
  const memoHome = await tmp();
  const scope = 'repo:raceaccept';
  const svc = await createMemoryService({ memoHome, scope });
  const q1 = createCaptureQueue({ memoHome, scope });
  const q2 = createCaptureQueue({ memoHome, scope });
  q1.add([{ text: '并发 accept 的候选', kind: 'fact' }]);
  const id = q1.list()[0].id;
  const [r1, r2] = await Promise.all([
    q1.accept([id], { service: svc, by: 'probe-a' }),
    q2.accept([id], { service: svc, by: 'probe-b' }),
  ]);
  out.concurrentAccept = { r1, r2, recordCount: svc._records.size, inbox: q1.list().map((r) => ({ id: r.id, status: r.status })) };
  await svc.close();
}

// —— 5) 跨线程并发 add 丢更新 ——
{
  const memoHome = await tmp();
  const scope = 'repo:lost';
  const q = createCaptureQueue({ memoHome, scope });
  // 预填 30000 条，让 read() 的 JSON.parse 时间足够长，放大 read→write 窗口
  const seed = [];
  for (let i = 0; i < 30000; i += 1) seed.push(JSON.stringify({ id: `seed-${i}`, text: `种子 ${i}`, status: 'pending' }));
  await mkdir(path.dirname(q._file), { recursive: true });
  await appendFile(q._file, seed.join('\n') + '\n');
  const before = readFileSync(q._file, 'utf8').split('\n').filter(Boolean).length;

  const code = `
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const { createCaptureQueue } = await import(workerData.mod);
      const q = createCaptureQueue({ memoHome: workerData.home, scope: workerData.scope });
      Atomics.wait(new Int32Array(workerData.sab), 0, 0);
      q.add([{ text: 'worker-' + workerData.tag, kind: 'fact' }]);
      parentPort.postMessage('done');
    })().catch((e) => { parentPort.postMessage('error:' + e.message); });
  `;
  const rounds = [];
  let startLines = before;
  for (let round = 0; round < 5; round += 1) {
    const sab = new SharedArrayBuffer(4);
    const flag = new Int32Array(sab);
    const mk = (tag) => new Worker(code, { eval: true, workerData: { mod: queueMod, home: memoHome, scope, tag: `${round}-${tag}`, sab } });
    const w1 = mk('a');
    const w2 = mk('b');
    const done = Promise.all([
      new Promise((res) => w1.on('message', res)),
      new Promise((res) => w2.on('message', res)),
    ]);
    await new Promise((r) => setTimeout(r, 50));
    Atomics.store(flag, 0, 1);
    Atomics.notify(flag, 0, 2);
    const msgs = await done;
    await w1.terminate(); await w2.terminate();
    const lines = readFileSync(q._file, 'utf8').split('\n').filter(Boolean).length;
    rounds.push({ round, msgs, linesDelta: lines - startLines });
    startLines = lines;
  }
  // linesDelta 应为 2（两个 worker 各 1 条）；<2 即丢更新
  const lost = rounds.filter((r) => r.linesDelta < 2).length;
  out.concurrentAdd = {
    seededLines: before,
    rounds,
    lostRounds: lost,
    finalLines: readFileSync(q._file, 'utf8').split('\n').filter(Boolean).length,
  };
}

console.log(JSON.stringify(out, null, 2));
