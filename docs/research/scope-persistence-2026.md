# sedimem UI：切页丢分库选择 —— 根因与最小修法（2026-11）

## 1. 现状全貌：hash 的读写点

读 hash（scope / q / route）：

| 位置 | 代码 | 说明 |
|---|---|---|
| ui/app.js:18-21 | `currentScope()` 正则取 `?scope=` | 唯一 scope 读取口；hash 无 query → 返回 `''` → api() 不带 scope → 服务端回落到启动分库 |
| ui/app.js:23-26 | `api()` 每次请求拼 `scope=` | 所有 `/api/*`（除 graph）走这里 |
| ui/app.js:422-425 | `currentQuery()` 取 `?q=` | 搜索词，同样从 hash 读 |
| ui/app.js:495-499 | `currentRoute()` 取 path 段 | 路由解析，`split('?')[0]`，不碰 scope |
| ui/graph.js:105,108 | 直接 `fetch` `/graph`、`/summary` 拼 scope | 图谱页绕过 `api()`，scope 由 app.js:405 `currentScope()` 传入 `initGraph` |

写 hash：

| 位置 | 代码 | 丢 scope？ |
|---|---|---|
| ui/app.js:520 | tab 点击 `location.hash = '#/' + r` | **丢**。这是切页丢分库的直接根因：新 hash 无 `?scope=`，`currentScope()` 返回 `''` |
| ui/app.js:559 | 切分库 `#/${route}?scope=...` | 不丢 scope，但 route 为 search 时丢 `q`（搜索词被清） |
| ui/app.js:465 | 搜索回车 `#/search?q=..&scope=..` | 不丢（刻意保留） |
| ui/app.js:571 | 启动 `location.hash = '#/today'` | hash 为空时才触发，此时本来无 scope |
| ui/app.js:484 | 图谱详情链接 `#/search?q=<id>&scope=..` | 不丢 |

search-view.js 不读 hash（纯函数，只接收参数，由 app.js:449 调用）——scope 读取只有 app.js 一处 + graph.js 两次直接 fetch。

**根因链**：用户在下拉切分库（app.js:559 写入 `?scope=`）→ 点任一 tab（app.js:520 重写 hash 为 `#/route`，scope 参数丢失）→ `hashchange`（app.js:513）→ `render()` → 各 load* 经 `currentScope()`（app.js:18）拿到 `''` → `api()` 不带 scope → 服务端（server.js:115 `serviceFor(null)`）回落启动分库。现象：顶栏下拉经 `loadScopes()` 重渲染（app.js:540 `currentScope() || s.current`）也跳回启动分库。

## 2. 修法对比

### A. tab 点击带上当前 scope（最小改动）
- 改动点：仅 app.js:520 一行：`location.hash = \`#/${r}${sc ? `?scope=${encodeURIComponent(sc)}` : ''}\``。
- 兼容：旧 `#/today` 链接照常（无 query → 回落启动分库，现状行为）。
- 失效场景：刷新/新开标签（hash 无 scope 仍回启动库）；从外部打开 `#/graph` 裸链接仍丢；不解决"我上次看的是哪个库"。
- 可测性：一条断言即可（点 tab 后 hash 仍含 scope），但只覆盖一个入口。

### B. localStorage 粘性分库（推荐）
- 改动点：`currentScope()`（app.js:18）改为：hash `?scope=` > `localStorage['sedimem.ui.scope']` > `''`（回落服务端 current）；切分库处（app.js:557-560）同步写 localStorage；tab 点击（app.js:520）不必改（读侧已兜底），但建议顺手带上 scope 使 URL 可分享。
- 兼容：旧 `#/today` 链接 → localStorage 命中则用上次的库；首次无 localStorage → 现状回落。URL 带 scope 时永远优先（显式意图 > 记忆）。
- 失效场景：分库被删（jsonl 文件移走）→ localStorage 里是陈旧值 → 服务端 serviceFor 抛 E_INVALID_ARG/不存在则回落启动库，UI 需容错：`loadScopes()`（app.js:540）已用 `s.current` 兜底，但 currentScope 仍返回陈旧值——修法里要在 `/api/scopes` 返回后校验，不在列表则清除 localStorage 并重载。多标签页：两个标签各切各的库，localStorage 互相覆盖——可接受（最后写者赢），hash 里带 scope 的标签不受影响。
- 可测性：好——读侧是纯函数（hash, localStorage) → scope），可表驱动单测；E2E 断言跨 tab 切页后 `/api/*` 的 scope 恒定。

### C. 路径式 `#/<scope>/<page>`
- 改动点：`currentRoute()`（app.js:495-499）与 `currentScope()`（app.js:18）都要改解析；所有写 hash 点（520/559/465/484/571）改构造；graph.js 的 scope 由 app.js 传入不受影响；服务端不动。
- 入容：旧 `#/today` 需兼容分支（首段不是合法 scope 形态 `repo:|dir:` 则视为路由）；scope 含 `/` 理论上被 SCOPE_PATTERN 挡住（repo:name/dir:name），可编码。
- 失效场景：URL 变长、scope 暴露在路径里可分享（这是优点）；解析歧义需小心；改动面最大，回归风险最高。
- 可测性：路由解析可单测，但 5 个写点都要覆盖。

