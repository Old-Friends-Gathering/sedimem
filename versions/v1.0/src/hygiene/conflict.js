// hygiene/conflict.js — 同 slot 冲突裁决（规则化，v0.1 无 LLM）
// 原则（对应 MemoryBank 事故防线）：不确定就 dispute，绝不静默覆盖。

import { normalizeText, tokenize, containment, charBigrams, signatureSimilarity } from '../core/text.js';
import { parseComparable } from '../core/time.js';

// W2 单点化：文本相似度实现搬至 core/text.js（charBigrams/signatureSimilarity
// 经 re-export 保持既有导入路径），时间可比较解析搬至 core/time.js。
export { charBigrams, signatureSimilarity } from '../core/text.js';
export { parseComparable };

/**
 * 近重复相似度（裁决 14/15）：containment = |A∩B| / min(|A|,|B|)，实现见 core/text.js。
 * 选 containment 而非 Jaccard：同一事实的不同长度措辞，短句应被长句吸收；
 * 空文本（无 token）→ 0。保留旧名 textSimilarity 是既有模块契约的一部分。
 * @param {string} aText
 * @param {string} bText
 * @returns {number} [0, 1]
 */
export function textSimilarity(aText, bText) {
  return containment(aText, bText);
}

/** scope+subject+predicate 三者在 normalizeText 后相等 */
export function sameSlot(a, b) {
  if (!a || !b) return false;
  return (
    normalizeText(String(a.scope ?? '')) === normalizeText(String(b.scope ?? '')) &&
    normalizeText(String(a.subject ?? '')) === normalizeText(String(b.subject ?? '')) &&
    normalizeText(String(a.predicate ?? '')) === normalizeText(String(b.predicate ?? ''))
  );
}

/**
 * 两值都能 parseComparable 且同类型时：next 更大/更晚 → supersede；相等 → ignore（同值）；
 * 否则 dispute。**任何不确定 → dispute，绝不静默覆盖。**
 * @param {import('../core/record.js').MemoryRecord} next 新记录
 * @param {import('../core/record.js').MemoryRecord} prev 旧记录
 * @param {{clock?: object}} ctx
 * @returns {{action:'supersede'|'dispute'|'ignore', reason:string}}
 */
export function decideConflict(next, prev, _ctx = {}) {
  const a = parseComparable(next?.value);
  const b = parseComparable(prev?.value);
  if (a.type === null || b.type === null || a.type !== b.type) {
    return {
      action: 'dispute',
      reason: `values not comparable (next.type=${a.type}, prev.type=${b.type})`,
    };
  }
  if (a.n > b.n) {
    return {
      action: 'supersede',
      reason: `comparable ${a.type}: next (${next.value}) > prev (${prev.value})`,
    };
  }
  if (a.n === b.n) {
    return {
      action: 'ignore',
      reason: `comparable ${a.type}: equal values (${next.value})`,
    };
  }
  return {
    action: 'dispute',
    reason: `comparable ${a.type}: next (${next.value}) <= prev (${prev.value}); refusing silent overwrite`,
  };
}

/**
 * 0.5 ** (ageMs / halfLifeMs)。必须严格单调递减（MemoryBank 事故的防线，有单测）。
 * 值域 (0, 1]：极端 age 会让 0.5**x 浮点下溢为 0，这里钳到 Number.MIN_VALUE
 * 以维持契约的严格为正（下溢区已无分辨力，钳位不影响单调性方向）。
 * @param {number} ageMs 年龄（毫秒），< 0 按 0 处理
 * @param {number} halfLifeMs 半衰期（毫秒），必须 > 0
 * @returns {number} (0, 1]
 */
export function monotonicDecay(ageMs, halfLifeMs) {
  if (!Number.isFinite(halfLifeMs) || halfLifeMs <= 0) {
    const err = new Error(`monotonicDecay: halfLifeMs must be a positive finite number, got ${halfLifeMs}`);
    err.code = 'E_INVALID_HALF_LIFE';
    throw err;
  }
  if (!Number.isFinite(ageMs)) {
    const err = new Error(`monotonicDecay: ageMs must be finite, got ${ageMs}`);
    err.code = 'E_INVALID_AGE';
    throw err;
  }
  const age = ageMs < 0 ? 0 : ageMs;
  const v = 0.5 ** (age / halfLifeMs);
  return v > 0 ? v : Number.MIN_VALUE;
}

// ─── 以下为裁决 22 新增（dedupeScan 分簇，只加不删） ───────────────────────────

const UNSTRUCTURED_SLOT = '\u0000unstructured';

