// web/api/search.js — /api/search 端点（v0.4 D1）：带 basis / degraded 的检索视图（从 web/handlers.js 拆出）。

import { intArg, invalidArg } from './shared.js';

/**
 * /api/search（v0.4 D1）：带 basis / degraded 的检索视图。
 * 语义道未配置或不可用时照常返回结果，但给 degraded=true + 原因，UI 据此提示。
 */
export async function apiSearch(service, query) {
  const q = String(query.get('q') ?? '').trim();
  if (!q) throw invalidArg('search: q (non-empty) is required');
  const limit = intArg(query, 'limit', { min: 1, max: 100, fallback: 30 });
  const result = await service.search(q, { limit, includeDisputed: true });
  return {
    query: q,
    items: result.items.map((it) => ({
      id: it.record.id,
      text: it.record.text,
      kind: it.record.kind,
      score: it.score,
      basis: it.basis ?? 'bm25',
      validFrom: it.record.validFrom ?? it.record.createdAt,
    })),
    total: result.total,
    degraded: result.degraded === true,
    degradedReason: result.degradedReason ?? null,
  };
}
