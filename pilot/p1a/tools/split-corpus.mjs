// split-corpus.mjs —— dev/test 家族分层切分 + 近重复不跨集校验
// 规格：docs/plans/v2.0-p1.md §7 B3、04-scoring-and-splits.md §2（近重复不跨集合，Dice 0.85）、
//       eval-manifest.json thresholds.nearDuplicateDice
//
// CLI：
//   node split-corpus.mjs <corpusDir> <manifest> --check            校验已有 split 字段
//   node split-corpus.mjs <corpusDir> <manifest> --apply --seed N   家族分层分配并写回场景文件
// 退出码：切分问题（近重复跨集/家族缺边）→ 1；--check 且无 split 字段 → 1。

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** 字符二元组 Dice 系数（0..1）；空串对定义为 0。中英混排都按码点切。 */
export function diceBigram(a, b) {
  const norm = (s) => String(s ?? '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
  const x = norm(a);
  const y = norm(b);
  if (x === y && x.length > 0) return 1;
  if (x.length < 2 || y.length < 2) return 0;
  const grams = (s) => {
    const out = new Map();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      out.set(g, (out.get(g) ?? 0) + 1);
    }
    return out;
  };
  const gx = grams(x);
  const gy = grams(y);
  let inter = 0;
  let totalX = 0;
  let totalY = 0;
  for (const n of gx.values()) totalX += n;
  for (const n of gy.values()) totalY += n;
  for (const [g, n] of gx) {
    const m = gy.get(g);
    if (m) inter += Math.min(n, m);
  }
  return (2 * inter) / (totalX + totalY);
}

/** mulberry32：小而确定性的 PRNG（种子 → [0,1)）。 */
function mulberry32(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 家族分层 dev/test 分配：按家族分组 → 家族内按 scenarioId 排序 → 种子洗牌 → 逐个交替
 * dev/test（家族大小为奇数时多出的那一个给当前较少的一边）。不修改输入，返回带 split 的新数组。
 */
export function assignSplit(scenarios, { seed = 0 } = {}) {
  const rand = mulberry32(seed);
  const shuffled = (arr) => {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };
  const byFamily = new Map();
  for (const s of scenarios) {
    const f = s.family || '_none';
    if (!byFamily.has(f)) byFamily.set(f, []);
    byFamily.get(f).push(s);
  }
  const out = [];
  for (const members of byFamily.values()) {
    const ordered = shuffled(members.sort((p, q) => String(p.scenarioId).localeCompare(String(q.scenarioId))));
    let dev = 0;
    let test = 0;
    for (const s of ordered) {
      const split = dev <= test ? 'dev' : 'test';
      if (split === 'dev') dev += 1;
      else test += 1;
      out.push({ ...s, split });
    }
  }
  return out;
}

/** 场景的近重复比较文本：全部事件文本拼接。 */
function scenarioText(s) {
  return (Array.isArray(s?.events) ? s.events : []).map((e) => e?.text ?? '').join('\n');
}

/** 跨集近重复对：a∈dev、b∈test 且 Dice ≥ threshold。返回 [{a, b, score}]。 */
export function nearDupAcrossSets(scenarios, { threshold = 0.85 } = {}) {
  const dev = scenarios.filter((s) => s.split === 'dev');
  const test = scenarios.filter((s) => s.split === 'test');
  const pairs = [];
  for (const a of dev) {
    for (const b of test) {
      const score = diceBigram(scenarioText(a), scenarioText(b));
      if (score >= threshold) pairs.push({ a: a.scenarioId, b: b.scenarioId, score });
    }
  }
  return pairs;
}

/**
 * 切分校验：① 每个家族 dev/test 两边都出现（家族缺边 = 评测盲区）；
 * ② 跨集近重复（threshold 用 manifest 的 nearDuplicateDice.value）。
 * 返回问题字符串数组（空 = 通过）。
 */
export function validateSplit(assigned, { dice = 0.85 } = {}) {
  const problems = [];
  const famSide = new Map();
  for (const s of assigned) {
    const f = s.family || '_none';
    if (!famSide.has(f)) famSide.set(f, { dev: 0, test: 0 });
    famSide.get(f)[s.split === 'test' ? 'test' : 'dev'] += 1;
  }
  for (const [f, n] of famSide) {
    if (n.dev === 0 || n.test === 0) problems.push(`家族 ${f} 缺${n.dev === 0 ? 'dev' : 'test'}边（dev=${n.dev} test=${n.test}）`);
  }
  for (const p of nearDupAcrossSets(assigned, { threshold: dice })) {
    problems.push(`近重复跨集：${p.a} ~ ${p.b}（dice=${p.score.toFixed(3)} ≥ ${dice}）`);
  }
  return problems;
}

function loadJsonlFiles(dir) {
  const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort();
  const all = [];
  for (const f of files) {
    const text = readFileSync(path.join(dir, f), 'utf8');
    for (const [i, line] of text.split('\n').entries()) {
      if (!line.trim()) continue;
      all.push({ file: f, line: i + 1, scenario: JSON.parse(line) });
    }
  }
  return all;
}

export async function main(argv = process.argv.slice(2)) {
  const dir = argv[0];
  const manifestPath = argv[1];
  const apply = argv.includes('--apply');
  const check = argv.includes('--check');
  const seedIdx = argv.indexOf('--seed');
  const seed = seedIdx >= 0 ? Number(argv[seedIdx + 1]) : 20261118;
  if (!dir || !manifestPath || (!apply && !check)) {
    console.error('用法：node split-corpus.mjs <corpusDir> <manifest> --check | --apply [--seed N]');
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const dice = manifest?.thresholds?.nearDuplicateDice?.value ?? 0.85;
  const rows = loadJsonlFiles(dir);
  if (check) {
    const missing = rows.filter((r) => r.scenario.split !== 'dev' && r.scenario.split !== 'test');
    if (missing.length > 0) {
      console.error(`${missing.length} 个场景缺 split 字段（示例 ${missing[0].scenario.scenarioId}）——先 --apply`);
      process.exit(1);
    }
  }
  const scenarios = rows.map((r) => r.scenario);
  const assigned = apply ? assignSplit(scenarios, { seed }) : scenarios;
  const problems = validateSplit(assigned, { dice });
  const dev = assigned.filter((s) => s.split === 'dev').length;
  const test = assigned.filter((s) => s.split === 'test').length;
  console.log(`场景 ${assigned.length}（dev ${dev} / test ${test}）· dice 阈值 ${dice} · 跨集近重复配对校验完成`);
  if (problems.length > 0) {
    for (const p of problems.slice(0, 10)) console.error('  ✗ ' + p);
    if (problems.length > 10) console.error(`  …共 ${problems.length} 条`);
    process.exit(1);
  }
  if (apply) {
    const byFile = new Map();
    for (const s of assigned) {
      const orig = rows.find((r) => r.scenario.scenarioId === s.scenarioId);
      if (!byFile.has(orig.file)) byFile.set(orig.file, []);
      byFile.get(orig.file).push(JSON.stringify(s));
    }
    for (const [file, lines] of byFile) {
      writeFileSync(path.join(dir, file), lines.join('\n') + '\n');
    }
    console.log(`已写回 ${byFile.size} 个文件（seed=${seed}）`);
  } else {
    console.log('切分校验通过');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
