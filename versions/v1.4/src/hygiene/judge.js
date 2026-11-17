// hygiene/judge.js — JudgePort 默认实现（车道 C，issue #34；契约：docs/02 §3.13 裁决 50）
// 为什么是确定性规则而非 LLM：curateAuto 是无人值守回路，默认裁决器必须可单测、可复现、
// 零 IO——误合并的代价只能来自「strong + 同 slot」这种结构化证据，语义歧义一律 keep_both
// 交回 Agent。自定义裁决器经 createMemoryService({ judge }) 注入（裁决 50），不走环境变量。

/**
 * 构造裁决器。
 * @param {{policy?: object}} [args] policy.curate.judge 指定裁决器名；
 *        缺省或 'rule' 用内置规则裁决器；名称不认识 → E_POLICY（fail-loud，
 *        静默换回默认会让「配了 LLM judge 却跑的是规则」变成玄学）。
 * @returns {{name: string, decide({pair: object, a: object, b: object}): {decision: string, note: string}}}
 */
export function createJudge({ policy } = {}) {
  // 裁决器名只认 policy（策略单一来源，裁决 20）；未配置 = 'rule'
  const wanted = policy?.curate?.judge ?? 'rule';
  if (wanted !== 'rule') {
    const err = new Error(
      `createJudge: unknown judge "${wanted}" (known: rule); configure policy.curate.judge or inject via createMemoryService({judge})`,
    );
    err.code = 'E_POLICY';
    throw err;
  }
  return { name: 'rule', decide: ruleJudge };
}

/** slot 键：subject + NUL + predicate（NUL 不会出现在正文字段里，无歧义拼接） */
function slotOf(r) {
  return `${r?.subject ?? ''}\u0000${r?.predicate ?? ''}`;
}

/**
 * 规则裁决器（确定性、无 LLM、无 IO）。
 * 规则表（docs/02 §3.13 裁决 50）：
 * - strength !== 'strong'                          → keep_both（rule:weak）
 * - strong 且 a/b slot 不同                        → keep_both（rule:strong-diff-slot）
 * - strong 且同 slot 且 hits 不等                  → hits 高者胜（rule:strong+hits(a=…,b=…)）
 * - strong 且同 slot 且 hits 相等                  → createdAt 更早者胜（老记录先到先得）
 * - strong 且同 slot 且 hits/createdAt 完全相等     → keep_both（rule:strong+equal，无依据不下判）
 * @param {{pair: {strength?: string}, a: object, b: object}} args
 * @returns {{decision: 'a_wins'|'b_wins'|'keep_both', note: string}}
 */
export function ruleJudge({ pair, a, b }) {
  // weak（含 strength 缺失）：默认保守，宁可漏杀不可误杀（裁决 27）
  if (pair?.strength !== 'strong') return { decision: 'keep_both', note: 'rule:weak' };

  // strong 但 slot 不同：结构化证据不成立，两条可能是同主题的不同事实
  if (slotOf(a) !== slotOf(b)) return { decision: 'keep_both', note: 'rule:strong-diff-slot' };

  const hitsA = a.hits ?? 0;
  const hitsB = b.hits ?? 0;
  if (hitsA !== hitsB) {
    // hits 是唯一可量的「谁更有用」信号：被召回多者胜
    const winner = hitsA > hitsB ? 'a_wins' : 'b_wins';
    return { decision: winner, note: `rule:strong+hits(a=${hitsA},b=${hitsB})` };
  }

  const createdA = String(a.createdAt ?? '');
  const createdB = String(b.createdAt ?? '');
  if (createdA !== createdB) {
    // hits 打平：保留先写入的（先到先得，且与 dedupeScan 的 validFrom 升序一致）
    const winner = createdA < createdB ? 'a_wins' : 'b_wins';
    return { decision: winner, note: `rule:strong+createdAt(a=${createdA},b=${createdB})` };
  }

  // 完全无差别：没有任何依据可下判，keep_both（非破坏，交回 Agent）
  return { decision: 'keep_both', note: 'rule:strong+equal' };
}
