// session/capture.js — 段捕获（v1.2 B1，契约：versions/v1.2/docs/SEGMENT-SPEC.md §4）
//
// 三步：读转录 turns → planSegments（半开区间、跳过 covered、按 turn 数切块）
//       → extractSegment（默认规则抽取零 token；mode:'llm' 才调 llmPort）
//       → appendSegment（锁内判重叠 + 追加 + 重建 index）。
//
// 硬规则（SPEC §2/§4、裁决 118-121）：
//   - 段区间 [fromSeq, toSeq) 与 coveredSeqs 不相交；重复 capture 是幂等的（第二次 created===0）。
//   - 写段前对每条抽取文本先 redactText 再 detectSuspicious；命中可疑 → quarantined:true + taint:['suspicious']。
//   - fail-closed：读转录失败时零写入；dryRun 只返回将写入的段，不落盘。
//
// 零运行时依赖：只 import node: 内置与同仓模块。

import path from 'node:path';
import { systemClock } from '../core/clock.js';
import { newId } from '../core/ids.js';
import { detectSuspicious } from '../hygiene/suspicious.js';
import { redactText } from '../hygiene/redact.js';
import { appendSegment, coveredSeqs, SEGMENT_LIMITS } from './ledger.js';
import { compactTranscript, readDshTranscript } from './transcript.js';

/** summary 每条 turn 取前多少字（SPEC §4：首尾各 2 条 turn 拼接；单条只取前 120 字防长 turn 吞预算） */
const SUMMARY_EDGE_CHARS = 120;
/** summary 头尾各取几条 turn（SPEC §4） */

/** 规则抽取的句子切分（中英文句末 + 换行） */
const SENTENCE_SPLIT_RE = /[。！？!?；;\n]+/;

/**
 * 会话里的「非对话噪声」：系统注入的运行时快照、时间采样、ACP 元数据、工具回执开头等。
 * 这些既不是用户诉求也不是结论，进摘要只会把真信息挤掉。
 */
