// hygiene/redact.js — 入库脱敏（D7，契约：docs/plans/v0.4-competitive-gaps.md §D7）
// 单向：命中处替换为 `[REDACTED:<kind>]`，原文不落盘（调用方保证脱敏先于 hash/写盘）。
// 幂等：已含 `[REDACTED:` 的片段按占位符切段后再跑正则，绝不二次匹配。

/** 支持的脱敏类别（顺序即优先级：高特异性先匹配） */
export const REDACT_KINDS = [
  'private_key',
  'jwt',
  'github_token',
  'aws_key',
  'api_key',
  'internal_host',
  'assignment',
];

/** 占位符切分：捕获组让占位符自成一段（保护段） */
const PLACEHOLDER_SPLIT = /(\[REDACTED:[a-z_]+\])/g;

/** 各 kind 的正则（assignment 特殊：只替换捕获组 2 的值部分） */
const PATTERNS = {
  // -----BEGIN ... PRIVATE KEY----- 整块（含 RSA/EC/OPENSSH/ENCRYPTED 等变体）
  private_key: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  // eyJ 三段点分（JWT / Bearer token）
  jwt: /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  // ghp_/gho_/ghu_/ghs_/ghr_ + 至少 20 位
  github_token: /gh[pousr]_[A-Za-z0-9]{20,}/g,
  // AKIA + 16 位大写字母数字
  aws_key: /AKIA[0-9A-Z]{16}/g,
  // sk- 长 token（≥20 位，天然排除 sk-learn 这类短词）
  api_key: /sk-[A-Za-z0-9_-]{20,}/g,
  // 内网 IP：10. / 192.168. / 172.16-31. 开头的完整 IPv4，可带端口
  internal_host: /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(?::\d{1,5})?\b/g,
  // key=value / "key": "value" / DB_PASSWORD=… 形式，**只遮值**。
  // 对抗审核 B-4 实测的三类漏网：`"password":"x"`（key 后紧跟引号）、`DB_PASSWORD=x`
  // （key 前有 `_` 时 \b 不成立）、嵌套 JSON（同上）。因此 key 允许 `[A-Za-z0-9_]` 前缀，
  // 分隔符前允许一个关闭引号，值可带一个开启引号——匹配必须**以值结尾**，
  // 这样脱敏函数里「截掉尾部 value 长度」的替换才成立。
  assignment: /([A-Za-z0-9_]{0,32}(?:password|passwd|pwd|secret|token|api_key))\b["']?\s*[:=]\s*(["']?)([^"'\s,}]{6,})/gi,
};

/**
 * 文本脱敏。
 * @param {string} text 原文
 * @param {{policy?: {redact?: {kinds?: string[]}}}[]} [opts] 配置从 opts 传入（policy.redact.kinds 可选白名单）
 * @returns {{text: string, redactions: Array<{kind: string, count: number}>, changed: boolean}}
 * @throws {Error} err.code='E_INVALID_ARG'（text 非字符串 / kinds 含未知类别）
 */
export function redactText(text, { policy } = {}) {
  if (typeof text !== 'string') {
    const err = new Error(`redactText: text must be a string, got ${typeof text}`);
    err.code = 'E_INVALID_ARG';
    throw err;
  }
  let kinds = REDACT_KINDS;
  const allow = policy?.redact?.kinds;
  if (allow !== undefined) {
    if (!Array.isArray(allow) || allow.some((k) => !REDACT_KINDS.includes(k))) {
      const err = new Error(`redactText: policy.redact.kinds must be an array drawn from [${REDACT_KINDS.join(', ')}]`);
      err.code = 'E_INVALID_ARG';
      throw err;
    }
    kinds = REDACT_KINDS.filter((k) => allow.includes(k));
  }

  const counts = new Map();
  let out = text;
  for (const kind of kinds) {
    // 关键幂等步骤：先按占位符切段，正则只作用于非占位符段
    const parts = out.split(PLACEHOLDER_SPLIT);
    for (let i = 0; i < parts.length; i += 2) { // 偶数下标 = 非保护段
      parts[i] = parts[i].replace(PATTERNS[kind], (...args) => {
        counts.set(kind, (counts.get(kind) ?? 0) + 1);
        if (kind === 'assignment') {
          // 只遮值：保留 key、分隔符与引号，替换第 3 个捕获组（1=key, 2=开启引号, 3=值）
          const match = args[0];
          const value = args[3];
          return match.slice(0, match.length - value.length) + `[REDACTED:${kind}]`;
        }
        return `[REDACTED:${kind}]`;
      });
    }
    out = parts.join('');
  }

  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  return {
    text: out,
    redactions: [...counts.entries()].map(([kind, count]) => ({ kind, count })),
    changed: total > 0,
  };
}
