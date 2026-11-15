// v0.4 架构审核探针：语义道的三个生命周期问题（只写临时 MEMO_HOME；本地假 embedder）。
// 1) 增量 write 经 lifecycle.commit -> index.add(record) 单参，hybrid.add(id, record) 双参错位
//    -> embedRecord({id:<record>}) 直接 return，在线新增记录永远没有向量。
// 2) service.close() 只 flushHits，不 await index.flush() -> 初始化 build 的在途向量被丢。
// 3) 每次 createMemoryService 都 build(records) 全量重嵌，且不清旧向量 -> 向量文件线性膨胀。
import http from 'node:http';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMemoryService } from '../../src/api/service.js';

const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sedimem-v04-flush-'));
let calls = 0;
const server = http.createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  const { input } = JSON.parse(body);
  calls += 1;
  await new Promise((r) => setTimeout(r, 120));
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ data: input.map((_, index) => ({ index, embedding: Array.from({ length: 8 }, (_, i) => (index + i + 1) / 10) })) }));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/v1/embeddings`;
const policy = { search: { embedder: { kind: 'http', url, model: 'fake-8', timeoutMs: 2000 } } };
const vf = path.join(home, 'index', 'repo-flush.vectors.jsonl');
const lines = async () => (await fsp.readFile(vf, 'utf8').catch(() => '')).split('\n').filter(Boolean).length;

const s1 = await createMemoryService({ memoHome: home, scope: 'repo:flush', policy });
await s1.write({ text: '端口是 7788', subject: 'obs', predicate: 'port', value: 7788, source: { agent: 'probe' } });
await s1.write({ text: '端口是 7799', subject: 'obs', predicate: 'port2', value: 7799, source: { agent: 'probe' } });
await new Promise((r) => setTimeout(r, 500));
const afterWrites = { calls, lines: await lines() };
await s1.close();

const callsBeforeInit2 = calls;
const s2 = await createMemoryService({ memoHome: home, scope: 'repo:flush', policy });
const atClose2 = { calls: calls - callsBeforeInit2, lines: await lines() };
await s2.close();
await new Promise((r) => setTimeout(r, 500));
const afterInit2Delay = { calls: calls - callsBeforeInit2, lines: await lines() };

const callsBeforeInit3 = calls;
const s3 = await createMemoryService({ memoHome: home, scope: 'repo:flush', policy });
await new Promise((r) => setTimeout(r, 500));
const afterInit3 = { calls: calls - callsBeforeInit3, lines: await lines() };
await s3.close();

server.close();
console.log(JSON.stringify({
  after_two_writes_in_same_process: afterWrites,
  init2_at_close_immediately: atClose2,
  init2_after_500ms: afterInit2Delay,
  init3_after_500ms: afterInit3,
}, null, 2));
