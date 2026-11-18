// annotation-pass.mjs — 双独立标注工作流（P1a B4）
// 五件套：盲评包导出 / 导入校验 / 一致性报告 / 裁决工作表 / goldset 生成（裁决落地、版本化）。
// 红线：goldset 只在两份标注都覆盖、且裁决表无待裁决行时才产出（fail-closed）。
// 红线（06-annotation-spec §2）：工具只做机械比对，绝不产出 pass/fail 裁决；
// 独立性=盲评包必须剥离全部 gold 侧字段（gold/shouldReject/adversarial/split/expected*）。
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeClaim } from './score.mjs';

const GOLD_SIDE_KEYS = new Set([
  'gold', 'shouldReject', 'adversarial', 'split', 'expectedOutcome', 'expectedErrorClass',
]);
const TYPE_ENUM = new Set(['fact', 'decision', 'preference', 'gotcha', 'task-state', 'hypothesis']);
const ROLE_ENUM = new Set(['user', 'assistant', 'tool']);
const SPEECH_ACT_ENUM = new Set(['state', 'suggest', 'agree', 'decide', 'complete', 'retract']);
const STATUS_ENUM = new Set(['active', 'retracted', 'conditional', 'suggestion-only', 'not-done']);

function stripGoldSide(value) {
  if (Array.isArray(value)) return value.map(stripGoldSide);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (GOLD_SIDE_KEYS.has(k)) continue;
      out[k] = stripGoldSide(v);
    }
    return out;
  }
  return value;
}

/** 导出盲评包：只保留事件与场景元数据，剥离全部 gold 侧字段。 */
export function buildBlindPackage(scenarios, { blindPass = 'pass-2', clock = () => new Date() } = {}) {
  const blind = scenarios.map(stripGoldSide);
  return {
    scenarios: blind,
    manifest: {
      annotationMode: 'dual-independent',
      blindPass,
      generatedAt: clock().toISOString(),
      corpusScenarios: scenarios.length,
      scenarioIds: scenarios.map((s) => s.scenarioId),
    },
  };
}

/** 校验第二遍标注：场景覆盖齐全 + gold 枚举合法。返回 {errors, annotationMode}。 */
export function importBlindAnnotation(annotations, blindPackage) {
  const errors = [];
  const pkgScenarios = blindPackage?.scenarios ?? [];
  const expected = new Set(blindPackage?.manifest?.scenarioIds ?? pkgScenarios.map((s) => s.scenarioId));
  // 事件索引：用于校验证据（eventId 必须存在、quote 必须逐字子串）——盲评包只含事件文本，足以独立判定
  const eventsByScenario = new Map(
    pkgScenarios.map((s) => [s.scenarioId, new Map((s.events ?? []).map((e) => [e.eventId, String(e.text ?? '')]))]),
  );
  const seen = new Set();
  for (const row of annotations) {
    const sid = row?.scenarioId;
    if (!sid) { errors.push('标注行缺 scenarioId'); continue; }
    seen.add(sid);
    if (!expected.has(sid)) errors.push(`未知场景 ${sid}（盲评包中没有）`);
    for (const g of row.gold ?? []) {
      if (!TYPE_ENUM.has(g.type)) errors.push(`${sid}: gold type 非法枚举 ${JSON.stringify(g.type)}`);
      if (g.role && !ROLE_ENUM.has(g.role)) errors.push(`${sid}: gold role 非法枚举 ${JSON.stringify(g.role)}`);
      if (!g.claim || typeof g.claim !== 'string') errors.push(`${sid}: gold 缺 claim`);
      if (g.status != null && !STATUS_ENUM.has(g.status)) errors.push(`${sid}: gold status 非法枚举 ${JSON.stringify(g.status)}（合法：active|retracted|conditional|suggestion-only|not-done）`);
      const sa = g.assertion?.speechAct;
      if (sa != null && !SPEECH_ACT_ENUM.has(sa)) errors.push(`${sid}: assertion.speechAct 非法枚举 ${JSON.stringify(sa)}（合法：state|suggest|agree|decide|complete|retract）`);
      if (typeof g.claim === 'string' && g.claim.length > 100) errors.push(`${sid}: claim 超过 100 字符上限（实际 ${g.claim.length}）`);
      // 证据校验（06 §1：quote 必须逐字出自事件文本）
      const evMap = eventsByScenario.get(sid);
      if (evMap) {
        for (const [i, ev] of (g.evidence ?? []).entries()) {
          if (!ev?.eventId) { errors.push(`${sid}: 第 ${i + 1} 条 evidence 缺 eventId`); continue; }
          if (!evMap.has(ev.eventId)) { errors.push(`${sid}: 第 ${i + 1} 条 evidence 的 eventId ${ev.eventId} 不在此场景事件中`); continue; }
          if (!ev.quote || !evMap.get(ev.eventId).includes(String(ev.quote))) {
            errors.push(`${sid}: 第 ${i + 1} 条 evidence 的 quote 不是事件 ${ev.eventId} 的逐字子串`);
          }
        }
      }
    }
  }
  for (const sid of expected) {
    if (!seen.has(sid)) errors.push(`缺场景 ${sid} 的标注（盲评包要求全覆盖）`);
  }
  return { errors, annotationMode: 'dual-independent', covered: seen.size, expected: expected.size };
}

