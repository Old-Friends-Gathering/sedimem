// storage/audit.js — events.jsonl 的审计链（B5 审计统一，v1.4）
//
// 设计目标（docs/02 §3.24）：
//  - 每条事件都带 `kind`（与 op 同值，便于按类别过滤）、`seq`（单调递增）、
//    `prevHash`（上一条事件的 hash）与 `hash`（本条内容的 sha256）。
//  - 链只做**本地可验证的防篡改**：改中间一行而不重算后面所有 hash 会被 verify 发现。
//  - 明确边界：**不抗同 UID 重算**——能重写 events.jsonl 的同一用户当然也能重算整条链；
//    要抗这一点只能把链头锚到外部（git 提交 / 远端），本模块只提供可选的本地文件锚。
//  - 兼容旧事件：老行没有 seq/hash，链在它之后重新起头，verify 把老行当作未链接前缀，
//    从第一条带 hash 的事件开始校验（不会把升级前的库判成损坏）。
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

/** 读链头时最多回看的字节数（事件行远小于这个量级；detail 再大也不会截断头部）。 */
const HEAD_TAIL_BYTES = 256 * 1024;

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * 事件内容 hash：覆盖除 `hash` 自身以外的全部字段。
 * 为什么用 JSON.stringify 而不是排序键：写入与读回都由本模块/JSON.parse 保证
 * 字段顺序一致（V8 保持插入顺序），且事件由我们自己构造，没有外部对象进来。
 * @param {object} event
 * @returns {string} `sha256:<hex>`
 */
export function eventHash(event) {
  const { hash: _ignored, ...rest } = event ?? {};
  return `sha256:${sha256(JSON.stringify(rest))}`;
}

/**
 * 给事件补上审计链字段。`prev` 是 events.jsonl 的最后一条（可为旧格式/ null）。
 * @param {object} event 至少含 ts/op/scope/id/detail
 * @param {object|null} prev
 * @returns {object} 新对象，不修改入参
 */
export function withAuditFields(event, prev) {
  const base = { ...event };
  if (typeof base.kind !== 'string' || base.kind === '') {
    base.kind = typeof base.op === 'string' && base.op !== '' ? base.op : 'unknown';
  }
  const prevSeq = Number.isInteger(prev?.seq) ? prev.seq : 0;
  base.seq = prevSeq + 1;
  base.prevHash = prev ? eventHash(prev) : null;
  return { ...base, hash: eventHash(base) };
}

/**
 * 读 events.jsonl 的最后一条完整事件（链头）。文件不存在/为空/坏行 → null。
 * 只读尾部：事件文件是追加型审计面，可能很大，不能每次 append 全量读。
 * @param {string} eventsPath
 * @returns {Promise<object|null>}
 */
function parseHead(raw, start) {
  let text = raw;
  // 从中间切进去时第一行可能是半截：丢掉它（除非确实从头读）
  if (start > 0) {
    const nl = text.indexOf('\n');
    text = nl === -1 ? '' : text.slice(nl + 1);
  }
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  // 从尾部找第一条能解析的完整事件：末尾半行（进程崩溃/并发写）不能当链头。
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const ev = JSON.parse(lines[i]);
      if (ev && typeof ev === 'object') return ev;
    } catch {
      continue;
    }
  }
  return null;
}

export async function readAuditHead(eventsPath) {
  let fh;
  try {
    fh = await fsp.open(eventsPath, 'r');
    const st = await fh.stat();
    if (st.size === 0) return null;
    const start = Math.max(0, st.size - HEAD_TAIL_BYTES);
    const len = st.size - start;
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, start);
    return parseHead(buf.toString('utf8'), start);
  } catch {
    return null; // 坏尾行 / ENOENT / 读失败 → 链从 null 重新起头，不阻断主流程
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

/**
 * 同步版链头读取（给无法 await 的同步 API 用，如 removeSession）。
 * @param {string} eventsPath
 * @returns {object|null}
 */
export function readAuditHeadSync(eventsPath) {
  let fd;
  try {
    fd = fs.openSync(eventsPath, 'r');
    const st = fs.fstatSync(fd);
    if (st.size === 0) return null;
    const start = Math.max(0, st.size - HEAD_TAIL_BYTES);
    const len = st.size - start;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    return parseHead(buf.toString('utf8'), start);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

/**
 * 同步追加一条带链字段的事件（统一审计用；调用方需接受与该路径其它写者的并发风险）。
 * @param {string} eventsPath
 * @param {object} event
 * @returns {object} 实际写入的事件
 */
export function appendAuditedEventSync(eventsPath, event) {
  const prev = readAuditHeadSync(eventsPath);
  const audited = withAuditFields(event, prev);
  fs.appendFileSync(eventsPath, `${JSON.stringify(audited)}\n`);
  return audited;
}

/**
 * 校验审计链。未链接的旧事件作为前缀跳过，但链头仍以它为 prev（见 withAuditFields）。
 * @param {object[]} events 按文件顺序（旧 → 新）
 * @returns {{ok: boolean, chained: number, broken: {index: number, reason: string}[]}}
 */
export function verifyEventChain(events) {
  const broken = [];
  let prev = null;
  let chained = 0;
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (!ev || typeof ev !== 'object') {
      broken.push({ index: i, reason: 'not-object' });
      continue;
    }
    if (typeof ev.hash !== 'string') {
      // 升级前/外部写入的旧事件：不校验，但它是下一条的 prev
      prev = ev;
      continue;
    }
    chained += 1;
    const expectedPrev = prev ? eventHash(prev) : null;
    if (ev.prevHash !== expectedPrev) broken.push({ index: i, reason: 'prevHash' });
    if (eventHash(ev) !== ev.hash) broken.push({ index: i, reason: 'hash' });
    const expectedSeq = Number.isInteger(prev?.seq) ? prev.seq + 1 : 1;
    if (ev.seq !== expectedSeq) broken.push({ index: i, reason: 'seq' });
    prev = ev;
  }
  return { ok: broken.length === 0, chained, broken };
}

/**
 * 写一个可选链头锚文件（`<memoHome>/events.anchor.json`）。锚文件本身不进链。
 * 注意：仍不抗同 UID 重算——它只是「上次确认到哪」的本地检查点，配合 git 提交才有外部时间戳。
 * @param {{memoHome: string, events: object[], now?: string}} args
 * @returns {Promise<{path: string, chainHead: string|null, count: number, chained: number}>}
 */
export async function writeAnchor({ memoHome, events, now }) {
  const last = events[events.length - 1] ?? null;
  const verify = verifyEventChain(events);
  const anchor = {
    anchorVersion: 1,
    at: now ?? new Date().toISOString(),
    count: events.length,
    chained: verify.chained,
    chainHead: last ? eventHash(last) : null,
    lastSeq: Number.isInteger(last?.seq) ? last.seq : null,
    note: '本地锚：只证明「上次确认到这条」；不抗同 UID 重算，要外部时间戳请把本文件一起 git commit（不 push）。',
  };
  const file = path.join(memoHome, 'events.anchor.json');
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(anchor, null, 2)}\n`, 'utf8');
  await fsp.rename(tmp, file);
  return { path: file, chainHead: anchor.chainHead, count: anchor.count, chained: anchor.chained };
}
