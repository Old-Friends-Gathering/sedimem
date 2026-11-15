// v0.4 对抗审核探针：语义道的「表面绿、实际错」
//   1) 写入新记录后，向量道从未补写（incremental add 签名错位），检索 degraded=false
//   2) 模型更换不拒绝混用：文件里同时存在 model-a / model-b 的向量；启动 build 尚未完成时
//      用新模型 query 检索旧模型向量 → 命中不相关记录，degraded 仍为 false
//   3) 维度漂移：换模型后 dim 不同 → 显式 degraded（这一条是对的，作为对照）
//   4) 向量文件首行空 base64 → fixedDim 锁成 0，启动后永久 degraded 且无法自愈
// 运行：node reviews/probes/v04-adv-semantic.mjs
import http from 'node:http';
import { mkdtemp, readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createMemoryService } from '../../src/api/service.js';

const results = {};
const tmp = () => mkdtemp(path.join(tmpdir(), 'sedimem-adv-sem-'));

// —— 假 OpenAI 兼容 embedding 服务 ——
// model-a: alpha→[0,1,0]  beta→[1,0,0]
// model-b: alpha→[0,0,1]  beta→[0,1,0]  gamma(query)→[1,0,0]
// model-c: 4 维（模拟维度漂移）
// 启动窗口实验：对 alpha/beta 的 build 调用延迟 300ms，query(gamma) 立即返回。
const state = { delayRecords: false };
function vecFor(model, text) {
  const t = String(text);
  if (model === 'model-c') return [1, 0, 0, 0];
  if (model === 'model-b') {
    if (t.includes('alpha')) return [0, 0, 1];
    if (t.includes('beta')) return [0, 1, 0];
    return [1, 0, 0]; // gamma
  }
  // model-a
  if (t.includes('beta')) return [1, 0, 0];
  return [0, 1, 0]; // alpha / 其它
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let payload;
    try { payload = JSON.parse(body); } catch { res.writeHead(400).end('bad json'); return; }
    const model = payload.model;
    const rows = (payload.input ?? []).map((t, i) => ({ index: i, embedding: vecFor(model, t) }));
    const wait = state.delayRecords && (payload.input ?? []).some((t) => /alpha|beta/.test(String(t)));
    const send = () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: rows }));
    };
    if (wait) setTimeout(send, 300); else send();
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const url = `http://127.0.0.1:${port}/v1/embeddings`;

function policyFor(model) {
  return { search: { embedder: { kind: 'http', url, model, timeoutMs: 2000 } } };
}
const lines = async (file) => {
  try {
    return (await readFile(file, 'utf8')).split('\n').filter((l) => l.trim() !== '');
  } catch { return []; }
};

// —— 1) 增量写入不补向量 ——
{
  const memoHome = await tmp();
  const svc = await createMemoryService({ memoHome, scope: 'repo:add', policy: policyFor('model-a') });
  const written = await svc.write({ text: 'quantum entanglement note', source: { agent: 'probe' } });
  await svc.index.flush();
  const id = written.record.id;
  const vf = path.join(memoHome, 'index', 'repo-add.vectors.jsonl');
  const afterWrite = {
    recordId: id,
    hybrid: typeof svc.index.semantic === 'object',
    semanticSize: svc.index.semantic?.size,
    vectorFileLines: (await lines(vf)).length,
    idInVectorFile: (await lines(vf)).some((l) => l.includes(id)),
  };
  const s1 = await svc.search('quantum entanglement');
  afterWrite.search = {
    hits: s1.items.map((i) => ({ id: i.record.id, basis: i.basis })),
    degraded: s1.degraded ?? false,
    degradedReason: s1.degradedReason ?? null,
  };
  await svc.close();

  // 重启一次（build 会把所有记录重新嵌入）→ 同一条记录才有向量
  const svc2 = await createMemoryService({ memoHome, scope: 'repo:add', policy: policyFor('model-a') });
  await svc2.index.flush();
  const afterRestart = {
    semanticSize: svc2.index.semantic?.size,
    vectorFileLines: (await lines(vf)).length,
    idInVectorFile: (await lines(vf)).some((l) => l.includes(id)),
  };
  await svc2.close();
  results.incrementalAdd = { afterWrite, afterRestart };
}

