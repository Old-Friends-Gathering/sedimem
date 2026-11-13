// core/ids.js — ULID 风格 id（契约：26 位 Crockford base32，10 位时间 + 16 位随机）
// 禁止列表下标、禁止自增整数（docs/02 §2 不变式 1）。

import { randomBytes } from 'node:crypto';

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32（无 I L O U）
const ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const TIME_LEN = 10;
const RAND_LEN = 16;
const MAX_TIME = 32n ** BigInt(TIME_LEN); // 32^10
const MAX_RAND = 32n ** BigInt(RAND_LEN); // 32^16

function encodeTime(ms) {
  let t = BigInt(ms);
  if (t < 0n) t = 0n;
  if (t >= MAX_TIME) t = MAX_TIME - 1n;
  let out = '';
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    out = ENCODING[Number(t % 32n)] + out;
    t /= 32n;
  }
  return out;
}

function encodeRand(big) {
  let v = big % MAX_RAND;
  let out = '';
  for (let i = 0; i < RAND_LEN; i++) {
    out = ENCODING[Number(v % 32n)] + out;
    v /= 32n;
  }
  return out;
}

function randomRand() {
  const bytes = randomBytes(10); // 80 bit = 16 chars × 5 bit
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return v % MAX_RAND;
}

// 同毫秒内单调不重复：记住上次的时间与随机数，同毫秒则随机数 +1
let _lastMs = -Infinity;
let _lastRand = -1n;

/**
 * 生成 26 位 ULID 风格 id。
 * @param {number} nowMs 毫秒时间戳（默认 Date.now()）
 * @returns {string} 匹配 /^[0-9A-HJKMNP-TV-Z]{26}$/
 */
export function newId(nowMs = Date.now()) {
  if (!Number.isFinite(nowMs)) {
    const err = new Error(`newId: nowMs must be finite, got ${nowMs}`);
    err.code = 'E_INVALID_RECORD';
    throw err;
  }
  let ms = Math.floor(nowMs);
  let rand;
  if (ms <= _lastMs) {
    // 同毫秒（或时钟回拨）：沿用上次时间戳，随机数自增保证唯一 + 单调
    ms = _lastMs;
    _lastRand = (_lastRand + 1n) % MAX_RAND;
    rand = _lastRand;
  } else {
    rand = randomRand();
  }
  _lastMs = ms;
  _lastRand = rand;
  return encodeTime(ms) + encodeRand(rand);
}

/** s 是否为合法 id */
export function isId(s) {
  return typeof s === 'string' && ID_RE.test(s);
}
