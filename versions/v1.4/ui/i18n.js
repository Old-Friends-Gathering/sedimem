// versions/v1.4/ui/i18n.js
// 英文界面（?lang=en）的最小实现：不改视图模块的模板，渲染后按词表翻译 DOM。
// 只翻译「界面文案」，不碰用户数据：词表是精确匹配 + 少量标题模式，
// 记录正文里恰好出现「今日」之类的词不会被误翻。
// 词表覆盖导航、页标题、按钮、统计卡与四页截图用到的固定标签；未覆盖的文案保持中文，
// 这是「中文优先、英文可选」的边界，不是完整 i18n 框架。

const DICT = {
  // 壳
  '记忆观测台': 'Memory Observatory',
  '主导航': 'Main navigation',
  '今日': 'Today',
  '图谱': 'Graph',
  '搜索': 'Search',
  '卫生': 'Hygiene',
  '编辑': 'Edit',
  '导入': 'Import',
  '任务': 'Tasks',
  '交接': 'Handoffs',
  '设置': 'Settings',
  '只读优先 · 编辑需': 'Read-only first · editing needs',
  '分库': 'Scope',
  '本地': 'local',
  '只读': 'Read-only',
  '切换分库': 'Switch scope',
  '今日变化': "Today's changes",
  '库里的变化': "Today's changes",
  '这一天库里发生了什么：写入、取代、删除与合并，命中折叠在末尾。':
    'What happened in this store today: writes, supersedes, deletes and merges; hits are folded at the end.',
  '‹ 前一天': '‹ Previous day',
  '后一天 ›': 'Next day ›',
  '新增 created': 'Created',
  '被取代 superseded': 'Superseded',
  '删除 tombstone': 'Deleted (tombstone)',
  '合并 merge': 'Merged',
  '新增': 'Created',
  '被取代': 'Superseded',
  '删除': 'Deleted',
  '合并': 'Merged',
  '裁决': 'Verdict',
  '改标题': 'Retitle',
  '回填标题': 'Backfill title',
  '命中': 'Hit',
  '今天没有写入。': 'No writes today.',
  '这个分库在这一天是安静的。': 'This scope was quiet on this day.',
  '加载失败 ·': 'Load failed ·',
  '清理': 'Cleanup',
  '人工显式取代': 'Explicit manual supersede',
  '新事实：无相同内容，也无同槽记录': 'New fact: no identical content and no same-slot record',
  '与已有记录近似重复，未重复写入': 'Near-duplicate of an existing record; not written again',
  '与已有记录内容完全相同，未重复写入': 'Identical to an existing record; not written again',
  '同槽已有完全相同的事实': 'The same slot already has an identical fact',

  // 搜索
  '搜索记忆': 'Search memory',
  '词法检索（语义道启用时自动融合）；结果按相关度排序，跟随顶栏分库。':
    'Lexical search (fused with the semantic lane when enabled); results ranked by relevance, following the top-bar scope.',
  '输入关键词，回车搜索': 'Type a keyword and press Enter',
  '搜索记忆': 'Search memory',

  // 卫生
  '库的卫生状况': 'Store hygiene',
  '待裁决簇给 Agent 裁决参考；体检摘要逐项给结论；趋势看 30 天。':
    'Pending clusters are references for agent verdicts; the doctor summary gives per-item conclusions; trend covers 30 days.',
  '待裁决候选': 'Pending candidates',
  '词法只报候选，不判决': 'Lexical checks only nominate; they never decide',
  '体检摘要（doctor）': 'Doctor summary',
  '清理史（最近 30 天）': 'Cleanup history (last 30 days)',
  '合并与取代': 'Merges & supersedes',
  '日期': 'Date',
  '类型': 'Type',
  '记录': 'Records',
  '趋势（30 天）': 'Trend (30 days)',
  '冗余 / 冲突 / active / 检索健康': 'Duplicates / conflicts / active / retrieval health',
  '当前没有待裁决的近重复候选。': 'No pending near-duplicate candidates.',
  '最近 30 天没有合并或失效记录。': 'No merges or invalidations in the last 30 days.',
  '未发现问题。': 'No issues found.',
  '加载失败 ·': 'Load failed ·',
  'dupRatio（冗余率）': 'dupRatio (duplicate rate)',
  'conflictRate（冲突率）': 'conflictRate (conflict rate)',
  'active 占比（相对配额）': 'active share (of quota)',
  '检索空结果率': 'Empty-result rate',
  '检索命中过期率': 'Stale-hit rate',

  // 编辑 / 导入
  '编辑记忆': 'Edit memory',
  '左侧选记录、右侧改字段；保存走 supersede（不原地改真相层），新增走 write。':
    'Pick a record on the left, edit fields on the right; save uses supersede (never rewrites truth), create uses write.',
  '导入记忆': 'Import memory',
  '选来源、填路径，先预览（dryRun）确认解析结果，再写入（apply）。':
    'Pick a source, fill the path, preview (dryRun) to confirm parsing, then apply.',

  // 任务 / 交接
  '按任务组织的临时记忆库：一个任务可跨多个 agent 接力；关闭走 CLI，这里负责浏览与清理。':
    'Task-scoped temporary memory: one task can span multiple agents; close via CLI, browse and clean up here.',
  '交接': 'Handoffs',
  '任务关闭时自动生成的交接文档：目标、做到哪、卡在哪、下一步。':
    'Handoff docs generated on task close: goal, progress, blockers, next steps.',

  // 设置
  '这个库现在是怎么配的：版本、写侧契约、检索阈值、kind 注册表与健康数字。':
    'How this store is configured: version, write contract, retrieval thresholds, kind registry and health numbers.',

  // 图谱
  '记忆图谱': 'Memory graph',
  '节点 = 记录，边 = 同实体 / 版本链 / 近重复候选 / 冲突；颜色按 kind，透明度按状态。':
    'Nodes = records, edges = same entity / version chain / near-duplicate candidates / conflicts; color by kind, opacity by status.',
  '点击节点查看详情。': 'Click a node for details.',
  '力导向布局：滚轮缩放、拖拽平移、拖节点固定、单击看详情、双击聚焦。':
    'Force layout: wheel to zoom, drag to pan, drag a node to pin, click for details, double-click to focus.',
  '记忆关系图': 'Memory relationship graph',

  // 任务账本
  '账本': 'Ledger',
  '捕获': 'Capture',
  '归档': 'Archive',
  '导出 expand': 'Export expand',
  '简报': 'Brief',
  '默认折叠；点「生成简报」按当前账本生成。': 'Collapsed by default; click “Generate brief” to build from the current ledger.',
  '生成简报': 'Generate brief',
  '复制': 'Copy',
  '生成简报后可复制': 'Copy is available after generating a brief',
  '展开': 'Expand',
  '收起': 'Collapse',
  '决策': 'Decisions',
  '卡点': 'Blockers',
  '下一步': 'Next steps',
  '上下文接力': 'Context relay',
  '关键文件': 'Key files',
  '还没有账本段': 'No ledger segments yet',
  '还没有简报。点「生成简报」按当前账本生成。': 'No brief yet. Click “Generate brief” to build from the current ledger.',
  '用 memo serve --write 启动才可写': 'Start with memo serve --write to enable writing',
  '（无摘要）': '(no summary)',
  '适应视图': 'Fit view',
  '重新布局': 'Re-layout',
  '只显示当前分库': 'Current scope only',
  '搜索节点...': 'Search nodes...',
  '旋转视角': 'Rotate view',
  '全开': 'All',
  '任务库': 'Task stores',
  '进行中': 'In progress',
  '选择一个任务': 'Select a task',
  '点击左侧任务查看其中的记录。': 'Pick a task on the left to see its records.',
};

