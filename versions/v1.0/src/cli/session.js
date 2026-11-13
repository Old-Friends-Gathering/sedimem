// cli/session.js — memo session 子命令（v0.6 W2，契约：docs/plans/v0.6 §2.3）
// start / checkpoint / status / close / sweep 五个子命令，业务委托 src/session/*，
// 入口层只做参数解析与输出。close 幂等：重复 close 返回 already-closed。
// 零依赖（只用 node 内置）；不改 src/cli/memo.js（W3 再接入口）。

import { readFile } from 'node:fs/promises';
import { systemClock } from '../core/clock.js';
import { PROMOTE_KINDS } from '../session/cli-support.js';

// 兼容旧导出路径：常量本体已迁到 session/cli-support.js（arch 边界：mcp 不依赖 cli）。
export { PROMOTE_KINDS };
import {
  SESSION_PREFIX, isSessionScope,
  startSession, sessionStatus, sweepSessions,
  resolveParentScope, updateSessionRegistry,
} from '../session/lifecycle.js';
import { normalizeCheckpoint, parseDshSummary, writeCheckpoint } from '../session/checkpoint.js';
import { renderHandoff, writeHandoff } from '../session/handoff.js';

const USAGE = `memo session —— 会话临时记忆库（可丢弃、可晋升）

用法:
  memo session start --title <t> [--repo <path>] [--json]        建临时库，返回 scope 与提示
  memo session checkpoint --scope session:<id> (--file <json> | --from-summary <dsh.json>) [--json]
  memo session status --scope session:<id> [--json]
  memo session close --scope session:<id> [--json]               晋升 decision/gotcha → 主库 + 写交接 + 其余 tombstone
  memo session sweep [--older-than 14d] [--json]                 只报告僵尸 session 候选，不删

提示: 临时库 close 时只晋升 decision/gotcha；fact 禁止写入（E_SCRATCH_KIND_FORBIDDEN）。`;


function err(code, msg) {
  const e = new Error(msg);
  e.code = code;
  return e;
}

class UsageError extends Error {
  constructor(msg) {
    super(msg);
    this.code = 'E_USAGE';
  }
}

/** 解析 `--flag value` / `--flag` / 位置参数（与 cli/memo.js 同款简单实现） */
function parseArgs(argv) {
  const positional = [];
  const opts = Object.create(null);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { positional.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { opts[key] = next; i++; }
      else opts[key] = true;
    } else positional.push(a);
  }
  return { positional, opts };
}

/** `14d`/`48h`/`30m`/`10s`/`500ms` → 毫秒；非法抛用法错误 */
function parseDuration(raw, fallback) {
  if (raw === undefined || raw === true) return fallback;
  const m = /^(\d+)(ms|s|m|h|d)$/.exec(String(raw));
  if (!m) throw new UsageError(`--older-than 需形如 14d/48h/30m/10s/500ms，收到: ${raw}`);
  const unitMs = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]];
  return Number(m[1]) * unitMs;
}

function requireScope(opts) {
  const s = opts.scope;
  if (s === undefined || s === true || s === '') {
    throw new UsageError(`需要 --scope session:<id>\n${USAGE}`);
  }
  if (!isSessionScope(s)) {
    throw new UsageError(`--scope 必须形如 ${SESSION_PREFIX}<id>，收到: ${s}`);
  }
  return String(s);
}

