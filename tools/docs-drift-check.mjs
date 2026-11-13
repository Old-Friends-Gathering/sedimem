#!/usr/bin/env node
// 文档漂移门禁：docs/11-doc-governance.md 的 Q14 六条检查（R1–R6）。
// 零依赖，只用 node: 内置模块。
import fs from 'node:fs';
import path from 'node:path';

// 递归扫描时整体跳过的目录（历史/调研/营销类冻结文档）
const DOCS_SKIP_DIRS = ['research', 'plans', 'marketing'];

// R6：代码注释不得引用的已删除文档 → 应改指的 docs/02 附录
const DELETED_DOC_REFS = [
  { ref: 'docs/09-sqlite-index', appendix: 'A' },
  { ref: 'docs/10-curate-auto', appendix: 'B' },
];

// adr-*.md 只豁免 R2/R3/R4/R5（内容冻结），R1 头部元信息仍要查
function isContentExempt(rel) {
  return path.basename(rel).startsWith('adr-');
}

// 递归遍历 docs/ 下所有 *.md；豁免目录（research/plans/marketing）整体跳过，
// 其余子目录一律扫描（子目录不能再作为绕过口）。
function listDocs(root) {
  const dir = path.join(root, 'docs');
  const out = [];
  if (!fs.existsSync(dir)) return out;
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        const relDir = path.relative(dir, p).split(path.sep).join('/');
        if (DOCS_SKIP_DIRS.includes(relDir)) continue;
        walk(p);
      } else if (e.isFile() && e.name.endsWith('.md')) {
        out.push(p);
      }
    }
  })(dir);
  return out;
}

function readSafe(file) {
  try {
    return { text: fs.readFileSync(file, 'utf8'), err: null };
  } catch (e) {
    return { text: '', err: e.message };
  }
}

// ── allowlist ──────────────────────────────────────────────────────
function loadAllowlist(root, findings) {
  const file = path.join(root, 'tools', 'docs-drift-allowlist.json');
  if (!fs.existsSync(file)) return [];
  const { text, err } = readSafe(file);
  if (err) { findings.push({ rule: 'ALLOWLIST', file: 'tools/docs-drift-allowlist.json', line: 0, message: `allowlist 读取失败: ${err}` }); return []; }
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed.entries)) throw new Error('缺少 entries 数组');
    // 逐条校验 reason / until：非法条目报 ALLOWLIST 且不生效（不允许静默豁免）
    const valid = [];
    for (const [i, e] of parsed.entries.entries()) {
      const bad = [];
      if (typeof e.reason !== 'string' || e.reason.trim() === '') bad.push('reason 为空');
      if (typeof e.until !== 'string' || Number.isNaN(new Date(e.until).getTime())) bad.push('until 不可解析');
      if (bad.length > 0) {
        findings.push({ rule: 'ALLOWLIST', file: 'tools/docs-drift-allowlist.json', line: i + 1, message: `豁免条目非法（${bad.join('；')}），该条豁免不生效：file=${e.file} rule=${e.rule}` });
        continue;
      }
      valid.push(e);
    }
    return valid;
  } catch (e) {
    findings.push({ rule: 'ALLOWLIST', file: 'tools/docs-drift-allowlist.json', line: 0, message: `allowlist JSON 非法: ${e.message}` });
    return [];
  }
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function allowlisted(rel, rule, line, message, entries, findings) {
  const today = todayStr();
  let matched = false;
  for (const [i, e] of entries.entries()) {
    if (e.rule !== rule || e.file !== rel) continue;
    if (typeof e.until === 'string' && e.until < today) {
      findings.push({ rule: 'ALLOWLIST_EXPIRED', file: 'tools/docs-drift-allowlist.json', line: i + 1, message: `豁免已过期（until=${e.until}），file=${e.file} rule=${rule}，请删除或续期` });
      continue;
    }
    if (e.pattern && !matchPattern(rel, line, message, e.pattern)) continue;
    matched = true;
  }
  return matched;
}

