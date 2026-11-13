/**
 * 图谱工具栏（独立模块，控制 ui/graph.js 的文件规模）。
 *
 * 之前这里有个真实 bug：先 append 旋转开关、再 `replaceChildren()` 清空，
 * 导致「旋转视角」复选框从未出现过（用户 m07849 的疑惑来源之一）。
 * 现在顺序固定为「先清空 → 再逐个 append」。
 */
export function renderToolbar({
  toolbarEl,
  state,
  pref,
  optionalEdgeTypes,
  checks,
  saveEdgePref,
  render,
}) {
  toolbarEl.replaceChildren();

  const rotWrap = document.createElement('label');
  rotWrap.style.marginRight = '12px';
  const rotInput = document.createElement('input');
  rotInput.type = 'checkbox';
  rotInput.checked = false;
  rotInput.addEventListener('change', () => {
    state.rotateMode = rotInput.checked;
  });
  const rotSpan = document.createElement('span');
  rotSpan.textContent = ' 旋转视角';
  rotWrap.append(rotInput, rotSpan);
  toolbarEl.append(rotWrap);

  const mk = (key, label, onChange) => {
    const labelEl = document.createElement('label');
    labelEl.style.marginRight = '12px';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.addEventListener('change', () => onChange(input.checked));
    const span = document.createElement('span');
    span.textContent = ` ${label}`;
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
    saveEdgePref();
    render();
  });
  toolbarEl.append(all);

  for (const t of optionalEdgeTypes) {
    toolbarEl.append(mk(t, t, (v) => {
      pref[t] = v;
      if (!v) pref.all = false;
      if (checks.all) checks.all.checked = pref.all || (pref['duplicate-of'] && pref['disputed-with']);
      saveEdgePref();
      render();
    }));
  }

  checks.all.checked = pref.all || (pref['duplicate-of'] && pref['disputed-with']);
  if (checks['duplicate-of']) checks['duplicate-of'].checked = !!pref['duplicate-of'];
  if (checks['disputed-with']) checks['disputed-with'].checked = !!pref['disputed-with'];
}
