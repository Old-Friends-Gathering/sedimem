/**
 * sedimem 观察台子进程入口（DSH 插件专用）。
 *
 * 与 `memo serve` 的差异只有一个：端口/MEMO_HOME/MEMO_SCOPE 全部来自环境变量
 * （MEMO_PORT 支持随机端口），stdout 只打一行 JSON 就绪信号（宿主据此判断可代理），
 * 不复用 CLI 的人读输出。SIGTERM/SIGINT → 优雅关闭 → exit 0。
 */
import { createWebServer } from './src/web/server.js';

const port = Number(process.env.MEMO_PORT ?? 0);
const memoHome = process.env.MEMO_HOME;
const scope = process.env.MEMO_SCOPE || undefined;

if (!memoHome) {
  process.stderr.write('observer-entry: MEMO_HOME is required\n');
  process.exit(2);
}

let web;
try {
  web = await createWebServer({ memoHome, scope, port, host: '127.0.0.1', includeUi: true });
} catch (err) {
  process.stderr.write(`observer-entry: ${err?.code ?? 'E_START'} ${err?.message ?? err}\n`);
  process.exit(1);
}

const bound = web.server?.address?.();
process.stdout.write(`${JSON.stringify({ ok: true, url: web.url, port: typeof bound === 'object' && bound ? bound.port : null })}\n`);

let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  try {
    await web.close();
  } finally {
    process.exit(0);
  }
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
