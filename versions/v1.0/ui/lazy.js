// ui/lazy.js —— 「任务 / 交接 / 设置」三页的懒加载器
//
// 单独成文件是为了让 app.js 守在 600 行 Q9 硬线内（拆模块而不是放宽阈值）。
// 每页导出的是 mountXxxView（不是统一的 mount），设置页的参数名是 api 而非 apiGet ——
// 早期按固定命名 guess，三页全落到「未加载」占位符（v1.0.2 修）。

const LAZY_VIEWS = {
  session: { file: 'session-view.js', mount: 'mountSessionView' },
  handoff: { file: 'handoff-view.js', mount: 'mountHandoffView' },
  settings: { file: 'settings-view.js', mount: 'mountSettingsView' },
};

// 串行化：初次渲染与 hashchange 可能同时触发同一个页面；两次 mount 交错 await，
// 各自 replaceChildren 后分别 append，就会把同一份内容画两遍（v1.0.5 修）。
const CHAINS = new Map();

/**
 * 懒加载并挂载一个只读页（同一页面重复调用按先后顺序串行，最后一次生效）。
 * @param {string} name session|handoff|settings
 * @param {{api: Function, el: Function}} deps
 */
export function loadLazyView(name, deps) {
  const prev = CHAINS.get(name) ?? Promise.resolve();
  const next = prev.then(() => mountOnce(name, deps)).catch(() => {});
  CHAINS.set(name, next);
  return next;
}

async function mountOnce(name, { api, el }) {
  const spec = LAZY_VIEWS[name];
  const box = document.getElementById(`${name}-container`);
  if (!spec) { box.replaceChildren(el('p', 'dim', `未知页面 ${name}`)); return; }
  const mod = await import(`./${spec.file}`).catch(() => null);
  const fn = mod?.[spec.mount];
  if (typeof fn === 'function') await fn({ container: box, apiGet: api, api });
  else box.replaceChildren(el('p', 'dim', `${spec.file} 未加载，刷新页面重试。`));
}
