// R4.5 断言框架机判 — docs/design/v2.0/09-extraction-pipeline.md §5「R4.5 断言框架机判」
// 纯函数、无 IO；五条机判均只看确定性格式，不做语义相似度判断。
// 每条 check 对应规格表格一行（表格列：speaker / negated / speechAct=suggest /
// speechAct=complete / speechAct=retract）。

const QUOTE_MARKERS = (s) => typeof s === 'string';

// —— speaker（规格表第 1 行）——
// 转述/引用位置不得标 user（应 quoted）
const QUOTE_CONTEXT = ['用户说', '用户提到', 'user said', 'per the user'];

function checkSpeaker(assertion, evidence) {
  const violations = [];
  const declared = assertion.speaker;
  for (const e of evidence) {
    const role = e.role;
    if (role === 'quoted') continue; // quoted 与任何声明不冲突
    if (declared == null) continue; // 未声明 speaker → 不算错
    if (declared === 'quoted') continue;
    if (declared === 'tool' || declared.startsWith('tool:')) {
      if (role === 'tool') {
        // tool:<name> 时要求 toolName===name；缺 toolName 按 role==='tool' 通过
        if (declared.startsWith('tool:')) {
          const name = declared.slice('tool:'.length);
          if (assertion.toolName != null && assertion.toolName !== name) {
            violations.push({ check: 'speaker', reason: `evidence ${e.eventId}: role=tool 但 assertion.toolName="${assertion.toolName}" 与声明 "${declared}" 不符` });
          }
        }
        continue; // 通过
      }
      if (role != null && role.startsWith('tool:')) {
        if (declared === 'tool' || role === declared) continue;
        violations.push({ check: 'speaker', reason: `evidence ${e.eventId}: role="${role}" 与声明 "${declared}" 不符` });
        continue;
      }
      violations.push({ check: 'speaker', reason: `evidence ${e.eventId}: role="${role}" 不是工具输出，与声明 "${declared}" 不符` });
      continue;
    }
    // 声明为 user/assistant 等：直接比对 role
    if (role !== declared) {
      // 特例：assistant 转述用户发言而声明 user → 应标 quoted
      if (role === 'assistant' && declared === 'user' && QUOTE_CONTEXT.some((m) => (e.quote || '').includes(m))) {
        violations.push({ check: 'speaker', reason: `evidence ${e.eventId}: 引文为转述位置（含「用户说」类标记），应标 quoted 而非 user` });
        continue;
      }
      violations.push({ check: 'speaker', reason: `evidence ${e.eventId}: role="${role}" 与声明 speaker="${declared}" 不符` });
    }
  }
  return violations;
}

// —— negated（规格表第 2 行）——
const NEG_MARKERS = ['不', '未', '没有', '没', 'never', 'not', 'no'];
const NEG_EXCLUDES = ['不仅', '不过', '不确定', 'not only'];

function hasNegation(text) {
  const t = text || '';
  const window = (marker) => t.split(marker).length - 1 > 0;
  for (const marker of NEG_MARKERS) {
    let idx = t.indexOf(marker);
    while (idx !== -1) {
      // 排除不表否定的组合词：检查 marker 前后是否构成排除词
      const excluded = NEG_EXCLUDES.some((ex) => {
        const p = t.indexOf(ex);
        while (p !== -1) {
          if (ex.includes(marker) && p <= idx && idx < p + ex.length) return true;
          p = t.indexOf(ex, p + 1);
        }
        return false;
      });
      if (!excluded) return true;
      idx = t.indexOf(marker, idx + 1);
    }
  }
  return false;
}

function checkNegated(assertion, evidence) {
  const violations = [];
  const negated = assertion.negated === true;
  for (const e of evidence) {
    const q = QUOTE_MARKERS(e.quote) ? e.quote : '';
    if (hasNegation(q) && !negated) {
      violations.push({ check: 'negated', reason: `evidence ${e.eventId}: 引文含否定标记但 negated=false` });
    } else if (!hasNegation(q) && negated) {
      violations.push({ check: 'negated', reason: `evidence ${e.eventId}: 引文无否定标记但 negated=true` });
    }
  }
  return violations;
}