/** F2 修复：Map<normalizedKey, gold[]>，同键多条 claim 按序保留，不再互相覆盖。 */
function indexByClaim(rows) {
  const m = new Map();
  for (const g of rows ?? []) {
    const key = normalizeClaim(g.claim ?? '');
    if (!m.has(key)) m.set(key, []);
    m.get(key).push(g);
  }
  return m;
}

/** F6：收集同场景内「归一化键相同但原文不同」的碰撞，供裁决人复核。 */
function collectKeyCollisions(index) {
  const out = [];
  for (const [key, claims] of index) {
    const raws = new Set(claims.map((c) => c.claim));
    if (raws.size > 1) out.push({ key, claims: claims.map((c) => c.claim) });
  }
  return out;
}

const COMPARE_FIELDS = ['role', 'type', 'scope', 'status'];

function fieldValue(g, field) {
  if (field.startsWith('assertion.')) return g.assertion?.[field.slice('assertion.'.length)] ?? null;
  return g[field] ?? null;
}

/**
 * 兼容 shouldReject 的两种落盘形态：布尔 + 同级 reason（当前 pass 文件），
 * 或 { reason } 对象（早期样例/测试）。统一成 { flag, reason }。
 */
function rejectInfo(row) {
  const r = row?.shouldReject;
  if (typeof r === 'boolean') return { flag: r, reason: typeof row.reason === 'string' ? row.reason : '' };
  if (r && typeof r === 'object') return { flag: true, reason: typeof r.reason === 'string' ? r.reason : '' };
  return { flag: false, reason: '' };
}

const RESOLUTIONS = new Set(['a', 'b', 'merge', 'both']);

/** 一致性报告：逐场景 claim 匹配 + 字段级一致率；永不产出 pass/fail。 */
function collectPasses(pass) {
  // 同场景可能多行（分片标注），gold 合并。
  // F7①：shouldReject 多行冲突（非空 reason 不同）不再静默取首个——返回冲突清单，
  // 分歧记录以冲突值为准（a=首个非空，b=冲突的另一个值）。
  const m = new Map();
  for (const r of pass) {
    const cur = m.get(r.scenarioId) ?? { gold: [], shouldReject: false, reason: '', shouldRejectConflict: null };
    cur.gold.push(...(r.gold ?? []));
    const info = rejectInfo(r);
    if (info.flag) {
      if (!cur.shouldReject) { cur.shouldReject = true; cur.reason = info.reason; }
      else if (info.reason && cur.reason && info.reason !== cur.reason && cur.shouldRejectConflict == null) {
        cur.shouldRejectConflict = info.reason;
      }
    }
    m.set(r.scenarioId, cur);
  }
  return m;
}