const NOISE_RES = [
  /^Time sampled (while|during)/i,
  /^Current runtime context/i,
  /^Current working directory/i,
  /^Current DSH (file|implementation)/i,
  /^This snapshot supersedes/i,
  /^Browser time zone for this request/i,
  /^Elapsed since/i,
  /^<system-reminder>/i,
  /^<acp /i,
  /^\[Compressed conversation section\]/i,
  /^The following information describes your current session/i,
  /^You are (the root agent|a coding agent|the Team Lead)/i,
  /^Use list_agents\(/i,
  /^Time sampled: /i,
  /^<goal_/i,
  /^Objective:/i,
  /^##\s/, // markdown 二级标题开头
];

/** 是否是噪声 turn（噪声 turn 不参与摘要与抽取，但仍计入区间） */
function isNoiseTurn(turn) {
  const text = String(turn?.text ?? '').trim();
  if (text === '') return true;
  const head = text.slice(0, 120);
  if (NOISE_RES.some((re) => re.test(head))) return true;
  // 整段都是代码块/JSON 的 turn 也当噪声
  if (/^```[\s\S]*```$/.test(text)) return true;
  return false;
}

/** 关键词：决定/改为/采用/不再 → decisions；坑/注意/踩了/原来/必须 → gotchas；
 *  TODO/待/还没 → pendingJobs；下一步/接着/然后 → nextSteps（SPEC §4） */
const DECISION_RE = /(决定|改为|采用|不再)/;
const GOTCHA_RE = /(坑|注意|踩了|原来|必须)/;
const PENDING_RE = /(TODO|待|还没)/i;
const NEXT_STEP_RE = /(下一步|接着|然后)/;

/** 文件路径：只收 src/ tests/ docs/ 下的仓库相对路径（SPEC §4） */
const FILE_RE = /(?:src|tests|docs)\/[A-Za-z0-9_.@%+\-/]+/g;

function err(code, msg) {
  const e = new Error(msg);
  e.code = code;
  return e;
}

/** clock 的毫秒读数（兼容只实现 now() 的时钟端口） */
function clockMs(clock) {
  if (clock && typeof clock.nowMs === 'function') return clock.nowMs();
  if (clock && typeof clock.now === 'function') return Date.parse(clock.now());
  return Date.now();
}

function textsOf(turns) {
  const out = [];
  for (const t of Array.isArray(turns) ? turns : []) {
    if (t && typeof t.text === 'string' && t.text.trim() !== '') out.push(t.text);
  }
  return out;
}

/** 规则摘要（SPEC §4）：首尾各 2 条 turn 的句子拼接（每条取前 120 字）；整段不足 400 字则整段拼 */
/**
 * 把一段文本压成「一行人话」：去代码围栏与行内代码、去 markdown 标记、折叠空白、截断。
 * 摘要要能塞进简报的一行里，不能带换行和代码块。
 */
function toOneLine(text, max = SUMMARY_EDGE_CHARS) {
  const flat = String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')      // 代码围栏整体丢弃
    .replace(/`([^`]*)`/g, '$1')            // 行内代码保留内容
    .replace(/\*\*/g, '')                    // 粗体标记
    .replace(/\|/g, ' ')                     // 表格竖线
    .replace(/-{3,}/g, ' ')                   // 表格分隔线
    .replace(/^\s{0,3}[#>*+-]+\s*/gm, ' ')  // 标题/列表/引用前缀
    .replace(/\s+/g, ' ')
    .trim();
  if (flat === '') return;
  return flat.length <= max ? flat : flat.slice(0, max).replace(/[，,、;；:：\s]+$/, '') + '…';
}

function buildSummary(turns, fromSeq, toSeq) {
  const clean = turns.filter((t) => !isNoiseTurn(t));
  if (clean.length === 0) return `段 ${fromSeq}–${toSeq}：${turns.length} 轮对话（无可读内容）`;
  const users = clean.filter((t) => t.role === 'user');
  const assistants = clean.filter((t) => t.role === 'assistant');
  const ask = toOneLine(users[0]?.text ?? clean[0].text, 120);
  const last = assistants.length > 0 ? toOneLine(assistants[assistants.length - 1].text, 140) : undefined;
  const stats = `${clean.length} 轮对话${users.length ? ` · ${users.length} 次提问` : ''}`;
  const parts = [];
  if (ask) parts.push(`诉求：${ask}`);
  else parts.push(`过程：${stats}`);
  if (ask) parts.push(stats);
  if (last) parts.push(`结论：${last}`);
  const joined = parts.join('；');
  return joined.length <= SEGMENT_LIMITS.summary ? joined : joined.slice(0, SEGMENT_LIMITS.summary - 1) + '…';
}

/** 句子列表：切句、去首尾列表符号、去重、单句截 200 字 */
function sentencesOf(texts) {
  const out = [];
  const seen = new Set();
  for (const text of texts) {
    if (isNoiseTurn({ text })) continue;
    for (const raw of text.split(SENTENCE_SPLIT_RE)) {
      const s = raw.trim().replace(/^[-*+>·\d.\s]+/, '').trim();
      if (s === '' || seen.has(s)) continue;
      if (s.length < 8) continue;                        // 太短的多是标签/标题（「待办：还没跑测试」这类要留）
      if (/^\|/.test(s) || s.includes(' | ')) continue;    // markdown 表格行
      if (/^\s*(const|let|var|function|import|export|return|if|for|await)\b/.test(s)) continue; // 代码行
      if (/^(Time sampled|Current runtime|Elapsed)/i.test(s)) continue;
      if (/^(git|npm|pnpm|node|npx|memo|curl|cd|ls|rm|cp|mv|bash|sh|cat|grep|find)\b/.test(s)) continue; // 命令
      if (/^[├└│|][─\-\s]*\S/.test(s)) continue;                            // 目录树
      if (/^#{1,6}\s/.test(s) || /^【/.test(s)) continue;                    // 标题/方括号小标题
      if (/^\$\s/.test(s)) continue;
      if (!/[\u4e00-\u9fa5]/.test(s) && s.split(' ').length < 8) continue; // 非中文短串
      seen.add(s);
      out.push(s.length > SEGMENT_LIMITS.factItem ? s.slice(0, SEGMENT_LIMITS.factItem) : s);
    }
  }
  return out;
}

/** 命中关键词的句子，最多 cap 条 */
function pickBy(sentences, re, cap) {
  const out = [];
  const seenPrefix = new Set();
  for (const s of sentences) {
    if (!re.test(s)) continue;
    if (s.length > 120) continue;                      // 长句多半是叙述，不是结论
    if (s.includes('**') || s.includes('|') || s.includes('](')) continue; // markdown 残留
    if ((s.match(/[\u4e00-\u9fa5]/g) ?? []).length < 6) continue;         // 中文太少
    const key = s.slice(0, 14);
    if (seenPrefix.has(key)) continue;                  // 近重复只留第一条
    seenPrefix.add(key);
    out.push(s);
    if (out.length >= cap) break;
  }
  return out;
}

/** 从文本抽 src/ tests/ docs/ 路径（去重、去尾标点、上限 20） */
function filesOf(texts) {
  const seen = new Set();
  const out = [];
  for (const text of texts) {
    for (const m of text.matchAll(FILE_RE)) {
      const f = m[0].replace(/[.,;:，。；：、)）\]】」』]+$/, '');
      if (f === '' || seen.has(f)) continue;
      seen.add(f);
      out.push(f);
      if (out.length >= SEGMENT_LIMITS.files) return out;
    }
  }
  return out;
}

/**
 * 统一收口：逐条 redactText（先）→ detectSuspicious（后），命中即整段 quarantined。
 * 同时套 spec 上限，补默认 trust/taint/mode。
 */
function finalizeSegment(raw, {
  mode, policy, fromSeq, toSeq, anchor, source, fallbackReason,
}) {
  const patterns = Array.isArray(policy?.suspiciousPatterns) ? policy.suspiciousPatterns : [];
  const heuristics = policy?.suspiciousHeuristics;
  const detectOpts = heuristics && typeof heuristics === 'object' ? { heuristics } : {};
  let suspicious = false;

  const clean = (value) => {
    const red = redactText(String(value ?? ''), { policy });
    const det = detectSuspicious(red.text, patterns, detectOpts);
    if (det.suspicious) suspicious = true;
    return red.text;
  };
  const cleanList = (arr, cap, itemCap) => {
    const list = Array.isArray(arr) ? arr : [];
    const out = [];
    for (const item of list) {
      const s = clean(item).slice(0, itemCap).trim();
      if (s !== '') out.push(s);
      if (out.length >= cap) break;
    }
    return out;
  };

  const summary = clean(raw.summary ?? '').slice(0, SEGMENT_LIMITS.summary).trim()
    || `段 [${fromSeq}, ${toSeq})`;

  const segment = {
    fromSeq,
    toSeq,
    summary,
    facts: cleanList(raw.facts, SEGMENT_LIMITS.facts, SEGMENT_LIMITS.factItem),
    decisions: cleanList(raw.decisions, SEGMENT_LIMITS.decisions, SEGMENT_LIMITS.factItem),
    gotchas: cleanList(raw.gotchas, SEGMENT_LIMITS.gotchas, SEGMENT_LIMITS.factItem),
    pendingJobs: cleanList(raw.pendingJobs, SEGMENT_LIMITS.pendingJobs, SEGMENT_LIMITS.factItem),
    files: cleanList(raw.files, SEGMENT_LIMITS.files, 300),
    nextSteps: cleanList(raw.nextSteps, SEGMENT_LIMITS.nextSteps, SEGMENT_LIMITS.factItem),
    tokens: raw.tokens ?? null,
    trust: typeof raw.trust === 'string' && raw.trust !== '' ? raw.trust : 'T1',
    taint: suspicious ? ['suspicious'] : [],
    quarantined: suspicious,
    mode,
  };
  if (anchor) segment.anchor = anchor;
  if (source) segment.source = source;
  if (fallbackReason) segment.fallbackReason = fallbackReason;
  return segment;
}

/** 规则模式抽取（零 token，确定性） */
function extractRules({ turns, fromSeq, toSeq, policy, anchor, source }) {
  const texts = textsOf(turns);
  // decisions/gotchas 只从 assistant 的发言里抽（用户消息里的"决定"多是转述需求）；
  // pendingJobs/nextSteps 允许来自双方（用户也会说"下一步做 X"，助手会说"我接着做"）
  const assistantTexts = turns.filter((t) => t.role === 'assistant').map((t) => String(t.text ?? ''));
  const sentences = sentencesOf(assistantTexts.length > 0 ? assistantTexts : texts);
  const allSentences = sentencesOf(texts);
  return finalizeSegment({
    summary: buildSummary(turns, fromSeq, toSeq),
    facts: [],
    decisions: pickBy(sentences, DECISION_RE, SEGMENT_LIMITS.decisions),
    gotchas: pickBy(sentences, GOTCHA_RE, SEGMENT_LIMITS.gotchas),
    pendingJobs: pickBy(allSentences, PENDING_RE, SEGMENT_LIMITS.pendingJobs),
    nextSteps: pickBy(allSentences, NEXT_STEP_RE, SEGMENT_LIMITS.nextSteps),
    files: filesOf(texts),
    tokens: null,
  }, { mode: 'rules', policy, fromSeq, toSeq, anchor, source });
}

/** 从 LLM 输出文本里抽第一个配平的 JSON 对象（容忍 ```json 围栏 / 前后废话） */
function extractJson(text) {
  const raw = String(text ?? '');
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const candidates = fence ? [fence[1], raw] : [raw];
  for (const cand of candidates) {
    const start = cand.indexOf('{');
    if (start === -1) continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < cand.length; i++) {
      const ch = cand[i];
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') inStr = !inStr;
      if (inStr) continue;
      if (ch === '{') depth++;
      if (ch === '}') {
        depth--;
        if (depth === 0) {
          try {
            const obj = JSON.parse(cand.slice(start, i + 1));
            if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj;
          } catch { break; }
        }
      }
    }
  }
  return null;
}