/**
 * 归一化 slot 键（裁决 22）：subject/predicate 归一化后相等视为同 slot；
 * 两者都为 'text'（默认值）→ 归入 unstructured 超组（组内不设 slot 门槛，两两比较）。
 * @param {import('../core/record.js').MemoryRecord} r
 * @returns {string}
 */
/** 是否为「无结构」记录（subject 与 predicate 都是默认值 text）。 */
export function isUnstructured(r) {
  const s = normalizeText(String(r?.subject ?? 'text'));
  const p = normalizeText(String(r?.predicate ?? 'text'));
  return s === 'text' && p === 'text';
}

export function dedupeSlotKey(r) {
  const s = normalizeText(String(r?.subject ?? 'text'));
  const p = normalizeText(String(r?.predicate ?? 'text'));
  if (s === 'text' && p === 'text') return UNSTRUCTURED_SLOT;
  return `${s}\u0001${p}`;
}

/**
 * dedupeScan 核心分簇（裁决 22）：先按 slot 分组（text/text → unstructured 超组），
 * 组内两两 containment ≥ threshold 的用并查集聚簇。
 * 候选对优先用倒排 token 桶生成——threshold > 0 时合格对必然共享 ≥1 个 token，
 * 因此桶召回是完备的（无漏召）；仅当候选对数超过全比较对数时退回全比较并标 mode:'exact'。
 * 确定性：同输入同输出（组键排序、成员按 id 排序、簇按 maxSimilarity 降序 + key 升序）。
 * 只读：不修改入参。
 * @param {import('../core/record.js').MemoryRecord[]} records
 * @param {{threshold?: number}} [opts]
 * @returns {{clusters: {key: string, size: number, maxSimilarity: number, items: object[]}[], mode: 'bucket'|'exact'}}
 */
/**
 * dedupeScan 核心分簇（裁决 22 + 26 双度量）：
 * - 先按 slot 分组（text/text → unstructured 超组，组内不设 slot 门槛）；组内两两比较。
 * - 候选边满足任一条件即连边：containment ≥ threshold（裁决 14，宁漏不误杀的写入门控）
 *   或 字符二元组 Dice ≥ diceThreshold（裁决 26，中文/跨语种改写召回）。
 * - 两种度量都只做**候选发现**，判决仍交给 Agent（memory_curate）。
 * - 候选对用倒排桶生成：阈值 > 0 时合格对必共享 ≥1 个 token / ≥1 个字符二元组，
 *   故桶召回完备（无漏召）；桶膨胀超过全比较工作量级 ×4 时退全比较并标 mode:'exact'。
 * - 确定性：组键排序、成员按 id 排序、簇按 maxSimilarity 降序 + key 升序。
 * - 只读：不修改入参。
 * @param {import('../core/record.js').MemoryRecord[]} records
 * @param {{threshold?: number, diceThreshold?: number}} [opts] threshold 默认 0.45（containment）；diceThreshold 默认 0.15
 * @returns {{clusters: {key: string, size: number, maxSimilarity: number, basis: 'containment'|'dice',
 *    metrics: {maxContainment: number, maxDice: number}, items: object[]}[], mode: 'bucket'|'exact'}}
 */
