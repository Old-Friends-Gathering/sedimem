import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { createEmbedder } from '../../src/index/embedder.js';

/** 起一个本地 embedding 假服务（端口 0，由内核分配）。 */
function startStub(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/embed` }));
  });
}

const httpPolicy = (url, over = {}) => ({
  search: { embedder: { kind: 'http', url, model: 'stub-model', timeoutMs: 1000, minScore: 0.2, ...over } },
});

describe('createEmbedder — kind:none', () => {
  test('ready=false / dim=0 / embed 抛 E_EMBED_UNAVAILABLE', async () => {
    const emb = createEmbedder({ policy: { search: { embedder: { kind: 'none' } } } });
    assert.equal(emb.ready, false);
    assert.equal(emb.name, 'none');
    await assert.rejects(() => emb.embed(['x']), (e) => e.code === 'E_EMBED_UNAVAILABLE');
    await emb.close();
  });

  test('policy 缺省（无 search.embedder）等价 none', () => {
    const emb = createEmbedder({ policy: {} });
    assert.equal(emb.ready, false);
  });

  test('未知 kind 抛 E_INVALID_ARG', () => {
    assert.throws(
      () => createEmbedder({ policy: { search: { embedder: { kind: 'magic' } } } }),
      (e) => e.code === 'E_INVALID_ARG',
    );
  });

  test('http 缺 url/model 抛 E_INVALID_ARG', () => {
    assert.throws(
      () => createEmbedder({ policy: { search: { embedder: { kind: 'http' } } } }),
      (e) => e.code === 'E_INVALID_ARG',
    );
  });
});

describe('createEmbedder — kind:http', () => {
  test('解析 OpenAI 兼容响应，返回顺序与输入一致（含 index 乱序）', async () => {
    const { server, url } = await startStub((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const { input } = JSON.parse(body);
        // 故意按 index=1,0 乱序返回
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          data: [
            { index: 1, embedding: [0.2, 0.2] },
            { index: 0, embedding: [0.1, 0.1] },
          ],
          model: 'stub-model', usage: {},
          _saw: input.length,
        }));
      });
    });
    const emb = createEmbedder({ policy: httpPolicy(url) });
    try {
      assert.equal(emb.ready, true);
      const vecs = await emb.embed(['a', 'b']);
      assert.deepEqual(vecs, [[0.1, 0.1], [0.2, 0.2]]);
      assert.equal(emb.dim, 2);
    } finally {
      await emb.close();
      server.close();
    }
  });

  test('非 2xx → E_EMBED_UNAVAILABLE 且不重试', async () => {
    let calls = 0;
    const { server, url } = await startStub((req, res) => {
      calls++;
      res.statusCode = 503;
      res.end('overloaded');
    });
    const emb = createEmbedder({ policy: httpPolicy(url) });
    try {
      await assert.rejects(() => emb.embed(['a']), (e) => e.code === 'E_EMBED_UNAVAILABLE');
      assert.equal(calls, 1, '失败不得重试（D1）');
    } finally {
      await emb.close();
      server.close();
    }
  });

  test('超时（timeoutMs）→ E_EMBED_UNAVAILABLE', async () => {
    const { server, url } = await startStub((req, res) => {
      setTimeout(() => res.end(JSON.stringify({ data: [{ embedding: [1] }] })), 5000);
    });
    const emb = createEmbedder({ policy: httpPolicy(url, { timeoutMs: 100 }) });
    try {
      await assert.rejects(
        () => emb.embed(['a']),
        (e) => e.code === 'E_EMBED_UNAVAILABLE' && /aborted|fetch failed/i.test(e.message),
      );
    } finally {
      await emb.close();
      server.close();
    }
  });

  test('连接不可达（服务器已关）→ E_EMBED_UNAVAILABLE', async () => {
    const { server, url } = await startStub(() => {});
    const bound = url;
    await new Promise((r) => server.close(r));
    const emb = createEmbedder({ policy: httpPolicy(bound) });
    try {
      await assert.rejects(() => emb.embed(['a']), (e) => e.code === 'E_EMBED_UNAVAILABLE');
    } finally {
      await emb.close();
    }
  });

  test('维度漂移 → E_EMBED_DIM_MISMATCH（拒绝混维度）', async () => {
    const dims = [3, 2];
    let call = 0;
    const { server, url } = await startStub((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const { input } = JSON.parse(body);
        const d = dims[Math.min(call++, dims.length - 1)];
        res.end(JSON.stringify({ data: input.map(() => ({ embedding: new Array(d).fill(1) })) }));
      });
    });
    const emb = createEmbedder({ policy: httpPolicy(url) });
    try {
      const first = await emb.embed(['a']);
      assert.equal(first[0].length, 3);
      await assert.rejects(() => emb.embed(['b']), (e) => e.code === 'E_EMBED_DIM_MISMATCH');
    } finally {
      await emb.close();
      server.close();
    }
  });
});
