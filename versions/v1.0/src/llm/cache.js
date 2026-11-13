// llm/cache.js — LLM 响应缓存（契约：docs/plans/v1.0.0-refactor.md §2.1，审核 C2 修复）
//
// $MEMO_HOME/llm/cache.jsonl，append-only，每行 { key, value, ts }。
// 读时取最后一条同 key；文件超 2000 行只扫尾部 2000 行，写入超 2000 行触发一次
// compact（tmp + rename 原子重写，保留最新 2000 条）。

import { createHash } from 'node:crypto';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { withPathLock, atomicWriteFile } from './lock.js';

const CACHE_MAX_LINES = 2000;

/**
 * 缓存键：sha256(model|promptVersion|purpose|input)
 * @param {string} model  模型名
 * @param {string} promptVersion  prompt 版本号（prompt 变更即自然失效）
 * @param {string} purpose  用途（derive/curate/checkpoint/brief）
 * @param {string} input  归一化输入文本
 * @returns {string} 64 位 hex
 */
export function cacheKey(model, promptVersion, purpose, input) {
  return createHash('sha256').update(`${model}|${promptVersion}|${purpose}|${input}`).digest('hex');
}

function cachePaths(memoHome) {
  const dir = path.join(memoHome, 'llm');
  return { dir, file: path.join(dir, 'cache.jsonl'), lock: 'cache.lock' };
}

/** 解析 JSONL 为行对象数组（坏行跳过，append-only 容忍半行写入） */
function parseLines(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* 坏行跳过 */ }
  }
  return out;
}

/**
 * 读缓存：取最后一条同 key 的记录；文件超 2000 行只扫尾部 2000 行。
 * @param {string} memoHome
 * @param {string} key  cacheKey(...) 结果
 * @returns {Promise<{key:string, value:any, ts:number}|null>} 未命中返回 null
 */
export async function readCache(memoHome, key) {
  const { file } = cachePaths(memoHome);
  let text = '';
  try { text = await fsp.readFile(file, 'utf8'); } catch { return null; } // 文件不存在：未命中
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  const tail = lines.length > CACHE_MAX_LINES ? lines.slice(-CACHE_MAX_LINES) : lines;
  let hit = null;
  for (const line of tail) { // 顺序扫，后者覆盖 → 天然取最后一条同 key
    let entry = null;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry && entry.key === key) hit = entry;
  }
  return hit ? { key: hit.key, value: hit.value, ts: hit.ts } : null;
}

/**
 * 写缓存：append 一行；若写入后超过 2000 行，触发一次 compact（原子重写保留最新 2000 条）。
 * @param {string} memoHome
 * @param {string} key
 * @param {any} value  缓存值（complete 成功结果的对象，由调用方组装）
 * @param {{clock?: () => number, compacted?: (n:number) => void}} [opts]
 *   clock 注入时间戳；compacted 仅测试用（compact 发生时回调条数）
 */
export async function writeCache(memoHome, key, value, opts = {}) {
  const { dir, file, lock } = cachePaths(memoHome);
  const ts = typeof opts.clock === 'function' ? opts.clock() : Date.now();

  return withPathLock(dir, lock, async () => {
    const entry = JSON.stringify({ key, value, ts }) + '\n';
    await fsp.mkdir(dir, { recursive: true });
    await fsp.appendFile(file, entry);

    // 超 2000 行：compact 一次（原子重写，保留最新 2000 条）
    let text = '';
    try { text = await fsp.readFile(file, 'utf8'); } catch { text = ''; }
    const lines = text.split('\n').filter((l) => l.trim() !== '');
    if (lines.length > CACHE_MAX_LINES) {
      const kept = lines.slice(-CACHE_MAX_LINES).join('\n') + '\n';
      await atomicWriteFile(file, kept);
      if (typeof opts.compacted === 'function') opts.compacted(CACHE_MAX_LINES);
    }
    return { key, value, ts };
  });
}
