// session/checkpoint-llm.js — 会话临时库接 LLM 的自动 checkpoint（W4）
// 流程：transcript turns → compact → LLM（purpose="checkpoint"）→ 严格 JSON 8 段
// → normalizeCheckpoint + writeCheckpoint。
// LLM 不可用 / 调用失败 / 解析失败 → 回落确定性规则抽 8 段（永不抛异常给调用方，
// 失败返回 { mode:'fallback', reason }）。
// 价格读 policy.llm?.price（inPerM/outPerM，元/百万字符粗估），缺省 0.8 / 2.8。

import { systemClock } from '../core/clock.js';
import { normalizeCheckpoint, writeCheckpoint } from './checkpoint.js';
import { compactTranscript } from './transcript.js';

/** 价格缺省：输入 0.8 元/M 字符、输出 2.8 元/M 字符（与 config/policy.json 缺省一致） */
const DEFAULT_PRICE = { inPerM: 0.8, outPerM: 2.8 };

const SCHEMA_PROMPT = [
  '只输出一个 JSON 对象，不要输出任何其他文字（可以包在 ```json 代码围栏里）。',
  '字段（8 段，缺的给空值，不要编造）：',
  '{"intent": string, "concepts": string[], "files": string[], "errorsAndFixes": string[],',
  ' "pendingJobs": string[], "currentState": string, "nextSteps": string[], "criticalContext": string}',
  'intent/currentState/criticalContext 是字符串，其余是字符串数组。',
  'files 只收真实出现过的文件路径；nextSteps 只收明确的下一步动作。',
].join('\n');

/** 从 LLM 输出文本里抽第一个配平的 JSON 对象（容忍代码围栏 / 前后废话） */
function extractJson(text) {
  const raw = String(text ?? '');
  // 先剥 ```json 围栏（有围栏时优先按围栏内容整段解析）
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const candidates = [];
  if (fence) candidates.push(fence[1]);
  candidates.push(raw);
  for (const cand of candidates) {
    const start = cand.indexOf('{');
    if (start === -1) continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < cand.length; i++) {
      const ch = cand[i];
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') inStr = !inStr;
      if (inStr) continue;
      if (ch === '{') depth += 1;
      if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          try {
            const obj = JSON.parse(cand.slice(start, i + 1));
            if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj;
          } catch { break; }
        }
      }
    }
  }
  return null;
}

// ===== 确定性回落规则（无 LLM 也能抽出像样的 8 段）=====

/** 意图关键词：命中即拼进 intent */
const INTENT_KEYWORDS = ['任务', '实现', '修复', '重构', '测试', '接入', '编写', '新增', '修改', '目标', '需求'];

/** 从 turns 按关键词抽 intent（取前 3 条命中的 user 行，最多 200 字） */
function fallbackIntent(turns) {
  const hits = [];
  for (const t of turns) {
    if (t.role !== 'user') continue;
    if (INTENT_KEYWORDS.some((k) => t.text.includes(k))) hits.push(t.text.slice(0, 200));
    if (hits.length >= 3) break;
  }
  return hits.join('；');
}

/** 路径正则：抽文件路径（带扩展名，含目录斜杠，排除纯词） */
const FILE_RE = /(?:[\w.-]+\/)+[\w.-]+\.[A-Za-z][\w]{0,9}|[\w-]+\.(?:js|ts|jsx|tsx|mjs|cjs|json|md|py|go|rs|java|yaml|yml|html|css|sh|toml)\b/g;

function fallbackFiles(turns) {
  const seen = new Set();
  const files = [];
  for (const t of turns) {
    for (const m of t.text.matchAll(FILE_RE)) {
      const f = m[0];
      if (!seen.has(f)) { seen.add(f); files.push(f); }
    }
    if (files.length >= 20) break;
  }
  return files;
}

/** 抽「TODO / 接下来 / 下一步」句子作 nextSteps */
const NEXT_RE = /(?:TODO[:：]|接下来[:：,，]?|下一步[:：,，]?)([^。\n]{1,160})/g;

function fallbackNextSteps(turns) {
  const steps = [];
  for (const t of turns) {
    for (const m of t.text.matchAll(NEXT_RE)) {
      const s = m[1].trim();
      if (s !== '') steps.push(s);
    }
    if (steps.length >= 10) break;
  }
  return steps;
}

/** 确定性 8 段：intent/files/nextSteps 有规则，其余诚实留空（不编造） */
function fallbackCheckpoint(turns) {
  return normalizeCheckpoint({
    intent: fallbackIntent(turns),
    concepts: [],
    files: fallbackFiles(turns),
    errorsAndFixes: [],
    pendingJobs: [],
    currentState: '',
    nextSteps: fallbackNextSteps(turns),
    criticalContext: '',
  });
}