function matchPattern(rel, line, message, pattern) {
  const haystack = `${rel}:${line} ${message ?? ''}`;
  // 精确 "file:line" 形式才短路放行；pattern 里碰巧含行号数字不再误放行
  if (pattern === `${rel}:${line}`) return true;
  try { return new RegExp(pattern).test(haystack); } catch { return haystack.includes(pattern); }
}

// ── 基准事实 ────────────────────────────────────────────────────────
function readCurrent(root, findings) {
  const { text, err } = readSafe(path.join(root, 'versions', 'CURRENT'));
  if (err) { findings.push({ rule: 'FACT', file: 'versions/CURRENT', line: 0, message: `无法读取 versions/CURRENT: ${err}` }); return null; }
  const cur = text.trim();
  if (!/^v\d+\.\d+$/.test(cur)) { findings.push({ rule: 'FACT', file: 'versions/CURRENT', line: 0, message: `versions/CURRENT 内容异常: "${cur}"` }); return null; }
  return cur; // 如 "v0.6"
}

// 从 eval/run.js 文本解析 CASE_FILES 数组条数（不 import）
function countCaseFiles(root, cur, findings) {
  const file = path.join(root, 'versions', cur, 'eval', 'run.js');
  const { text, err } = readSafe(file);
  if (err) {
    findings.push({ rule: 'FACT', file: path.relative(root, file), line: 0, message: `无法读取 eval/run.js: ${err}` });
    return null;
  }
  const m = text.match(/const\s+CASE_FILES\s*=\s*\[([\s\S]*?)\];/);
  if (!m) {
    findings.push({ rule: 'FACT', file: path.relative(root, file), line: 0, message: '未找到 CASE_FILES 数组' });
    return null;
  }
  // 每条形如 ['I1', 'i1-duplicate.test.js'] 的二元组
  const count = (m[1].match(/\[\s*['"][^'"]+['"]\s*,\s*['"][^'"]+['"]\s*\]/g) || []).length;
  return count;
}

// 从 quality-check.mjs 抓 Q 编号最大值
function maxQNumber(root, findings) {
  const { text, err } = readSafe(path.join(root, 'tools', 'quality-check.mjs'));
  if (err) { findings.push({ rule: 'FACT', file: 'tools/quality-check.mjs', line: 0, message: `无法读取 quality-check.mjs: ${err}` }); return null; }
  // 用「不同的 Q 编号个数」而不是最大值：Q12/Q13 是预留号，跳号不代表少一项
  const ids = new Set();
  for (const m of text.matchAll(/\bQ(\d+)\b/g)) ids.add(Number(m[1]));
  return ids.size || null;
}

// 从文本抓测试数：认「N tests」「tests-N badge」「N 个测试」「N 用例」四种写法
function grabTestCounts(text) {
  const out = [];
  for (const m of text.matchAll(/(\d+)\s*tests/gi)) out.push(Number(m[1]));
  for (const m of text.matchAll(/tests[-=](\d+)/gi)) out.push(Number(m[1]));
  for (const m of text.matchAll(/(\d+)\s*个测试/g)) out.push(Number(m[1]));
  for (const m of text.matchAll(/(\d+)\s*用例/g)) out.push(Number(m[1]));
  return out;
}

// 抓文件里**所有** I1–IN 声明（分隔符认 – - ～ ~ 至），逐个返回 N
function grabIRanges(text) {
  const out = [];
  for (const m of text.matchAll(/I1\s*[–\-～~至]\s*I?(\d+)/g)) out.push(Number(m[1]));
  return out;
}

// ── 主检查 ─────────────────────────────────────────────────────────
export const DEFAULT_RULES = ['R1', 'R2', 'R3', 'R4', 'R5', 'R6'];

