// session/auto-capture.js — 任务账本自动捕获（v1.4.x，issue #223）
//
// 设计（docs/06 §22.1）：v1.2 的账本捕获只有 CLI 手动入口，`captureOnClose`/`autoWatch`
// 在 policy 里声明了但从未实现，任务库长期使用时账本停在最后一次手动捕获。
// 本模块补两条自动路径：
//   1) MCP 挂车捕获：tools/call 分发完成后（session scope + 候选工具），检查绑定转录是否
//      增长；守卫链全部 stat 级（不解压 zstd、零 token），达阈值才 captureTask（rules 模式）。
//   2) close 捕获：memory_session_close 成功后 force 一次（兑现 captureOnClose）。
// fail-closed：任何失败只返回 {ran:false, reason}，绝不影响主工具调用。
// 运行状态 $MEMO_HOME/sessions/<taskId>/autocapture.json：可删（删了重新积累守卫基线）。
//
// 硬规则：
//   - 自动捕获一律 rules 模式（确定性零 token；LLM 模式只留给显式手动捕获）。
//   - captureTask 自带幂等（covered 去重）与账本锁（防重叠），这里不重复加锁。
//   - 非注入路径不产生任何记忆写入：本模块只写 sessions/<taskId>/autocapture.json 状态。

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { defaultPolicy } from '../config/policy.js';
import { systemClock } from '../core/clock.js';
import { cwdToSessionSlug } from './transcript.js';
import { readBoundSessionIds, rememberSession } from './ledger.js';
import { createLlmPort } from '../llm/port.js';

const TASK_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * 默认阈值（可被 config/policy.json 的 session.ledger.autoCapture 整体覆盖）。
 * captureTokens=30000 落实设计决定（docs/research/task-context-ledger-design.md §捕获时机）：
 * 「--if-needed：按 policy.session.captureTokens（默认 30000，真正实现旧 hintTokens）判断」。
 * 转录增长量在 stat 级只能拿到字节——用 bytesPerToken 折算阈值（中英混合 ≈4.4 B/token），
 * 30000 × 4.4 ≈ 132000 字节。要精确 token 数必须解压 zstd 全量重读，违背零成本守卫。
 */
const DEFAULTS = Object.freeze({ enabled: true, captureTokens: 30_000, bytesPerToken: 4.4, minIntervalMs: 1_800_000, cooldownMs: 60_000 });

/** 会触发挂车检查的工具（memory_session_close 的捕获走 handler 内部，不在挂车层）。 */
export const OFF_FILE = 'autocapture.off';

export function autoCaptureOff(memoHome) {
  return existsSync(path.join(memoHome, OFF_FILE));
}

export const AUTO_CAPTURE_TOOLS = Object.freeze(new Set([
  'memory_write', 'memory_supersede', 'memory_search', 'memory_brief',
  'memory_session_start', 'memory_session_checkpoint', 'memory_session_status',
  'memory_session_brief', 'memory_session_segments',
]));

/** MCP server 进程 cwd 可能不等于转录 cwd；可用 MEMO_CAPTURE_CWD 显式指定。 */
const CAPTURE_CWD = process.env.MEMO_CAPTURE_CWD || process.cwd();
const MEMO_HOME = process.env.MEMO_HOME || path.join(os.homedir(), '.memo');

function nowMs(clock = systemClock) {
  const v = clock?.nowMs?.() ?? clock?.now?.() ?? Date.now();
  return typeof v === 'number' ? v : Date.now();
}

