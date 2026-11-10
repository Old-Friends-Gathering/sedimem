// pre-step.js —— 把「每步注入」注册到宿主（v0.4 D2）。
//
// 内容组装在 ./inject-core.js（由 scripts/sync-plugin.sh 从
// versions/v0.4/src/render/inject.js 复制，勿手改）；本文件只负责：
//  1. 读配置开关（inject.enabled，默认关闭）；
//  2. 用 systemPrompt.context 注册一个「动态 text」槽位；
//  3. 在 agent/pre-step 事件里刷新缓存（不改 messages）；
//  4. 任何异常只 log，不影响主对话。
//
// 宿主接缝实证（2026-11-10，app.asar）：
//  - `ctx.systemPrompt.context({name, order, required, text})`，`text` 可为 () => string（11 处同款）；
//  - `ctx.on('agent/pre-step', async ({agent,messages,step,signal}, next) => …)`（15 处同款）。

import { buildInjection } from './inject-core.js';

// 兼容再导出：老调用方（测试 / 其他插件）历史上从 pre-step.js 取 buildInjection。
export { buildInjection } from './inject-core.js';

const TAG = '[sedimem:inject]';

/**
 * 注册每步注入（D2）。**只做一件事：让宿主在每步渲染时拿到一小段记忆目录。**
 *
 * 接缝选择（基于 app.asar 实证）：
 *  - 主接缝 `ctx.systemPrompt.context({name, order, required, text})`：asar 内 11 处同款
 *    用法，`text` 可以是 `() => string` 的函数（动态求值），这是唯一**非侵入**的注入方式；
 *  - 辅助 `ctx.on('agent/pre-step', handler)`：只在渲染前**刷新缓存**，不修改 messages
 *    （改宿主消息数组会把一次注入变成对话历史污染，且不同版本 payload 形状会漂）。
 *
 * 防御纪律：
 *  - `inject.enabled !== true` → 不注册（默认关闭）；
 *  - 没有 systemPrompt 接缝 → 只注册缓存刷新并 log（registered:false）；
 *  - 任何构建/读盘异常都吞掉并 log，注入面故障绝不冒泡到对话。
 *
 * @param {object} ctx 宿主插件上下文（全部防御式访问）
 * @param {{config?: {inject?: {enabled?: boolean, maxChars?: number, scope?: string}},
 *          memoHome?: string, log?: (...args: unknown[]) => void}} args
 * @returns {{registered: boolean, mode?: 'systemPrompt'|'cache-only'}}
 */
export function registerPreStep(ctx, { config = {}, memoHome, log = () => {} } = {}) {
  const inject = config.inject ?? {};
  if (inject.enabled !== true) return { registered: false };
  if (!memoHome || typeof memoHome !== 'string') {
    const err = new Error('registerPreStep: memoHome is required when inject.enabled');
    err.code = 'E_INVALID_ARG';
    throw err;
  }
  const maxChars = Number.isFinite(inject.maxChars) ? inject.maxChars : 1200;
  // 对抗审核 S-7：**绝不**用「最近修改的分库」猜 scope —— 那会把别的项目记忆注入进来。
  // 只认显式配置或 MEMO_SCOPE；都没有就宁可不注入（fail closed）。
  const configured = typeof inject.scope === 'string' && inject.scope !== '' ? inject.scope : '';
  const scope = configured !== '' ? configured : (process.env.MEMO_SCOPE ?? '').trim();
  if (!scope) {
    log(`${TAG} no explicit scope (config.inject.scope / MEMO_SCOPE), injection stays idle`);
    return { registered: false };
  }

  /** 最近一次成功构建的注入文本（systemPrompt.context 的 text 必须同步返回）。 */
  let cached = '';
  /** 并发保护：同一时刻只跑一次磁盘构建。 */
  let inflight = null;

  async function refresh() {
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const built = await buildInjection({ memoHome, scope, maxChars });
        cached = built?.text ?? '';
        if (built) log(`${TAG} prepared ${built.chars} chars from ${built.source} (scope=${scope})`);
      } catch (e) {
        log(`${TAG} build failed: ${e?.message ?? e}`);
        cached = '';
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  // 启动即预热一次：第一步渲染就能拿到内容（不阻塞 apply）
  void refresh();

  // ① 主接缝：systemPrompt.context —— 动态 text 函数，每步渲染时读缓存
  const prompt = ctx?.systemPrompt;
  if (prompt && typeof prompt.context === 'function') {
    try {
      prompt.context({
        name: 'dsh-sedimem:memory-index',
        // 排在 team identity(125) 之后、harness source(200) 之前：
        // 记忆目录属于「环境事实」，不该抢在身份之后、也不该落到部署说明之后。
        order: 150,
        required: false,
        text: () => cached,
      });
      // ② 辅助：每步开始前刷新缓存（不碰 messages）
      if (typeof ctx.on === 'function') {
        try {
          ctx.on('agent/pre-step', async (_payload, next) => {
            await refresh();
            if (typeof next === 'function') await next();
          });
        } catch (e) {
          log(`${TAG} ctx.on('agent/pre-step') unavailable: ${e?.message ?? e}`);
        }
      }
      log(`${TAG} per-step injection enabled (maxChars=${maxChars}, scope=${scope})`);
      return { registered: true, mode: 'systemPrompt' };
    } catch (e) {
      log(`${TAG} ctx.systemPrompt.context failed: ${e?.message ?? e}`);
    }
  }

  // ③ 没有 systemPrompt 接缝：保留缓存刷新，不做注入（诚实降级，不假装成功）
  log(`${TAG} no systemPrompt.context on host — injection idle (cache refresh only)`);
  return { registered: false, mode: 'cache-only' };
}