function asStringArray(v) {
  if (!Array.isArray(v)) return [];
  return v.filter((x) => typeof x === 'string').map((x) => x);
}

/** LLM 模式抽取：失败/未就绪一律回落规则，段上 mode='rules' + fallbackReason（永不抛） */
async function extractWithLlm({ turns, fromSeq, toSeq, llmPort, policy, anchor, source }) {
  const rules = () => extractRules({ turns, fromSeq, toSeq, policy, anchor, source });
  if (!llmPort) {
    const seg = rules();
    seg.mode = 'rules';
    seg.fallbackReason = '未提供 llmPort';
    return seg;
  }
  try {
    const ready = typeof llmPort.ready === 'function' ? llmPort.ready() : llmPort.ready;
    if (ready === false) throw new Error('llm 未就绪（ready=false）');
    const user = [
      '把下面会话转录折叠成一个 JSON 对象，字段：summary, facts, decisions, gotchas, pendingJobs, files, nextSteps。',
      '硬性要求：summary ≤180 字、一句话概括这一段在做什么与结论；每个数组最多 4 条、每条 ≤60 字、只写结论不写过程；',
      'files 只收真实出现过的仓库相对路径；不要编造转录里没有的内容；只输出 JSON，不要任何解释。',
      '```',
      compactTranscript(turns),
      '```',
    ].join('\n');
    const res = await llmPort.complete({
      purpose: 'capture',
      system: '你是会话上下文折叠器。严格 JSON 输出，禁止编造。',
      user,
    });
    if (res === null || res === undefined) throw new Error('llm 返回空');
    if (typeof res === 'object' && res.ok === false) {
      throw new Error(`llm 调用失败: ${res.error?.code ?? 'unknown'}`);
    }
    const text = typeof res === 'string' ? res : (res.text ?? res.content ?? '');
    const parsed = extractJson(text);
    if (!parsed) throw new Error('llm 输出无法解析为 JSON');
    const raw = {
      summary: typeof parsed.summary === 'string' ? parsed.summary : '',
      facts: asStringArray(parsed.facts),
      decisions: asStringArray(parsed.decisions),
      gotchas: asStringArray(parsed.gotchas),
      pendingJobs: asStringArray(parsed.pendingJobs),
      files: asStringArray(parsed.files),
      nextSteps: asStringArray(parsed.nextSteps),
      tokens: null,
    };
    if (raw.summary.trim() === '') raw.summary = buildSummary(turns, fromSeq, toSeq);
    return finalizeSegment(raw, { mode: 'llm', policy, fromSeq, toSeq, anchor, source });
  } catch (e) {
    const seg = rules();
    seg.mode = 'rules';
    seg.fallbackReason = `llm 回落: ${e?.code ?? e?.message ?? String(e)}`;
    return seg;
  }
}