## 3. 推荐：B（localStorage 粘性 + tab 点击带 scope）

理由：根因是「scope 的唯一载体是 hash query，而 hash 会被路由跳转整段重写」。B 把「用户意图」放进读侧兜底，一处改动覆盖所有丢 scope 的入口（tab、外部裸链接、刷新），URL 显式 scope 仍最高优先，可分享性不受损。A 只堵一个口；C 收益与 B 相同但改动面 5 倍。

伪代码（读侧统一入口，≤30 行）：

```js
const LS_KEY = 'sedimem.ui.scope';

function hashScope() {                       // 原 app.js:18 提取
  const m = /(?:^|[?&])scope=([^&]+)/.exec(location.hash.split('?')[1] ?? '');
  return m ? decodeURIComponent(m[1]) : '';
}

function currentScope() {                    // hash 显式 > 粘性 > 空(服务端回落)
  return hashScope() || safeGet(LS_KEY) || '';
}
function safeGet(k) { try { return localStorage.getItem(k) ?? ''; } catch { return ''; } }
function safeSet(k, v) { try { localStorage.setItem(k, v); } catch { /* 隐私模式 */ } }

// 切分库（app.js:557 change 回调）：写 hash + 记忆
sel.addEventListener('change', () => {
  safeSet(LS_KEY, sel.value);
  const route = currentRoute();
  const q = currentQuery();                  // 顺手修 search 页丢 q
  const qs = new URLSearchParams({ scope: sel.value, ...(q && { q }) });
  location.hash = `#/${route}?${qs}`;
});

// loadScopes()（app.js:533 后）校验陈旧粘性值：不在列表则清除并重渲染
const remembered = safeGet(LS_KEY);
if (remembered && !scopes.some((s) => s.scope === remembered)) {
  localStorage.removeItem(LS_KEY);
  renderScopePicker(scopes);                 // 回落到 s.current
  return;
}

// tab 点击（app.js:520）带上 scope，URL 保持可分享
location.hash = `#/${r}${currentScope() ? `?scope=${encodeURIComponent(currentScope())}` : ''}`;
```

### 机械验收
1. 打开 `#/today`，下拉切到 `repo:foo`，依次点 graph→search→today：DevTools Network 里每次 `/api/*`（含 graph.js:105 的 `/api/graph`）`scope=repo:foo` 恒定；顶栏下拉选中 `repo:foo`。
2. 地址栏直接输入 `#/graph`（无 query，localStorage 已有 `repo:foo`）：首屏 `/api/graph?...&scope=repo:foo`。
3. `localStorage.removeItem('sedimem.ui.scope')` + 刷新 `#/today`：请求不带 scope，`/api/scopes` 的 `current` 项被选中（启动分库）。
4. URL 显式 `?scope=repo:bar` 覆盖 localStorage 的 `repo:foo`：请求用 `repo:bar`，且 change 后 localStorage 变为 `repo:bar`。
5. 删除 `~/.memo/items/repo:foo.jsonl` 后刷新：localStorage 被清，回落 current，无 500（陈旧 scope 校验生效）。
6. search 页输入词后切分库：hash 保留 `q`，结果按新 scope 重查。

## 4. 顺带检查

- **`/api/scopes` 有 `current` 字段**：有。server.js:103-108 调 `listScopes(memoHome, svc.scope)`；scopes.js:46 每项带 `current: scope === currentScope`，且 scopes.js:50-52 保证无文件的当前库也列出（records:0）。app.js:540 的 `list.find((s) => s.current)?.scope` 依赖成立。
- **注意**：`/api/scopes` 的 `current` 恒指服务端启动分库，与 hash 里的 scope 无关（listScopes 不接收 query scope）——这正是 app.js:540 要先 `currentScope()` 再兜底 `s.current` 的原因，B 方案读侧兜底与此一致。
- **下拉计数不会因刷新而错**：listScopes 每次调用都重读 jsonl 全文计数（scopes.js:36-44，读一次防 TOCTOU）；且 app.js:513 hashchange 和启动（app.js:569）都调 `loadScopes()`，页面切换即刷新计数。唯一偏差窗口是「同页停留期间他处写入」，属可接受的最终一致。

## 改造清单（可照抄）
1. ui/app.js:18-21 拆出 `hashScope()`，新增 `currentScope()` 三级回落（hash > localStorage > ''）+ `safeGet/safeSet`。
2. ui/app.js:557-560 change 回调：写 localStorage；用 URLSearchParams 保留 `q`（修搜索页切库丢词）。
3. ui/app.js:533 loadScopes：渲染前校验 localStorage 值是否在 `/api/scopes` 列表，不在则删除并按 `s.current` 回落。
4. ui/app.js:520 tab 点击：hash 带 `?scope=`（URL 可分享；非必须但建议）。
5. 服务端零改动（scopes.js/server.js 不动）。
