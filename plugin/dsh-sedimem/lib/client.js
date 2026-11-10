/**
 * dsh-sedimem —— 客户端束（DSH Web GUI 侧）。
 *
 * 注册两个座位（都是壳层缝，不碰会话中列）：
 *  - `sidebar.panellist`：侧边栏一行「记忆中心」（地层图标）；
 *  - `main`：中列一页，iframe 同源加载宿主代理的观察台（`api/dsh-sedimem/ui/`）。
 *
 * 两条实现纪律（照抄 skill-explorer 的实测契约）：
 *  1. 路径必须文档相对（无前导斜杠）——DSH GUI 带 `<base href="./">`，
 *     子路径部署下 `/api/...` 会打到错的根（issue #1707 同类坑）。
 *  2. 图标组件只画 glyph：壳拥有按钮/标签/几何，组件吃 `{ size }`，
 *     挂 `data-dsh-panel-entry`（L2 皮肤契约靠它认行归属）。
 */
window.__ModuleLoader__.load({
	id: 'dsh-sedimem',
	factory: (require) => {
		const module = { exports: {} };
		const exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
		const react = require('react');

		/** 侧边栏行与中列页共用的稳定 id。 */
		const PANEL_ID = 'sedimem.memory-center';
		/** 壳的全局行序：Plugins 0 / Schedule 10 / skill-explorer 30 → 取 40 避开。 */
		const PANEL_ORDER = 40;
		/** 观察台 UI 的文档相对入口（宿主前缀路由）。 */
		const UI_SRC = 'api/dsh-sedimem/ui/';
		/** health 路由（文档相对）。 */
		const HEALTH = 'api/dsh-sedimem/health';

		const zh = () => (navigator.language || '').toLowerCase().startsWith('zh');

		/**
		 * 侧边栏 glyph：三层沉积（记忆越往下越老）。壳按自己的尺寸与选中态来要，
		 * 组件只画形状 —— 与其它面板行完全同构。
		 * @param {{size?: number}} props 壳的 icon share。
		 */
		function MemoryPanelIcon({ size }) {
			return react.createElement(
				'svg',
				{
					'data-dsh-panel-entry': PANEL_ID,
					viewBox: '0 0 16 16',
					width: size,
					height: size,
					fill: 'none',
					stroke: 'currentColor',
					'stroke-width': '1.3',
					'stroke-linecap': 'round',
					'stroke-linejoin': 'round',
					'aria-hidden': 'true',
				},
				react.createElement('path', { d: 'M2.5 5.5 8 2.7l5.5 2.8L8 8.3z' }),
				react.createElement('path', { d: 'M2.5 9 8 11.8 13.5 9', opacity: 0.65 }),
				react.createElement('path', { d: 'M2.5 12.2 8 15l5.5-2.8', opacity: 0.4 }),
			);
		}

		/**
		 * 中列页：整幅 iframe + 底部状态条。
		 * health 只探一次（观察台数据在 iframe 内自刷）；失败可见、给逃生口，不白屏。
		 */
		function MemoryCenterPage() {
			const [state, setState] = react.useState({ status: 'loading' });
			react.useEffect(() => {
				let alive = true;
				fetch(HEALTH)
					.then((r) => r.json())
					.then((j) => {
						if (alive) setState({ status: 'ok', running: !!j.running, mode: j.mode ?? null, summary: j.summary || null });
					})
					.catch(() => {
						if (alive) setState({ status: 'error' });
					});
				return () => { alive = false; };
			}, []);
			const label = react.useMemo(() => {
				if (state.status === 'loading') return zh() ? '检查观察台…' : 'checking observer…';
				if (state.status === 'error') return zh() ? '观察台状态未知（宿主路由未就绪？）' : 'observer status unknown';
				if (!state.running) return zh() ? '观察台待启动（首次打开自动拉起）' : 'observer idle (starts on first open)';
				const s = state.summary;
				if (s && s.version) return `sedimem ${s.version} · ${s.scope ?? ''}${state.mode === 'external' ? ' · 复用常驻观察台' : ''}`;
				return zh() ? '观察台运行中' : 'observer running';
			}, [state]);
			return react.createElement(
				'div',
				{
					'data-dsh-plugin': 'dsh-sedimem',
					style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 },
				},
				react.createElement('iframe', {
					src: UI_SRC,
					title: 'sedimem memory center',
					style: { flex: 1, width: '100%', border: 'none', minHeight: 0, background: '#0b0e14' },
				}),
				react.createElement(
					'div',
					{
						style: {
							display: 'flex', alignItems: 'center', gap: 8,
							padding: '4px 10px', fontSize: 12, opacity: 0.75,
							borderTop: '1px solid rgba(127,127,127,.25)', flexShrink: 0,
						},
					},
					react.createElement('span', null, label),
					react.createElement(
						'a',
						{ href: UI_SRC, target: '_blank', rel: 'noreferrer', style: { marginLeft: 'auto' } },
						zh() ? '新窗口打开' : 'open in new tab',
					),
				),
			);
		}

		/** 注册侧边栏行与中列页；座位由壳插件声明，未声明时静默缺席而不是崩启动。 */
		function registerMemoryCenter(ctx) {
			const slots = ctx.slots;
			const disposers = [];
			disposers.push(slots.inject('sidebar.panellist', () => slots.register(
				{
					name: 'sidebar.panellist',
					id: PANEL_ID,
					order: PANEL_ORDER,
					label: () => (zh() ? '记忆中心' : 'Memory'),
				},
				MemoryPanelIcon,
			)));
			disposers.push(slots.inject('main', () => slots.register(
				{ name: 'main', key: PANEL_ID },
				MemoryCenterPage,
			)));
			return () => { for (const dispose of disposers.splice(0)) dispose(); };
		}

		/** 需要的客户端服务（fiber inject 等待：slots 未就绪前 apply 不执行）。 */
		const inject = ['slots'];

		/** 装配入口：注册 UI 并在 effect 里收尾。 */
		function apply(ctx) {
			const disposers = [];
			try {
				disposers.push(registerMemoryCenter(ctx));
			} catch (error) {
				console.warn('[dsh-sedimem] panel registration failed:', error);
			}
			ctx.effect(() => () => {
				for (const dispose of disposers.splice(0)) dispose();
			}, 'dsh-sedimem: ui mounts');
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.PANEL_ID = PANEL_ID;
		exports.UI_SRC = UI_SRC;
		return module.exports;
	},
});
