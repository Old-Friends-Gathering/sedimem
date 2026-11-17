// cli/quarantine.js — `memo quarantine list|accept|reject`（B5）
//
// 隔离区只存引用（uri + hash + ≤200 字 quote），accept 只走人工提升（--by 必填）。
// list/reject 不打开 MemoryService；accept 必须打开（走 service.write 的全部门禁）。
import process from 'node:process';
import { UsageError, serviceOpts, loadService, printJson } from './commands/shared.js';
import { createQuarantine } from '../capture/quarantine.js';

function idsOf(opts, positional) {
  const fromPositional = positional.filter((x) => typeof x === 'string' && x !== '');
  const fromIds = typeof opts.ids === 'string' ? opts.ids.split(',').map((s) => s.trim()).filter(Boolean) : [];
  return [...new Set([...fromPositional, ...fromIds])];
}

function clip(text, n = 80) {
  const s = String(text ?? '');
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/**
 * @param {{sub?: string, positional?: string[], opts?: object, json?: boolean}} args
 * @returns {Promise<number>} 退出码
 */
export async function quarantineCli({ sub, positional = [], opts = {}, json = false } = {}) {
  const action = sub ?? 'list';
  const service = await loadService(serviceOpts());
  try {
    const quarantine = createQuarantine({ memoHome: service.memoHome, scope: service.scope });
    if (action === 'list') {
      const rows = quarantine.list({ status: opts.status === true ? undefined : opts.status });
      if (json) printJson({ items: rows });
      else if (rows.length === 0) process.stdout.write('（隔离区为空）\n');
      else {
        for (const r of rows) {
          process.stdout.write(`[${r.status}${r.expired ? ',expired' : ''}] ${r.id} ${r.uri}#${clip(r.hash, 24)}  「${clip(r.quote)}」  (${r.addedBy}, ${r.at})\n`);
        }
      }
      return 0;
    }
    if (action === 'accept' || action === 'reject') {
      const ids = idsOf(opts, positional);
      if (ids.length === 0) throw new UsageError(`memo quarantine ${action} <id...> [--by <人工标识>]`);
      if (action === 'reject') {
        const out = quarantine.reject(ids, { by: typeof opts.by === 'string' ? opts.by : 'user' });
        if (json) printJson(out);
        else process.stdout.write(`已拒绝 ${out.rejected.length} 条\n`);
        return 0;
      }
      const by = typeof opts.by === 'string' ? opts.by : '';
      const out = await quarantine.accept(ids, { service, by });
      if (json) printJson(out);
      else process.stdout.write(`已提升 ${out.accepted.length} 条，跳过 ${out.skipped.length} 条\n`);
      return out.accepted.length > 0 ? 0 : 1;
    }
    throw new UsageError('memo quarantine list|accept|reject [--json]');
  } finally {
    await service.close();
  }
}
