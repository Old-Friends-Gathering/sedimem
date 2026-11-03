// probe 1: IndexPort 可替换性推演 —— 注入一个只实现契约（build/add/remove/search）的假索引
// 契约 docs/02 §3 `InvertedIndex` 导出仅有 build/add/remove/search；docs/03 §2 判定标准：
// 换实现不应要求改 api/service.js / hygiene。
import { createMemoryService } from '../../src/api/service.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'memo-arch1-'));

// 完全符合契约签名的假 IndexPort（足以让 build/add/search 正常工作）
class FakeSqliteLikeIndex {
  constructor({ clock } = {}) { this.clock = clock ?? null; this._docs = new Map(); }
  build(records) { this._docs = new Map(records.map((r) => [r.id, r])); return this; }
  add(record) { this._docs.set(record.id, record); return this; }
  remove(id) { this._docs.delete(id); return this; }
  search(query, { limit = 10, filter } = {}) {
    // 不重要：随便给个词法匹配，返回 [{id, score}]
    const q = String(query ?? '').toLowerCase();
    const out = [];
    for (const [id, r] of this._docs) {
      if (filter && !filter(r)) continue;
      if (String(r.text).toLowerCase().includes(q)) out.push({ id, score: 1 });
    }
    return out.slice(0, limit);
  }
}

const svc = await createMemoryService({
  memoHome: home,
  scope: 'repo:probe',
  index: new FakeSqliteLikeIndex({}),
});

await svc.write({ text: 'server port is 8080', subject: 'monitor.server', predicate: 'port', value: '8080', source: { agent: 'test' } });

// ① search: service.js:265 访问 this.index.size（契约外的隐藏属性）
try {
  const r = await svc.search('server port', {});
  console.log('SEARCH_OK', JSON.stringify(r.items.map((i) => i.record.id)));
} catch (e) {
  console.log('SEARCH_FAIL:', e.constructor.name, e.message);
}

// ② doctor: service.js:440 同样访问 index.size
try {
  const d = await svc.doctor();
  console.log('DOCTOR_OK', JSON.stringify(d));
} catch (e) {
  console.log('DOCTOR_FAIL:', e.constructor.name, e.message);
}

// ③ asOf 路径：service.js:261 直接 new InvertedIndex（绕过注入的 index 端口）
const clock = { now: () => '2026-01-02T00:00:00.000Z', nowMs: () => Date.parse('2026-01-02T00:00:00.000Z') };
const svc2 = await createMemoryService({
  memoHome: home, scope: 'repo:probe', clock,
  index: new FakeSqliteLikeIndex({}),
});
try {
  const r = await svc2.search('server port', { asOf: '2026-01-03T00:00:00.000Z' });
  console.log('ASOF_OK items=', r.items.length);
} catch (e) {
  console.log('ASOF_FAIL:', e.constructor.name, e.message);
}
await svc.close(); await svc2.close();
rmSync(home, { recursive: true, force: true });