/**
 * 按 turn 数切段（SPEC §3/§4）。跳过 covered 已覆盖的 seq；
 * turn 上没有 seq 时用「数组下标 + 1」当 seq。返回段的区间恒不与 covered 相交。
 * @param {{turns: object[], covered?: Array<[number, number]>, maxTurnsPerSegment?: number}} args
 * @returns {Array<{fromSeq: number, toSeq: number, turns: object[]}>}
 */
export function planSegments({ turns, covered = [], maxTurnsPerSegment = 120 } = {}) {
  const list = Array.isArray(turns) ? turns : [];
  const max = Number.isInteger(maxTurnsPerSegment) && maxTurnsPerSegment > 0 ? maxTurnsPerSegment : 120;
  const ranges = (Array.isArray(covered) ? covered : [])
    .filter((r) => Array.isArray(r) && Number.isFinite(r[0]) && Number.isFinite(r[1]) && r[0] < r[1])
    .map((r) => [Number(r[0]), Number(r[1])]);
  const isCovered = (seq) => ranges.some(([from, to]) => seq >= from && seq < to);

  // 1) 过滤 covered + 去重，按 seq 形成「连续 run」（run 内 seq 严格 +1）
  const free = [];
  const seen = new Set();
  list.forEach((turn, idx) => {
    const rawSeq = turn && typeof turn === 'object' ? turn.seq : undefined;
    const seq = Number.isFinite(rawSeq) ? rawSeq : idx + 1;
    if (isCovered(seq) || seen.has(seq)) return;
    seen.add(seq);
    free.push({ turn, seq });
  });
  const runs = [];
  let run = [];
  for (const item of free) {
    const prev = run[run.length - 1];
    if (prev && item.seq !== prev.seq + 1) {
      runs.push(run);
      run = [];
    }
    run.push(item);
  }
  if (run.length > 0) runs.push(run);

  // 2) 每个 run 按 turn 数切块（不跨 run，保证区间内没有已覆盖的洞）
  const plans = [];
  for (const r of runs) {
    for (let i = 0; i < r.length; i += max) {
      const chunk = r.slice(i, i + max);
      const fromSeq = chunk[0].seq;
      const toSeq = chunk[chunk.length - 1].seq + 1;
      if (fromSeq < toSeq) plans.push({ fromSeq, toSeq, turns: chunk.map((x) => x.turn) });
    }
  }
  return plans;
}

