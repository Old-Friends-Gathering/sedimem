#!/usr/bin/env node
/**
 * memo CLI —— 入口层，只做参数解析与 JSON 编解码，业务全部委托 MemoryService。
 * 命令实现拆分在 src/cli/commands/（shared/memory/hygiene/ops），本文件保留 USAGE、parseArgs、main 分发与退出码。
 * 契约：docs/02-data-model-and-contract.md §3 `src/cli/memo.js`
 * 退出码：0 成功 / 1 业务失败 / 2 用法错误
 */
import process from 'node:process';
import { UsageError, parseArgs, setCurrentOpts, serviceOpts, loadService, resolveMemoHome } from './commands/shared.js';
import { cmdWrite, cmdSearch, cmdBrief, cmdGet, cmdSupersede, cmdForget, withStats, cmdScope, cmdDoctor } from './commands/memory.js';
import { cmdDedupe, cmdCurate, cmdRetitle } from './commands/hygiene.js';
import { cmdServe, cmdMigrate, cmdConflicts, cmdBackfillVectors } from './commands/ops.js';
import { cmdView, cmdBriefTier0 } from './view.js';

const USAGE = `memo —— 本地跨会话记忆系统 v0.1

用法:
  memo write --text "..." [--title "一句话标题"] [--kind fact] [--subject s] [--predicate p] [--agent dsh] [--value v] [--confidence 0.8] [--tags a,b] [--privacy private|shared] [--json]
  memo search "..." [--limit 10] [--kind fact] [--as-of ISO] [--json]
  memo brief [--lines 80] [--tier0]              # --tier0：一条一行的目录（≤800 字符，v0.3）
  memo view build|rebuild                        # 重建 L2 场景块视图（纯派生，可删可重建）
  memo view show L2 [--limit 50] [--json]
  memo view trace <recordId> [--json]            # 这条记录属哪个 L2 块 / 它是哪几条的派生（L3 溯源）
  memo view l3 plan [--json]                     # L3 候选（预算上限来自 policy.l3）
  memo view l3 apply --file drafts.json          # 写入 L3（必须带 sourceRefs，一次 ≤ batchSize）
  memo get <id>
  memo supersede <id> --value "..." [--text "..."] [--agent dsh] [--json]
  memo forget <id> [--purge] [--reason "..."] [--json]
  memo stats [--json]
  memo scope [--json]                                         # 看本目录解析出的分库（以及 MCP 侧覆盖文件）
  memo doctor [--json]
  memo reindex
  memo curate export [--limit 20]
  memo curate prompt  [--limit N] [--json]              # 生成裁决任务包（docs/02 附录 B）
  memo curate auto    [--limit N] [--dry-run] [--json]   # 自动裁决（JudgePort，确定性无 LLM；裁决 50）
  memo compact        [--dry-run] [--grace 7d] [--json]  # 物理清理：只删 purge+过期的墓碑（裁决 51）
  memo curate status                                  # 列出批次与进度
  memo curate apply   --file <任务包.json>              # 应用裁决（严格校验）
  memo curate apply <batchId> --decisions <file|->
  memo dedupe scan [--threshold 0.45] [--dice 0.15] [--limit 50] [--json]   # 只读：近重复候选簇（裁决 22/23/26）
  memo dedupe apply --file decisions.json                     # decisions.json: {batchId?, decisions:[{ids:[...]|pairIndex, decision, note}]}
  memo session start --title "..." [--repo <path>]              # 建临时会话库 session:<id>（v0.6）
  memo session checkpoint [--scope s] [--file ck.json] [--from-summary sum.json]
  memo session status [--scope s] [--json]
  memo session close [--scope s]                                # 晋升 decision/gotcha + 交接文档 + 其余墓碑
  memo session sweep [--older-than 14d] [--json]                # 只报告僵尸会话，不删
  memo session list [--json]                                     # 任务库清单（标题/记录数/状态/时间/scope）
  memo session rename --scope session:<id> --title <t> [--json]  # 任务库改名（1..80 字符）
  memo session remove --scope session:<id> [--yes] [--json]     # 删任务库→trash/（无 --yes 仅预览，退出码 2）
  memo migrate dsh-memory [--db path]
  memo serve [--port N] [--no-ui]                             # 只读 Web UI/API（默认 127.0.0.1:7788；--no-ui 只提供 API）

环境:
  MEMO_HOME   记忆库根目录（默认 ~/.memo）
  MEMO_SCOPE  强制指定 scope（默认按 cwd 推导 repo:x / dir:y）

退出码: 0 成功 / 1 业务失败 / 2 用法错误`;

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
    process.stdout.write(USAGE + '\n');
    return 0;
  }
  const command = argv[0];
  const { positional, opts } = parseArgs(argv.slice(1));
  setCurrentOpts(opts); // 让 loadService() 能读到 --scope（0.6.2）
  const asJson = Boolean(opts.json);

  switch (command) {
    case 'write':
      await cmdWrite(opts, asJson);
      return 0;
    case 'search':
      await cmdSearch(positional, opts, asJson);
      return 0;
    case 'brief': {
      if (opts.tier0) {
        const service = await loadService(serviceOpts());
        try { await cmdBriefTier0(opts, asJson, service); } finally { await service.close(); }
        return 0;
      }
      await cmdBrief(opts);
      return 0;
    }
    case 'view': {
      const service = await loadService(serviceOpts());
      try { return await cmdView(positional, opts, asJson, service); } finally { await service.close(); }
    }
    case 'get':
      await cmdGet(positional);
      return 0;
    case 'supersede':
      await cmdSupersede(positional, opts, asJson);
      return 0;
    case 'forget':
      await cmdForget(positional, opts, asJson);
      return 0;
    case 'stats':
      await withStats(asJson, (s) => s.stats());
      return 0;
    case 'scope':
      return await cmdScope(asJson);
    case 'doctor':
      return await cmdDoctor(asJson);
    case 'reindex':
      await withStats(asJson, (s) => s.reindex());
      return 0;
    case 'curate':
      await cmdCurate(positional[0], positional.slice(1), opts, asJson, USAGE);
      return 0;
    case 'dedupe':
      await cmdDedupe(positional[0], opts, asJson, USAGE);
      return 0;
    case 'compact': {
      const { compactCli } = await import('./compact.js');
      const service = await loadService(serviceOpts());
      try {
        // grace 不写死 7d：交给 policy.quota.purgeGraceMs（契约裁决 51），CLI 只透传用户显式值
        await compactCli(service, { dryRun: opts['dry-run'] === true, grace: opts.grace, json: asJson });
      } finally {
        await service.close();
      }
      return 0;
    }
    case 'derive': {
      const { deriveCli } = await import('./derive.js');
      const service = await loadService(serviceOpts());
      try {
        return await deriveCli(service, { drain: opts.drain === true, rebuild: opts.rebuild === true, limit: opts.limit, json: asJson });
      } finally {
        await service.close();
      }
    }
    case 'llm': {
      const { llmCli } = await import('./commands/ops.js');
      const service = await loadService(serviceOpts());
      try {
        return await llmCli(service, { action: positional[0] ?? 'status', json: asJson });
      } finally {
        await service.close();
      }
    }
    case 'retitle':
      return await cmdRetitle(opts, asJson);
    case 'backfill-vectors':
      return await cmdBackfillVectors(opts, asJson);
    case 'conflicts':
      return await cmdConflicts(positional, opts, asJson);
    case 'session': {
      const { sessionCli } = await import('./session.js');
      const service = await loadService(serviceOpts());
      try {
        // sessionCli 自己解析 argv（与 --scope/--file 等混排更稳），这里把原始参数整段交出去
        const res = await sessionCli(argv.slice(1), {
          service,
          memoHome: resolveMemoHome(),
          clock: service.clock,
          json: asJson,
          out: (line) => process.stdout.write(`${line}\n`),
        });
        return typeof res === 'number' ? res : 0;
      } finally {
        await service.close();
      }
    }
    case 'capture': {
      const { captureCli } = await import('./capture.js');
      return await captureCli({ sub: positional[0], file: opts.file, scope: opts.scope, json: asJson, ids: opts.ids, all: opts.all === true, note: opts.note });
    }
    case 'import': {
      const { cmdImport } = await import('./import.js');
      return await cmdImport(opts, positional, asJson);
    }
    case 'migrate':
      await cmdMigrate(positional, opts, USAGE);
      return 0;
    case 'serve':
      return await cmdServe(opts);
    default:
      throw new UsageError(`未知命令: ${command}\n${USAGE}`);
  }
}

try {
  // 命令实现里有的分支会 return 出结构化结果（如 capture/conflicts 的 payload），
  // 那不是退出码——只接受整数，否则保持 0（否则 process.exitCode = {} 会抛
  // ERR_INVALID_ARG_TYPE，用户看到「memo 失败」但其实命令已经成功）。
  const code = await main();
  process.exitCode = Number.isInteger(code) ? code : 0;
} catch (err) {
  if (err instanceof UsageError) {
    process.stderr.write(`用法错误: ${err.message}\n`);
    process.exitCode = 2;
  } else {
    process.stderr.write(
      `memo 失败 [${err.code ?? 'E_UNKNOWN'}]: ${err && err.message ? err.message : err}\n`
    );
    process.exitCode = 1;
  }
}
