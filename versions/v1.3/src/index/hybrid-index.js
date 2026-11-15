// index/hybrid-index.js — 词法 + 语义双路索引（v0.4 D1）
//
// 设计约束（docs/plans/v0.4-competitive-gaps.md D1）：
//  1. **永不阻断检索**：语义路任一环节不可用（embedder 未配置 / 后端 500 / 超时 /
//     维度漂移）都只是把 `degraded` 置真、退回纯词法，绝不抛给调用方；
//  2. **降级必须显式**：`degraded` 与 `degradedReason` 由 search 结果透传到
//     `/api/search` 与 CLI，用户能看见「这次是词法给的」；
//  3. **索引仍是派生物**：向量文件只是 `$MEMO_HOME/index/<scopeKey>.vectors.jsonl`，
//     删掉重跑 `memo backfill-vectors` 就能重建，真相层不受影响；
//  4. **写入路径不变**：`add`/`remove` 与词法索引同步，向量补齐是后台异步（不阻塞写，
//     失败只记 degraded，不回滚真相层写入）。
//
// 接口与 IndexPort 一致（build/add/remove/search/size），额外暴露 `degraded` /
// `degradedReason` / `flush()`（等待在途向量任务，测试与 backfill 用）。

import { fuseSearch } from './hybrid.js';

/** 单条文本的语义侧候选数（词法侧由调用方 limit 决定）。 */
const DEFAULT_VECTOR_TOP_K = 30;
/** 单次 build 期间后台补齐向量的分片大小。 */
const DEFAULT_BATCH = 32;

/**
 * 构造双路索引。
 * @param {{base: object, embedder: object, vectorIndex: object,
 *          lexicalTopK?: number, vectorTopK?: number, batchSize?: number,
 *          rrfK?: number, minScore?: number, clock?: object, onDegrade?: Function}} args
 */