const ASSERTION_FIELDS = ['assertion.speechAct', 'assertion.negated', 'assertion.about', 'assertion.condition'];
const ALL_COMPARE_FIELDS = [...COMPARE_FIELDS, ...ASSERTION_FIELDS];

export function agreementReport(passA, passB) {
  const A = collectPasses(passA);
  const B = collectPasses(passB);
  const byScenario = new Map();
  for (const sid of new Set([...A.keys(), ...B.keys()])) {
    byScenario.set(sid, { a: A.get(sid) ?? null, b: B.get(sid) ?? null });
  }
  const perScenario = {};
  const normalizedKeyCollisions = [];
  const shouldRejectConflicts = [];
  let both = 0, aOnly = 0, bOnly = 0, fieldAtoms = 0, fieldAgree = 0, bothNullAtoms = 0;
  for (const [sid, pair] of byScenario) {
    const a = indexByClaim(pair.a?.gold);
    const b = indexByClaim(pair.b?.gold);
    const fieldDisagreements = [];
    // F6：碰撞复核清单（任一遍内出现即记录）。
    for (const [passName, index] of [['A', a], ['B', b]]) {
      for (const c of collectKeyCollisions(index)) {
        normalizedKeyCollisions.push({ scenarioId: sid, pass: passName, key: c.key, claims: c.claims });
      }
    }
    for (const [key, gaList] of a) {
      const gbList = b.get(key) ?? [];
      // F2：按序配对；A 多出的进 aOnly，B 多出的进 bOnly。
      const paired = Math.min(gaList.length, gbList.length);
      both += paired;
      for (let i = 0; i < paired; i += 1) {
        const ga = gaList[i];
        const gb = gbList[i];
        for (const f of ALL_COMPARE_FIELDS) {
          const va = fieldValue(ga, f);
          const vb = fieldValue(gb, f);
          if (va === null && vb === null) { bothNullAtoms += 1; continue; } // F7②：双 null 不计入一致率
          fieldAtoms += 1;
          if (va === vb) fieldAgree += 1;
          else fieldDisagreements.push({ claim: ga.claim, field: f, a: va, b: vb });
        }
      }
      aOnly += gaList.length - paired;
    }
    for (const [key, gbList] of b) {
      const gaList = a.get(key) ?? [];
      bOnly += gbList.length - Math.min(gaList.length, gbList.length);
    }
    const rejA = pair.a?.shouldReject ?? null;
    const rejB = pair.b?.shouldReject ?? null;
    if (rejA !== rejB) fieldDisagreements.push({ field: 'shouldReject', a: rejA, b: rejB });
    // F7①：同遍内多行 shouldReject 冲突。
    for (const [side, entry] of [['A', pair.a], ['B', pair.b]]) {
      if (entry?.shouldRejectConflict != null) {
        const reasons = [entry.reason ?? null, entry.shouldRejectConflict];
        shouldRejectConflicts.push({ scenarioId: sid, pass: side, reasons });
        fieldDisagreements.push({ field: 'shouldReject', a: entry.reason ?? null, b: entry.shouldRejectConflict });
      }
    }
    perScenario[sid] = { both: !!pair.a && !!pair.b, fieldDisagreements };
  }
  return {
    annotationMode: 'dual-independent',
    perScenario,
    totals: { both, aOnly, bOnly, fieldAgreement: fieldAtoms === 0 ? null : fieldAgree / fieldAtoms, fieldAtoms, bothNullAtoms },
    normalizedKeyCollisions,
    shouldRejectConflicts,
  };
}

