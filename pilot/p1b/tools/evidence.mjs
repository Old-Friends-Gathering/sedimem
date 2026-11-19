// evidence.mjs —— R3「证据存在」的真实实现（P1b 管线，非桩）
// 规格：docs/design/v2.0/09-extraction-pipeline.md §3（五条机判）、§4（stale / 禁 fuzzy re-anchor）
// 设计约束：
//   1. 一切偏移按**码点**计数（Array.from），不混用 UTF-16 indexOf；
//   2. span 边界必须落在码点边界上（否则 span-splits-surrogate）；
//   3. quote 必须唯一可定位（出现两次即 ambiguous，不做相似度兜底）；
//   4. 快照存在则必须 hash 一致；快照缺失不得静默放行（snapshot-missing → 上层转 stale 路径）；
//   5. 失败项逐条给出 eventId + reason，绝不吞异常。
import { createHash } from 'node:crypto';

export const QUOTE_MAX_CHARS = 200;

export function hashText(text) {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

export function codePoints(text) {
  return Array.from(text);
}

export function codePointLength(text) {
  return codePoints(text).length;
}

export function sliceByCodePoints(text, start, end) {
  return codePoints(text).slice(start, end).join('');
}

// UTF-16 偏移是否落在码点边界（防半个代理对）
export function isCodePointBoundary(text, utf16Index) {
  if (utf16Index <= 0 || utf16Index >= text.length) return true;
  const code = text.charCodeAt(utf16Index);
  return !(code >= 0xdc00 && code <= 0xdfff);
}

// 把 UTF-16 偏移换算成码点偏移；越界或切半返回 null
export function utf16ToCodePointOffset(text, utf16Index) {
  if (utf16Index < 0) return null;
  if (utf16Index > text.length) return 'out-of-range';
  if (!isCodePointBoundary(text, utf16Index)) return null;
  return codePointLength(text.slice(0, utf16Index));
}

// 唯一位置查找：返回码点 span；0 次 → not-found，≥2 次 → ambiguous
function locateUnique(text, quote) {
  const hay = codePoints(text);
  const needle = codePoints(quote);
  if (needle.length === 0) return { kind: 'empty' };
  const hits = [];
  outer: for (let i = 0; i + needle.length <= hay.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (hay[i + j] !== needle[j]) continue outer;
    }
    hits.push(i);
    if (hits.length > 1) return { kind: 'ambiguous', count: hits.length };
  }
  if (hits.length === 0) return { kind: 'not-found' };
  return { kind: 'ok', start: hits[0], end: hits[0] + needle.length };
}

// 快照存储：sourceId + sourceEpoch + eventId → 文本 hash（内存实现，P1b 阶段）
export function createSnapshotStore(seed = []) {
  const map = new Map();
  const key = (sourceId, sourceEpoch, eventId) => `${sourceId}\u0000${sourceEpoch}\u0000${eventId}`;
  return {
    put({ sourceId, sourceEpoch, eventId, text }) {
      map.set(key(sourceId, sourceEpoch, eventId), { hash: hashText(text), sourceId, sourceEpoch, eventId });
    },
    get({ sourceId, sourceEpoch, eventId }) {
      return map.get(key(sourceId, sourceEpoch, eventId)) ?? null;
    },
    size() {
      return map.size;
    },
    keys() {
      return [...map.keys()];
    },
    _seed: seed,
  };
}

/**
 * 解析并校验一条（或一组）候选证据。
 * @returns {{ok: boolean, evidence: object[], failures: object[]}}
 *   evidence[i] = {eventId, quote, span:{start,end}, hash, role, ts, snapshotHash}
 *   failures[i] = {eventId, reason, detail?}
 */
export function resolveEvidence({
  events,
  evidence = [],
  snapshots = null,
  sourceId = null,
  sourceEpoch = null,
}) {
  const out = [];
  const failures = [];

  for (const ev of evidence) {
    const event = events instanceof Map ? events.get(ev.eventId) : events?.[ev.eventId];
    if (!event) {
      failures.push({ eventId: ev.eventId, reason: 'event-missing' });
      continue;
    }
    const text = event.text ?? '';
    const quote = ev.quote ?? '';

    const quoteLen = codePointLength(quote);
    if (quoteLen === 0) {
      failures.push({ eventId: ev.eventId, reason: 'quote-empty' });
      continue;
    }
    if (quoteLen > QUOTE_MAX_CHARS) {
      failures.push({ eventId: ev.eventId, reason: 'quote-too-long', detail: `${quoteLen}>${QUOTE_MAX_CHARS}` });
      continue;
    }

    // span：优先用候选给的（UTF-16 语义），否则唯一查找
    let span;
    if (ev.span && typeof ev.span.start === 'number' && typeof ev.span.end === 'number') {
      const startCp = utf16ToCodePointOffset(text, ev.span.start);
      const endCp = utf16ToCodePointOffset(text, ev.span.end);
      if (startCp === 'out-of-range' || endCp === 'out-of-range') {
        failures.push({ eventId: ev.eventId, reason: 'span-out-of-range', detail: JSON.stringify(ev.span) });
        continue;
      }
      if (startCp === null || endCp === null) {
        failures.push({ eventId: ev.eventId, reason: 'span-splits-surrogate', detail: JSON.stringify(ev.span) });
        continue;
      }
      if (endCp < startCp || endCp > codePointLength(text)) {
        failures.push({ eventId: ev.eventId, reason: 'span-out-of-range', detail: JSON.stringify(ev.span) });
        continue;
      }
      span = { start: startCp, end: endCp };
      const sliced = sliceByCodePoints(text, span.start, span.end);
      if (!sliced.startsWith(quote)) {
        failures.push({ eventId: ev.eventId, reason: 'quote-span-mismatch', detail: sliced.slice(0, 40) });
        continue;
      }
    } else {
      const located = locateUnique(text, quote);
      if (located.kind === 'not-found') {
        failures.push({ eventId: ev.eventId, reason: 'quote-not-found' });
        continue;
      }
      if (located.kind === 'ambiguous') {
        failures.push({ eventId: ev.eventId, reason: 'quote-ambiguous', detail: String(located.count) });
        continue;
      }
      if (located.kind === 'empty') {
        failures.push({ eventId: ev.eventId, reason: 'quote-empty' });
        continue;
      }
      span = { start: located.start, end: located.end };
    }

    const hash = hashText(text);
    let snapshotHash = null;
    if (snapshots) {
      const snap = snapshots.get({ sourceId, sourceEpoch, eventId: ev.eventId });
      if (!snap) {
        failures.push({ eventId: ev.eventId, reason: 'snapshot-missing' });
        continue;
      }
      snapshotHash = snap.hash;
      if (snap.hash !== hash) {
        failures.push({
          eventId: ev.eventId,
          reason: 'stale-snapshot',
          detail: `${snap.hash.slice(0, 18)}≠${hash.slice(0, 18)}`,
        });
        continue;
      }
    }

    out.push({
      eventId: ev.eventId,
      quote,
      span,
      hash,
      role: event.role ?? null,
      ts: event.ts ?? null,
      snapshotHash,
    });
  }

  return { ok: failures.length === 0 && out.length > 0, evidence: out, failures };
}