/**
 * 抽取一段（返回不含 id/taskId 的 segment；captureTask 负责补全）。
 * 规则模式同步返回；mode='llm' 返回 Promise（失败回落规则，永不 reject）。
 * @param {{turns: object[], fromSeq: number, toSeq: number, mode?: string,
 *          llmPort?: object, policy?: object, anchor?: object, source?: object}} args
 * @returns {object|Promise<object>}
 */
export function extractSegment({
  turns, fromSeq, toSeq, mode = 'rules', llmPort, policy, anchor, source,
} = {}) {
  if (!Number.isInteger(fromSeq) || !Number.isInteger(toSeq) || fromSeq < 0 || fromSeq >= toSeq) {
    throw err('E_INVALID_ARG', `extractSegment: 需要 0 <= fromSeq < toSeq，收到 [${fromSeq}, ${toSeq})`);
  }
  if (mode === 'llm') {
    return extractWithLlm({ turns, fromSeq, toSeq, llmPort, policy, anchor, source });
  }
  return extractRules({ turns, fromSeq, toSeq, policy, anchor, source });
}

/**
 * 捕获任务：读最新 DSH 转录 → plan → 逐段 extract → append。
 * sessionId 省略即取该 cwd 下最新会话；sessionsRoot 缺省 $HOME/.dsh/sessions（测试可注入）。
 * dryRun=true 时只返回将写入的段，不落盘。无新 turn → {created:0, skipped:1, segments:[]}。
 * @param {{memoHome: string, taskId: string, cwd: string, mode?: string, llmPort?: object,
 *          dryRun?: boolean, sessionId?: string, sessionsRoot?: string, policy?: object,
 *          clock?: object, maxTurnsPerSegment?: number}} args
 * @returns {Promise<{created: number, skipped: number, segments: object[]}>}
 */
