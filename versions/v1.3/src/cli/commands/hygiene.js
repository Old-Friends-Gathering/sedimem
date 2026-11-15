/**
 * memo CLI —— 「卫生」命令 handler（从 src/cli/memo.js 原样搬出，行为零变化）。
 * dedupe / curate / retitle
 */
import process from 'node:process';
import {
  UsageError, requireOpt, serviceOpts, loadService, printJson, parseNumber,
} from './shared.js';

/** memo dedupe scan / apply（任务 B，裁决 22/23）。
 *  scan 只读：走 service.dedupeScan；apply 走 service.curateApply（非破坏落盘）。 */
export async function cmdDedupe(sub, opts, asJson, USAGE) {
  if (sub !== 'scan' && sub !== 'apply') {
    throw new UsageError(`未知的 dedupe 子命令: ${sub ?? '(空)'}\n${USAGE}`);
  }
  const service = await loadService(serviceOpts());
  try {
    if (sub === 'scan') {
      const threshold = parseNumber(opts, 'threshold');
      if (threshold !== undefined && (threshold < 0 || threshold > 1)) {
        throw new UsageError(`--threshold 需在 [0,1] 内，收到: ${threshold}`);
      }
      if (typeof service.dedupeScan !== 'function') {
        const e = new Error('E_MISSING_DEDUPE_SCAN: MemoryService 尚未提供 dedupeScan（src/api/service.js 同事并行实现中）');
        e.code = 'E_MISSING_DEDUPE_SCAN';
        throw e;
      }
      const diceThreshold = parseNumber(opts, 'dice');
      if (diceThreshold !== undefined && (diceThreshold < 0 || diceThreshold > 1)) {
        throw new UsageError('--dice 需在 [0,1] 内');
      }
      const result = await service.dedupeScan({ threshold, diceThreshold, limit: parseNumber(opts, 'limit') });
      if (asJson) {
        printJson(result);
      } else if (result.clusters.length === 0) {
        process.stdout.write(`scanned=${result.scanned} threshold=${result.threshold}，无候选簇\n`);
      } else {
        process.stdout.write(`候选簇 ${result.clusters.length} 个（scanned=${result.scanned} threshold=${result.threshold} dice=${result.diceThreshold}）\n`);
        for (const c of result.clusters) {
          process.stdout.write(
            `\n#${c.key}  size=${c.size}  maxSimilarity=${c.maxSimilarity.toFixed(3)}  basis=${c.basis}\n`,
          );
          for (const i of c.items) {
            process.stdout.write(`  ${i.id}  [${i.kind}/${i.status}]  ${i.text}\n`);
          }
          if (Array.isArray(c.pairs) && c.pairs.length > 0) {
            process.stdout.write('  pairs:\n');
            for (const p of c.pairs) {
              process.stdout.write(
                `    ${p.strength} ${p.basis} score=${p.score} (c=${p.containment} d=${p.dice})  ${p.aId} <-> ${p.bId}\n`,
              );
            }
          }
        }
      }
      return;
    }
    // dedupe apply --file decisions.json
    const file = requireOpt(opts, 'file', 'memo dedupe apply --file decisions.json');
    const { readFile } = await import('node:fs/promises');
    let parsed;
    try {
      parsed = JSON.parse(await readFile(file, 'utf8'));
    } catch (err) {
      throw new UsageError(`--file 不是合法 JSON (${file}): ${err.message}`);
    }
    const batchId = parsed && typeof parsed === 'object' && typeof parsed.batchId === 'string' ? parsed.batchId : undefined;
    const idShaped = Array.isArray(parsed.decisions) && parsed.decisions.some((d) => d && Array.isArray(d.ids));
    if (!batchId && !idShaped) {
      throw new UsageError(
        '--file 内容需含字符串 batchId（pairIndex 形状裁决），或 decisions 内使用 {ids:[...], decision} 形状（dedupe 簇 id 直接裁决，无需 batchId）'
      );
    }
    if (!Array.isArray(parsed.decisions)) throw new UsageError('--file 内容需含 decisions 数组 [{ids|pairIndex, decision, note}]');
    const result = await service.curateApply({ batchId, decisions: parsed.decisions });
    printJson(result);
  } finally {
    await service.close();
  }
}

/** memo curate（B 路，docs/02 附录 B）：prompt/status 为新增；apply 兼容两个形状——
 *  旧：`curate apply <batchId> --decisions <file|->`；新：`curate apply --file <pkg.json>`。 */