// —— 2) 模型更换：文件混模型 + 启动窗口跨模型命中 ——
{
  const memoHome = await tmp();
  const scope = 'repo:swap';
  const svcA = await createMemoryService({ memoHome, scope, policy: policyFor('model-a') });
  const a = await svcA.write({ text: 'alpha', subject: 'vec-a', predicate: 'note', source: { agent: 'probe' } });
  const b = await svcA.write({ text: 'beta', subject: 'vec-b', predicate: 'note', source: { agent: 'probe' } });
  await svcA.index.flush();
  await svcA.close();
  // 关键：写入路径从不补向量（见 1），必须重启一次让 build 把 model-a 向量落盘，
  // 才谈得上「换模型后混用」。这一步也顺带证明向量只能是启动时批量补。
  const svcA2 = await createMemoryService({ memoHome, scope, policy: policyFor('model-a') });
  await svcA2.index.flush();
  await svcA2.close();
  const vf = path.join(memoHome, 'index', 'repo-swap.vectors.jsonl');
  const beforeSwap = (await lines(vf)).map((l) => JSON.parse(l)).map((r) => ({ id: r.id, model: r.model, dim: r.dim }));
  const ids = { a: a.record.id, b: b.record.id };

  // 以 model-b 重启；build 的重新嵌入被服务端延迟 300ms，先检索
  state.delayRecords = true;
  const svcB = await createMemoryService({ memoHome, scope, policy: policyFor('model-b') });
  const s = await svcB.search('gamma');
  const duringBuild = {
    hits: s.items.map((i) => ({ id: i.record.id, text: i.record.text, basis: i.basis, score: Number(i.score.toFixed(4)) })),
    degraded: s.degraded ?? false,
    degradedReason: s.degradedReason ?? null,
    // 期望空结果（gamma 与 alpha/beta 无关）；实际命中 beta（旧模型向量 [1,0,0] 恰好与新 query 同向）
    betaId: ids.b,
    alphaId: ids.a,
  };
  await svcB.index.flush();
  state.delayRecords = false;
  const s2 = await svcB.search('gamma');
  const afterBuild = {
    hits: s2.items.map((i) => ({ id: i.record.id, text: i.record.text, basis: i.basis })),
    degraded: s2.degraded ?? false,
  };
  await svcB.close();
  const afterSwap = (await lines(vf)).map((l) => JSON.parse(l)).map((r) => ({ id: r.id, model: r.model }));
  results.modelSwap = {
    ids,
    beforeSwap,
    duringBuild,
    afterBuild,
    modelsInFileAfterSwap: [...new Set(afterSwap.map((r) => r.model))],
    sameIdHasBothModels: Object.values(ids).map((id) => ({
      id,
      models: [...new Set(afterSwap.filter((r) => r.id === id).map((r) => r.model))],
    })),
  };
}

// —— 3) 维度漂移：显式 degraded（对照组） ——
{
  const memoHome = await tmp();
  const scope = 'repo:dim';
  const svc3 = await createMemoryService({ memoHome, scope, policy: policyFor('model-a') });
  await svc3.write({ text: 'alpha', source: { agent: 'probe' } });
  await svc3.index.flush();
  await svc3.close();
  const svc3b = await createMemoryService({ memoHome, scope, policy: policyFor('model-a') });
  await svc3b.index.flush();
  await svc3b.close();
  const svc4 = await createMemoryService({ memoHome, scope, policy: policyFor('model-c') });
  await svc4.index.flush();
  const s = await svc4.search('alpha');
  results.dimDrift = {
    degraded: s.degraded ?? false,
    degradedReason: s.degradedReason ?? null,
    hits: s.items.length,
  };
  await svc4.close();
}