/** 裁决工作表：只为分歧产出待裁决行，resolution 一律 null（人工填）。 */
export function adjudicationWorksheet(passA, passB) {
  const rows = [];
  const A = collectPasses(passA);
  const B = collectPasses(passB);
  const byScenario = new Map();
  for (const sid of new Set([...A.keys(), ...B.keys()])) {
    byScenario.set(sid, { a: A.get(sid) ?? null, b: B.get(sid) ?? null });
  }
  for (const [sid, pair] of byScenario) {
    const a = indexByClaim(pair.a?.gold);
    const b = indexByClaim(pair.b?.gold);
    for (const [key, gaList] of a) {
      const gbList = b.get(key) ?? [];
      const paired = Math.min(gaList.length, gbList.length);
      // F2：按序配对比较字段；A 多出的产出 claim-only-in-A 行。
      for (let i = 0; i < paired; i += 1) {
        const ga = gaList[i];
        const gb = gbList[i];
        const diffs = ALL_COMPARE_FIELDS.filter((f) => fieldValue(ga, f) !== fieldValue(gb, f));
        if (diffs.length > 0) {
          rows.push({ scenarioId: sid, kind: 'field-mismatch', fields: diffs, claimA: ga.claim, claimB: gb.claim, resolution: null });
        }
      }
      for (let i = paired; i < gaList.length; i += 1) {
        rows.push({ scenarioId: sid, kind: 'claim-only-in-A', claimA: gaList[i].claim, claimB: null, resolution: null });
      }
    }
    for (const [key, gbList] of b) {
      const gaList = a.get(key) ?? [];
      for (let i = Math.min(gaList.length, gbList.length); i < gbList.length; i += 1) {
        rows.push({ scenarioId: sid, kind: 'claim-only-in-B', claimA: null, claimB: gbList[i].claim, resolution: null });
      }
    }
    const rejA = pair.a?.shouldReject ?? null;
    const rejB = pair.b?.shouldReject ?? null;
    if (rejA !== rejB) rows.push({ scenarioId: sid, kind: 'reject-mismatch', rejectA: rejA, rejectB: rejB, resolution: null });
  }
  return { annotationMode: 'dual-independent', rows, pending: rows.filter((r) => r.resolution === null).length };
}

/** 裁决合并：文本取 A，字段级分歧取 B（"merge" 语义，逐字段可核对）。 */
function mergeClaims(ga, gb) {
  const out = structuredClone(ga);
  for (const f of ALL_COMPARE_FIELDS) {
    if (fieldValue(ga, f) === fieldValue(gb, f)) continue;
    if (f.startsWith('assertion.')) {
      out.assertion = { ...(out.assertion ?? {}), [f.slice('assertion.'.length)]: fieldValue(gb, f) };
    } else {
      out[f] = fieldValue(gb, f);
    }
  }
  return out;
}

/**
 * goldset 生成：把两份独立标注 + 裁决表落地成可版本化的 goldset-vN。
 * fail-closed：任一行未裁决 / 非法 resolution / 场景只在一侧标注 → 不产出，只返错误。
 */