async function readJsonFile(file) {
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (e) {
    throw new UsageError(`无法读取 ${file}: ${e.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new UsageError(`${file} 不是合法 JSON: ${e.message}`);
  }
}

/**
 * session CLI 入口。
 * @param {string[]} args 子命令与参数（如 ['start','--title','x']）
 * @param {{service: object, memoHome: string, clock?: object, out?: {write: Function}}} deps
 *   service：主库服务（晋升目标）；memoHome：记忆库根；out：输出端口（缺省 process.stdout）。
 * @returns {Promise<object>} 结构化结果（供测试与 --json 复用）
 */
export async function sessionCli(args, { service, memoHome, clock = systemClock, out } = {}) {
  if (!service) throw err('E_INVALID_ARG', 'sessionCli: service is required');
  if (!memoHome) throw err('E_INVALID_ARG', 'sessionCli: memoHome is required');
  // out 既接受 Node 的 stream（有 .write），也接受简单函数（便于测试注入）
  const writeOut = typeof out === 'function' ? out : (out?.write ? (s) => out.write(s) : (s) => process.stdout.write(s));
  const [sub, ...rest] = Array.isArray(args) ? args : [];
  const { opts } = parseArgs(rest);
  const asJson = opts.json === true;

  const emit = (human, payload) => {
    if (asJson) writeOut(JSON.stringify(payload) + '\n');
    else writeOut(human);
    return payload;
  };

  // 现开一个绑定指定 session scope 的服务（主 service 保持绑定主库）
  const openScoped = async (scope) => {
    const { createMemoryService } = await import('../api/service.js');
    return createMemoryService({ memoHome, scope, clock });
  };
  // startSession 的依赖注入形状是 ({memoHome, scope, clock}) → 服务；这里适配到 openScoped
  const sessionServiceFactory = async ({ memoHome: mh, scope, clock: ck }) => {
    const { createMemoryService } = await import('../api/service.js');
    return createMemoryService({ memoHome: mh, scope, clock: ck });
  };

  switch (sub) {
    case 'start': {
      if (opts.title === undefined || opts.title === true || opts.title === '') {
        throw new UsageError(`需要 --title <t>\n${USAGE}`);
      }
      const title = String(opts.title);
      const repo = opts.repo === true || opts.repo === undefined ? undefined : String(opts.repo);
      const { scope, meta } = await startSession({
        service, title, repo, clock, serviceFactory: sessionServiceFactory,
      });
      return emit(
        `session 已创建: ${scope}\n` +
          `这是临时库：close 时只晋升 decision/gotcha 到主库，其余记录会被 tombstone。\n` +
          `请把它设为当前写库（如 MEMO_SCOPE=${scope}）。\n`,
        { scope, meta },
      );
    }

    case 'checkpoint': {
      const scope = requireScope(opts);
      let checkpoint;
      let compactionId;
      if (opts.file !== undefined && opts.file !== true) {
        checkpoint = normalizeCheckpoint(await readJsonFile(String(opts.file)));
      } else if (opts['from-summary'] !== undefined && opts['from-summary'] !== true) {
        const parsed = parseDshSummary(await readJsonFile(String(opts['from-summary'])));
        checkpoint = parsed.checkpoint;
        compactionId = parsed.dsh.compactionId ?? undefined;
      } else {
        throw new UsageError(`需要 --file <8段json> 或 --from-summary <dsh compaction/summary json>\n${USAGE}`);
      }
      const svc = await openScoped(scope);
      let result;
      try {
        result = await writeCheckpoint({ service: svc, scope, checkpoint, compactionId, clock });
      } finally {
        await svc.close();
      }
      return emit(
        `checkpoint 已追加 (${result.record.id} @ ${result.record.createdAt})\n`,
        { action: result.action, recordId: result.record.id, checkpoint: result.checkpoint },
      );
    }

    case 'status': {
      const scope = requireScope(opts);
      const svc = await openScoped(scope);
      let status;
      try {
        status = sessionStatus({ service: svc });
      } finally {
        await svc.close();
      }
      return emit(
        `session ${status.sessionId}  status=${status.status}\n` +
          `checkpoints=${status.checkpoints}  facts=${status.facts}  ` +
          `lastCheckpointAt=${status.lastCheckpointAt ?? '无'}\n`,
        status,
      );
    }

    case 'close': {
      const scope = requireScope(opts);
      const sessionId = scope.slice(SESSION_PREFIX.length);
      const svc = await openScoped(scope);
      // 双 service 模型（v0.6 修复）：入口 service 可能因 MEMO_SCOPE 被切到 session 库，
      // 晋升目标以 meta.parentScope（start 时记录的主库 scope）为准，现开主库服务写。
      let main;
      try {
        const status = sessionStatus({ service: svc });
        // 幂等：meta 已是 closed → 直接返回 already-closed，不再晋升/落盘
        if (status.meta && status.meta.status === 'closed') {
          return emit(`session ${sessionId} 已关闭（幂等，无动作）\n`,
            { scope, alreadyClosed: true, status });
        }
        // 晋升目标以登记文件（sessions/<id>.json，start 时写、记忆流之外）为准，缺失才回落 meta
        //（回落时只接受非 session 型且匹配 SCOPE_PATTERN 的 parentScope，对抗 B-02 重定向）
        const { parentScope, source } = resolveParentScope(memoHome, scope, status.meta);
        if (!parentScope) {
          throw err('E_INVALID_ARG',
            `session ${sessionId} 缺少有效的 parentScope（主库 scope，来源=${source}），无法安全晋升；` +
              `请用 start 重开 session 或手动迁移记录。`);
        }
        main = service.scope === parentScope ? service
          : await (await import('../api/service.js'))
            .createMemoryService({ memoHome, scope: parentScope, clock });

        const records = [...svc._records.values()].filter((r) => r.status === 'active');

        // ① 白名单 kind 晋升主库（tags 加 from-session:<id>）
        const promoted = [];
        for (const r of records) {
          // meta/checkpoint 是会话自身骨架，不晋升（checkpoint 内容走 handoff 文档/state）
          if (r.subject === 'session' && (r.predicate === 'meta' || r.predicate === 'checkpoint')) continue;
          if (!PROMOTE_KINDS.has(r.kind)) continue;
          const tags = Array.isArray(r.tags) ? [...r.tags] : [];
          const tag = `from-session:${sessionId}`;
          if (!tags.includes(tag)) tags.push(tag);
          const w = await main.write({
            text: r.text,
            ...(typeof r.title === 'string' && r.title !== '' ? { title: r.title } : {}),
            kind: r.kind,
            subject: r.subject,
            predicate: r.predicate,
            value: r.value,
            confidence: r.confidence,
            tags,
            privacy: r.privacy,
            source: { agent: r.source?.agent ?? 'cli' },
          });
          promoted.push({ kind: r.kind, id: w.record.id, title: r.title, text: r.text });
        }

        // 取最后一个 checkpoint（createdAt 最大）做交接底稿
        const lastCpRecord = records
          .filter((r) => r.subject === 'session' && r.predicate === 'checkpoint')
          .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))[0];
        let checkpoint = null;
        if (lastCpRecord) {
          try {
            const v = JSON.parse(lastCpRecord.value);
            checkpoint = normalizeCheckpoint(v);
          } catch { /* 坏 checkpoint 不阻断 close，只是交接缺底稿 */ }
        }

        // ② nextSteps 写成主库一条 handoff state（§2.5）
        if (checkpoint && Array.isArray(checkpoint.nextSteps) && checkpoint.nextSteps.length > 0) {
          await main.write({
            text: `session ${sessionId} handoff: ${checkpoint.nextSteps.join('；')}`,
            kind: 'state',
            subject: 'session',
            predicate: 'handoff',
            value: JSON.stringify({ sessionId, nextSteps: checkpoint.nextSteps }),
            tags: [`from-session:${sessionId}`],
            source: { agent: 'cli' },
          });
        }

        // ③ 写交接文档 <memoHome>/handoffs/<id>.md
        const meta = status.meta ?? { id: sessionId };
        const markdown = renderHandoff({ sessionId, meta, checkpoint, promoted, pending: [] });
        const handoffPath = writeHandoff({ memoHome, sessionId, markdown });

        // ④ meta 置 closed（同 slot 新值 → write 门禁走 supersede；内部旁路写 meta），其余记录 tombstone
        const closedMeta = { ...meta, status: 'closed', closedAt: clock.now() };
        await svc.write({
          text: `session ${sessionId} 关闭`,
          kind: 'state',
          subject: 'session',
          predicate: 'meta',
          value: JSON.stringify(closedMeta),
          source: { agent: 'cli' },
          _sessionInternal: true, // lifecycle 内部写 meta 旁路（E_SESSION_META_PROTECTED 不拦）
        });
        // 登记文件同步置 closed（close/status 的状态真相源；B-03：此后该 scope 写入被拒）
        updateSessionRegistry(memoHome, scope, { status: 'closed', closedAt: closedMeta.closedAt });
        let forgotten = 0;
        for (const r of svc._records.values()) {
          if (r.status !== 'active') continue;
          if (r.subject === 'session' && r.predicate === 'meta') continue; // 保留 closed meta
          await svc.forget({ id: r.id, reason: 'session-closed' });
          forgotten++;
        }

        return emit(
          `session ${sessionId} 已关闭：晋升 ${promoted.length} 条到主库，` +
            `tombstone ${forgotten} 条；交接文档 ${handoffPath}\n`,
          { scope, alreadyClosed: false, promoted, forgotten, handoffPath, checkpoint },
        );
      } finally {
        // main 是 close 内现开的主库服务时要关；沿用入口 service 时不关（归调用方）
        if (main && main !== service) await main.close().catch(() => {});
        await svc.close();
      }
    }

    case 'sweep': {
      const olderThanMs = parseDuration(opts['older-than'], 14 * 86_400_000);
      const result = sweepSessions({ service, memoHome, olderThanMs, clock });
      if (asJson) return emit('', result);
      const head = `扫描 ${result.scanned} 个 session scope，` +
        `超过阈值候选 ${result.candidates.length} 个（只报告，不删）\n`;
      const body = result.candidates.map(
        (c) => `  ${c.scope}  开始于 ${c.startedAt}（${Math.floor(c.ageMs / 86_400_000)} 天前）  ${c.title}\n`,
      ).join('');
      return emit(head + body, result);
    }

    default:
      throw new UsageError(`未知的 session 子命令: ${sub ?? '(空)'}\n${USAGE}`);
  }
}
