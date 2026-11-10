# dsh-sedimem · 记忆中心（DSH 插件）

把 [sedimem](https://github.com/Old-Friends-Gathering/sedimem) 的只读观察台（今日变化 / 记忆图谱 / 卫生洞察）装进 DeepSeek Harness 的侧边栏：一行「记忆中心」，点击进入中列整页。

```
DSH 侧边栏
└── 记忆中心 ──→ 中列 iframe（同源代理）
                 └── sedimem 观察台（今日 / 图谱 / 卫生，只读）
```

## 它不替换任何东西

- **MCP 记忆工具（`memory_*`）与本插件无关**：工具仍由 `dsh-mcp-client` + sedimem MCP server 那行 cordis 配置提供，三端（DSH / Codex / Claude Code）共用 `~/.memo` 的既有链路原样保留。
- 插件优先**复用已经在跑的观察台**（配了 `observerUrl` 且活着就直接代理）；探测不到才启动内嵌副本兜底——所以本机 launchd 常驻的那份永远是唯一事实源，不会出现第二套会漂移的代码。

## 安装

### 方式一：本仓库内插件目录（开发/自用）

```bash
cd ~/.dsh/profiles/desktop
<runtime-node> <pnpm.mjs> add file:/path/to/sedimem/plugin/dsh-sedimem
# 再把 cordis.patch.yml 的 insert 行合入 profile 的 cordis.patch.yml（见下）
```

然后完全退出并重启 DSH。

### 方式二：从 GitHub（dshmarket 的发现源就是 GitHub 仓库）

dshmarket 会扫描 GitHub 上带 `dsh` 元数据的包；本插件位于
`Old-Friends-Gathering/sedimem` 仓库的 `plugin/dsh-sedimem` 子路径，market 里按仓库地址即可安装。

### cordis 行（手动安装时合入 profile 的 `cordis.patch.yml`）

```yaml
- insert:
    - id: dsh-sedimem
      name: dsh-sedimem
      config:
        observerUrl: http://127.0.0.1:7788   # 可选：复用已常驻的观察台（强烈建议）
        # memoHome: /your/.memo               # 可选，默认 ~/.memo
        # scope: repo:your-project            # 可选，默认取 items/ 里 mtime 最新的分库
```

## 配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `observerUrl` | 无 | 已常驻观察台地址（必须回环）。活着→纯代理壳；不可达→内嵌兜底 |
| `memoHome` | `~/.memo` | 内嵌兜底副本的数据目录（与 MCP/CLI 同一份） |
| `scope` | items 里最新分库 | 内嵌兜底副本的默认分库；页面里仍可随时切 |
| `port` | 随机空闲 | 内嵌兜底副本端口 |
| `nodePath` | `process.execPath` | 兜底副本的 node |
| `enabled` | `true` | `false` 时不注册任何路由 |

## 安全

- 观察台本身只读、只绑 `127.0.0.1`；插件代理路由再叠一层栅栏（回环 socket + 回环 Host + 无转发头 + 非跨站标记），与 skill-explorer 同款。
- `observerUrl` 只接受回环目标——不会被配置成把请求代理到局域网。
- iframe 同源（经 DSH 自己的 webServer），无跨源 cookie / X-Frame-Options 问题。

## 内嵌副本的同步纪律

`lib/{src,ui,config}` 是 `versions/v0.3` 的**逐字节拷贝**（插件必须自包含才能 npm/GitHub 分发）。改了核心代码后跑：

```bash
bash scripts/sync-from-v03.sh
```

`test/host.test.js` 有哈希一致性断言，忘了同步会红。

## 测试

```bash
node --test --test-force-exit test/host.test.js
```

覆盖：路由元数据 / 内嵌副本防漂移 / 外部模式纯代理 / 内嵌模式兜底 / 非回环 Host 与非回环 observerUrl 双拒。
