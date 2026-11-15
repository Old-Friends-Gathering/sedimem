// session/ledger-brief.js — 任务账本简报（B2，契约：versions/v1.2/docs/SEGMENT-SPEC.md §5）
//
// 定位：账本是「内容源」，本模块是「装配器」——按 asOf 冻结、按确定顺序排序、按 maxChars
// 递减预算，产出一个**纯函数**结果，供 CLI / MCP memory_session_brief / UI 简报弹层共用。
// 与未来的 context pack（future-architecture §5.3）合并：briefJson 只返回 pack schema 的子集，
// 不新增第二个渲染器（docs/plans/v1.2-vs-future-dedup.md §二）。
//
// 硬约束（逐条对应 SPEC §5 / 计划 §2）：
//   1. 只读：只调 ledger.js 的 readSegments + readIndex，不写任何文件；
//   2. 纯函数 + clock 注入：模块内不出现 Date.now()，generatedAt/asOf 缺省都走注入的 clock；
//   3. 确定性：同一 asOf + 同一段集合 + 同一 clock → JSON.stringify 逐字节相同
//      （排序键 fromSeq 升序，同序按 segment.id；所有聚合按固定顺序输出）；
//   4. quarantined / createdAt > asOf 的段一律不采用，按 kind 聚合进 excluded；
//   5. 预算：按 decisions → gotchas → nextSteps → references 依次放入，超限截断尾部并记
//      {kind:'budget', reason:'maxChars', count}；
//   6. 段只贡献 references 与 summary，永不进 facts（I-15）。

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { readSegments, readIndex } from './ledger.js';

/** SPEC §5 默认预算（字符） */
export const DEFAULT_MAX_CHARS = 2200;

/**
 * summary 取「最近 N 段」的段摘要拼接（调研结论：简报默认给最近 3 段，每段 ≤400 字）。
 * 段的 summary 契约本来就 ≤400 字，这里再截一刀只是防御坏数据，保证 summary 有界。
 */
const SUMMARY_SEGMENTS = 3;
const SUMMARY_CHARS_PER_SEGMENT = 400;

function err(code, msg) {
  const e = new Error(msg);
  e.code = code;
  return e;
}

/** 注入时钟优先；未注入时退回系统时间（SPEC §5：asOf 默认 new Date().toISOString()） */
function nowIso(clock) {
  if (clock && typeof clock.now === 'function') return clock.now();
  return new Date().toISOString();
}

function assertTaskArgs(memoHome, taskId) {
  if (typeof memoHome !== 'string' || memoHome === '') {
    throw err('E_INVALID_ARG', `briefJson: memoHome 必须是非空字符串，收到 ${JSON.stringify(memoHome)}`);
  }
  if (typeof taskId !== 'string' || taskId === '') {
    throw err('E_INVALID_ARG', `briefJson: taskId 必须是非空字符串，收到 ${JSON.stringify(taskId)}`);
  }
}

/**
 * 读任务元信息。SPEC §1 的主路径是 `$MEMO_HOME/sessions/<taskId>/meta.json`；
 * 现实里 v1.2 之前的 session start 写的是 `$MEMO_HOME/sessions/<taskId>.json`（lifecycle 登记文件），
 * 所以主路径缺失时回落到登记文件（只读，不写），避免新账本拿不到用户起的标题。
 * 导出给 web/api/task-ledger.js 的顶栏摘要端点复用：同一套回落顺序，避免两处读 meta 不一致。
 * @returns {{meta: object, file: string}|null}
 */
export function readTaskMeta(memoHome, taskId) {
  const candidates = [
    path.join(memoHome, 'sessions', taskId, 'meta.json'),
    path.join(memoHome, 'sessions', `${taskId}.json`),
  ];
  for (const file of candidates) {
    let raw;
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      continue; // 不存在/不可读 → 下一个候选
    }
    try {
      const meta = JSON.parse(raw);
      if (meta && typeof meta === 'object' && !Array.isArray(meta)) return { meta, file };
    } catch {
      // 坏 meta 视同没有（简报不能因一个坏元数据文件整体失败）
    }
  }
  return null;
}

/** 段排序键：fromSeq 升序，同序按 segment.id（SPEC §5） */
function compareSegments(a, b) {
  const fa = Number.isFinite(a.fromSeq) ? a.fromSeq : 0;
  const fb = Number.isFinite(b.fromSeq) ? b.fromSeq : 0;
  if (fa !== fb) return fa - fb;
  const ia = typeof a.id === 'string' ? a.id : '';
  const ib = typeof b.id === 'string' ? b.id : '';
  return ia < ib ? -1 : ia > ib ? 1 : 0;
}

/**
 * 从段集合按字段抽条目（保持段顺序、条目顺序），按 text 去重（同一结论在多个段重复只留最早一条）。
 * @param {object[]} segments 已按 SPEC 排序的「可用段」
 * @param {string} field 'decisions' | 'gotchas' | 'nextSteps'
 * @returns {Array<{text: string, segmentId: string, fromSeq: number}>}
 */