export function buildGoldset(passA, passB, worksheet = {}, { goldsetVersion = 'goldset-v1', clock = () => new Date(), annotationMode = 'dual-independent', adjudication = null } = {}) {
  const errors = [];
  const rows = Array.isArray(worksheet?.rows) ? worksheet.rows.filter(Boolean) : [];
  const pending = rows.filter((r) => r.resolution == null);
  if (pending.length > 0) errors.push(`裁决表还有 ${pending.length} 条未裁决（resolution=null），不能生成 goldset`);
  const bad = rows.filter((r) => r.resolution != null && !RESOLUTIONS.has(r.resolution));
  if (bad.length > 0) {
    const vals = [...new Set(bad.map((r) => r.resolution))].join('|');
    errors.push(`裁决表有 ${bad.length} 条非法 resolution：${vals}（合法：a|b|merge|both）`);
  }
  const A = collectPasses(passA);
  const B = collectPasses(passB);
  const sids = new Set([...A.keys(), ...B.keys()]);
  const missing = [...sids].filter((sid) => !A.has(sid) || !B.has(sid));
  if (missing.length > 0) errors.push(`缺场景：${missing.join(',')} 只在一侧标注（双独立标注必须两边覆盖）`);
  if (errors.length > 0) return { errors, goldset: null };

  const bySid = new Map();
  for (const r of rows) {
    const arr = bySid.get(r.scenarioId) ?? [];
    arr.push(r);
    bySid.set(r.scenarioId, arr);
  }
  // 手工裁决行可能不带 claimA/claimB（单 claim 场景）——此时视为对该场景唯一键生效。
  const pickRow = (sid, kind, key) => (bySid.get(sid) ?? []).find((r) => {
    if (r.kind !== kind) return false;
    if (key == null) return true;
    const side = r.claimA ?? r.claimB ?? null;
    return side == null || normalizeClaim(side) === key;
  });

  const scenarios = [];
  let goldTotal = 0;
  let adjudicated = 0;
  let droppedA = 0;
  let droppedB = 0;
  for (const sid of [...sids].sort()) {
    const a = A.get(sid);
    const b = B.get(sid);
    const idxA = indexByClaim(a.gold);
    const idxB = indexByClaim(b.gold);
    const gold = [];
    for (const key of new Set([...idxA.keys(), ...idxB.keys()])) {
      const gaList = idxA.get(key) ?? [];
      const gbList = idxB.get(key) ?? [];
      const paired = Math.min(gaList.length, gbList.length);
      const mismatch = pickRow(sid, 'field-mismatch', key);
      const res = mismatch?.resolution ?? 'a';
      if (mismatch) adjudicated += 1;
      for (let i = 0; i < paired; i += 1) {
        const ga = gaList[i];
        const gb = gbList[i];
        const claim = res === 'b' ? structuredClone(gb) : res === 'merge' ? mergeClaims(ga, gb) : structuredClone(ga);
        claim.confirmedByBoth = true; // 两遍盲评都提出了同一 claim（归一化键相同）
        gold.push(claim);
      }
      for (let i = paired; i < gaList.length; i += 1) {
        const row = pickRow(sid, 'claim-only-in-A', key);
        const r = row?.resolution ?? 'a';
        if (row) adjudicated += 1;
        if (r === 'a' || r === 'both') {
          const claim = structuredClone(gaList[i]);
          claim.confirmedByBoth = false; // 单侧提出：未经第二遍确认
          gold.push(claim);
        } else droppedA += 1;
      }
      for (let i = paired; i < gbList.length; i += 1) {
        const row = pickRow(sid, 'claim-only-in-B', key);
        const r = row?.resolution ?? 'b';
        if (row) adjudicated += 1;
        if (r === 'b' || r === 'both') {
          const claim = structuredClone(gbList[i]);
          claim.confirmedByBoth = false;
          gold.push(claim);
        } else droppedB += 1;
      }
    }
    let reject;
    if (a.shouldReject === b.shouldReject) {
      reject = a.shouldReject;
    } else {
      const row = pickRow(sid, 'reject-mismatch');
      const r = row?.resolution ?? 'a';
      if (row) adjudicated += 1;
      reject = r === 'b' ? b.shouldReject : a.shouldReject;
    }
    if (reject) gold.length = 0; // 无可记场景不得携带 gold（防另一侧 claim 泄漏）
    goldTotal += gold.length;
    scenarios.push({ scenarioId: sid, shouldReject: reject, reason: reject ? (a.reason || b.reason || '') : '', gold });
  }
  return {
    errors: [],
    goldset: {
      annotationMode,
      ...(adjudication ? { adjudication } : {}),
      goldsetVersion,
      frozenAt: clock().toISOString(),
      scenarios,
      stats: { scenarios: scenarios.length, gold: goldTotal, adjudicated, droppedA, droppedB },
    },
  };
}

// ---------- CLI ----------
function loadJsonl(file) {
  const text = readFileSync(file, 'utf8');
  return text.split('\n').filter((l) => l.trim()).map((l, i) => {
    try { return JSON.parse(l); } catch (e) { throw new Error(`${file}:${i + 1} JSON 解析失败：${e.message}`); }
  });
}

