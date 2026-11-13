// index/hybrid.js — RRF 融合检索（契约：docs/plans/v0.4-competitive-gaps.md D1）
// 词法（bm25）与语义（vector）两路排名用 Reciprocal Rank Fusion 合并：
//   score(id) = Σ_lists 1/(k + rank)，rank 从 1 起，k 默认 60。
// 降级语义（D1）：语义道缺失/不可用时照常返回词法结果并打 degraded 标记，
// 绝不静默假装有语义——basis 字段显式说明每条命中来自哪一路。

/**
 * 列表项归一化：接受 string 或 {id} / {id, score} 形态。
 * @param {string|{id: string}} item
 * @returns {string}
 */
function idOf(item) {
  if (typeof item === 'string') return item;
  if (item && typeof item.id === 'string') return item.id;
  throw new Error(`rrfFuse: list item without id: ${JSON.stringify(item)}`);
}

/**
 * RRF 融合多路排名列表。
 * @param {Array<Array<string|{id: string}>>} lists 每路已按相关度降序的 id 列表
 * @param {{k?: number}} [opts] RRF 常数 k（默认 60）
 * @returns {{id: string, score: number, ranks: Array<number|undefined>}[]}
 *   按 score 降序；ranks[i] = 该 id 在第 i 路的 1-based 排名（不在该路则 undefined）
 */
export function rrfFuse(lists, { k = 60 } = {}) {
  if (!Number.isFinite(k) || k <= 0) {
    const err = new Error(`rrfFuse: k must be a positive number, got ${k}`);
    err.code = 'E_INVALID_ARG';
    throw err;
  }
  /** @type {Map<string, {score: number, ranks: Array<number|undefined>}>} */
  const acc = new Map();
  for (let li = 0; li < lists.length; li++) {
    const list = lists[li];
    let rank = 0;
    for (const item of list ?? []) {
      rank++;
      const id = idOf(item);
      let e = acc.get(id);
      if (!e) {
        e = { score: 0, ranks: new Array(lists.length).fill(undefined) };
        acc.set(id, e);
      }
      e.score += 1 / (k + rank);
      e.ranks[li] = rank;
    }
  }
  return [...acc]
    .map(([id, e]) => ({ id, score: e.score, ranks: e.ranks }))
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
}

/**
 * 词法 + 语义两路融合检索。
 * @param {{lexical?: Array<{id: string, score?: number}>|null,
 *          semantic?: Array<{id: string, score?: number}>|null, k?: number}} args
 * @returns {{items: Array<{id: string, score: number, basis: 'bm25'|'vector'|'bm25+vector',
 *   lexicalRank?: number, vectorRank?: number}>, degraded: boolean}}
 *   degraded=true 表示语义道本应参与但缺席（调用方需附 degraded 原因）。
 */
export function fuseSearch({ lexical, semantic, k = 60 } = {}) {
  const lex = Array.isArray(lexical) ? lexical : null;
  const sem = Array.isArray(semantic) ? semantic : null;
  const lists = [];
  if (lex) lists.push(lex);
  if (sem) lists.push(sem);
  const fused = rrfFuse(lists, { k });
  const lexRank = new Map(lex ? lex.map((it, i) => [idOf(it), i + 1]) : []);
  const semRank = new Map(sem ? sem.map((it, i) => [idOf(it), i + 1]) : []);
  const items = fused.map(({ id, score }) => {
    const l = lexRank.get(id);
    const v = semRank.get(id);
    const basis = l !== undefined && v !== undefined ? 'bm25+vector'
      : l !== undefined ? 'bm25'
        : 'vector';
    /** @type {{id: string, score: number, basis: string, lexicalRank?: number, vectorRank?: number}} */
    const item = { id, score, basis };
    if (l !== undefined) item.lexicalRank = l;
    if (v !== undefined) item.vectorRank = v;
    return item;
  });
  // 降级定义：一路缺席。两路全空不算降级（空结果），两路都在则 degraded=false。
  const degraded = (lex === null) !== (sem === null);
  return { items, degraded };
}
