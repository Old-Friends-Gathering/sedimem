/**
 * 图谱工具栏（独立模块，控制 ui/graph.js 的文件规模）。
 *
 * v1.0 图谱可用性改造：缩放/适应/重排按钮、分库范围切换、搜索框、kind 图例；
 * 保留原有「旋转视角」与边类型勾选。所有新元素 id 前缀 gx-（自动化验收定位用）。
 * 顺序纪律不变：「先清空 → 再逐个 append」（历史上 append 后 replaceChildren 导致控件丢失）。
 * v1.1 设计系统改造：全部用 style.css 的 .toolbar 组件类——按钮 .sm/.ghost 变体、
 * .sep 分隔、kind 筛选 chips 用 .badge（选中态 .b-accent + .dotk 色块）、搜索输入框；
 * 去掉行内样式。逻辑与事件行为不动，渲染部分照旧只在 #graph-toolbar（.toolbar）内。
 */

export function renderToolbar({
  toolbarEl,
  state,
  pref,
  optionalEdgeTypes,
  checks,
  saveEdgePref,
  render,
  actions = {},          // { zoomIn, zoomOut, fit, relayout, toggleScope }
  kindColors = {},       // kind → 颜色（来自 /api/summary policy.kinds）
  kindsOff = new Set(),  // 当前隐藏的 kind 集合（读写 state.ui.kindsOff）
  onKindToggle = () => {},
  onlyThisScope = true,
  refs = {},            // 输出：refs.searchInput 暴露给 graph.js（Esc 清空等）
  search = '',           // 搜索框初始值
  onSearch = () => {},   // (value) 输入即时回调
  onSearchEnter = () => {}, // 回车聚焦第一个命中
}) {
  toolbarEl.replaceChildren();

  const sep = () => {
    const s = document.createElement('span');
    s.className = 'sep';
    return s;
  };

  const btn = (id, text, fn, title, cls = 'sm') => {
    const b = document.createElement('button');
    b.id = id; b.type = 'button'; b.textContent = text;
    b.title = title || text;
    if (cls) b.className = cls;
    b.addEventListener('click', fn);
    return b;
  };
  toolbarEl.append(
    btn('gx-zoom-in', '＋', actions.zoomIn, '放大（快捷键 +）'),
    btn('gx-zoom-out', '－', actions.zoomOut, '缩小（快捷键 -）'),
    btn('gx-fit', '适应视图', actions.fit, '适应视图（快捷键 0）'),
    btn('gx-relayout', '重新布局', actions.relayout, '重新布局（快捷键 r，同时释放全部固定）'),
  );

  // 分库范围：只显示当前分库 / 全部（切换触发按需重新拉数据）
  toolbarEl.append(
    btn('gx-scope', onlyThisScope ? '只显示当前分库' : '显示全部',
      () => actions.toggleScope(), '切换：只看当前分库 / 全部', 'ghost'),
    sep(),
  );

  // kind 筛选 chips：.badge + .dotk 色块；选中态 .b-accent，隐藏态 gx-off（降透明+划线）
  const legend = document.createElement('span');
  legend.id = 'gx-legend';
  legend.className = 'gx-legend';
  legend.style.cssText = 'display:inline-flex;gap:6px;align-items:center;flex-wrap:wrap;';
  for (const [kind, color] of Object.entries(kindColors)) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.dataset.kind = kind;
    chip.title = '点击显示 / 隐藏该类型';
    chip.className = 'badge';
    if (!kindsOff.has(kind)) chip.classList.add('b-accent');
    else chip.classList.add('gx-off');
    const dot = document.createElement('span');
    dot.className = 'dotk';
    dot.style.color = color; // .dotk 用 currentColor 染色，文字颜色不受影响
    chip.append(dot, document.createTextNode(kind));
    chip.addEventListener('click', () => onKindToggle(kind));
    legend.append(chip);
  }
  if (kindColors && Object.keys(kindColors).length) toolbarEl.append(legend, sep());

  // 搜索框：输入即时高亮，回车聚焦第一个命中
  const searchInput = document.createElement('input');
  searchInput.id = 'gx-search';
  searchInput.type = 'search';
  searchInput.placeholder = '搜索节点…';
  searchInput.value = search;
  searchInput.addEventListener('input', () => onSearch(searchInput.value));
  searchInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); onSearchEnter(); }
    if (ev.key === 'Escape') { searchInput.value = ''; onSearch(''); searchInput.blur(); ev.stopPropagation(); }
  });
  toolbarEl.append(searchInput, sep());
  refs.searchInput = searchInput;

  /* ---------- 以下为原有控件：旋转视角 + 边类型勾选 ---------- */
  const rotWrap = document.createElement('label');
  rotWrap.className = 'sm';
  rotWrap.style.cssText = 'display:inline-flex;gap:5px;align-items:center;color:var(--sd-muted);font-size:var(--fs-xs);';
  const rotInput = document.createElement('input');
  rotInput.type = 'checkbox';
  rotInput.checked = false;
  rotInput.addEventListener('change', () => { state.rotateMode = rotInput.checked; });
  const rotSpan = document.createElement('span');
  rotSpan.textContent = '旋转视角';
  rotWrap.append(rotInput, rotSpan);
  toolbarEl.append(rotWrap);

  const mk = (key, label, onChange) => {
    const labelEl = document.createElement('label');
    labelEl.style.cssText = 'display:inline-flex;gap:5px;align-items:center;color:var(--sd-muted);font-size:var(--fs-xs);margin-left:8px;';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.addEventListener('change', () => onChange(input.checked));
    const span = document.createElement('span');
    span.textContent = label;
    labelEl.append(input, span);
    checks[key] = input;
    return labelEl;
  };

  const all = mk('all', '全开', (v) => {
    pref.all = v;
    pref['duplicate-of'] = v;
    pref['disputed-with'] = v;
    if (checks['duplicate-of']) checks['duplicate-of'].checked = v;
    if (checks['disputed-with']) checks['disputed-with'].checked = v;
    saveEdgePref(); render();
  });
  toolbarEl.append(all);

  for (const t of optionalEdgeTypes) {
    toolbarEl.append(mk(t, t, (v) => {
      pref[t] = v;
      if (!v) pref.all = false;
      if (checks.all) checks.all.checked = pref.all || (pref['duplicate-of'] && pref['disputed-with']);
      saveEdgePref(); render();
    }));
  }
  checks.all.checked = pref.all || (pref['duplicate-of'] && pref['disputed-with']);
  if (checks['duplicate-of']) checks['duplicate-of'].checked = !!pref['duplicate-of'];
  if (checks['disputed-with']) checks['disputed-with'].checked = !!pref['disputed-with'];
}
