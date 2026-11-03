// tests/injection/i16-index-parity.test.js — I16：SQLite FTS5 索引与内存索引一致性
// 契约：docs/09-sqlite-index.md §7 注入用例（G1/G2/G3）：
//   G1 同一批记录两个后端 build 后检索语义一致（top-3 集合相等，同分并列允许顺序不同）；
//   G2 sqlite 库删掉后重建（memo reindex 场景），size 等于真相层记录数；
//   G3 index.backend=sqlite 时 $MEMO_HOME/index/<scopeKey>.sqlite 真实存在且检索走 SQLite。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

import { createMemoryService } from '../../src/api/service.js';
import { InvertedIndex } from '../../src/index/inverted-index.js';
import { SqliteIndex } from '../../src/index/sqlite-index.js';
import { createIndex } from '../../src/index/create-index.js';
import { scopeKeyOf } from '../../src/config/paths.js';

const require = createRequire(import.meta.url);

// 12 条中英混合记录：覆盖中文短语、英文术语、中英混合、subject/predicate 命中
const RECORDS = [
  { text: '数据库连接池上限是 20', subject: 'db.pool', predicate: 'limit', value: '20' },
  { text: '数据库连接池最大 20 个连接', subject: 'db.pool', predicate: 'max', value: '20' },
  { text: 'deploy script lives in scripts/deploy.sh', subject: 'ci.deploy', predicate: 'path', value: 'scripts/deploy.sh' },
  { text: 'release script located at scripts/deploy.sh', subject: 'ci.release', predicate: 'path', value: 'scripts/deploy.sh' },
  { text: '缓存命中率低于 60% 要报警', subject: 'cache.alert', predicate: 'threshold', value: '0.6' },
  { text: 'cache hit rate below 60 percent triggers an alert', subject: 'cache.alert', predicate: 'rule', value: '0.6' },
  { text: '日志按天切割并保留 14 天', subject: 'ops.log', predicate: 'retention', value: '14d' },
  { text: 'logs rotate daily with 14 days retention', subject: 'ops.log', predicate: 'rotation', value: 'daily' },
  { text: '压测目标 QPS 定在 500', subject: 'perf.load', predicate: 'qps', value: '500' },
  { text: 'load test target QPS is 500', subject: 'perf.load', predicate: 'target', value: '500' },
  { text: '发布窗口限定工作日晚上', subject: 'ops.release', predicate: 'window', value: 'weekday-night' },
  { text: '发版只能在工作日夜间进行', subject: 'ops.release', predicate: 'restriction', value: 'night-only' },
];

// 8 条查询：中文、英文、中英混合、subject 词、无命中
const QUERIES = [
  '数据库 连接池',
  'database connection pool',
  'deploy script',
  '缓存命中率 报警',
  'cache alert',
  '日志 保留 14 天',
  'QPS 500 压测',
  'does-not-exist-token',
];

test('I16 SQLite FTS5 索引与内存索引：检索一致 + 删库重建 + sqlite 后端落盘', async () => {
  process.env.MEMO_QUIET = '1'; // 静默实验特性提示，避免污染测试输出
  const memoHome = mkdtempSync(join(tmpdir(), 'memo-i16-'));
  const scope = 'repo:eval-i16';
  const sqliteMod = require('node:sqlite');

  let svc;
  try {
    // G3：index.backend=sqlite 时 createIndex 返回 SqliteIndex，service 检索走它
    const backend = createIndex({ policy: { index: { backend: 'sqlite' } }, memoHome, scope });
    assert.ok(backend instanceof SqliteIndex, 'backend=sqlite 必须返回 SqliteIndex（fail-loud，不允许静默降级）');
    svc = await createMemoryService({ memoHome, scope, index: backend });

    // 写入 12 条（write 需要 source.agent）
    for (const r of RECORDS) {
      const res = await svc.write({ ...r, source: { agent: 'qa-i16' } });
      assert.ok(res, `写入必须成功：${r.text}`);
    }
    assert.equal((await svc.stats()).total, 12, '真相层应有 12 条');

    // G3：$MEMO_HOME/index/<scopeKey>.sqlite 真实存在
    const dbPath = join(memoHome, 'index', `${scopeKeyOf(scope)}.sqlite`);
    assert.ok(existsSync(dbPath), `sqlite 后端必须落盘 ${dbPath}`);
    // 且 service 检索走的确实是该后端（在库里能搜到刚写的记录）
    const svcHits = await svc.search('数据库 连接池', { limit: 5 });
    assert.ok(svcHits.items.length >= 2, `service 检索应命中连接池两条，实际 ${svcHits.items.length}`);

    // G1：两个后端对同一批记录分别 build，8 条查询 top-3 集合相等
    const records = (await svc.exportRecords({ status: 'all', limit: 100 })).records;
    assert.equal(records.length, 12, `导出应为 12 条，实际 ${records.length}`);

    const mem = new InvertedIndex();
    mem.build(records);
    const sql = new SqliteIndex({ memoHome, scope: 'repo:eval-i16-parity', sqlite: sqliteMod });
    sql.build(records);
    try {
      assert.equal(mem.size, 12);
      assert.equal(sql.size, 12);
      for (const q of QUERIES) {
        const top3Of = (idx) => new Set(idx.search(q, { limit: 3 }).map((h) => h.id));
        const a = top3Of(mem);
        const b = top3Of(sql);
        assert.deepEqual(
          [...a].sort(),
          [...b].sort(),
          `查询「${q}」top-3 集合不一致：memory=${[...a]} sqlite=${[...b]}`,
        );
      }
    } finally {
      sql.close();
    }

    // G2：memo reindex 场景——sqlite 库删掉后（等价于索引目录被清），
    // 重新打开 + reindex，size 必须等于真相层记录数（索引是派生层，可随时重建）
    await svc.close();
    backend.close();
    for (const suffix of ['', '-wal', '-shm']) rmSync(dbPath + suffix, { force: true });
    assert.ok(!existsSync(dbPath), '删库后 .sqlite 不应存在');

    const backend2 = createIndex({ policy: { index: { backend: 'sqlite' } }, memoHome, scope });
    const svc2 = await createMemoryService({ memoHome, scope, index: backend2 });
    try {
      assert.equal(backend2.size, 12, '重开服务加载真相层后 sqlite 索引应含 12 条');
      const out = await svc2.reindex();
      assert.equal(out.rebuilt, 12, `memo reindex 应重建 12 条，实际 ${out.rebuilt}`);
      assert.equal(backend2.size, 12, 'reindex 后 size 必须等于真相层记录数');
      // 重建后检索不回归
      const hits = await svc2.search('release script', { limit: 3 });
      assert.ok(hits.items.length >= 2, `重建后英文检索应命中两条，实际 ${hits.items.length}`);
    } finally {
      await svc2.close();
      backend2.close();
    }
  } finally {
    if (svc && !svc._closed) await svc.close().catch(() => {});
    rmSync(memoHome, { recursive: true, force: true });
  }
});