// —— 4) 向量文件首行空 base64：fixedDim 锁 0，永久 degraded ——
{
  const memoHome = await tmp();
  const scope = 'repo:poison';
  const svc5 = await createMemoryService({ memoHome, scope, policy: policyFor('model-a') });
  await svc5.write({ text: 'alpha record', source: { agent: 'probe' } });
  await svc5.index.flush();
  await svc5.close();
  const vf = path.join(memoHome, 'index', 'repo-poison.vectors.jsonl');
  const healthy = await lines(vf);
  await mkdir(path.join(memoHome, 'index'), { recursive: true });
  await writeFile(vf, `${JSON.stringify({ id: 'poison', v: '', model: null, dim: 0 })}\n${healthy.join('\n')}\n`);
  const svc6 = await createMemoryService({ memoHome, scope, policy: policyFor('model-a') });
  await svc6.index.flush();
  const s = await svc6.search('alpha');
  results.emptyVectorPoison = {
    semanticSize: svc6.index.semantic?.size,
    degraded: s.degraded ?? false,
    degradedReason: s.degradedReason ?? null,
    hits: s.items.length,
    vectorFileExists: (await readdir(path.join(memoHome, 'index'))).includes('repo-poison.vectors.jsonl'),
  };
  await svc6.close();
}

// —— 5) 外部篡改向量文件（同维度）→ 静默错排序，degraded=false ——
{
  const memoHome = await tmp();
  const scope = 'repo:tamper';
  const svc7 = await createMemoryService({ memoHome, scope, policy: policyFor('model-a') });
  const a = await svc7.write({ text: 'alpha', subject: 't-a', predicate: 'note', source: { agent: 'probe' } });
  const b = await svc7.write({ text: 'beta', subject: 't-b', predicate: 'note', source: { agent: 'probe' } });
  await svc7.index.flush();
  await svc7.close();
  const svc7b = await createMemoryService({ memoHome, scope, policy: policyFor('model-a') });
  await svc7b.index.flush();
  await svc7b.close();
  const vf = path.join(memoHome, 'index', 'repo-tamper.vectors.jsonl');
  const rows = (await lines(vf)).map((l) => JSON.parse(l));
  // 把 beta 的向量改成 alpha 的（维度不变、model 不变）：文件没有任何 id/contentHash 绑定校验。
  // query 'zzz' 的 model-a 向量是 [0,1,0]，本应只命中 alpha；篡改后 beta 也以 vector 命中。
  const byId = new Map(rows.map((r) => [r.id, r]));
  byId.get(b.record.id).v = byId.get(a.record.id).v;
  await writeFile(vf, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const svc7c = await createMemoryService({ memoHome, scope, policy: policyFor('model-a') });
  await svc7c.index.flush();
  const s = await svc7c.search('zzz');
  results.tamperedVectors = {
    query: 'zzz',
    expectedOnly: a.record.id,
    hits: s.items.map((i) => ({ id: i.record.id, text: i.record.text, basis: i.basis })),
    degraded: s.degraded ?? false,
    leakedPhantomHit: s.items.some((i) => i.record.id === b.record.id),
  };
  await svc7c.close();
}

// —— 6) 每次启动 build 都是 append，向量文件无界增长 ——
{
  const memoHome = await tmp();
  const scope = 'repo:grow';
  const policy = policyFor('model-a');
  const svc0 = await createMemoryService({ memoHome, scope, policy });
  await svc0.write({ text: 'alpha', subject: 'g-a', predicate: 'note', source: { agent: 'probe' } });
  await svc0.write({ text: 'beta', subject: 'g-b', predicate: 'note', source: { agent: 'probe' } });
  await svc0.close();
  const vf = path.join(memoHome, 'index', 'repo-grow.vectors.jsonl');
  const counts = [];
  for (let i = 0; i < 4; i += 1) {
    const svc = await createMemoryService({ memoHome, scope, policy });
    await svc.index.flush();
    await svc.close();
    const rows = (await lines(vf)).map((l) => JSON.parse(l));
    counts.push({ start: i + 1, lines: rows.length, perId: [...new Set(rows.map((r) => r.id))].map((id) => rows.filter((r) => r.id === id).length) });
  }
  results.vectorFileGrowth = counts;
}

server.close();
console.log(JSON.stringify(results, null, 2));
