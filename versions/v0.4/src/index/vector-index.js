// index/vector-index.js — VectorIndex（契约：docs/plans/v0.4-competitive-gaps.md D1）
// 持久化 $MEMO_HOME/index/<scopeKey>.vectors.jsonl，每行 {id, v, model, dim}：
//   v = float32 小端序列化后的 base64（比 JSON 数组省 ~75% 磁盘与解析时间）；
//   scopeKey 用 paths.scopeKeyOf（路径命名单一来源，scope 直接拼会带 ':'）。
// 写策略：add 追加写（O(1)，不重写全文件）；remove/build 全量 rewrite，
//   rewrite 前先把旧文件备份成 .bak（真相层可回滚，坏写不丢数据）。
// 启动热加载：构造时读 jsonl 进内存 Float32Array，避免每次 search 重新 parse。

import {
  mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync, renameSync, unlinkSync,
  copyFileSync, openSync, closeSync, fsyncSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { scopeKeyOf } from '../config/paths.js';

function dimMismatch(expected, got, where) {
  const err = new Error(`vectorIndex: dim mismatch at ${where}: expected ${expected}, got ${got}`);
  err.code = 'E_EMBED_DIM_MISMATCH';
  return err;
}

function invalidArg(msg) {
  const err = new Error(msg);
  err.code = 'E_INVALID_ARG';
  return err;
}

/** Float32Array → base64（小端，Buffer 默认平台无关按字节复制） */
export function encodeVector(vec) {
  return Buffer.from(Float32Array.from(vec).buffer).toString('base64');
}

/** base64 → Float32Array（拷贝出独立 buffer，避免视图共享） */
export function decodeVector(b64) {
  const buf = Buffer.from(String(b64), 'base64');
  if (buf.length % 4 !== 0) throw invalidArg(`vectorIndex: bad base64 length ${buf.length}`);
  const out = new Float32Array(buf.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = buf.readFloatLE(i * 4);
  return out;
}

/**
 * 创建向量索引（同步热加载；文件不存在则空索引）。
 * @param {{memoHome: string, scope?: string, dim?: number, model?: string}} args
 * @returns {{size: number, build(records: {id: string, vec: number[]|Float32Array}[]): void,
 *   add(id: string, vec: number[]|Float32Array): void, remove(id: string): boolean,
 *   search(vec: number[]|Float32Array, opts?: {topK?: number, minScore?: number}):
 *     {id: string, score: number}[], close(): void}}
 */
export function createVectorIndex({ memoHome, scope = 'default', dim, model } = {}) {
  if (!memoHome) throw invalidArg('createVectorIndex: memoHome is required');
  const idxDir = join(memoHome, 'index');
  const file = join(idxDir, `${scopeKeyOf(scope)}.vectors.jsonl`);
  const bak = `${file}.bak`;

  /** @type {Map<string, Float32Array>} id → 向量 */
  const vectors = new Map();
  /** 锁定维度：构造参数 > 首条向量；之后一切写入必须一致 */
  let fixedDim = typeof dim === 'number' && dim > 0 ? dim : null;

  // —— 启动热加载：读 jsonl，同 id 最后一行胜出；维度/模型不符的行跳过（脏数据不炸启动）——
  // 对抗审核 B5：曾忽略 row.model → model-a 与 model-b 的向量同 id 并存，换模型后
  // 用 b 的查询向量命中了 a 的窗口（basis:'vector' 却完全无关）。
  // 现在：给了 model 就只接受同 model 的行；跳过/重复/坏行都会把文件**清理重写**（顺带修 S-1 的无界增长）。
  let loadDirty = false;
  if (existsSync(file)) {
    const lines = readFileSync(file, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        loadDirty = true;
        continue; // 热加载容错：坏行跳过（随后重写清除）
      }
      if (!row || typeof row.id !== 'string' || typeof row.v !== 'string') { loadDirty = true; continue; }
      let vec;
      try {
        vec = decodeVector(row.v);
      } catch {
        loadDirty = true;
        continue;
      }
      // 模型锁：模型变了就是另一套向量空间，混算等于乱答（只跳过，不抛——启动必须能起来）
      if (typeof model === 'string' && model !== '' && row.model !== model) { loadDirty = true; continue; }
      if (fixedDim === null) fixedDim = vec.length;
      if (vec.length !== fixedDim) { loadDirty = true; continue; }
      if (vectors.has(row.id)) { loadDirty = true; vectors.delete(row.id); }
      vectors.set(row.id, vec);
    }
  }

  function assertDim(vec, where) {
    if (vec.length === 0) throw invalidArg(`vectorIndex: empty vector at ${where}`);
    if (fixedDim === null) fixedDim = vec.length;
    if (vec.length !== fixedDim) throw dimMismatch(fixedDim, vec.length, where);
  }

  function rowOf(id, vec) {
    return JSON.stringify({ id, v: encodeVector(vec), model: model ?? null, dim: vec.length }) + '\n';
  }

  /** 全量重写：先备份旧文件成 .bak，再原子写新文件 */
  function rewrite() {
    mkdirSync(idxDir, { recursive: true });
    // 备份旧文件（不存在就跳过；不用 existsSync 预判——路径存在性判断本身是竞态源）
    try {
      copyFileSync(file, bak);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    const parts = [];
    for (const [id, vec] of vectors) parts.push(rowOf(id, vec));
    // 先写**本次进程独占的临时文件**（wx = 必须新建，0600 权限），再 rename 覆盖：
    // 这样要么看到旧文件、要么看到完整新文件，不会读到半截 JSONL。
    const tmp = `${file}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
    const fd = openSync(tmp, 'wx', 0o600);
    try {
      writeFileSync(fd, parts.join(''));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, file);
  }

  if (loadDirty) rewrite(); // 清理脏行/重复行/换模型残留（不这样做文件会无界增长，S-1）

  return {
    get size() { return vectors.size; },

    /** 全量重建（先清空内存再写入；空 records = 清库），rewrite 前备份 */
    build(records) {
      vectors.clear();
      for (const r of records ?? []) {
        const vec = Float32Array.from(r.vec);
        assertDim(vec, `build id=${r.id}`);
        vectors.set(r.id, vec);
      }
      rewrite();
    },

    /** 追加写：内存 Map + 文件 append（O(1)） */
    add(id, vec) {
      if (!id || typeof id !== 'string') throw invalidArg('vectorIndex.add: id is required');
      const v = Float32Array.from(vec);
      assertDim(v, `add id=${id}`);
      vectors.set(id, v);
      mkdirSync(idxDir, { recursive: true });
      appendFileSync(file, rowOf(id, v));
    },

    /** 删除：内存移除 + rewrite（含 .bak 备份）；不存在返回 false */
    remove(id) {
      if (!vectors.has(id)) return false;
      vectors.delete(id);
      rewrite();
      return true;
    },

    /** 余弦相似度 topK 检索（dim 不符抛 E_EMBED_DIM_MISMATCH，查询向量必须与库同维） */
    search(vec, { topK = 50, minScore = 0.2 } = {}) {
      const q = Float32Array.from(vec);
      assertDim(q, 'search query');
      let qn = 0;
      for (let i = 0; i < q.length; i++) qn += q[i] * q[i];
      qn = Math.sqrt(qn);
      const hits = [];
      for (const [id, v] of vectors) {
        let dot = 0;
        let vn = 0;
        for (let i = 0; i < v.length; i++) {
          dot += q[i] * v[i];
          vn += v[i] * v[i];
        }
        vn = Math.sqrt(vn);
        const score = qn === 0 || vn === 0 ? 0 : dot / (qn * vn);
        if (score >= minScore) hits.push({ id, score });
      }
      hits.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
      return hits.slice(0, Math.max(1, topK));
    },

    close() {
      // 纯内存句柄，无待清理资源；保留方法以满足 Port 契约
      vectors.clear();
      void bak;
      void unlinkSync;
    },
  };
}
