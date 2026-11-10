// cli/view.js — `memo view` 与 `memo brief --tier0` 的入口（v0.3 / issue #50 #51 #52）
//
// 为什么单独成文件：memo.js 已接近 Q2 的 900 行硬线，而且「视图」是纯派生物：
// 它们只读真相层、只写 $MEMO_HOME/views/，与写入路径零耦合。放在这里能让「读视图」的
// 失败模式（文件缺失/损坏）完全隔离，不影响 write/search 这些主路径。
//
// 三条硬约束（来自 docs/research/layered-memory-2026.md）：
// 1. 视图是派生物：删掉整个 views/ 目录必须能重建出字节相同的结果；
// 2. L3 必须带 sourceRefs（空数组等于假装有出处，直接拒）；
// 3. 预算有上界：一次 apply 的条数 ≤ batchSize，累计调用 ≤ maxCallsPerRun。

import { readFileSync } from 'node:fs';
import { loadPolicy } from '../config/policy.js';
import { buildL2, readL2, writeL2, viewDir, traceRecord } from '../views/l2.js';
import { planL3, validateL3Draft, buildL3Record, traceL3 } from '../views/l3.js';
import { renderTier0 } from '../render/tier0.js';

const L2_FILE = 'L2.jsonl';

/** 块 key 里的 \u0001 是分隔符（避免 subject 含 '/' 时撞键），显示时换成 '/' */
function prettyKey(key) {
  return String(key).replace(/\u0001/g, '/');
}

/** 读真相层全量（含非 active，视图要能反映 superseded 的状态） */
async function allRecords(service) {
  const out = await service.exportRecords({ status: 'all', limit: 1_000_000 });
  return out.records;
}

async function activeRecords(service) {
  const out = await service.exportRecords({ status: 'active', limit: 1_000_000 });
  return out.records;
}

/**
 * `memo view build|rebuild|show|trace`（L2）与 `memo view l3 plan|apply|trace`（L3）
 * @param {string[]} positional ['view', sub, ...]
 */