/**
 * 会话自动 checkpoint：LLM 优先，失败回落确定性规则。
 * 永不抛异常（除 service 缺失等参数错误）；LLM 分支失败不影响 fallback 落盘。
 * @param {{service: object, transcriptPath?: string, turns?: Array,
 *          llmPort?: object, memoHome: string, scope: string,
 *          price?: {inPerM: number, outPerM: number}, clock?: object}} args
 *   llmPort 鸭子类型同 src/llm/port.js：{ ready: boolean, complete({purpose,system,user}) }。
 *   price 缺省回落 DEFAULT_PRICE（调用方通常传 policy.llm?.price）。
 * @returns {Promise<{mode: 'llm'|'fallback', checkpoint: object,
 *            reason?: string, cost?: {inputChars: number, outputChars: number, estimatedCny: number}}>}
 */
export async function autoCheckpoint({
  service, transcriptPath, turns, llmPort,
  price, clock = systemClock,
}) {
  if (!service) {
    const e = new Error('autoCheckpoint: service is required');
    e.code = 'E_INVALID_ARG';
    throw e;
  }
  // turns 来源：显式传入优先；否则读 transcriptPath（plain text 或 jsonl 都逐行当记录试）
  let src = Array.isArray(turns) ? turns : null;
  let fileRaw = '';
  if (!src) {
    if (!transcriptPath || typeof transcriptPath !== 'string') {
      throw Object.assign(new Error('autoCheckpoint: 需要 turns 或 transcriptPath'), { code: 'E_INVALID_ARG' });
    }
    const { readFileSync } = await import('node:fs');
    try {
      fileRaw = readFileSync(transcriptPath, 'utf8');
    } catch (e) {
      return { mode: 'fallback', reason: `transcript 读取失败: ${e.message}`, checkpoint: fallbackCheckpoint([]) };
    }
    const parsed = [];
    for (const line of fileRaw.split('\n')) {
      const t = line.trim();
      if (t === '') continue;
      try {
        const rec = JSON.parse(t);
        if (rec && typeof rec === 'object') parsed.push(rec);
      } catch { /* 纯文本行：当 user 消息 */ parsed.push({ role: 'user_message', message: t }); }
    }
    // 复用 toTurns 的形状兼容（user_message / response_item / message …）
    const { toTurns } = await import('./transcript.js');
    src = toTurns(parsed).turns;
  }

  const inputChars = src.reduce((n, t) => n + String(t.text ?? '').length, 0);
  const runLlm = async () => {
    const ready = typeof llmPort?.ready === 'function' ? llmPort.ready() : llmPort?.ready;
    if (ready !== true) {
      return { ok: false, reason: llmPort ? `llm 未就绪（ready=${String(ready)}）` : '未提供 llmPort' };
    }
    const user = [
      '以下是会话转录（可能被压缩省略中间部分），请总结成 8 段 checkpoint：',
      '```',
      compactTranscript(src),
      '```',
      SCHEMA_PROMPT,
    ].join('\n');
    const system = '你是会话 checkpoint 总结器。严格 JSON 输出，禁止编造转录里不存在的内容。';
    let res;
    try {
      res = await llmPort.complete({ purpose: 'checkpoint', system, user });
    } catch (e) {
      return { ok: false, reason: `llm 调用异常: ${e?.code ?? e?.message ?? 'Error'}`, inputChars: user.length };
    }
    if (!res || res.ok !== true) {
      return {
        ok: false,
        reason: `llm 调用失败: ${res?.error?.code ?? 'unknown'}`,
        inputChars: user.length,
      };
    }
    const parsed = extractJson(res.text);
    if (!parsed) return { ok: false, reason: 'llm 输出无法解析为 JSON', inputChars: user.length, outputChars: res.text.length };
    return { ok: true, parsed, inputChars: user.length, outputChars: res.text.length };
  };

  const price_ = price && typeof price === 'object' ? price : DEFAULT_PRICE;
  const inRate = Number(price_.inPerM) > 0 ? Number(price_.inPerM) : DEFAULT_PRICE.inPerM;
  const outRate = Number(price_.outPerM) > 0 ? Number(price_.outPerM) : DEFAULT_PRICE.outPerM;

  const llmRes = await runLlm();
  if (llmRes.ok) {
    try {
      const checkpoint = normalizeCheckpoint(llmRes.parsed);
      await writeCheckpoint({ service, checkpoint, clock });
      return {
        mode: 'llm',
        checkpoint,
        cost: {
          inputChars: llmRes.inputChars ?? inputChars,
          outputChars: llmRes.outputChars ?? 0,
          estimatedCny: ((llmRes.inputChars ?? 0) / 1_000_000) * inRate
            + ((llmRes.outputChars ?? 0) / 1_000_000) * outRate,
        },
      };
    } catch (e) {
      // LLM 给的 JSON 过不了 8 段校验 → 回落确定性规则
      const checkpoint = fallbackCheckpoint(src);
      await writeCheckpoint({ service, checkpoint, clock });
      return { mode: 'fallback', reason: `llm 输出未通过校验: ${e.message}`, checkpoint };
    }
  }
  const checkpoint = fallbackCheckpoint(src);
  await writeCheckpoint({ service, checkpoint, clock });
  return { mode: 'fallback', reason: llmRes.reason, checkpoint };
}