function loadCorpusDir(dir) {
  const { readdirSync } = process.getBuiltinModule
    ? process.getBuiltinModule('node:fs')
    : { readdirSync: null };
  const fs = readdirSync ? { readdirSync } : null;
  if (!fs) throw new Error('CLI 需要 node:fs');
  const files = fs.readdirSync(dir).filter((f) => f.startsWith('scenarios-') && f.endsWith('.jsonl')).sort();
  const scenarios = [];
  for (const f of files) scenarios.push(...loadJsonl(join(dir, f)));
  return scenarios;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const arg = (name) => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  if (cmd === 'export') {
    const corpusDir = arg('--corpus') ?? 'corpus';
    const outDir = arg('--out') ?? 'out/blind';
    const scenarios = loadCorpusDir(corpusDir);
    const pkg = buildBlindPackage(scenarios);
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'blind-pass.jsonl'), pkg.scenarios.map((s) => JSON.stringify(s)).join('\n') + '\n');
    writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(pkg.manifest, null, 2) + '\n');
    console.log(JSON.stringify({ ok: true, scenarios: pkg.scenarios.length, out: outDir }));
    return;
  }
  if (cmd === 'import') {
    const file = arg('--file');
    const pkgDir = arg('--package') ?? 'out/blind';
    const manifest = JSON.parse(readFileSync(join(pkgDir, 'manifest.json'), 'utf8'));
    // 盲评包场景（含 events）用于证据逐字校验；文件缺失时退化为只校验枚举/覆盖
    const pkgScenariosFile = join(pkgDir, 'blind-pass.jsonl');
    const scenarios = existsSync(pkgScenariosFile) ? loadJsonl(pkgScenariosFile) : [];
    const result = importBlindAnnotation(loadJsonl(file), { manifest, scenarios });
    console.log(JSON.stringify(result, null, 2));
    if (result.errors.length > 0) process.exit(1);
    return;
  }
  if (cmd === 'compare') {
    const a = loadJsonl(arg('--a'));
    const b = loadJsonl(arg('--b'));
    console.log(JSON.stringify(agreementReport(a, b), null, 2));
    return;
  }
  if (cmd === 'worksheet') {
    const a = loadJsonl(arg('--a'));
    const b = loadJsonl(arg('--b'));
    const ws = adjudicationWorksheet(a, b);
    const out = arg('--out') ?? 'out/blind/adjudication.json';
    writeFileSync(out, JSON.stringify(ws, null, 2) + '\n');
    console.log(JSON.stringify({ ok: true, rows: ws.rows.length, pending: ws.pending, out }));
    return;
  }
  if (cmd === 'goldset') {
    const a = loadJsonl(arg('--a'));
    const b = loadJsonl(arg('--b'));
    const ws = JSON.parse(readFileSync(arg('--worksheet'), 'utf8'));
    const adjFile = arg('--adjudication');
    const res = buildGoldset(a, b, ws, {
      goldsetVersion: arg('--version') ?? 'goldset-v1',
      annotationMode: arg('--mode') ?? 'dual-independent',
      adjudication: adjFile ? JSON.parse(readFileSync(adjFile, 'utf8')) : null,
    });
    if (res.errors.length > 0) {
      console.error(JSON.stringify({ ok: false, errors: res.errors }, null, 2));
      process.exit(1);
    }
    const out = arg('--out') ?? 'out/blind/goldset-v1.json';
    writeFileSync(out, JSON.stringify(res.goldset, null, 2) + '\n');
    console.log(JSON.stringify({ ok: true, ...res.goldset.stats, version: res.goldset.goldsetVersion, out }));
    return;
  }
  console.error('用法：node annotation-pass.mjs <export|import|compare|worksheet|goldset> [--corpus dir] [--out file] [--a file] [--b file] [--worksheet file] [--version vN] [--package dir] [--mode dual-independent|model-dual-blinded] [--adjudication file]');
  process.exit(2);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