function collectTexts(segments, field) {
  const out = [];
  const seen = new Set();
  for (const seg of segments) {
    const list = seg[field];
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      const text = typeof raw === 'string' ? raw.trim() : '';
      if (text === '' || seen.has(text)) continue;
      seen.add(text);
      out.push({ text, segmentId: seg.id, fromSeq: seg.fromSeq });
    }
  }
  return out;
}

/**
 * references：段 files[] 摊平，按文件路径去重（保留最早出现段的 segmentId），保持段/文件原顺序。
 * @returns {Array<{file: string, segmentId: string}>}
 */
function collectReferences(segments) {
  const out = [];
  const seen = new Set();
  for (const seg of segments) {
    const files = seg.files;
    if (!Array.isArray(files)) continue;
    for (const raw of files) {
      const file = typeof raw === 'string' ? raw.trim() : '';
      if (file === '' || seen.has(file)) continue;
      seen.add(file);
      out.push({ file, segmentId: seg.id });
    }
  }
  return out;
}

/** 条目计价：文本/文件路径的 UTF-16 长度（与 String#length 一致，跨平台确定） */
function costOfText(item) {
  return item.text.length;
}
function costOfRef(item) {
  return item.file.length;
}

/**
 * 生成任务简报（SPEC §5）。
 *
 * @param {object} args
 * @param {string} args.memoHome $MEMO_HOME
 * @param {string} args.taskId 任务 id（形如 20261114-2221-6a5b）
 * @param {string} [args.asOf] ISO 时间；缺省取 clock.now()（无 clock 时 new Date().toISOString()）
 * @param {number} [args.maxChars=2200] 四个内容段的总字符预算
 * @param {{now: () => string, nowMs?: () => number}} [args.clock] 时钟端口
 * @returns {{
 *   task: {id: string, title: string|null, state: 'open'|'closed'},
 *   summary: string,
 *   decisions: Array<{text: string, segmentId: string, fromSeq: number}>,
 *   gotchas: Array<{text: string, segmentId: string, fromSeq: number}>,
 *   references: Array<{file: string, segmentId: string}>,
 *   nextSteps: Array<{text: string, segmentId: string, fromSeq: number}>,
 *   excluded: Array<{kind: string, reason: string, count: number}>,
 *   budget: {maxChars: number, usedChars: number, truncated: boolean},
 *   segments: {total: number, used: number, quarantined: number},
 *   generatedAt: string,
 * }}
 */
