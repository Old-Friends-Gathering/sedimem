// cli/import-parsers.js — 五种外部记忆源的解析器（W7 导入器）
// 全部纯函数：输入文本/对象，输出 [{text, kind, subject, predicate}]，不做任何 IO 与落盘。
// 幂等性依赖 service.write 的 noop_same_value（同 text 同 slot 不重复写）。
import { createHash } from 'node:crypto';

/** 小节标题 → slug：小写、空白与非字母数字折叠为 -、去首尾连字符 */
export function slugify(title) {
  return String(title).trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-+|-+$/g, '') || 'general';
}

/**
 * 按 `## ` 二级标题切分小节。返回 [{title, body}]，标题前内容 title=null。
 * @param {string} content markdown 文本
 */
export function splitSections(content) {
  const lines = String(content).split(/\r?\n/);
  const sections = [];
  let cur = { title: null, lines: [] };
  for (const line of lines) {
    const m = /^##\s+(.*)$/.exec(line);
    if (m) {
      if (cur.title !== null || cur.lines.some((l) => l.trim() !== '')) sections.push(cur);
      cur = { title: m[1].trim(), lines: [] };
    } else {
      cur.lines.push(line);
    }
  }
  if (cur.title !== null || cur.lines.some((l) => l.trim() !== '')) sections.push(cur);
  return sections;
}

/** 提取小节内的列表项（`- ` / `* `），去掉 marker 后 trim */
function listItems(bodyText) {
  return bodyText
    .split(/\r?\n/)
    .map((l) => /^\s*[-*]\s+(.*)$/.exec(l))
    .filter(Boolean)
    .map((m) => m[1].trim())
    .filter((t) => t.length > 0);
}

const AGENT_SUBJECT = 'import:agents';

/** agents：AGENTS.md/CLAUDE.md 的 `## ` 小节段落与列表项；每条 → fact */
export function parseAgents(content) {
  const out = [];
  for (const sec of splitSections(content)) {
    const predicate = slugify(sec.title ?? 'general');
    const items = listItems(sec.lines.join('\n'));
    if (items.length > 0) {
      // 同小节可能有多条独立事实：predicate 带序号，否则它们会落进同一个 (subject,predicate)
      // 槽位 → 写入门禁判成「同槽不同值」→ 16 条全 disputed（W7 实测踩到）
      items.forEach((text, i) => out.push({ text, kind: 'fact', subject: AGENT_SUBJECT, predicate: `${predicate}-${i + 1}` }));
    } else {
      // 无列表项的小节：整段正文压成一条（保留段落语义，避免空小节产生噪音）
      const body = sec.lines.join('\n').trim();
      if (body) out.push({ text: body, kind: 'fact', subject: AGENT_SUBJECT, predicate });
    }
  }
  return out;
}

/** basic-memory：markdown 里的 `- ` 列表项，每条一条 fact；[[wikilink]] 原样留在 text */
export function parseBasicMemory(content) {
  return listItems(String(content)).map((text) => ({
    text, kind: 'fact', subject: 'import:basic-memory', predicate: 'note',
  }));
}

/** obsidian：同 basic-memory，但按 `## ` 分节 → predicate */
export function parseObsidian(content) {
  const out = [];
  for (const sec of splitSections(content)) {
    const predicate = slugify(sec.title ?? 'general');
    for (const text of listItems(sec.lines.join('\n'))) {
      out.push({ text, kind: 'fact', subject: 'import:obsidian', predicate });
    }
  }
  return out;
}

/**
 * mem0：JSON 数组文件，取每项的 memory / text 字段。
 * @param {string} content 文件全文（合法 JSON 数组）
 */
export function parseMem0(content) {
  const data = JSON.parse(String(content));
  if (!Array.isArray(data)) throw new Error('mem0 导入源必须是 JSON 数组');
  return data
    .map((item) => (item && typeof item === 'object' ? item.memory ?? item.text : null))
    .filter((t) => typeof t === 'string' && t.length > 0)
    .map((text) => ({ text, kind: 'fact', subject: 'import:mem0', predicate: 'memory' }));
}

/** cline 六个标准文件 → 期望文件名与 kind 映射（progress 是进行时 → state；模式/技术栈 → decision） */
const CLINE_FILES = [
  { name: 'projectbrief.md', kind: 'fact' },
  { name: 'productContext.md', kind: 'fact' },
  { name: 'activeContext.md', kind: 'fact' },
  { name: 'systemPatterns.md', kind: 'decision' },
  { name: 'techContext.md', kind: 'decision' },
  { name: 'progress.md', kind: 'state' },
];

/**
 * cline：目录下的 6 个 md 文件，每节 → 一条记录（kind 按文件映射）。
 * @param {Record<string, string>} files 文件名 → 内容
 */
export function parseCline(files) {
  const out = [];
  for (const { name, kind } of CLINE_FILES) {
    const content = files?.[name];
    if (typeof content !== 'string') continue;
    const sections = splitSections(content);
    const entries = sections.some((s) => s.title !== null)
      ? sections.filter((s) => s.title !== null)
      : [{ title: name.replace(/\.md$/, ''), lines: content.split(/\r?\n/) }];
    for (const sec of entries) {
      const body = sec.lines.join('\n').trim();
      if (!body) continue;
      // text 带上小节标题，保证不同节不因正文相同而误判 noop
      const text = `${sec.title}\n${body}`;
      out.push({ text, kind, subject: 'import:cline', predicate: slugify(`${name.replace(/\.md$/, '')} ${sec.title}`) });
    }
  }
  return out;
}

/** 文件内容 sha256（导入事件用：同一文件重复导入可通过事件识别） */
export function fileSha256(content) {
  return createHash('sha256').update(String(content), 'utf8').digest('hex');
}

/** 按 src 名解析一个文件 → 记录草案 */
export function parseSource(src, content) {
  switch (src) {
    case 'agents': return parseAgents(content);
    case 'basic-memory': return parseBasicMemory(content);
    case 'obsidian': return parseObsidian(content);
    case 'mem0': return parseMem0(content);
    default: throw new Error(`src ${src} 不接受单文件内容`);
  }
}

/** 按 kind 分类计数 */
export function countByKind(items) {
  const byKind = {};
  for (const it of items) byKind[it.kind] = (byKind[it.kind] ?? 0) + 1;
  return byKind;
}
