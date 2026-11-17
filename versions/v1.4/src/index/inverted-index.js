// index/inverted-index.js — 纯 JS 内存倒排索引 + BM25（实现 IndexPort，契约：docs/02 §3）
// search: BM25(k1=1.2, b=0.75)，filter 由调用方传入，score>0 才返回，score 降序取 limit。

import { tokenize } from '../core/hash.js';

const K1 = 1.2;
const B = 0.75;

export class InvertedIndex {
  /** @param {{clock?: object}} opts（clock 保留端口位，BM25 本身不需要时间） */
  constructor({ clock } = {}) {
    this.clock = clock ?? null;
    this._docs = new Map();        // id -> record
    this._postings = new Map();    // term -> Map(id -> tf)
    this._docLen = new Map();      // id -> token count
    this._totalLen = 0;
  }

  _docTerms(record) {
    return tokenize(`${record.text ?? ''} ${record.subject ?? ''} ${record.predicate ?? ''} ${record.value ?? ''}`);
  }

  /** 全量重建 */
  build(records) {
    this._docs.clear();
    this._postings.clear();
    this._docLen.clear();
    this._totalLen = 0;
    for (const r of records) this.add(r);
    return this;
  }

  add(record) {
    if (!record || typeof record.id !== 'string') {
      const err = new Error('InvertedIndex.add: record with string id required');
      err.code = 'E_INVALID_RECORD';
      throw err;
    }
    if (this._docs.has(record.id)) this.remove(record.id);
    const terms = this._docTerms(record);
    this._docs.set(record.id, record);
    this._docLen.set(record.id, terms.length);
    this._totalLen += terms.length;
    const tf = new Map();
    for (const t of terms) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const [term, freq] of tf) {
      let postings = this._postings.get(term);
      if (!postings) { postings = new Map(); this._postings.set(term, postings); }
      postings.set(record.id, freq);
    }
    return this;
  }

  remove(id) {
    const record = this._docs.get(id);
    if (!record) return this;
    const terms = new Set(this._docTerms(record));
    for (const term of terms) {
      const postings = this._postings.get(term);
      if (!postings) continue;
      postings.delete(id);
      if (postings.size === 0) this._postings.delete(term);
    }
    this._totalLen -= this._docLen.get(id) ?? 0;
    this._docLen.delete(id);
    this._docs.delete(id);
    return this;
  }

  /**
   * BM25 检索。
   * @param {string} query
   * @param {{limit?: number, filter?: (record) => boolean}} opts
   * @returns {{id: string, score: number}[]}
   */
  search(query, { limit = 10, filter } = {}) {
    const terms = tokenize(String(query ?? ''));
    if (terms.length === 0) return [];
    const N = this._docs.size;
    if (N === 0) return [];
    const avgLen = this._totalLen / N;
    const scores = new Map();

    for (const term of terms) {
      const postings = this._postings.get(term);
      if (!postings) continue;
      const df = postings.size;
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      if (idf <= 0) continue;
      for (const [id, tf] of postings) {
        const len = this._docLen.get(id) ?? 1;
        const norm = tf * (K1 + 1) / (tf + K1 * (1 - B + B * (len / (avgLen || 1))));
        scores.set(id, (scores.get(id) ?? 0) + idf * norm);
      }
    }

    const out = [];
    for (const [id, score] of scores) {
      if (score <= 0) continue;
      const record = this._docs.get(id);
      if (filter && !filter(record)) continue;
      out.push({ id, score });
    }
    out.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
    return typeof limit === 'number' ? out.slice(0, Math.max(0, limit)) : out;
  }

  /** 当前索引的文档数（诊断用） */
  get size() { return this._docs.size; }
}
