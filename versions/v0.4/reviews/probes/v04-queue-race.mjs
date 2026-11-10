// v0.4 架构审核探针：capture queue 的 append 是「读全量 → 字符串拼接 → writeFileSync」，
// 没有 lock / rename，两个并发 scan 会互相覆盖，静默丢候选。
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const NODE = process.execPath;
const memoHome = await mkdtemp(path.join(tmpdir(), 'sedimem-v04-race-'));
const scope = 'repo:probe';
const inbox = path.join(memoHome, 'inbox');
const { mkdir } = await import('node:fs/promises');
await mkdir(inbox, { recursive: true });

// 预置 20000 行，放大 read → write 的窗口。
const base = 20000;
const lines = [];
for (let i = 0; i < base; i++) {
  lines.push(JSON.stringify({ id: `seed-${i}`, text: `seed candidate ${i}`, kind: 'fact', reason: 'seed', at: new Date(0).toISOString(), status: 'pending' }));
}
await writeFile(path.join(inbox, 'repo-probe.jsonl'), `${lines.join('\n')}\n`);

const child = `
import { createCaptureQueue } from '${path.resolve('src/capture/queue.js')}';
const q = createCaptureQueue({ memoHome: process.env.MEMO_HOME, scope: 'repo:probe' });
const tag = process.argv[1];
const cands = Array.from({ length: 100 }, (_, i) => ({ text: tag + ' unique candidate ' + i, kind: 'fact', reason: 'race' }));
q.add(cands);
`;
const run = (tag) => new Promise((resolve, reject) => {
  const p = spawn(NODE, ['--input-type=module', '-e', child, tag], {
    env: { ...process.env, MEMO_HOME: memoHome }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let err = '';
  p.stderr.on('data', (d) => { err += d; });
  p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(err || `exit ${code}`))));
});

await Promise.all([run('A'), run('B')]);
const raw = await readFile(path.join(inbox, 'repo-probe.jsonl'), 'utf8');
const count = raw.split('\n').filter(Boolean).length;

console.log(JSON.stringify({
  base,
  two_batches: 200,
  expected: base + 200,
  actual: count,
  lost: base + 200 - count,
  race_confirmed: count < base + 200,
}, null, 2));
