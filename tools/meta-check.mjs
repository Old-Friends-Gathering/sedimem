#!/usr/bin/env node
// tools/meta-check.mjs — 版本真值元检查（P0a）
//
// 为什么单独一个脚本：CI 与门禁脚本里写死 `versions/v0.3` 会让「当前版本」形同虚设，
// 而且这类错误不会让任何测试变红。这里只钉一件事：除 `versions/CURRENT` 外，
// 任何 `versions/vX.Y` 字面量（含 path.join 写法）都必须显式登记并带到期日。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET_DIRS = ['.github/workflows', 'tools', 'plugin/dsh-sedimem'];
const EXT = new Set(['.yml', '.yaml', '.mjs', '.js', '.sh', '.md', '.json']);
const ALLOW = [
  { prefix: 'tools/meta-check.mjs', reason: '检查器自身需要写出模式', until: '2027-01-31' },
  { prefix: 'plugin/dsh-sedimem/', reason: '已发布插件冻结在 v0.3 契约，P0b 迁移前豁免', until: '2027-01-31' },
];
const PATTERNS = [
  /versions\/(v\d+\.\d+)/g,
  /['"]versions['"]\s*,\s*['"](v\d+\.\d+)['"]/g,
];

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (EXT.has(path.extname(ent.name))) out.push(p);
  }
  return out;
}

function stripBlockComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

function stripLineComment(line, ext) {
  const s = line.trim();
  if (s.startsWith('#') || s.startsWith('//')) return '';
  if (ext === '.yml' || ext === '.yaml') return line.replace(/\s+#.*$/, '');
  return line.replace(/\s\/\/.*$/, '');
}

function allowed(rel) {
  const hit = ALLOW.find((a) => rel === a.prefix || rel.startsWith(a.prefix));
  if (!hit) return null;
  if (new Date(hit.until) < new Date()) return { expired: true, ...hit };
  return hit;
}

const findings = [];
for (const dir of TARGET_DIRS) {
  for (const abs of walk(path.join(ROOT, dir))) {
    const rel = path.relative(ROOT, abs).split(path.sep).join('/');
    const hit = allowed(rel);
    if (hit && !hit.expired) continue;
    if (hit?.expired) findings.push(`${rel}: allowlist 已过期（${hit.until}）`);
    const text = stripBlockComments(fs.readFileSync(abs, 'utf8'));
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      const code = stripLineComment(line, path.extname(rel));
      for (const re of PATTERNS) {
        for (const m of code.matchAll(re)) {
          findings.push(`${rel}:${i + 1} 出现 ${m[0]}（应读 versions/CURRENT）`);
        }
      }
    });
  }
}

if (findings.length) {
  console.error(`❌ meta-check: ${findings.length} 处写死版本/过期豁免`);
  for (const f of findings) console.error(`  [${f}]`);
  process.exit(1);
}
console.log('✅ meta-check: CI 与门禁脚本未写死版本目录');
