// ui/scope.js —— 分库（scope）解析与内部链接拼装的纯函数集（无 DOM、无 fetch，node --test 可直测）。
// 存在理由：分库要「粘」在 URL 上。此前 tab 点击写 `location.hash='#/'+route` 会丢掉 `?scope=`，
// 读侧又只认 hash —— 于是切过一次页 scope 就静默漂回默认库。修法是把「选哪个库」收敛成一个
// 纯函数（hash 优先 → 本地记忆 → 服务端默认 → 列表首个），并让所有内部跳转统一走 hrefFor。
// 合法性判断与后端共用同一形状：src/mcp/scope-state.js 的 SCOPE_PATTERN（按契约同步抄写，不自创）。

/** scope 形状：`repo:名字` / `dir:名字` / `user:名字` / `global:名字`，小写字母数字开头，允许 . _ -，总长 ≤64。 */
export const SCOPE_PATTERN = /^(repo|dir|user|global):[a-z0-9][a-z0-9._-]{0,63}$/;

/** 组装结果；fallbackReason 只在发生回落时出现。 */
function result(scope, source, fallbackReason) {
  return fallbackReason ? { scope, source, fallbackReason } : { scope, source };
}

/**
 * 三路合成当前分库：hash（合法且在 available）> stored（localStorage）> serverDefault > available[0]。
 * 优先级里每一路都要求「形状合法 + 在列表里」；被拒的那一路通过 fallbackReason 说明原因：
 *  - 'invalid'：形状不合法（不过 SCOPE_PATTERN）
 *  - 'not-found'：形状合法但不在 available 里（库文件已被删/更名）
 *  - 'missing'：hash/stored 都没给出可用的，连 serverDefault 也不在列表里（兜到列表首个）
 * available 为空（/api/scopes 拉取失败）时只做形状校验不查成员，保证 UI 不至于彻底失去 scope。
 * @param {{hashScope?: string, storedScope?: string, serverDefault?: string, available?: string[]}} args
 * @returns {{scope: string, source: 'hash'|'stored'|'default', fallbackReason?: 'invalid'|'missing'|'not-found'}}
 */
export function resolveScope({ hashScope = '', storedScope = '', serverDefault = '', available = [] } = {}) {
  const norm = (v) => (typeof v === 'string' ? v.trim() : '');
  const hash = norm(hashScope);
  const stored = norm(storedScope);
  const def = norm(serverDefault);
  const list = (Array.isArray(available) ? available : [])
    .map((s) => String(s))
    .filter((s) => SCOPE_PATTERN.test(s));
  const usable = (s) => list.length === 0 || list.includes(s);

  let reason = null;
  if (hash) {
    if (SCOPE_PATTERN.test(hash) && usable(hash)) return result(hash, 'hash');
    reason = SCOPE_PATTERN.test(hash) ? 'not-found' : 'invalid';
  }
  if (stored) {
    if (SCOPE_PATTERN.test(stored) && usable(stored)) return result(stored, 'stored');
    reason = SCOPE_PATTERN.test(stored) ? 'not-found' : 'invalid';
  }
  if (def && SCOPE_PATTERN.test(def) && usable(def)) return result(def, 'default', reason);
  if (list.length > 0) return result(list[0], 'default', reason ?? 'missing');
  return result('', 'default', 'missing');
}

/**
 * 拼内部跳转链接：`#/<route>?<params>`。params 值经 encodeURIComponent，空值自动省略；
 * 全空则退回 `#/<route>`。所有内部跳转都应走它，禁止裸写 `'#/'+route`（那是丢 scope 的根因）。
 * @param {string} route 路由名（today/graph/search/hygiene）
 * @param {Record<string, string>} [params] query 参数，如 { scope: 'repo:x', q: '词' }
 * @returns {string} 形如 '#/graph?scope=repo%3Ax'
 */
export function hrefFor(route, params = {}) {
  const qs = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v).trim())}`)
    .join('&');
  return qs ? `#/${route}?${qs}` : `#/${route}`;
}