const PATTERNS = [
  [/^本地 (.+)$/, (m) => `local ${m[1]}`],
  [/^(\d{4}-\d{2}-\d{2}) 的变化$/, (m) => `Changes · ${m[1]}`],
  [/^(\d+) 段$/, (m) => `${m[1]} segments`],
  [/^簇 #(\d+) · (\d+) 条$/, (m) => `Cluster #${m[1]} · ${m[2]} records`],
  [/^任务库[（(](\d+)[）)]$/, (m) => `Task stores (${m[1]})`],
  [/^· (\d+) 条记录 · (.+)$/, (m) => `· ${m[1]} records · ${m[2]}`],
  [/^(\d+) 条记录$/, (m) => `${m[1]} records`],
  [/^任务 (.+)$/, (m) => `Task ${m[1]}`],
  [/^上次写入是 (.+)（(\d+) 天前）。$/, (m) => `Last write was ${m[1]} (${m[2]} days ago).`],
  [/^这些记忆当天被读过 (\d+) 次（点开展开明细）$/, (m) => `These memories were read ${m[1]} times that day (expand for detail)`],
  [/^覆盖 (.+)$/, (m) => `Covers ${m[1]}`],
  [/^未覆盖$/, () => 'Uncovered'],
  [/^合并：(.+) 并入 (.+)$/, (m) => `Merge: ${m[1]} into ${m[2]}`],
  [/^(\d+) 条记录被标记 suspicious（默认不在 UI 渲染原文）。$/, (m) => `${m[1]} records are marked suspicious (source text is not rendered by default).`],
  [/^([\d.]+[KMG]?) 段$/, (m) => `${m[1]} segments`],
];

export function resolveLang(search = '', stored = '', nav = '') {
  const q = new URLSearchParams(search).get('lang');
  if (q === 'en' || q === 'zh') return q;
  if (stored === 'en' || stored === 'zh') return stored;
  return nav === 'en-US' || nav === 'en' ? 'en' : 'zh';
}

export function tr(text, lang) {
  if (lang !== 'en' || typeof text !== 'string') return text;
  const key = text.trim();
  if (!key) return text;
  const hit = DICT[key];
  if (hit) return text.replace(key, hit);
  for (const [re, fn] of PATTERNS) {
    const m = key.match(re);
    if (m) return text.replace(key, fn(m));
  }
  return text;
}

function walk(node, lang, seen) {
  if (node.nodeType === 3) {
    if (seen.has(node)) return;
    const next = tr(node.nodeValue, lang);
    if (next !== node.nodeValue) {
      node.nodeValue = next;
      seen.add(node);
    }
    return;
  }
  if (node.nodeType !== 1) return;
  for (const attr of ['placeholder', 'aria-label', 'title']) {
    const v = node.getAttribute(attr);
    if (v) {
      const next = tr(v, lang);
      if (next !== v) node.setAttribute(attr, next);
    }
  }
  for (const child of node.childNodes) walk(child, lang, seen);
}

export function initI18n(root = document, win = window) {
  const lang = resolveLang(win.location.search, win.localStorage?.getItem('sedimem.lang') ?? '', win.navigator?.language ?? '');
  if (lang !== 'en') return 'zh';
  win.localStorage?.setItem('sedimem.lang', 'en');
  document.documentElement.lang = 'en';
  const seen = new WeakSet();
  walk(root.body ?? root, 'en', seen);
  const mo = new MutationObserver((muts) => {
    for (const mut of muts) {
      for (const node of mut.addedNodes) walk(node, 'en', seen);
      if (mut.type === 'characterData') walk(mut.target, 'en', seen);
    }
  });
  mo.observe(root.body ?? root, { childList: true, subtree: true, characterData: true });
  return 'en';
}