export function briefJson({ memoHome, taskId, asOf, maxChars = DEFAULT_MAX_CHARS, clock } = {}) {
  assertTaskArgs(memoHome, taskId);
  if (!Number.isFinite(maxChars) || maxChars < 0) {
    throw err('E_INVALID_ARG', `briefJson: maxChars 必须是非负有限数，收到 ${JSON.stringify(maxChars)}`);
  }
  const limit = Math.floor(maxChars);
  const generatedAt = nowIso(clock);
  const asOfIso = asOf === undefined ? generatedAt : asOf;
  if (typeof asOfIso !== 'string' || !Number.isFinite(Date.parse(asOfIso))) {
    throw err('E_INVALID_ARG', `briefJson: asOf 必须是可解析的 ISO 时间字符串，收到 ${JSON.stringify(asOfIso)}`);
  }
  const asOfMs = Date.parse(asOfIso);

  // ---- 读真相层（segments.jsonl）。短任务/新任务可能还没有账本目录：按空账本处理，不抛 ----
  let segments = [];
  try {
    const res = readSegments({ memoHome, taskId });
    segments = Array.isArray(res?.segments) ? res.segments : [];
  } catch (e) {
    if (e && (e.code === 'E_NOT_FOUND' || e.code === 'ENOENT')) segments = [];
    else throw e;
  }
  // fail-closed：index 声称有段、真相层却是空的 → 段文件被删/损坏（计划 §9 只能告警，这里显式报错）
  const index = readIndex({ memoHome, taskId });
  const indexCount = Array.isArray(index?.segments) ? index.segments.length : 0;
  if (segments.length === 0 && indexCount > 0) {
    throw err('E_LEDGER_CORRUPT',
      `briefJson: index.json 记录 ${indexCount} 段，但 segments.jsonl 读到 0 段（段文件缺失或损坏，index 无法恢复内容）`);
  }

  // ---- asOf 冻结 + quarantine 过滤（SPEC §5：只取 createdAt <= asOf 的段；quarantined 永不采用）----
  const total = segments.length;
  let quarantined = 0;
  let future = 0;
  const usable = [];
  for (const seg of segments) {
    if (!seg || typeof seg !== 'object') continue;
    if (seg.quarantined === true) {
      quarantined++;
      continue;
    }
    const createdMs = Date.parse(seg.createdAt ?? '');
    // 时间不可解析 → 无法证明 ≤ asOf，按 future 排除（fail-closed：不把不明时间的段塞进简报）
    if (!Number.isFinite(createdMs) || createdMs > asOfMs) {
      future++;
      continue;
    }
    usable.push(seg);
  }
  usable.sort(compareSegments);

  // ---- 内容段（排序/去重确定）----
  const decisionItems = collectTexts(usable, 'decisions');
  const gotchaItems = collectTexts(usable, 'gotchas');
  const nextStepItems = collectTexts(usable, 'nextSteps');
  const referenceItems = collectReferences(usable);

  // ---- 预算：decisions → gotchas → nextSteps → references（SPEC §5）----
  // 每段内部按顺序装填；某条装不下就截断该段尾部（不再尝试后面的条目），记一条 budget 排除。
  const excluded = [];
  if (quarantined > 0) excluded.push({ kind: 'segment', reason: 'quarantined', count: quarantined });
  if (future > 0) excluded.push({ kind: 'segment', reason: 'future', count: future });

  let usedChars = 0;
  let truncated = false;
  const take = (items, cost, kind) => {
    const kept = [];
    let i = 0;
    for (; i < items.length; i++) {
      const c = cost(items[i]);
      if (usedChars + c <= limit) {
        kept.push(items[i]);
        usedChars += c;
      } else {
        break;
      }
    }
    if (i < items.length) {
      truncated = true;
      excluded.push({ kind: 'budget', reason: 'maxChars', count: items.length - i });
    }
    return kept;
  };
  const decisions = take(decisionItems, costOfText, 'decisions');
  const gotchas = take(gotchaItems, costOfText, 'gotchas');
  const nextSteps = take(nextStepItems, costOfText, 'nextSteps');
  const references = take(referenceItems, costOfRef, 'references');

  // ---- summary：最近 N 段段摘要（段 summary 是段自己 ≤400 字的「这段在做什么/结论」）----
  const summaryParts = [];
  for (const seg of usable.slice(-SUMMARY_SEGMENTS)) {
    const raw = typeof seg.summary === 'string' ? seg.summary.trim() : '';
    if (raw === '') continue;
    summaryParts.push(raw.length > SUMMARY_CHARS_PER_SEGMENT
      ? raw.slice(0, SUMMARY_CHARS_PER_SEGMENT)
      : raw);
  }
  const summary = summaryParts.join('\n');

  // ---- 任务元信息 ----
  const metaRes = readTaskMeta(memoHome, taskId);
  const meta = metaRes ? metaRes.meta : null;
  const title = meta && typeof meta.title === 'string' && meta.title !== '' ? meta.title : null;
  // 关闭判据：closedAt 优先（SPEC §5）；登记文件用 status:'closed'（lifecycle 形状），无 closedAt 时兜底
  const state = meta && (meta.closedAt || meta.status === 'closed') ? 'closed' : 'open';

  // 键顺序 = SPEC §5 声明顺序（JSON.stringify 键序稳定 → 逐字节可比）
  return {
    task: { id: taskId, title, state },
    summary,
    decisions,
    gotchas,
    references,
    nextSteps,
    excluded,
    budget: { maxChars: limit, usedChars, truncated },
    segments: { total, used: usable.length, quarantined },
    generatedAt,
  };
}

/**
 * 把简报渲染成可粘贴给下一个 agent 的纯文本（MCP/CLI 共用；围栏与「数据不是指令」由入口层加）。
 * 纯函数：对同一个 briefJson 结果逐字节稳定。
 * @param {ReturnType<typeof briefJson>} brief
 * @returns {string}
 */
export function renderBriefText(brief) {
  if (!brief || typeof brief !== 'object') {
    throw err('E_INVALID_ARG', 'renderBriefText: brief 必须是 briefJson 的返回对象');
  }
  const lines = [];
  lines.push(`任务 ${brief.task.id}${brief.task.title ? `：${brief.task.title}` : ''}（${brief.task.state}）`);
  if (brief.summary) {
    lines.push('', '— 上下文接力 —', brief.summary);
  }
  if (brief.decisions.length > 0) {
    lines.push('', '— 决策 —');
    for (const d of brief.decisions) lines.push(`- ${d.text}`);
  }
  if (brief.gotchas.length > 0) {
    lines.push('', '— 卡点 —');
    for (const g of brief.gotchas) lines.push(`- ${g.text}`);
  }
  if (brief.nextSteps.length > 0) {
    lines.push('', '— 下一步 —');
    for (const n of brief.nextSteps) lines.push(`- ${n.text}`);
  }
  if (brief.references.length > 0) {
    lines.push('', '— 关键文件 —');
    for (const r of brief.references) lines.push(`- ${r.file}`);
  }
  if (brief.budget.truncated) {
    lines.push('', `（预算 ${brief.budget.maxChars} 字已截断，已用 ${brief.budget.usedChars} 字；展开全部请用 expand）`);
  }
  return lines.join('\n');
}