export async function captureTask({
  memoHome, taskId, cwd, mode = 'rules', llmPort, dryRun = false,
  sessionId, sessionsRoot, policy, clock = systemClock, maxTurnsPerSegment,
} = {}) {
  if (typeof memoHome !== 'string' || memoHome === '') {
    throw err('E_INVALID_ARG', 'captureTask: memoHome 必填');
  }
  if (typeof taskId !== 'string' || taskId === '') {
    throw err('E_INVALID_ARG', 'captureTask: taskId 必填');
  }
  if (typeof cwd !== 'string' || cwd === '') {
    throw err('E_INVALID_ARG', 'captureTask: cwd 必填');
  }

  // 1) 读转录（失败抛 E_TRANSCRIPT_UNAVAILABLE；此时零写入 = fail-closed）
  const root = typeof sessionsRoot === 'string' && sessionsRoot !== ''
    ? sessionsRoot
    : path.join(process.env.HOME ?? '', '.dsh', 'sessions');
  const tx = readDshTranscript({ sessionsRoot: root, cwd, sessionId });

  // 2) 只捕获上次以来的新增区间
  const covered = coveredSeqs({ memoHome, taskId });
  const plans = planSegments({
    turns: tx.turns,
    covered,
    ...(maxTurnsPerSegment ? { maxTurnsPerSegment } : {}),
  });
  if (plans.length === 0) return { created: 0, skipped: 1, segments: [] };

  // 3) 逐段抽取 + 追加（dryRun 不碰盘）
  const segments = [];
  let created = 0;
  for (const plan of plans) {
    const anchor = { path: tx.file, fromSeq: plan.fromSeq, toSeq: plan.toSeq };
    const source = { kind: 'dsh', path: tx.file, sessionId: tx.sessionId, frames: tx.frames };
    let extracted = extractSegment({
      turns: plan.turns,
      fromSeq: plan.fromSeq,
      toSeq: plan.toSeq,
      mode,
      llmPort,
      policy,
      anchor,
      source,
    });
    if (extracted && typeof extracted.then === 'function') extracted = await extracted;
    const segment = {
      id: newId(clockMs(clock)),
      taskId,
      createdAt: clock.now(),
      ...extracted,
      // anchor/source 由 captureTask 保证（extractSegment 契约里不含它们）
      anchor,
      source,
    };
    if (!dryRun) {
      await appendSegment({ memoHome, taskId, segment, clock });
      created++;
    }
    segments.push(segment);
  }
  return { created, skipped: 0, segments };
}
