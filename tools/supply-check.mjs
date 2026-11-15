#!/usr/bin/env node
// tools/supply-check.mjs — G6 供应链最小检查（P0a）
//
// 目标不是替代 npm audit，而是钉住「单人可维护」的最小供应链事实：
// 1) 根 workspace 与单一 lockfile 存在；
// 2) 每个 workspace 都没有 install 生命周期脚本（防止 npm ci 时执行任意代码）；
// 3) 声明了 dependencies 的 workspace 必须出现在 lockfile 里（避免 lockfile 漂移）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

const rootPkg = readJson(path.join(ROOT, 'package.json'));
if (!Array.isArray(rootPkg.workspaces) || rootPkg.workspaces.length === 0) {
  problems.push('根 package.json 缺少 workspaces');
}
const lockPath = path.join(ROOT, 'package-lock.json');
if (!fs.existsSync(lockPath)) {
  problems.push('缺少 package-lock.json（应提交单一 lockfile）');
} else {
  const lock = readJson(lockPath);
  if (lock.lockfileVersion !== 3) problems.push(`lockfileVersion=${lock.lockfileVersion}，期望 3`);
  for (const ws of rootPkg.workspaces ?? []) {
    const dir = path.join(ROOT, ws);
    const pkgPath = path.join(dir, 'package.json');
    if (!fs.existsSync(pkgPath)) { problems.push(`${ws}: 缺少 package.json`); continue; }
    const pkg = readJson(pkgPath);
    for (const s of ['preinstall', 'install', 'postinstall']) {
      if (pkg.scripts?.[s]) problems.push(`${ws}: 禁止 ${s} 生命周期脚本（npm ci 会执行）`);
    }
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.optionalDependencies ?? {}) };
    if (Object.keys(deps).length > 0 && !lock.packages?.[ws]?.dependencies) {
      problems.push(`${ws}: 有 dependencies 但 lockfile 未记录（先跑 npm install --package-lock-only）`);
    }
  }
}

if (problems.length) {
  console.error(`❌ supply-check: ${problems.length} 个问题`);
  for (const p of problems) console.error(`  [${p}]`);
  process.exit(1);
}
console.log('✅ supply-check: workspace + lockfile + 无 install 脚本');