// —— speechAct=suggest（规格表第 3 行）——
const SUGGEST_MARKERS = ['建议', '可以', '不妨', 'could', 'should', 'maybe', '建议你'];

function checkSuggest(assertion, status, evidence) {
  if (assertion.speechAct !== 'suggest') return [];
  const violations = [];
  const okStatus = ['suggestion-only', 'conditional'];
  for (const e of evidence) {
    const q = e.quote || '';
    if (SUGGEST_MARKERS.some((m) => q.includes(m)) && !okStatus.includes(status)) {
      violations.push({ check: 'speechAct-suggest', reason: `evidence ${e.eventId}: 引文含建议式表述但 status="${status}" 不是 suggestion-only|conditional` });
    }
  }
  return violations;
}

// —— speechAct=complete（规格表第 4 行）——
const USER_CONFIRM_MARKERS = ['已', '完成', 'done', '完成了吗', '确认'];

function checkComplete(claimObj, assertion, evidence) {
  if (assertion.speechAct !== 'complete') return [];
  const violations = [];
  if (claimObj.type !== 'task-state') {
    violations.push({ check: 'speechAct-complete', reason: `type="${claimObj.type}" 不是 task-state` });
    return violations;
  }
  for (const e of evidence) {
    const role = e.role || '';
    const isTool = role === 'tool' || role.startsWith('tool:');
    const isUserConfirm = role === 'user' && USER_CONFIRM_MARKERS.some((m) => (e.quote || '').includes(m));
    if (isTool || isUserConfirm) continue;
    if (role === 'assistant') {
      violations.push({ check: 'speechAct-complete', reason: `evidence ${e.eventId}: 助手自称完成不得作为 complete 证据` });
    } else {
      violations.push({ check: 'speechAct-complete', reason: `evidence ${e.eventId}: role="${role}" 既非工具输出，也非用户直接确认` });
    }
  }
  return violations;
}

// —— speechAct=retract（规格表第 5 行）——
const RETRACT_MARKERS = ['撤回', '作废', '取消', '不对', '说错了', 'ignore that', 'never mind'];

function checkRetract(assertion, status, evidence) {
  if (assertion.speechAct !== 'retract') return [];
  const violations = [];
  for (const e of evidence) {
    const q = e.quote || '';
    if (RETRACT_MARKERS.some((m) => q.includes(m)) && status !== 'retracted') {
      violations.push({ check: 'speechAct-retract', reason: `evidence ${e.eventId}: 引文含撤回式表述但 status="${status}" 不是 retracted` });
    }
  }
  return violations;
}

/**
 * checkAssertion({ claim, assertion, evidence }) → { ok, violations }
 * claim = { claim, type, assertion: {...}, status }，evidence = [{ eventId, quote, role }]
 * 逐条核对所有证据，任一不符 → ok=false。
 */
export function checkAssertion(input) {
  if (input == null || typeof input !== 'object') {
    return { ok: false, violations: [{ check: 'input', reason: '输入缺失或不是对象' }] };
  }
  const claimObj = input.claim;
  if (claimObj == null || typeof claimObj !== 'object') {
    return { ok: false, violations: [{ check: 'input', reason: 'claim 缺失或不是对象' }] };
  }
  const assertion = claimObj.assertion;
  if (assertion == null || typeof assertion !== 'object') {
    return { ok: false, violations: [{ check: 'input', reason: 'claim.assertion 缺失或不是对象' }] };
  }
  const evidence = input.evidence;
  if (!Array.isArray(evidence) || evidence.length === 0) {
    return { ok: false, violations: [{ check: 'input', reason: 'evidence 缺失或为空（至少需要一条证据）' }] };
  }

  const violations = [
    ...checkSpeaker(assertion, evidence),
    ...checkNegated(assertion, evidence),
    ...checkSuggest(assertion, claimObj.status, evidence),
    ...checkComplete(claimObj, assertion, evidence),
    ...checkRetract(assertion, claimObj.status, evidence),
  ];
  return { ok: violations.length === 0, violations };
}
