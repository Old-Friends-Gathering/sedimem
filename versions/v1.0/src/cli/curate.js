// cli/curate.js — `memo curate prompt|status|apply --file`（契约：docs/02 附录 B）
// B 路任务包：生成裁决任务包（.md 人读 + .json 机读）→ Agent 回填 decisions → 严格校验后落盘。
// 任务包 pairs 只取 service.dedupeScan() 返回（裁决 26/27），不二次计算相似度；
// apply 逐条调 service.curateApply()（语义只有一处实现，docs/02 附录 B）。

import process from 'node:process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { defaultPolicy } from '../config/policy.js';

const DECISIONS = new Set(['a_wins', 'b_wins', 'merge', 'keep_both']);

/** 排序后的 pair 键（裁决 36 裁决键语义：顺序无关） */
export function pairKeyOf(ids) {
  return [...ids].map(String).sort().join(',');
}

function invalidArg(msg) {
  const err = new Error(msg);
  err.code = 'E_INVALID_ARG';
  return err;
}

/** batchId 形如 batch-<ISO 去冒号>-<4 位随机>，如 batch-2026-11-02T10-15-00-ab12 */
function makeBatchId(nowIso) {
  const stamp = String(nowIso).replace(/\.\d{3}Z$/, 'Z').replace(/[:.]/g, '-');
  // 4 字节随机后缀：2 字节时同毫秒撞名概率 1/65536，撞了会静默覆盖旧批次（审核 B1/B3）
  return `batch-${stamp}-${randomBytes(4).toString('hex')}`;
}

/** Markdown 表格单元格转义：反斜杠必须先转，否则 `\|` 会被当成「已转义的竖线」 */
function mdCell(value) {
  return `${value ?? ''}`.replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
}

