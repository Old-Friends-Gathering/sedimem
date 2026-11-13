// tests/support/arch-graph.js — 架构图解析器（测试专用，不进 src，因此不影响契约覆盖率门禁）
//
// 为什么单独抽出来：它自己也需要被测试。首版把解析写在测试文件里，对抗审核证明它是纸糊的——
// 副作用 `import "../cli/x.js"` 与动态 `import("../mcp/y.js")` 完全逃逸，注释里的 `from '...'`
// 却会造假边。现在解析与断言分离，解析器有独立用例（tests/unit/arch-parser.test.js）。
import fs from 'node:fs';
import path from 'node:path';

/** 三种引入形式都要抓：from / 副作用 import / 动态 import(字面量) */
const SPEC_RES = [
  /from\s+['"]([^'"]+)['"]/g,
  /\bimport\s+['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

const BT = String.fromCharCode(96); // 反引号：用码点构造，避免源码里出现模板字面量歧义

/**
 * 剔注释（保留换行与行号）：状态机而不是正则。
 * 正则版踩过的坑：`// 策略来自 hygiene/*` 里的 `/*` 会一路吞到下一个块注释结束符，
 * 把中间的 import 全吃掉，导致「图缺边」的假绿。
 * @param {string} text
 * @returns {string} 与原文等长（注释位置换成空格，换行保留）
 */
export function stripComments(text) {
  let out = '';
  let i = 0;
  let quote = null;
  let inBlock = false;
  let inLine = false;
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (c === '\n') {
      inLine = false;
      out += c;
      i += 1;
      continue;
    }
    if (inLine) {
      out += ' ';
      i += 1;
      continue;
    }
    if (inBlock) {
      if (c === '*' && next === '/') {
        inBlock = false;
        out += '  ';
        i += 2;
        continue;
      }
      out += c === '\t' ? '\t' : ' ';
      i += 1;
      continue;
    }
    if (quote) {
      out += c;
      if (c === '\\') {
        out += text[i + 1] ?? '';
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i += 1;
      continue;
    }
    if (c === '/' && next === '/') {
      inLine = true;
      out += '  ';
      i += 2;
      continue;
    }
    if (c === '/' && next === '*') {
      inBlock = true;
      out += '  ';
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === BT) quote = c;
    out += c;
    i += 1;
  }
  return out;
}

/**
 * 把「不是引入说明」的字符串字面量内容抹成空格（保留引号与行号）。
 * 为什么需要：`const hint = "don't import from '../mcp/x.js'"` 这种字符串里出现 from '...'
 * 会被正则当成真依赖（对抗审核实测的假阳性）。
 * 判据：引号前面紧邻 `from` / `import` / `import(` 的才算 spec，其余抹掉内容。
 */
function maskNonSpecStrings(clean) {
  const out = clean.split('');
  let i = 0;
  let quote = null;
  let start = -1;
  while (i < clean.length) {
    const c = clean[i];
    if (!quote) {
      if (c === "'" || c === '"' || c === BT) { quote = c; start = i; }
      i += 1;
      continue;
    }
    if (c === '\\') { i += 2; continue; }
    if (c === quote) {
      const before = clean.slice(Math.max(0, start - 16), start).replace(/\s+$/, '');
      const isSpec = /\bfrom$/.test(before) || /\bimport$/.test(before) || /\bimport\($/.test(before);
      if (!isSpec) {
        for (let k = start + 1; k < i; k += 1) if (out[k] !== '\n') out[k] = ' ';
      }
      quote = null;
    }
    i += 1;
  }
  return out.join('');
}

/**
 * 抓一段源码里所有引入 spec（去重前，按行号）。
 * @param {string} source
 * @returns {Array<{spec: string, line: number}>}
 */
export function parseSpecs(source) {
  const clean = maskNonSpecStrings(stripComments(source));
  const found = [];
  clean.split('\n').forEach((line, idx) => {
    for (const re of SPEC_RES) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line)) !== null) found.push({ spec: m[1], line: idx + 1 });
    }
  });
  return found;
}

/** 读 package.json 的 name + exports/imports（用于解析 self-reference） */
export function loadSelfRef(root) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const map = new Map();
  const take = (obj) => {
    for (const [k, v] of Object.entries(obj ?? {})) {
      const target = typeof v === 'string' ? v : (v?.import ?? v?.default);
      if (typeof target === 'string') map.set(k, target);
    }
  };
  take(pkg.exports);
  take(pkg.imports);
  return { name: pkg.name, map };
}