export function checkDocs({ root } = {}) {
  root = root || process.cwd();
  const findings = [];
  const checked = { docs: 0, readme: false, current: null, caseFiles: null, maxQ: null };

  const cur = readCurrent(root, findings);
  const curMinor = cur ? cur.slice(1) : null;
  checked.current = cur;
  const caseCount = cur ? countCaseFiles(root, cur, findings) : null;
  checked.caseFiles = caseCount;
  const qmax = maxQNumber(root, findings);
  checked.maxQ = qmax;

  const allow = loadAllowlist(root, findings);
  const r4State = {};

  const mdFiles = [...listDocs(root), path.join(root, 'README.md')];
  for (const abs of mdFiles) {
    const rel = path.relative(root, abs);
    if (rel === 'README.md') checked.readme = true;
    checked.docs++;
    const { text, err } = readSafe(abs);
    if (err) { findings.push({ rule: 'R1', file: rel, line: 0, message: `文件读取失败: ${err}` }); continue; }
    const lines = text.split('\n');
    const findLine = (re) => lines.findIndex((l) => re.test(l)) + 1;
    const kindM = text.match(/^>\s*doc-kind:\s*(contract|manual|history)\s*$/m);
    const verM = text.match(/^>\s*doc-version:\s*(\d+\.\d+)\s*$/m);
    const kind = kindM ? kindM[1] : null;
    // adr-*.md 内容冻结：只豁免 R2–R5，R1 头部元信息仍要查
    const contentExempt = isContentExempt(rel);

    // R1 头部元信息缺失（history 可选）
    if (kind !== 'history' && (!kindM || !verM)) {
      const ln = findLine(/^>\s*doc-(kind|version):/) || 2;
      findings.push({ rule: 'R1', file: rel, line: ln, message: `缺头部元信息（${!kindM ? 'doc-kind' : 'doc-version'}）——contract/manual 必须有` });
    }
    if (kind === 'history' || contentExempt) continue; // history / adr 内容冻结，只查 R1 可选性

    // R2 contract 的 doc-version = CURRENT 小版本
    if (kind === 'contract' && verM && curMinor && verM[1] !== curMinor) {
      const ln = findLine(/^>\s*doc-version:/) || 2;
      findings.push({ rule: 'R2', file: rel, line: ln, message: `doc-version ${verM[1]} ≠ CURRENT ${curMinor}` });
    }

    // R3 正文出现非当前 versions/vX.Y 路径（治理契约自身引用旧路径作为证据，豁免）
    const r3Exempt = rel === 'docs/11-doc-governance.md';
    const curDirPath = cur ? `versions/${cur}` : null;
    const seen = new Map();
    if (!r3Exempt) for (const m of text.matchAll(/versions\/v\d+\.\d+/g)) {
      if (curDirPath && m[0] === curDirPath) continue;
      if (seen.has(m[0])) continue;
      seen.set(m[0], true);
      const before = text.slice(0, m.index);
      const ln = before.split('\n').length;
      findings.push({ rule: 'R3', file: rel, line: ln, message: `引用非当前版本路径 ${m[0]}（CURRENT 是 ${curDirPath}）` });
    }

    // R4 测试数与 I 用例区间：只约束 README 与 docs/07（契约正文引用证据豁免）
    const r4Target = rel === 'README.md' || rel.startsWith('docs') && path.basename(rel).startsWith('07');
    if (r4Target) {
      const testCounts = grabTestCounts(text);
      const iRanges = grabIRanges(text);
      const first = testCounts[0];
      if (first != null && testCounts.some((c) => c !== first)) {
        const bad = testCounts.find((c) => c !== first);
        const ln = findLine(new RegExp(`${bad}\\s*(tests|个测试|用例)`, 'i')) || findLine(new RegExp(`tests[-=]${bad}`, 'i'));
        findings.push({ rule: 'R4', file: rel, line: ln, message: `文件内测试数不一致：${testCounts.join(' vs ')}` });
      }
      // 文件里**每一条** I1–IN 声明都必须等于 CASE_FILES 条数（同文件矛盾也算漂移）
      const badNs = [...new Set(iRanges.filter((n) => caseCount != null && n !== caseCount))];
      for (const n of badNs) {
        const ln = findLine(new RegExp(`I1\\s*[–\\-～~至]\\s*I?${n}\\b`));
        findings.push({ rule: 'R4', file: rel, line: ln, message: `I 用例区间写 I1–I${n}，实际 CASE_FILES 共 ${caseCount} 条` });
      }
      if (rel === 'README.md') r4State.readme = { tests: first, iRanges };
      else r4State.doc07 = { tests: first, iRanges };
    }

    // R5 docs/07 门禁项数 = quality-check.mjs 不同 Q 编号个数（Q12/Q13 预留跳号不计数）
    if (rel.startsWith('docs') && path.basename(rel).startsWith('07') && qmax != null) {
      for (const m of text.matchAll(/quality-check\.mjs[^0-9]*[（(]?\s*(\d+)\s*项/g)) {
        const declared = Number(m[1]);
        if (declared !== qmax) {
          const ln = text.slice(0, m.index).split('\n').length;
          findings.push({ rule: 'R5', file: rel, line: ln, message: `声明的质量门禁项数 ${declared} ≠ quality-check.mjs 不同 Q 编号个数 ${qmax}` });
        }
      }
    }
  }

  // R4 跨文件：README 与 docs/07 测试数必须相等
  if (r4State.readme && r4State.doc07 && r4State.readme.tests !== r4State.doc07.tests) {
    findings.push({ rule: 'R4', file: 'docs/07-quality-and-security.md', line: 0, message: `docs/07 测试数 ${r4State.doc07.tests} ≠ README ${r4State.readme.tests}` });
  }

  // R6 当前版本代码注释不得引用已删除的 docs/09-sqlite-index / docs/10-curate-auto
  checkDeletedDocRefs(root, cur, findings);

  // allowlist 过滤（在 finding 生成后统一过滤）
  const kept = [];
  for (const f of findings) {
    if (f.rule === 'ALLOWLIST' || f.rule === 'ALLOWLIST_EXPIRED' || f.rule === 'FACT') { kept.push(f); continue; }
    if (allowlisted(f.file, f.rule, f.line, f.message, allow, findings)) continue;
    kept.push(f);
  }
  return { ok: kept.length === 0, findings: kept, checked };
}

// R6：扫 versions/<CURRENT>/src/**/*.js 与 ui/**/*.js 的注释行，
// 出现 docs/09-sqlite-index 或 docs/10-curate-auto 即报（这两篇已并入 docs/02 附录 A/B）。
function checkDeletedDocRefs(root, cur, findings) {
  if (!cur) return;
  const seen = new Set();
  for (const sub of ['src', 'ui']) {
    const base = path.join(root, 'versions', cur, sub);
    if (!fs.existsSync(base)) continue;
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!e.isFile() || !e.name.endsWith('.js')) continue;
        const { text, err } = readSafe(p);
        if (err) continue;
        const lines = text.split('\n');
        for (const [i, l] of lines.entries()) {
          if (!/(^|[^:])\/\/|\/\*/.test(l)) continue; // 只看注释内容
          for (const t of DELETED_DOC_REFS) {
            if (!l.includes(t.ref)) continue;
            const rel = path.relative(root, p).split(path.sep).join('/');
            const key = `${rel}:${i + 1}:${t.ref}`;
            if (seen.has(key)) continue;
            seen.add(key);
            findings.push({ rule: 'R6', file: rel, line: i + 1, message: `代码注释引用已删除文档 ${t.ref}，请改指 docs/02 附录 ${t.appendix}` });
          }
        }
      }
    })(base);
  }
}

// ── CLI ────────────────────────────────────────────────────────────
function main() {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const quiet = args.includes('--quiet');
  const root = process.cwd();
  const { ok, findings, checked } = checkDocs({ root });
  if (json) {
    console.log(JSON.stringify({ ok, findings, checked }, null, 2));
  } else if (!quiet) {
    if (findings.length === 0) {
      console.log(`✅ docs drift check: 无 finding（递归扫描 ${checked.docs} 个文档，CURRENT=${checked.current}，CASE_FILES=${checked.caseFiles}，Q项数=${checked.maxQ}）`);
    } else {
      console.log(`❌ docs drift check: ${findings.length} 条 finding`);
      for (const f of findings) console.log(`  [${f.rule}] ${f.file}:${f.line} ${f.message}`);
    }
  }
  // ok 与退出码同一口径：任何 finding（含 ALLOWLIST/FACT）都算失败
  process.exit(ok ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.url.replace('file://', ''))) {
  main();
}