function labelOf(item) {
  const text = String(item?.text ?? '');
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

/**
 * 由 dedupeScan 结果构造任务包 pairs（只做投影，不算相似度）。
 * @param {{clusters: object[]}} scan service.dedupeScan() 的返回
 * @returns {{pairs: object[], clusters: number, strong: number, weak: number}}
 */
export function pairsFromScan(scan) {
  const byId = new Map();
  for (const c of scan.clusters ?? []) {
    for (const it of c.items ?? []) byId.set(it.id, it);
  }
  const pairs = [];
  let strong = 0;
  let weak = 0;
  for (const c of scan.clusters ?? []) {
    for (const p of c.pairs ?? []) {
      const a = byId.get(p.aId);
      const b = byId.get(p.bId);
      pairs.push({
        pairIndex: pairs.length,
        ids: [p.aId, p.bId],
        strength: p.strength,
        containment: p.containment,
        dice: p.dice,
        score: p.score,
        basis: p.basis,
        // strength 只是默认动作建议，不是判决（裁决 26/27）
        suggestion: p.strength === 'strong' ? 'merge' : 'keep_both',
        a: a
          ? { id: a.id, label: labelOf(a), text: a.text, kind: a.kind, status: a.status, validFrom: a.validFrom }
          : { id: p.aId, label: '', text: '', kind: '', status: 'missing', validFrom: null },
        b: b
          ? { id: b.id, label: labelOf(b), text: b.text, kind: b.kind, status: b.status, validFrom: b.validFrom }
          : { id: p.bId, label: '', text: '', kind: '', status: 'missing', validFrom: null },
      });
      if (p.strength === 'strong') strong++;
      else weak++;
    }
  }
  return { pairs, clusters: (scan.clusters ?? []).length, strong, weak };
}

function renderMarkdown(pkg) {
  const lines = [];
  lines.push(`# 裁决任务包 ${pkg.batchId}`);
  lines.push('');
  lines.push(`- 批次: \`${pkg.batchId}\``);
  lines.push(`- 生成时间: ${pkg.createdAt}`);
  lines.push(`- scope: \`${pkg.scope}\``);
  lines.push(`- 聚类: ${pkg.meta.clusters} 簇 / ${pkg.pairs.length} 对（strong ${pkg.meta.strong}，weak ${pkg.meta.weak}）`);
  lines.push(`- 阈值: scanThreshold=${pkg.policy.scanThreshold} scanDiceThreshold=${pkg.policy.scanDiceThreshold}`);
  lines.push('');
  lines.push('decision 取值: `merge` | `a_wins` | `b_wins` | `keep_both`（a = ids[0]，b = ids[1]）。');
  lines.push('按下方裁决表在同名 `.json` 的 `decisions` 数组里回填：');
  lines.push('');
  lines.push('```json');
  lines.push('{ "ids": ["<idA>", "<idB>"], "decision": "merge", "note": "理由" }');
  lines.push('```');
  lines.push('');
  lines.push('然后执行 `memo curate apply --file <本任务包同名 .json>`。');
  lines.push('');
  lines.push('## 裁决表');
  lines.push('');
  lines.push('| # | ids | strength | containment | dice | 建议 | A | B |');
  lines.push('|---|-----|----------|-------------|------|------|---|---|');
  for (const p of pkg.pairs) {
    // Markdown 表格单元格：先转义反斜杠再转义竖线（只转义 | 会让 `\\|` 之类的输入破坏表格）
    const a = mdCell(p.a.label);
    const b = mdCell(p.b.label);
    lines.push(
      `| ${p.pairIndex} | ${p.ids[0]} <-> ${p.ids[1]} | ${p.strength} | ${p.containment} | ${p.dice} | ${p.suggestion} | ${a} | ${b} |`,
    );
  }
  lines.push('');
  lines.push('## 全文对照');
  for (const p of pkg.pairs) {
    lines.push('');
    lines.push(`### #${p.pairIndex}（${p.strength}，建议 ${p.suggestion}）`);
    lines.push(`- A (${p.a.id}) [${p.a.kind}/${p.a.status}]: ${p.a.text}`);
    lines.push(`- B (${p.b.id}) [${p.b.kind}/${p.b.status}]: ${p.b.text}`);
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * 生成裁决任务包并落盘两份（curate/<batchId>.md + .json）。
 * 无候选时不写文件，返回 { batchId: null, pairs: [] }（调用方正常退出）。
 * @param {object} service MemoryService
 * @param {{limit?: number, json?: boolean}} [opts]
 */
export async function curatePrompt(service, { limit, json = false } = {}) {
  const scan = await service.dedupeScan({ limit: limit ?? 50 });
  const projected = pairsFromScan(scan);
  const createdAt = service.clock.now();
  // 已裁决过的 pair 不再进新批次（对抗审核 S1：不过滤会让 prompt 永不收敛、批次文件无界增长）
  const decided = await decidedKeys(service);
  const fresh = projected.pairs.filter((p) => !decided.has(pairKeyOf(p.ids)));
  const pairs = fresh;
  const clusters = projected.clusters;
  const strong = fresh.filter((p) => p.strength === 'strong').length;
  const weak = fresh.length - strong;
  if (pairs.length === 0) {
    const empty = { batchId: null, createdAt, scope: service.scope, pairs: [], written: false };
    if (json) return empty;
    process.stdout.write('当前没有待裁决的近重复候选\n');
    return empty;
  }
  const batchId = makeBatchId(createdAt);
  const pkg = {
    batchId,
    createdAt,
    scope: service.scope,
    policy: {
      scanThreshold: scan.threshold,
      scanDiceThreshold: scan.diceThreshold,
      // 阈值来自 policy（唯一来源，docs/02 附录 A/B）；读不到时退回 0.85
      nearDupThreshold: Number(defaultPolicy.dedupe?.nearDupThreshold ?? 0.85),
    },
    meta: { clusters, strong, weak },
    pairs,
    decisions: [],
  };
  const dir = join(service.memoHome, 'curate');
  mkdirSync(dir, { recursive: true });
  const mdPath = join(dir, `${batchId}.md`);
  const jsonPath = join(dir, `${batchId}.json`);
  writeFileSync(mdPath, renderMarkdown(pkg), 'utf8');
  writeFileSync(jsonPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
  const out = { batchId, pairs: pkg.pairs, mdPath, jsonPath, written: true };
  if (json) return { ...out, pkg };
  process.stdout.write(`任务包已生成: ${mdPath}\n`);
  process.stdout.write(`批次: ${batchId}\n`);
  process.stdout.write(`聚类: ${clusters} 簇 / ${pairs.length} 对（strong ${strong}，weak ${weak}）\n`);
  process.stdout.write('下一步: 按任务包里的「裁决表」填 decisions，然后\n');
  process.stdout.write(`  memo curate apply --file ${jsonPath}\n`);
  return out;
}

/**
 * 纯函数校验（V1 之外的结构校验，docs/02 附录 B）。任一失败抛 E_INVALID_ARG（人话原因），
 * 调用方保证失败时一条都不落盘。
 * @param {{batchId: string, pairs: {ids: string[]}[]}} pkg 任务包
 * @param {{ids: string[], decision: string, note?: string}[]} decisions
 */
export function validateDecisions(pkg, decisions) {
  if (!pkg || typeof pkg !== 'object' || !Array.isArray(pkg.pairs)) {
    throw invalidArg('任务包损坏：缺少 pairs（请重新 memo curate prompt）');
  }
  if (!Array.isArray(decisions)) {
    throw invalidArg('decisions 必须是数组 [{ids, decision, note}]');
  }
  if (decisions.length === 0) {
    throw invalidArg('decisions 为空：没有可应用的裁决');
  }
  const validKeys = new Set(pkg.pairs.map((p) => pairKeyOf(p.ids)));
  const seen = new Set();
  for (let i = 0; i < decisions.length; i++) {
    const d = decisions[i];
    if (!d || typeof d !== 'object') {
      throw invalidArg(`第 ${i} 条 decision 不是对象`);
    }
    if (!DECISIONS.has(d.decision)) {
      throw invalidArg(
        `第 ${i} 条 decision 非法: ${JSON.stringify(d.decision)}（合法值 ${[...DECISIONS].join('|')}）`,
      );
    }
    if (!Array.isArray(d.ids) || d.ids.length < 2 || d.ids.some((x) => typeof x !== 'string')) {
      throw invalidArg(`第 ${i} 条 decision 的 ids 必须是 ≥2 个字符串的数组`);
    }
    const key = pairKeyOf(d.ids);
    if (!validKeys.has(key)) {
      throw invalidArg(`第 ${i} 条 decision 的 ids 与任务包不符: [${d.ids.join(', ')}]`);
    }
    if (seen.has(key)) {
      throw invalidArg(`重复裁决: pair [${d.ids.join(', ')}] 出现两次`);
    }
    seen.add(key);
  }
  return { ok: true, count: decisions.length };
}

/** 读 curate/<batchId>.json 任务包（V2：未知批次） */
export function readBatchPkg(memoHome, batchId) {
  if (!/^[A-Za-z0-9._-]+$/.test(String(batchId ?? ''))) {
    throw invalidArg(`非法 batchId: ${JSON.stringify(batchId)}`);
  }
  const p = join(memoHome, 'curate', `${batchId}.json`);
  if (!existsSync(p)) {
    throw invalidArg(`未知批次: ${batchId}（任务包 ${p} 不存在，请重新 memo curate prompt）`);
  }
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch (cause) {
    throw invalidArg(`任务包不是合法 JSON（${p}）: ${cause.message}`);
  }
}

/**
 * 事件流里已裁决的 pair 键集合（裁决 36 裁决键：curate_apply.detail.ids 排序串）。
 * 不靠额外状态文件——状态文件会与真相层漂移（docs/02 附录 B）。
 */
async function decidedKeys(service) {
  const { events } = await service.events({ ops: ['curate_apply'], limit: 1000000 });
  const keys = new Set();
  for (const ev of events) {
    const ids = ev?.detail?.ids;
    if (Array.isArray(ids) && ids.length >= 2) keys.add(pairKeyOf(ids));
  }
  return keys;
}

/**
 * 应用裁决文件（严格校验 V1–V5 全过后才落盘；V6 并发被删 → skipped 不整体失败）。
 * 逐条调 service.curateApply({batchId, decisions:[{ids, decision}]})。
 * @returns {{batchId: string, applied: number, skipped: number,
 *            results: {ids: string[], applied: boolean, reason?: string}[]}}
 */
export async function curateApplyFile(service, filePath) {
  const { readFile } = await import('node:fs/promises');
  let parsed;
  try {
    parsed = JSON.parse(await readFile(filePath, 'utf8'));
  } catch (cause) {
    throw invalidArg(`--file 不是合法 JSON (${filePath}): ${cause.message}`);
  }
  // V1：可解析且含 batchId 与 decisions[]
  if (!parsed || typeof parsed !== 'object' || typeof parsed.batchId !== 'string') {
    throw invalidArg('--file 内容需含字符串 batchId');
  }
  if (!Array.isArray(parsed.decisions)) {
    throw invalidArg('--file 内容需含 decisions 数组 [{ids, decision, note}]');
  }
  // V2：批次存在
  const pkg = readBatchPkg(service.memoHome, parsed.batchId);
  // V3–V5：decision 合法 / ids 属于某对 / 同 pair 不重复（全过后才允许第一条落盘）
  validateDecisions(pkg, parsed.decisions);

  const decided = await decidedKeys(service);
  const results = [];
  let applied = 0;
  let skipped = 0;
  for (const d of parsed.decisions) {
    const key = pairKeyOf(d.ids);
    // 幂等：事件流里该 pair 已有 curate_apply → skipped，不重复写
    if (decided.has(key)) {
      results.push({ ids: d.ids, applied: false, reason: 'already decided' });
      skipped++;
      continue;
    }
    // V6：记录在裁决后仍存在且未 tombstone（并发被删 → skipped，不整体失败）
    let gone = false;
    for (const id of d.ids) {
      const r = await service.get(id);
      if (!r || r.status === 'tombstoned') gone = true;
    }
    if (gone) {
      results.push({ ids: d.ids, applied: false, reason: 'record missing or tombstoned' });
      skipped++;
      continue;
    }
    try {
      const out = await service.curateApply({ batchId: parsed.batchId, decisions: [d] });
      const one = out.applied[0];
      if (one && one.applied) {
        results.push({ ids: d.ids, applied: true });
        applied++;
        decided.add(key);
      } else {
        // service 侧幂等命中（如败者已 superseded 且带 tag）
        results.push({ ids: d.ids, applied: false, reason: 'idempotent (already applied)' });
        skipped++;
      }
    } catch (cause) {
      // 落盘失败：不谎报成功，报告已完成条数与失败的 pair
      throw Object.assign(
        new Error(
          `curate apply 中断：已完成 ${applied} 条、skipped ${skipped} 条，` +
            `失败的 pair [${d.ids.join(', ')}]: ${cause.message}`,
        ),
        { code: cause.code ?? 'E_UNKNOWN', partial: results },
      );
    }
  }
  return { batchId: parsed.batchId, applied, skipped, results };
}

/**
 * `memo curate status`：列出 curate/ 下全部批次与进度。
 * 「已裁决」= 事件流 curate_apply 按裁决键聚合后命中该 pair（docs/02 附录 B）。
 */
export async function curateStatus(service) {
  const dir = join(service.memoHome, 'curate');
  const batches = [];
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      let pkg;
      try {
        pkg = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      } catch {
        continue; // 坏文件跳过（status 只读不修）
      }
      if (!pkg || typeof pkg.batchId !== 'string' || !Array.isArray(pkg.pairs)) continue;
      batches.push(pkg);
    }
  }
  batches.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const decided = await decidedKeys(service);
  const rows = batches.map((pkg) => {
    const keys = pkg.pairs.map((p) => pairKeyOf(p.ids));
    const done = keys.filter((k) => decided.has(k)).length;
    const total = keys.length;
    const state = done === 0 ? '未开始' : done < total ? '进行中' : '已完成';
    return { batchId: pkg.batchId, total, decided: done, state };
  });
  return { batches: rows.length, rows };
}

// ============================================================================
// 车道 C（issue #34）：memo curate auto —— 参数透传与打印，逻辑只在 maintenance.curateAuto。
// ============================================================================

import { curateAuto as curateAutoOf } from '../api/maintenance.js';

/**
 * `memo curate auto [--limit N] [--dry-run] [--json]` 的入口。
 * 为什么直接调 maintenance.curateAuto(service, …)：service.curateAuto 由 Lead 在
 * 类上补一行委托（车道边界，本文件不改 service.js）；直调承接模块保证两种形态语义同源。
 * JSON 输出字段与 service 返回完全一致（供 Agent 消费）；中文摘要只做可读投影。
 * @param {object} service MemoryService
 * @param {{limit?: number, dryRun?: boolean, json?: boolean}} [opts]
 */
export async function curateAutoCli(service, { limit, dryRun = false, json = false } = {}) {
  const out = await curateAutoOf(service, { limit: limit ?? 20, dryRun });
  if (json) {
    process.stdout.write(`${JSON.stringify(out)}\n`);
    return out;
  }
  const dryNote = out.dryRun ? '（dry-run，未落盘）' : '';
  process.stdout.write(`簇: ${out.clusters}，对: ${out.pairs}，applied: ${out.applied}，skipped: ${out.skipped}${dryNote}\n`);
  for (const d of out.decisions) {
    process.stdout.write(`  ${d.ids[0]} <-> ${d.ids[1]} → ${d.decision}（${d.note}）\n`);
  }
  return out;
}