export function createHybridIndex({
  base,
  embedder,
  vectorIndex,
  lexicalTopK = 50,
  vectorTopK = DEFAULT_VECTOR_TOP_K,
  batchSize = DEFAULT_BATCH,
  rrfK = 60,
  minScore = 0.25,
  clock,
  onDegrade,
} = {}) {
  if (!base || typeof base.search !== 'function') throw new TypeError('createHybridIndex: base index required');
  if (!embedder || typeof embedder.embed !== 'function') throw new TypeError('createHybridIndex: embedder required');
  if (!vectorIndex || typeof vectorIndex.search !== 'function') throw new TypeError('createHybridIndex: vectorIndex required');

  let degraded = embedder.ready === false;
  let degradedReason = degraded ? 'embedder-not-ready' : null;
  /** 在途向量任务串行链（保持写入顺序，避免同一 id 被并发覆盖）。 */
  let chain = Promise.resolve();

  function markDegraded(reason) {
    const first = !degraded;
    degraded = true;
    degradedReason = reason;
    if (first) {
      try { onDegrade?.(reason); } catch { /* 观测回调不得影响检索 */ }
    }
  }

  function clearDegraded() {
    degraded = false;
    degradedReason = null;
  }

  /** 把一次异步任务排进串行链；失败只标降级，绝不让链断掉。 */
  function enqueue(task) {
    chain = chain.then(async () => {
      try {
        await task();
      } catch (err) {
        markDegraded(err?.code ?? 'vector-task-failed');
      }
    });
    return chain;
  }

  /** 单条记录的向量化（内部复用）。 */
  async function embedRecord(record) {
    if (!record || typeof record.id !== 'string') return;
    const text = `${record.subject ?? ''} ${record.predicate ?? ''} ${record.text ?? ''}`.trim();
    if (!text) return;
    const rows = await embedder.embed([text]);
    const vec = Array.isArray(rows) ? rows[0] : null;
    if (!Array.isArray(vec) || vec.length === 0) return;
    vectorIndex.add(record.id, vec);
  }

  return {
    /** 词法索引构建（同步）+ 后台补齐向量。 */
    build(records) {
      base.build(records);
      if (embedder.ready === false) {
        markDegraded('embedder-not-ready');
        return this.size;
      }
      clearDegraded();
      const list = Array.isArray(records) ? records : [];
      // 分片入队：一次塞几千条会把微任务链拉成一条长任务，分片让 flush 可观察进度。
      for (let i = 0; i < list.length; i += batchSize) {
        const slice = list.slice(i, i + batchSize);
        enqueue(async () => {
          for (const rec of slice) await embedRecord(rec);
        });
      }
      return this.size;
    },

    /** 新增一条（词法同步、向量后台）。 */
    /**
     * 加一条。**签名必须兼容两种调用**（对抗审核 B6）：
     *   - `add(record)`：lifecycle/commit 的既有约定（单参，记录对象自带 id）
     *   - `add(id, record)`：IndexPort 的字节级约定（也被部分测试直接用）
     * 之前只实现双参，于是线上「新写入」永远拿不到向量（`record` 是 undefined，
     * `embedRecord` 被跳过），只有重启 build() 之后才补上——语义道等于只对旧数据生效。
     */
    add(a, b) {
      const id = typeof a === 'string' ? a : a?.id;
      const record = typeof a === 'string' ? (b ?? a) : a;
      const out = typeof a === 'string' ? base.add(a, b) : base.add(a);
      if (embedder.ready !== false && typeof record?.text === 'string') {
        enqueue(() => embedRecord({ ...record, id: record.id ?? id }));
      }
      return out;
    },

    /** 删除一条（两侧同步：向量文件小，删是 O(n) 重写，可接受）。 */
    remove(id) {
      const out = typeof base.remove === 'function' ? base.remove(id) : undefined;
      try { vectorIndex.remove(id); } catch (err) { markDegraded(err?.code ?? 'vector-remove-failed'); }
      return out;
    },

    async search(query, opts = {}) {
      const limit = opts.limit;
      const lexicalLimit = Math.max(limit ?? lexicalTopK, lexicalTopK);
      const lexical = base.search(query, { ...opts, limit: lexicalLimit }) ?? [];

      if (embedder.ready === false) {
        markDegraded('embedder-not-ready');
        return lexical;
      }
      let semantic = [];
      try {
        const rows = await embedder.embed([query]);
        const qvec = Array.isArray(rows) ? rows[0] : null;
        if (Array.isArray(qvec) && qvec.length > 0) {
          semantic = vectorIndex.search(qvec, { topK: vectorTopK, minScore });
        }
      } catch (err) {
        // 超时 / 5xx / 维度漂移：降级但不抛（D1 的核心承诺）
        markDegraded(err?.code ?? (err?.name === 'AbortError' ? 'embed-timeout' : 'embed-failed'));
        return lexical;
      }
      if (semantic.length === 0) return lexical;
      // fuseSearch 返回 {items, degraded}；单路缺席的 degraded 已在上面处理，这里取 items。
      const fused = fuseSearch({ lexical, semantic, k: rrfK }).items;
      return limit === undefined ? fused : fused.slice(0, limit);
    },

    get size() {
      return typeof base.size === 'number' ? base.size : (base.size ?? 0);
    },

    /** 是否处于降级（语义路不可用）。 */
    get degraded() {
      return degraded;
    },

    /** 降级原因（供 /api/search 与 CLI 展示；正常为 null）。 */
    get degradedReason() {
      return degradedReason;
    },

    /** 等待所有在途向量任务完成（测试 / backfill / 关机前用）。 */
    async flush() {
      await chain;
      return { embedded: typeof vectorIndex.size === 'number' ? vectorIndex.size : null, degraded, degradedReason };
    },

    /** 仅词法侧（供 doctor / 基准对照）。 */
    get lexical() {
      return base;
    },

    /** 仅语义侧（供 backfill / 测试）。 */
    get semantic() {
      return vectorIndex;
    },
  };
}