export function clusterNearDuplicates(records, { threshold = 0.45, diceThreshold = 0.15 } = {}) {
  if (!Array.isArray(records)) {
    const err = new Error('clusterNearDuplicates: records must be an array');
    err.code = 'E_INVALID_ARG';
    throw err;
  }
  if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold <= 0 || threshold > 1) {
    const err = new Error(`clusterNearDuplicates: threshold must be in (0,1], got ${threshold}`);
    err.code = 'E_INVALID_ARG';
    throw err;
  }
  if (typeof diceThreshold !== 'number' || !Number.isFinite(diceThreshold) || diceThreshold <= 0 || diceThreshold > 1) {
    const err = new Error(`clusterNearDuplicates: diceThreshold must be in (0,1], got ${diceThreshold}`);
    err.code = 'E_INVALID_ARG';
    throw err;
  }

  // 预分词/预切 2-gram 一次，映射为紧凑 int id（typed array 计数用）
  const dict = new Map(); // token -> int id
  const gdict = new Map(); // 字符二元组 -> int id
  const prepared = records.map((r) => {
    const toks = tokenize(String(r.text ?? ''));
    const ids = new Int32Array(toks.length);
    for (let i = 0; i < toks.length; i++) {
      let id = dict.get(toks[i]);
      if (id === undefined) { id = dict.size; dict.set(toks[i], id); }
      ids[i] = id;
    }
    const gramList = [...charBigrams(String(r.text ?? ''))];
    const gids = new Int32Array(gramList.length);
    for (let i = 0; i < gramList.length; i++) {
      let id = gdict.get(gramList[i]);
      if (id === undefined) { id = gdict.size; gdict.set(gramList[i], id); }
      gids[i] = id;
    }
    return { record: r, tokens: ids, grams: gids, slot: dedupeSlotKey(r), id: String(r.id ?? '') };
  });

  const groups = new Map();
  for (const p of prepared) {
    if (p.tokens.length === 0 && p.grams.length === 0) continue;
    if (!groups.has(p.slot)) groups.set(p.slot, []);
    groups.get(p.slot).push(p);
  }

  let mode = 'bucket';
  const clusters = [];
  for (const slotKey of [...groups.keys()].sort()) {
    const members = groups.get(slotKey)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const n = members.length;
    if (n < 2) continue;

    const totalPairs = (n * (n - 1)) / 2;
    const bucketEntriesOf = (index) => {
      let e = 0;
      for (const b of index.values()) e += (b.length * (b.length - 1)) / 2;
      return e;
    };
    const buildIndex = (key) => {
      const index = new Map();
      for (let i = 0; i < n; i++) {
        for (const t of members[i][key]) {
          let b = index.get(t);
          if (!b) { b = []; index.set(t, b); }
          b.push(i);
        }
      }
      return index;
    };

    // 并查集
    const parent = new Int32Array(n);
    for (let i = 0; i < n; i++) parent[i] = i;
    const find = (x) => {
      while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
      return x;
    };
    const union = (i, j) => {
      const ri = find(i); const rj = find(j);
      if (ri !== rj) parent[Math.max(ri, rj)] = Math.min(ri, rj);
    };

    // 每条合格边的两侧度量（用于簇内 max* / pairs 输出；簇内最大必落在合格边上）
    // 键 `i:j` 去重：同一对可能被 A/B 两路同时命中，合并两侧度量而不是重复计边。
    const edgeMap = new Map();
    const addEdge = (i, j, cont = 0, dice = 0) => {
      const k = `${i}:${j}`;
      const e = edgeMap.get(k);
      if (e) {
        if (cont > e.cont) e.cont = cont;
        if (dice > e.dice) e.dice = dice;
      } else {
        edgeMap.set(k, { i, j, cont, dice });
      }
    };

    // ---- 度量 A：containment（token 空间）----
    const tokenBuckets = buildIndex('tokens');
    // 桶膨胀到全比较工作量级（×4）就退全比较并标 mode:'exact'（正确性优先）
    const useTokenBuckets = bucketEntriesOf(tokenBuckets) < totalPairs * 4;
    if (!useTokenBuckets) mode = 'exact';

    if (useTokenBuckets) {
      // 单遍扫描：record i 的 token 桶展开，counter[j] 恰为 |tokens(i) ∩ tokens(j)|
      //（行内 token 无重复，加法计数即交集大小，无需二次求交）
      const counter = new Int32Array(n);
      const touched = new Int32Array(n);
      for (let i = 0; i < n; i++) {
        const ti = members[i].tokens;
        let tc = 0;
        for (const t of ti) {
          for (const j of tokenBuckets.get(t)) {
            if (j <= i) continue;
            if (counter[j] === 0) touched[tc++] = j;
            counter[j] += 1;
          }
        }
        for (let k = 0; k < tc; k++) {
          const j = touched[k];
          const cnt = counter[j];
          counter[j] = 0;
          const s = cnt / Math.min(ti.length, members[j].tokens.length);
          if (s >= threshold) { union(i, j); addEdge(i, j, s, 0); }
        }
      }
    } else {
      // 全比较（mode:'exact'）：stamp 表标记 tokens(i)，内层线性数交集
      const stamps = new Int32Array(dict.size).fill(-1);
      for (let i = 0; i < n; i++) {
        const ti = members[i].tokens;
        for (const t of ti) stamps[t] = i;
        for (let j = i + 1; j < n; j++) {
          let inter = 0;
          for (const t of members[j].tokens) if (stamps[t] === i) inter += 1;
          const s = inter / Math.min(ti.length, members[j].tokens.length);
          if (s >= threshold) { union(i, j); addEdge(i, j, s, 0); }
        }
      }
    }

    // ---- 度量 B：字符二元组 Dice（裁决 26，中文/跨语种改写召回）----
    const gramBuckets = buildIndex('grams');
    const useGramBuckets = bucketEntriesOf(gramBuckets) < totalPairs * 4;
    if (!useGramBuckets) mode = 'exact';
    const diceOf = (inter, ai, bj) => (2 * inter) / (ai + bj);

    if (useGramBuckets) {
      const counter = new Int32Array(n);
      const touched = new Int32Array(n);
      for (let i = 0; i < n; i++) {
        const gi = members[i].grams;
        if (gi.length === 0) continue;
        let tc = 0;
        for (const t of gi) {
          for (const j of gramBuckets.get(t)) {
            if (j <= i) continue;
            if (counter[j] === 0) touched[tc++] = j;
            counter[j] += 1;
          }
        }
        for (let k = 0; k < tc; k++) {
          const j = touched[k];
          const cnt = counter[j];
          counter[j] = 0;
          const d = diceOf(cnt, gi.length, members[j].grams.length);
          if (d >= diceThreshold) { union(i, j); addEdge(i, j, 0, d); }
        }
      }
    } else {
      const gstamps = new Int32Array(gdict.size).fill(-1);
      for (let i = 0; i < n; i++) {
        const gi = members[i].grams;
        for (const t of gi) gstamps[t] = i;
        for (let j = i + 1; j < n; j++) {
          let inter = 0;
          for (const t of members[j].grams) if (gstamps[t] === i) inter += 1;
          const d = diceOf(inter, gi.length, members[j].grams.length);
          if (d >= diceThreshold) { union(i, j); addEdge(i, j, 0, d); }
        }
      }
    }

    // 收簇（size ≥ 2）+ 每簇 maxContainment/maxDice（同簇合格边可能来自 A/B 两路）
    // 同时输出簇内**逐对**依据（pairs）：并查集是传递闭包，一条链可能把 A 与无关的 C 连在一起，
    // Agent 必须能看到「哪一对凭什么进候选」才能判定；pairs 每簇最多 20 条（按 score 降序）。
    const contByRoot = new Map();
    const diceByRoot = new Map();
    const pairsByRoot = new Map();
    for (const e of edgeMap.values()) {
      const root = find(e.i);
      if (e.cont > (contByRoot.get(root) ?? 0)) contByRoot.set(root, e.cont);
      if (e.dice > (diceByRoot.get(root) ?? 0)) diceByRoot.set(root, e.dice);
      if (!pairsByRoot.has(root)) pairsByRoot.set(root, []);
      pairsByRoot.get(root).push(e);
    }
    const comp = new Map(); // root -> member indices
    for (let i = 0; i < n; i++) {
      const root = find(i);
      if (!comp.has(root)) comp.set(root, []);
      comp.get(root).push(i);
    }
    for (const [root, idxs] of comp) {
      if (idxs.length < 2) continue;
      const maxContainment = contByRoot.get(root) ?? 0;
      const maxDice = diceByRoot.get(root) ?? 0;
      const maxSimilarity = Math.max(maxContainment, maxDice);
      const items = idxs.map((i) => members[i].record);
      const round = (x) => Math.round(x * 1e6) / 1e6;
      const pairs = (pairsByRoot.get(root) ?? [])
        .filter((e) => find(e.i) === root && find(e.j) === root)
        .map((e) => {
          const score = Math.max(e.cont, e.dice);
          return {
            aId: String(members[e.i].id),
            bId: String(members[e.j].id),
            containment: round(e.cont),
            dice: round(e.dice),
            score: round(score),
            basis: e.dice > e.cont ? 'dice' : 'containment',
            // strength 是给 Agent 的默认动作建议（不是判决）：
            // strong（containment≥0.45 或 dice≥0.30）= 词面高度重合，先怀疑同一事实；
            // weak = 仅同主题词重合（实测同域无关事实 dice 0.22–0.29），默认 keep_both 更安全。
            strength: (e.cont >= threshold || e.dice >= 0.3) ? 'strong' : 'weak',
          };
        })
        .sort((x, y) => (y.score - x.score) || (x.aId < y.aId ? -1 : x.aId > y.aId ? 1 : x.bId < y.bId ? -1 : 1))
        .slice(0, 20);
      clusters.push({
        key: `${slotKey === UNSTRUCTURED_SLOT ? 'unstructured' : slotKey}#${members[idxs[0]].id}`,
        size: items.length,
        maxSimilarity: round(maxSimilarity),
        basis: maxDice > maxContainment ? 'dice' : 'containment',
        metrics: { maxContainment: round(maxContainment), maxDice: round(maxDice) },
        pairs,
        items,
      });
    }
  }

  clusters.sort((a, b) => (
    b.maxSimilarity !== a.maxSimilarity ? b.maxSimilarity - a.maxSimilarity : (a.key < b.key ? -1 : 1)
  ));
  return { clusters, mode };
}
