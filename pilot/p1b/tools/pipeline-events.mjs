// R8 事件、用量与降级 —— docs/design/v2.0/09-extraction-pipeline.md §9
// 枚举映射（09 §9）：incomplete → missing（07 视角）、policy-blocked → failure、degradedReason → degraded。

const KINDS = ['extraction', 'usage', 'decision'];

const REQUIRED_FIELDS = {
  extraction: ['runId', 'rangeId', 'candidates', 'stageDurations', 'failureCounts'],
  usage: ['runId', 'inputTokens', 'outputTokens', 'pricingVersion', 'amountCny', 'retries'],
  decision: ['runId', 'opId', 'decider', 'reason', 'rulesHit', 'decision'],
};

export function createEventLog({ clock } = {}) {
  const now = clock ?? (() => new Date().toISOString());
  const entries = [];
  let seq = 0;

  return {
    record(kind, payload) {
      if (!KINDS.includes(kind)) {
        throw new Error(`E_EVENT_KIND:${kind}`);
      }
      for (const field of REQUIRED_FIELDS[kind]) {
        // usage.amountCny 必填键；成本未知用 null 表达（runStatus 计入 missing，绝不填 0）。
        if (payload[field] === undefined) {
          throw new Error(`E_EVENT_FIELDS:${field}`);
        }
        // amountCny=null 允许写入（runStatus 会视为 usage 缺，不得填 0）；其它字段 null 仍非法。
        if (payload[field] === null && !(kind === 'usage' && field === 'amountCny')) {
          throw new Error(`E_EVENT_FIELDS:${field}`);
        }
      }
      seq += 1;
      const entry = { ...payload, kind, at: now(), seq };
      entries.push(entry);
      return entry;
    },

    all() {
      return [...entries];
    },

    ofKind(kind) {
      return entries.filter((e) => e.kind === kind);
    },

    ofRun(runId) {
      return entries
        .filter((e) => e.runId === runId)
        .sort((a, b) => a.seq - b.seq);
    },

    size() {
      return entries.length;
    },
  };
}

export function runStatus(log, runId) {
  const runEvents = log.ofRun(runId);

  const missing = KINDS.filter((kind) => {
    const found = runEvents.filter((e) => e.kind === kind);
    if (found.length === 0) return true;
    // usage.amountCny 缺失/null 视为 usage 缺（不得填 0）
    if (kind === 'usage') {
      return !found.some((e) => e.amountCny !== undefined && e.amountCny !== null);
    }
    return false;
  });

  // 枚举映射：incomplete → missing（07 视角）。missing 比 degraded 更严重，先判。
  if (missing.length > 0) {
    return { status: 'incomplete', observability: 'missing', missing };
  }

  if (runEvents.some((e) => e.kind === 'decision' && e.reason === 'policy-blocked')) {
    return { status: 'policy-blocked', observability: 'failure', missing };
  }

  // 枚举映射：degradedReason → degraded
  const degraded = runEvents.find((e) => e.kind === 'extraction' && e.degradedReason != null);
  if (degraded) {
    return {
      status: 'success',
      observability: 'degraded',
      missing,
      degradedReason: degraded.degradedReason,
    };
  }

  return { status: 'success', observability: 'success', missing };
}

export function verdictAllowed(result) {
  return result != null && result.observability === 'success' && result.status === 'success';
}