export function autoCapturePolicy(policy = defaultPolicy) {
  const raw = policy?.session?.ledger?.autoCapture;
  return { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
}

export function captureOnCloseEnabled(policy = defaultPolicy) {
  return policy?.session?.ledger?.captureOnClose !== false;
}

function ledgerDirExists(memoHome, taskId) {
  const dir = path.join(memoHome, 'sessions', taskId);
  return existsSync(path.join(dir, 'meta.json'))
    || existsSync(path.join(dir, 'segments.jsonl'))
    || existsSync(path.join(dir, 'index.json'));
}

/**
 * stat 级探测绑定转录（不解压）。绑定顺序：
 *   ① 显式 probe（仅测试注入）
 *   ② DSH_SESSION_ID 环境变量 → sessionsRoot/<slug>/<sessionId>/session.v4.jsonl.zstd
 *     （精确绑定——转录目录名唯一，与进程 cwd 是否等于会话 cwd 无关）
 *   ③ cwd → cwdToSessionSlug(cwd) 下 mtime 最新的转录（进程 cwd = 会话 cwd 的部署形态）
 * 找不到 → null。
 */
export function probeTranscript({ cwd, sessionsRoot, sessionId }) {
  const root = sessionsRoot || path.join(process.env.HOME ?? os.homedir(), '.dsh', 'sessions');
  if (!existsSync(root)) return null;
  if (sessionId) {
    let entries = [];
    try {
      entries = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory());
    } catch {
      return null;
    }
    for (const slug of entries) {
      const f = path.join(root, slug.name, sessionId, 'session.v4.jsonl.zstd');
      if (!existsSync(f)) continue;
      try {
        const st = statSync(f);
        return { mtimeMs: st.mtimeMs, size: st.size, sessionId };
      } catch {
        /* stat 失败继续找下一个 slug */
      }
    }
    return null; // 有 env 绑定但转录不存在：精确失败优于模糊猜测
  }
  const slugDir = path.join(root, cwdToSessionSlug(cwd));
  if (!existsSync(slugDir)) return null;
  let best = null;
  let entries = [];
  try {
    entries = readdirSync(slugDir, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    return null;
  }
  for (const e of entries) {
    const f = path.join(slugDir, e.name, 'session.v4.jsonl.zstd');
    if (!existsSync(f)) continue;
    try {
      const st = statSync(f);
      if (!best || st.mtimeMs > best.mtimeMs) best = { mtimeMs: st.mtimeMs, size: st.size, sessionId: e.name };
    } catch {
      /* stat 失败的目录跳过 */
    }
  }
  return best;
}

export function readAutoCaptureState(memoHome, taskId, sessionId) {
  const file = path.join(memoHome, 'sessions', taskId, 'autocapture.json');
  if (!existsSync(file)) return null;
  let v;
  try {
    v = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null; // 坏状态文件 = 重新积累
  }
  if (!v || typeof v !== 'object') return null;
  if (typeof sessionId === 'string' && sessionId !== '') {
    const per = v.sessions && typeof v.sessions === 'object' ? v.sessions[sessionId] : null;
    if (per && typeof per === 'object') return per;
    // 旧格式只有顶层状态：只有主会话能复用它，其它会话视为首次。
    return v.sessionId === sessionId ? v : null;
  }
  return v;
}

function writeAutoCaptureState(memoHome, taskId, patch, sessionId) {
  const dir = path.join(memoHome, 'sessions', taskId);
  mkdirSync(dir, { recursive: true });
  const prev = readAutoCaptureState(memoHome, taskId) ?? {};
  const next = { ...prev };
  if (typeof sessionId === 'string' && sessionId !== '') {
    const sessions = prev.sessions && typeof prev.sessions === 'object' ? prev.sessions : {};
    sessions[sessionId] = { ...(sessions[sessionId] ?? {}), ...patch };
    next.sessions = sessions;
    // 主会话（最近一次 bind）才更新顶层，保持旧读法兼容。
    if (!prev.sessionId || prev.sessionId === sessionId) {
      next.sessionId = sessionId;
      Object.assign(next, patch);
    }
  } else {
    Object.assign(next, patch);
  }
  // 尾换行（Q8：文件末尾必须有换行符）
  writeFileSync(path.join(dir, 'autocapture.json'), `${JSON.stringify(next)}\n`);
  return next;
}

/**
 * 守卫链（纯函数，便于单测）：
 *   disabled > bad-task-id > no-transcript > no-ledger(非 force)
 *   > first-run(ok) > unchanged > cooldown > threshold-reached(ok) > interval-elapsed(ok) > below-threshold
 */
export function decideAutoCapture({ memoHome, taskId, policy = defaultPolicy, clock, probe, state, force = false, requireLedger = true }) {
  const pol = autoCapturePolicy(policy);
  if (!pol.enabled) return { ok: false, reason: 'disabled' };
  if (autoCaptureOff(memoHome)) return { ok: false, reason: 'disabled-by-file' };
  if (!TASK_ID_RE.test(String(taskId ?? ''))) return { ok: false, reason: 'bad-task-id' };
  if (!probe) return { ok: false, reason: 'no-transcript' };
  if (requireLedger && !force && !ledgerDirExists(memoHome, taskId)) return { ok: false, reason: 'no-ledger' };
  if (!state) return { ok: true, reason: 'first-run' };
  if (!force && probe.mtimeMs === state.mtimeMs && probe.size === state.size) return { ok: false, reason: 'unchanged' };
  const now = nowMs(clock);
  if (!force && typeof state.lastSuccessAt === 'number' && now - state.lastSuccessAt < pol.cooldownMs) {
    return { ok: false, reason: 'cooldown', waitMs: pol.cooldownMs - (now - state.lastSuccessAt) };
  }
  const growth = probe.size - (Number.isFinite(state.size) ? state.size : 0);
  if (force) return { ok: true, reason: 'forced', growth };
  const byteThreshold = Math.max(1, Math.round(pol.captureTokens * pol.bytesPerToken));
  if (growth >= byteThreshold) return { ok: true, reason: 'threshold-reached', growth };
  // 只按 30k 阈值捕获；不再用 interval-elapsed 在任意增长时兜底（会产生大量小段）。
  return { ok: false, reason: 'below-threshold', growth };
}

/**
 * 挂车自动捕获。返回（成功）：
 *   { ran:true, reason, created, skipped, segments }
 * （跳过/失败）：
 *   { ran:false, reason, code?, message? }
 * captureOnClose 场景传 force:true + captureOnClose:true —— 额外要求 policy 允许 close 捕获。
 */
export async function maybeAutoCapture({
  memoHome, taskId, cwd = CAPTURE_CWD, sessionsRoot, sessionId, policy = defaultPolicy, clock = systemClock,
  captureTaskImpl, probe, force = false, requireLedger = true, captureOnClose = false, llmPort,
} = {}) {
  try {
    if (captureOnClose && !captureOnCloseEnabled(policy)) return { ran: false, reason: 'capture-on-close-disabled' };
    const state = readAutoCaptureState(memoHome, taskId, sessionId);
    // 绑定优先级：显式参数/env（MCP 层注入）→ meta.json.hostSessionId（memo session bind，agent shell
    // 里有 DSH_SESSION_ID 而宿主 spawn 的 server 进程没有——issue #225 后续）。都不在才退 cwd slug。
    const sid = sessionId ?? readBoundSessionId(memoHome, taskId) ?? undefined;
    const tx = probe ?? probeTranscript({ cwd, sessionsRoot, sessionId: sid });
    const d = decideAutoCapture({ memoHome, taskId, policy, clock, probe: tx, state, force, requireLedger });
    if (!d.ok) return { ran: false, reason: d.reason, ...(d.waitMs !== undefined ? { waitMs: d.waitMs } : {}) };
    const now = nowMs(clock);
    const impl = captureTaskImpl ?? (await import('./capture.js')).captureTask;
    // sid 必须透传给 captureTask：否则它按 cwd slug 找转录——MCP server 进程 cwd 是宿主
    // profiles 目录，slug 永远匹配不上（bind 的意义就是让捕获用对转录，issue #225/#230）。
    // 捕获模式按 policy.session.ledger.llmMode（用户要求 llm 录入）；llm 模式注入就绪的
    // llmPort（key 解析 policy→env→~/.config/sedimem/llm-key），未就绪不透传——captureTask
    // 内部回落 rules + fallbackReason，fail-closed 永不抛。
    const ledgerPolicy = policy?.session?.ledger ?? {};
    const mode = ledgerPolicy.llmMode === 'llm' ? 'llm' : 'rules';
    let port;
    if (mode === 'llm') {
      port = llmPort ?? globalThis.__memoLlmPort ?? createLlmPort({ policy });
      const ready = typeof port?.ready === 'function' ? port.ready() : port?.ready;
      if (ready === false) port = undefined;
    }
    const res = await impl({ memoHome, taskId, cwd, mode, sessionId: sid, ...(port ? { llmPort: port } : {}) });
    writeAutoCaptureState(memoHome, taskId, {
      mtimeMs: tx.mtimeMs,
      size: tx.size,
      sessionId: res?.segments?.[0]?.source?.sessionId ?? state?.sessionId ?? tx.sessionId ?? sid ?? null,
      lastSuccessAt: now,
      lastAttemptAt: now,
    }, sid);
    return { ran: true, reason: d.reason, created: res?.created ?? 0, skipped: res?.skipped ?? 0, segments: res?.segments?.length ?? 0 };
  } catch (e) {
    try {
      const sid2 = sessionId ?? readBoundSessionId(memoHome, taskId) ?? undefined;
      const tx2 = probe ?? probeTranscript({ cwd, sessionsRoot, sessionId: sid2 });
      const now = nowMs(clock);
      writeAutoCaptureState(memoHome, taskId, {
        lastAttemptAt: now,
        ...(tx2 && !readAutoCaptureState(memoHome, taskId, sid2) ? { mtimeMs: tx2.mtimeMs, size: tx2.size } : {}),
      }, sid2);
    } catch {
      /* 状态写失败不影响 fail-closed 返回 */
    }
    return { ran: false, reason: 'error', code: e?.code ?? 'E_CAPTURE_FAILED', message: e?.message ?? String(e) };
  }
}

export function isAutoCaptureCandidateTool(name) {
  return AUTO_CAPTURE_TOOLS.has(name);
}

/**
 * 读 meta.json 里 agent 显式绑定的宿主会话 id（`memo session bind --session-id`）。
 * 背景（issue #225 后续）：DSH_SESSION_ID 在 agent 的 bash env 里有、在宿主 spawn 的
 * MCP server 进程 env 里没有；server 进程 cwd 也不是会话目录，cwd slug 兜底会跟错文件。
 * 所以由 agent 在开工时把当前会话 id 绑进任务 meta，自动捕获按它精确定位转录。
 * @returns {string|null} hostSessionId（非空字符串）或 null
 */
export function readBoundSessionId(memoHome, taskId) {
  let raw;
  try {
    raw = readFileSync(path.join(memoHome, 'sessions', taskId, 'meta.json'), 'utf8');
  } catch {
    return null;
  }
  try {
    const meta = JSON.parse(raw);
    const ids = Array.isArray(meta?.hostSessionIds) ? meta.hostSessionIds : [];
    const primary = typeof meta?.hostSessionId === 'string' ? meta.hostSessionId : '';
    const all = [primary, ...ids].filter((x) => typeof x === 'string' && x.trim() !== '');
    return all.length > 0 ? all[0].trim() : null;
  } catch {
    return null;
  }
}

/** 单次挂车检查硬超时：捕获慢（大 zstd）也不拖住工具响应。 */
const POST_TOOL_TIMEOUT_MS = 15_000;

/**
 * server.js tools/call 成功路径的挂钩。非 session scope / 非候选工具 → null；
 * 其余 → maybeAutoCapture（自带 try/catch + 超时，绝不抛出）。
 * overrides 仅测试注入（memoHome/taskId/cwd/policy/clock/captureTaskImpl/probe）。
 */
export async function postToolAutoCapture({ state, toolName, args, overrides = {} } = {}) {
  try {
    // 生效 scope：调用参数显式给的就优先（memory_write --scope / memory_session_* --task），
    // 否则退回连接级 scope。只认 session:<taskId>——挂车捕获只维护任务账本。
    let scope = typeof state?.scope === 'string' ? state.scope : '';
    const argScope = typeof args?.scope === 'string' ? args.scope : '';
    if (argScope.startsWith('session:')) {
      scope = argScope;
    } else if (typeof args?.task === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(args.task)) {
      scope = `session:${args.task}`;
    }
    if (!scope.startsWith('session:')) return null;
    if (!isAutoCaptureCandidateTool(toolName)) return null;
    const taskId = scope.slice('session:'.length);
    // MCP 层负责把宿主环境绑定进来：DSH 会话 id（精确）+ server 进程 cwd（兜底 slug）
    const sid = overrides.sessionId || process.env.DSH_SESSION_ID || state?.sessionId || undefined;
    // agent 一旦在任务库上调用候选工具，就把当前会话登记进 meta.hostSessionIds：
    // 后续 watcher 会按全部已登记会话逐个捕获，不需要人工 bind。
    if (sid) rememberSession({ memoHome: MEMO_HOME, taskId, hostSessionId: sid });
    const run = maybeAutoCapture({
      memoHome: MEMO_HOME, taskId, cwd: CAPTURE_CWD,
      sessionId: sid,
      ...overrides,
    });
    const timer = new Promise((resolve) => {
      const t = setTimeout(() => resolve({ ran: false, reason: 'timeout' }), POST_TOOL_TIMEOUT_MS);
      if (typeof t.unref === 'function') t.unref();
    });
    return await Promise.race([run, timer]);
  } catch {
    return null;
  }
}


// ===== 周期扫描（v1.4.1）：不依赖 memory_* 工具调用，后台按转录增长触发 =====

const WATCHER_PID_NAME = 'autocapture-watch.pid';

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === 'EPERM';
  }
}