export async function cmdView(positional, opts, asJson, service, log = console) {
  const sub = positional[0];
  const policy = loadPolicy();
  const memoHome = service.memoHome;
  const scope = service.scope;

  if (sub === 'build' || sub === 'rebuild') {
    const records = await allRecords(service);
    const built = buildL2(records, { scope, policy });
    writeL2(memoHome, scope, built);
    if (asJson) {
      log.log(JSON.stringify({ ok: true, blocks: built.blocks.length, sourceCount: built.sourceCount, dir: viewDir(memoHome, scope) }, null, 2));
    } else {
      log.log(`L2 ${sub === 'rebuild' ? '重建' : '构建'}完成：${built.blocks.length} 块 / ${built.sourceCount} 条 → ${viewDir(memoHome, scope)}`);
    }
    return 0;
  }

  if (sub === 'show') {
    const which = (positional[1] ?? 'L2').toUpperCase();
    if (which !== 'L2') {
      log.error(`memo view show ${which}：v0.3 只实现 L2（L3 用 memo view l3 plan 看候选）`);
      return 2;
    }
    const view = readL2(memoHome, scope);
    if (!view) {
      log.error('没有 L2 视图：先跑 memo view build');
      return 1;
    }
    if (asJson) {
      log.log(JSON.stringify(view, null, 2));
      return 0;
    }
    log.log(`L2：${view.blocks.length} 块 / ${view.sourceCount} 条（builtAt ${view.builtAt ?? '-'}）`);
    for (const b of view.blocks.slice(0, Number(opts.limit ?? 50))) {
      log.log(`  · ${prettyKey(b.key)}  ${b.stats?.count ?? b.recordIds.length} 条  ${b.stats?.firstAt ?? ''}~${b.stats?.lastAt ?? ''}`);
    }
    return 0;
  }

  if (sub === 'trace') {
    const id = positional[1];
    if (!id) {
      log.error('用法：memo view trace <recordId>');
      return 2;
    }
    const records = await allRecords(service);
    const t = traceRecord(memoHome, scope, id, records);
    const rec = records.find((r) => r.id === id);
    const l3 = rec?.sourceRefs ? traceL3(rec, records) : null;
    if (asJson) {
      log.log(JSON.stringify({ l2: t, l3 }, null, 2));
      return 0;
    }
    log.log(`记录 ${id}`);
    if (t.blockId) log.log(`  L2 块：${t.blockId}`);
    else log.log('  L2 块：未归属（先 memo view build）');
    if (l3) {
      log.log(`  L3 出处：${l3.sourceRefs.length} 条（missing ${l3.missing.length} / stale ${l3.stale.length}）`);
      for (const s of l3.stale) log.log(`    · ${s.id} 已 ${s.status}`);
    }
    return 0;
  }

  if (sub !== 'l3') {
    log.error('用法：memo view build|rebuild|show L2|trace <id>|l3 plan|apply');
    return 2;
  }

  // —— L3 ——
  const l3sub = positional[1];
  if (l3sub === 'plan') {
    const [records, active] = [await allRecords(service), await activeRecords(service)];
    const l2 = readL2(memoHome, scope);
    // 陈旧视图会把同主题拆成两组、吃双份预算（架构审核 S5）。判据：sourceCount 与真相层条数不符。
    const stale = Boolean(l2) && l2.sourceCount !== records.length;
    if (stale) log.error(`视图已过期（视图 ${l2.sourceCount} 条 vs 真相层 ${records.length} 条）：先跑 memo view rebuild，本次按无视图分组`);
    const plan = planL3(active, stale ? [] : (l2?.blocks ?? []), { policy, now: Date.now() });
    if (asJson) {
      log.log(JSON.stringify(plan, null, 2));
      return 0;
    }
    log.log(`L3 候选：${plan.candidates.length} 条（已覆盖跳过 ${plan.skipped}，预计 LLM 调用 ${plan.callsEstimate} ≤ ${policy.l3?.maxCallsPerRun ?? 20}）`);
    for (const c of plan.candidates) log.log(`  · ${prettyKey(c.key)}  ← ${c.recordIds.length} 条`);
    if (records.length === 0) log.log('  （真相层为空）');
    return 0;
  }

  if (l3sub === 'apply') {
    const file = opts.file;
    if (!file) {
      log.error('用法：memo view l3 apply --file drafts.json');
      return 2;
    }
    const drafts = JSON.parse(readFileSync(file, 'utf8'));
    const list = Array.isArray(drafts) ? drafts : drafts.drafts;
    const cap = Number(policy.l3?.batchSize ?? 10);
    if (!Array.isArray(list) || list.length === 0) {
      log.error('drafts 必须是非空数组');
      return 2;
    }
    if (list.length > cap) {
      log.error(`一次最多 ${cap} 条（policy.l3.batchSize），收到 ${list.length} 条；请分批`);
      return 2;
    }
    // 出处必须真实存在（对抗审核②实测：凭空编一个 26 位合法 ULID 就能过门禁，
    // 事后只能靠 trace 挖出来——那是侦探，不是门禁）。已失效的来源允许（历史依据），但要点出来。
    const truth = new Map();
    for (const r of await allRecords(service)) truth.set(r.id, r);
    const results = [];
    for (const [i, draft] of list.entries()) {
      const v = validateL3Draft(draft);
      if (!v.ok) {
        results.push({ index: i, ok: false, code: v.code, message: v.message });
        continue;
      }
      const unknown = (draft.sourceRefs ?? []).filter((id) => !truth.has(id));
      if (unknown.length > 0) {
        results.push({ index: i, ok: false, code: 'E_L3_SOURCEREFS_UNKNOWN', message: `出处不存在：${unknown.join(', ')}` });
        continue;
      }
      const stale = (draft.sourceRefs ?? []).filter((id) => truth.get(id)?.status !== 'active');
      try {
        const input = buildL3Record(draft, { now: Date.now(), policy });
        const res = await service.write({ ...input, source: { agent: opts.agent ?? 'cli' } });
        results.push({
          index: i,
          ok: true,
          action: res?.action ?? 'created',
          id: res?.record?.id ?? res?.id ?? null,
          ...(stale.length > 0 ? { staleSourceRefs: stale } : {}),
        });
      } catch (err) {
        // 逐条兜住：一条坏草稿不能让整批中途崩掉，更不能让已落盘的条数无从得知（对抗审核④）
        results.push({ index: i, ok: false, code: err?.code ?? 'E_WRITE_FAILED', message: err?.message ?? String(err) });
      }
    }
    const failed = results.filter((r) => !r.ok).length;
    const truncated = results.filter((r) => r.ok && r.action === 'created').length;
    const noop = results.filter((r) => r.ok && r.action !== 'created').length;
    if (asJson) log.log(JSON.stringify({ created: truncated, unchanged: noop, failed, results }, null, 2));
    else {
      log.log(`L3 落盘：新建 ${truncated} 条，未变（重复/冲突折叠）${noop} 条，失败 ${failed} 条`);
      for (const r of results) if (r.staleSourceRefs) log.error(`  #${r.index} 出处里有已失效记录：${r.staleSourceRefs.join(', ')}`);
    }
    for (const r of results) if (!r.ok) log.error(`  #${r.index} ${r.code}: ${r.message}`);
    return failed === 0 ? 0 : 1;
  }

  log.error('用法：memo view l3 plan|apply --file drafts.json');
  return 2;
}

/** `memo brief --tier0`：一条一行的目录，默认 ≤ policy.brief.tier0Chars 字符 */
export async function cmdBriefTier0(opts, asJson, service, log = console) {
  const policy = loadPolicy();
  const records = await service.exportRecords({ status: 'active', limit: 1_000_000 }).then((r) => r.records);
  const out = renderTier0(records, { policy, now: Date.now() });
  if (asJson) {
    log.log(JSON.stringify(out, null, 2));
    return 0;
  }
  log.log(out.text);
  return 0;
}

export const L2_VIEW_FILE = L2_FILE;
