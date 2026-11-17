// llm/derived-store.js — 派生层 sidecar 存储（契约：docs/plans/v1.0.0-refactor.md §2.x）
//
// 派生层是真相层（items/）之外的只读投影：LLM 生成的 title/summary/tags 等
// 展示性内容，全部落在 $MEMO_HOME/derived/<scopeKey>.jsonl，**绝不写 items/**
// （Q15 与 I44：派生前后真相层字节必须不变）。
//
// 文件格式：JSONL，每行一条派生记录。同一 (id, validFrom) 可以出现多行
// （重派生追加新行），读取时「取最后一行」；deriveStatus !== 'ok' 的行视为无派生。
// rebuildDerived 用「写 tmp + rename」原子重写，收敛历史行，幂等。

import path from 'node:path';
import fsp from 'node:fs/promises';
import { scopeKeyOf } from '../config/paths.js';

/** deriveStatus 合法取值（契约） */
export const DERIVE_STATUSES = new Set([
  'ok', 'failed', 'no-provider', 'budget-exceeded', 'privacy-blocked',
]);

/** 派生记录键：`id@validFrom`（validFrom 是 ISO 字符串，不含 @） */
function keyOf(id, validFrom) {
  return `${id}@${validFrom}`;
}

/** 派生 sidecar 文件路径：$MEMO_HOME/derived/<scopeKey>.jsonl */
export function derivedFilePath(memoHome, scope) {
  return path.join(memoHome, 'derived', `${scopeKeyOf(scope)}.jsonl`);
}

/**
 * 逐行解析 JSONL；坏行（半行 JSON / 空行）跳过不抛异常（崩溃残留不阻塞读取）。
 * @param {string} text
 * @returns {object[]}
 */
function parseLines(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === 'object') out.push(obj);
    } catch { /* 坏行：跳过 */ }
  }
  return out;
}

/**
 * 读原始行列表（loadDerived / rebuild 共用）。
 * @param {string} filePath
 * @returns {Promise<object[]>}
 */
async function readRows(filePath) {
  let text = '';
  try {
    text = await fsp.readFile(filePath, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    return []; // 文件不存在 = 无派生
  }
  return parseLines(text);
}

/**
 * 加载派生层：返回 Map，键 `id@validFrom`，值是**最后一行且 deriveStatus === 'ok'** 的记录。
 * 非 ok（failed / no-provider / budget-exceeded / privacy-blocked）视为无派生，不进 Map。
 * @param {{memoHome: string, scope: string}} opts
 * @returns {Promise<Map<string, object>>}
 */
export async function loadDerived({ memoHome, scope } = {}) {
  if (!memoHome || typeof memoHome !== 'string') {
    const err = new Error(`loadDerived: memoHome required, got ${JSON.stringify(memoHome)}`);
    err.code = 'E_INVALID_ARG';
    throw err;
  }
  // 派生 sidecar 是纯投影：坏行（半行 JSON / 未来字段）只跳过，绝不让读端崩溃（I46）。
  const rows = await readRowsTolerant(derivedFilePath(memoHome, scope));
  const latest = new Map();
  for (const row of rows) {
    if (typeof row.id !== 'string' || typeof row.validFrom !== 'string') continue;
    latest.set(keyOf(row.id, row.validFrom), row); // 后行覆盖前行 = 取最后一行
  }
  const out = new Map();
  for (const [key, row] of latest) {
    if (row.deriveStatus === 'ok') out.set(key, row);
  }
  return out;
}

/**
 * 追加一条派生记录（append-only）。字段缺省可省：spo / kindHint / kindMismatch。
 * @param {{memoHome: string, scope: string, record: object}} opts
 *   record: {id, validFrom, promptVersion, model, title, summary, tags,
 *            spo?, kindHint?, kindMismatch?, deriveStatus, ts}
 * @returns {Promise<object>} 落盘的记录（原样）
 */
export async function appendDerived({ memoHome, scope, record } = {}) {
  if (!memoHome || typeof memoHome !== 'string') {
    const err = new Error(`appendDerived: memoHome required, got ${JSON.stringify(memoHome)}`);
    err.code = 'E_INVALID_ARG';
    throw err;
  }
  if (!record || typeof record !== 'object'
    || typeof record.id !== 'string' || typeof record.validFrom !== 'string'
    || !DERIVE_STATUSES.has(record.deriveStatus)) {
    const err = new Error('appendDerived: record 必须含 id/validFrom/deriveStatus(ok|failed|...)');
    err.code = 'E_INVALID_ARG';
    throw err;
  }
  const filePath = derivedFilePath(memoHome, scope);
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.appendFile(filePath, `${JSON.stringify(record)}\n`, 'utf8');
  return record;
}

/**
 * 原子重写派生层：每个 (id, validFrom) 只保留最后一行，写 tmp 后 rename 覆盖。
 * 幂等：对同一份内容重复 rebuild 结果字节相同。绝不触碰 items/ 真相层。
 * @param {{memoHome: string, scope: string}} opts
 * @returns {Promise<{keys: number}>} 收敛后的条目数
 */
export async function rebuildDerived({ memoHome, scope } = {}) {
  if (!memoHome || typeof memoHome !== 'string') {
    const err = new Error(`rebuildDerived: memoHome required, got ${JSON.stringify(memoHome)}`);
    err.code = 'E_INVALID_ARG';
    throw err;
  }
  const filePath = derivedFilePath(memoHome, scope);
  const rows = await readRows(filePath);
  // 收敛：同键取最后一行（含非 ok 行——它们是审计事实，rebuild 不丢历史结论）
  const latest = new Map();
  for (const row of rows) {
    if (typeof row.id !== 'string' || typeof row.validFrom !== 'string') continue;
    latest.set(keyOf(row.id, row.validFrom), row);
  }
  const tmpPath = `${filePath}.tmp`;
  const body = [...latest.values()].map((r) => `${JSON.stringify(r)}\n`).join('');
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(tmpPath, body, 'utf8');
  await fsp.rename(tmpPath, filePath); // 同目录 rename：原子替换
  return { keys: latest.size };
}

/**
 * 容错读取：坏行跳过并计数（派生层损坏可由 rebuild 重建，不值得 fail-loud）。
 * @param {string} file 派生 sidecar 路径
 * @returns {Promise<object[]>}
 */
async function readRowsTolerant(file) {
  let text;
  try {
    text = await fsp.readFile(file, "utf8");
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const row = JSON.parse(t);
      if (row && typeof row === 'object') out.push(row);
    } catch { /* 坏行跳过 */ }
  }
  return out;
}