/** 列出 open 任务 id（读登记文件；不看目录，避免把已删任务算进来）。 */
export function listOpenTaskIds(memoHome) {
  const dir = path.join(memoHome, 'sessions');
  let names = [];
  try {
    names = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  const seen = new Set();
  const add = (id) => {
    if (TASK_ID_RE.test(id) && !seen.has(id)) { seen.add(id); out.push(id); }
  };
  for (const ent of names) {
    if (ent.isFile() && ent.name.endsWith('.json')) {
      // 旧登记文件：sessions/<taskId>.json
      let reg;
      try { reg = JSON.parse(readFileSync(path.join(dir, ent.name), 'utf8')); } catch { continue; }
      if (reg && reg.status === 'open') add(String(reg.id ?? ent.name.slice(0, -5)));
    } else if (ent.isDirectory()) {
      // v1.4 账本目录：sessions/<taskId>/meta.json（登记文件可能已被删/从未写过）
      try {
        const meta = JSON.parse(readFileSync(path.join(dir, ent.name, 'meta.json'), 'utf8'));
        if (meta && meta.status === 'open') add(String(meta.taskId ?? ent.name));
      } catch { /* 无 meta 的目录不是任务库 */ }
    }
  }
  return out;
}

function acquireWatcherPid(memoHome) {
  const file = path.join(memoHome, WATCHER_PID_NAME);
  const readPid = () => {
    try {
      return Number.parseInt(readFileSync(file, 'utf8').trim(), 10);
    } catch {
      return NaN;
    }
  };
  try {
    mkdirSync(memoHome, { recursive: true });
    writeFileSync(file, `${process.pid}\n`, { flag: 'wx' });
    return { file, acquired: true };
  } catch (e) {
    if (e?.code !== 'EEXIST') return { file, acquired: false };
    const old = readPid();
    if (pidAlive(old)) return { file, acquired: false };
    try { writeFileSync(file, `${process.pid}\n`); } catch { return { file, acquired: false }; }
    return { file, acquired: true };
  }
}

/**
 * 启动周期扫描（单例）。每个 tick 对每个 open 任务调用 maybeAutoCapture。
 * 返回 { started, stop }；started=false 表示已有存活 watcher 或 disabled。
 */
export function startAutoCaptureWatcher({
  memoHome = MEMO_HOME, intervalMs = 60_000, policy = defaultPolicy, clock = systemClock,
  log = () => {}, maybeImpl = maybeAutoCapture, pidFile,
} = {}) {
  const pol = autoCapturePolicy(policy);
  if (!pol.enabled) return { started: false, reason: 'disabled', stop: () => {} };
  if (autoCaptureOff(memoHome)) return { started: false, reason: 'disabled-by-file', stop: () => {} };
  const lock = pidFile
    ? (() => { try { mkdirSync(path.dirname(pidFile), { recursive: true }); writeFileSync(pidFile, `${process.pid}\n`, { flag: 'wx' }); return { file: pidFile, acquired: true }; } catch { return { file: pidFile, acquired: false }; } })()
    : acquireWatcherPid(memoHome);
  if (!lock.acquired) return { started: false, reason: 'already-running', stop: () => {} };

  let running = false;
  let stopped = false;
  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      for (const taskId of listOpenTaskIds(memoHome)) {
        const ids = readBoundSessionIds(memoHome, taskId);
        const targets = ids.length > 0 ? ids : [undefined];
        for (const sid of targets) {
          const r = await maybeImpl({ memoHome, taskId, policy, clock, ...(sid ? { sessionId: sid } : {}) });
          if (r?.ran) log(`[autocapture] ${taskId}${sid ? ` (${sid.slice(-6)})` : ''}: ${r.reason} created=${r.created ?? 0}`);
        }
      }
    } catch (e) {
      log(`[autocapture] tick failed: ${e?.message ?? e}`);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => { void tick(); }, Math.max(5_000, Number(intervalMs) || 60_000));
  if (typeof timer.unref === 'function') timer.unref();
  void tick();
  return {
    started: true,
    stop: () => {
      stopped = true;
      clearInterval(timer);
      try {
        if (readFileSync(lock.file, 'utf8').trim() === String(process.pid)) unlinkSync(lock.file);
      } catch { /* 文件已被别的进程替换/删除都无妨 */ }
    },
  };
}