/**
 * 把 spec 解析成 `src/...` key；不属于 src 返回 null。
 * 覆盖四种写法：相对、绝对路径（必须落在 src 内）、self-reference（exports/imports）、裸包名（忽略）。
 * @param {{root: string, fromFile: string, spec: string, selfRef: {name: string, map: Map<string,string>}}} args
 * @returns {string|null}
 */
export function resolveSpec({ root, fromFile, spec, selfRef }) {
  let target = null;
  if (spec.startsWith('.')) {
    target = path.resolve(path.dirname(fromFile), spec);
  } else if (spec.startsWith('/')) {
    target = path.resolve(spec);
  } else if (selfRef?.name && (spec === selfRef.name || spec.startsWith(`${selfRef.name}/`))) {
    const sub = spec === selfRef.name ? '.' : `.${spec.slice(selfRef.name.length)}`;
    const mapped = selfRef.map.get(sub) ?? selfRef.map.get(spec.slice(selfRef.name.length));
    if (mapped) target = path.resolve(root, mapped);
  }
  if (!target) return null;
  let rel = path.relative(root, target).split(path.sep).join('/');
  if (!rel.endsWith('.js')) rel = `${rel}.js`;
  return rel.startsWith('src/') ? rel : null;
}

/** 递归收集 src 下所有 .js */
export function collectJsFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectJsFiles(full, out);
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

/**
 * 建 import 图。key = 'src/x/y.js'，值 = [{dep, line}]。
 * @param {string} root 版本目录（含 src/ 与 package.json）
 * @returns {Map<string, Array<{dep: string, line: number}>>}
 */
export function buildGraph(root) {
  const selfRef = loadSelfRef(root);
  const graph = new Map();
  for (const file of collectJsFiles(path.join(root, 'src'))) {
    const key = path.relative(root, file).split(path.sep).join('/');
    const deps = [];
    for (const { spec, line } of parseSpecs(fs.readFileSync(file, 'utf8'))) {
      const dep = resolveSpec({ root, fromFile: file, spec, selfRef });
      if (dep) deps.push({ dep, line });
    }
    graph.set(key, deps);
  }
  return graph;
}

/** 找任意长度的环（三色 DFS），返回 [[a,b,...,a], ...] */
export function findCycles(graph) {
  const color = new Map();
  const cycles = [];
  for (const start of graph.keys()) {
    if (color.get(start)) continue;
    const stack = [];
    const dfs = (u) => {
      color.set(u, 1);
      stack.push(u);
      for (const { dep } of graph.get(u) ?? []) {
        if (!graph.has(dep)) continue;
        if (color.get(dep) === 1) {
          const at = stack.indexOf(dep);
          if (at >= 0) cycles.push([...stack.slice(at), dep]);
        } else if (!color.get(dep)) {
          dfs(dep);
        }
      }
      stack.pop();
      color.set(u, 2);
    };
    dfs(start);
  }
  return cycles;
}

/** 找出 fromPrefixes 指向 toPrefixes 的边 */
export function findForbidden(graph, fromPrefixes, toPrefixes) {
  const hits = [];
  for (const [from, edges] of graph) {
    if (!fromPrefixes.some((p) => from.startsWith(p))) continue;
    for (const { dep, line } of edges) {
      if (toPrefixes.some((t) => dep === t || dep.startsWith(t))) hits.push({ from, dep, line });
    }
  }
  return hits;
}

/**
 * api 子图可达性：拆分模块能否（直接或经 src/api/ 中间文件）回到 service.js。
 * 只看直连边会被 `_shared.js` 这类中转绕过（对抗审核实证）。
 * @returns {string[]} 人类可读的违规路径
 */
export function findApiReverseDeps(graph, splitModules, serviceKey = 'src/api/service.js') {
  const hits = [];
  for (const start of splitModules) {
    const seen = new Set([start]);
    const queue = [[start, null, null]];
    while (queue.length) {
      const [node, via, line] = queue.shift();
      for (const edge of graph.get(node) ?? []) {
        if (edge.dep === serviceKey) {
          hits.push(`${start} -> ... -> service.js${via ? `（经 ${via}:${line}）` : ''}`);
          continue;
        }
        if (edge.dep.startsWith('src/api/') && !seen.has(edge.dep)) {
          seen.add(edge.dep);
          // via 记「中间文件」，line 记进入该中间文件的那一行，便于回溯
          queue.push([edge.dep, edge.dep, edge.line]);
        }
      }
    }
  }
  return hits;
}
