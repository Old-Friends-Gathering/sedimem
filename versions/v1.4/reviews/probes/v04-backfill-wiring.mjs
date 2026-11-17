// v0.4 架构审核探针：backfillCli 的参数契约与真实 CLI 接线。
// 真实 CLI（src/cli/memo.js:681）把 parseArgs 的 opts 对象当 argv 数组传给 backfillCli；
// backfillCli 用 for (i<argv.length) 解析，对象没有 length，所有 --flag 静默失效。
import { mkdtemp, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createMemoryService } from '../../src/api/service.js';
import { backfillCli } from '../../src/cli/backfill.js';

const memoHome = await mkdtemp(path.join(tmpdir(), 'sedimem-v04-backfill-'));
const scope = 'repo:probe';
const svc = await createMemoryService({ memoHome, scope });
await svc.write({ text: 'alpha memory', source: { agent: 'probe' } });
await svc.write({ text: 'beta memory', source: { agent: 'probe' } });
await svc.close();

let calls = 0;
const fake = {
  name: 'fake', dim: 2, ready: true,
  async embed(texts) { calls += 1; return texts.map((t) => [1, t.length]); },
};

// 与 memo.js 完全相同的形状：opts 对象（含 --dry-run、--scope），不是 argv 数组。
process.env.MEMO_SCOPE = scope;
const vecPath = path.join(memoHome, 'index', 'repo-probe.vectors.jsonl');
const first = await backfillCli(
  { 'dry-run': true, scope, json: true },
  { memoHome, embedder: fake },
);
const wroteDespiteDryRun = existsSync(vecPath);
const linesAfterFirst = wroteDespiteDryRun
  ? (await readFile(vecPath, 'utf8')).trim().split('\n').filter(Boolean).length : 0;

// 第二次：--scope 也应失效。去掉 env 后 cwd 换到临时目录，解析成 dir:... → 扫不到 repo:probe。
delete process.env.MEMO_SCOPE;
process.chdir(memoHome);
const second = await backfillCli({ scope, json: true }, { memoHome, embedder: fake });

console.log(JSON.stringify({
  first_call_opts: { 'dry-run': true, scope },
  dry_run_still_wrote_vectors: wroteDespiteDryRun,
  vector_lines_after_first: linesAfterFirst,
  first_stats: first,
  embed_http_calls: calls,
  second_call_scope_flag: scope,
  second_stats_scanned: second.scanned,
  second_stats_embedded: second.embedded,
}, null, 2));