export async function cmdCurate(sub, positional, opts, asJson, USAGE) {
  // 新增子命令走 src/cli/curate.js（任务包生成/状态/严格校验应用）
  if (sub === 'auto') {
    const curate = await import('../curate.js');
    const service = await loadService(serviceOpts());
    try {
      await curate.curateAutoCli(service, {
        limit: parseNumber(opts, 'limit'), dryRun: opts['dry-run'] === true, json: asJson,
      });
    } finally {
      await service.close();
    }
    return;
  }
  if (sub === 'prompt' || sub === 'status' || (sub === 'apply' && opts.file !== undefined)) {
    const curate = await import('../curate.js');
    const service = await loadService(serviceOpts());
    try {
      if (sub === 'prompt') {
        const out = await curate.curatePrompt(service, {
          limit: parseNumber(opts, 'limit'), json: asJson,
        });
        if (asJson) printJson(out);
        return;
      }
      if (sub === 'status') {
        const out = await curate.curateStatus(service);
        if (asJson) {
          printJson(out);
          return;
        }
        if (out.batches === 0) {
          process.stdout.write('待处理批次: 0\n');
          return;
        }
        process.stdout.write(`待处理批次: ${out.batches}\n`);
        for (const r of out.rows) {
          process.stdout.write(`  ${r.batchId}  ${r.total} 对 / 已裁决 ${r.decided}  → ${r.state}\n`);
        }
        return;
      }
      // curate apply --file <pkg.json>
      const file = requireOpt(opts, 'file', 'memo curate apply --file <任务包.json>');
      const result = await curate.curateApplyFile(service, file);
      printJson(result);
      return;
    } finally {
      await service.close();
    }
  }
  const service = await loadService(serviceOpts());
  try {
    if (sub === 'export') {
      const batch = await service.curateExport({ limit: parseNumber(opts, 'limit') });
      if (!batch) {
        process.stdout.write('无待裁决候选\n');
        return;
      }
      printJson(batch);
    } else if (sub === 'apply') {
      const batchId = positional[0];
      if (!batchId) throw new UsageError('memo curate apply <batchId> --decisions <file|->');
      const decisionsSrc = requireOpt(opts, 'decisions', `memo curate apply ${batchId} --decisions <file|->`);
      let decisionsText;
      if (decisionsSrc === '-') {
        decisionsText = await new Promise((resolve, reject) => {
          let buf = '';
          process.stdin.setEncoding('utf8');
          process.stdin.on('data', (c) => (buf += c));
          process.stdin.on('end', () => resolve(buf));
          process.stdin.on('error', reject);
        });
      } else {
        const { readFile } = await import('node:fs/promises');
        decisionsText = await readFile(decisionsSrc, 'utf8');
      }
      let decisions;
      try {
        decisions = JSON.parse(decisionsText);
      } catch (err) {
        throw new UsageError(`decisions 不是合法 JSON: ${err.message}`);
      }
      if (!Array.isArray(decisions)) throw new UsageError('decisions 必须是 JSON 数组 [{pairIndex, decision, note}]');
      printJson(await service.curateApply({ batchId, decisions }));
    } else {
      throw new UsageError(`未知的 curate 子命令: ${sub}\n${USAGE}`);
    }
  } finally {
    await service.close();
  }
}

export async function cmdRetitle(opts, asJson) {
  const { retitleRecords } = await import('../../api/retitle.js');
  const service = await loadService(serviceOpts());
  try {
    const dryRun = opts['dry-run'] === true;
    const limit = opts.limit === undefined || opts.limit === true ? 0 : Number(opts.limit);
    // --from-file：Agent 批量产出 [{id,title}] 后一次性写入（LLM 给的标题比纯规则更像人话）
    if (opts['from-file'] !== undefined && opts['from-file'] !== true) {
      const fsp = await import('node:fs/promises');
      const raw = await fsp.readFile(String(opts['from-file']), 'utf8');
      const list = JSON.parse(raw);
      if (!Array.isArray(list)) throw new UsageError('--from-file 需要 JSON 数组：[{id,title}]');
      const { applyTitles } = await import('../../api/retitle.js');
      const r = await applyTitles(service, list, { dryRun });
      if (asJson) printJson(r);
      else process.stdout.write(`retitle(from-file): changed=${r.changed} skipped=${r.skipped} failed=${r.failed.length}${dryRun ? ' (dry-run)' : ''}\n`);
      return 0;
    }
    const r = await retitleRecords(service, { dryRun, limit });
    if (asJson) printJson(r);
    else {
      const tag = dryRun ? ' (dry-run)' : '';
      process.stdout.write(`retitle: 候选 ${r.total} 条，已补 ${r.changed} 条${r.failed?.length ? `，失败 ${r.failed.length}` : ''}${tag}\n`);
      for (const s of r.samples ?? []) process.stdout.write(`  · ${s.title}\n`);
    }
  } finally {
    await service.close();
  }
  return 0;
}
