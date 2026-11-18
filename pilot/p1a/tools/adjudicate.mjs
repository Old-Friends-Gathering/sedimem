// adjudicate.mjs —— 裁决表的**记录化自动裁决策略**（union 策略）
// 规格来源：docs/design/v2.0/06-annotation-spec.md §3.1（降级模式 model-dual-blinded）
//
// 这不是"人工裁决的替代品"：它把一套**可复核的规则**应用到裁决表上，并把规则与统计写进产物，
// 使 goldset 的每条 claim 都能追溯到「为什么留下」。人工双标注到位后应改用人工裁决并升级 annotationMode。
//
// 策略（union）：
//   - claim 只在一侧出现 → 取有该 claim 的一侧（a / b）——两遍盲评的并集，避免单遍漏标直接丢失候选；
//   - claim 两侧都在但有字段分歧 → merge（文本取 A、字段取 B，见 buildGoldset 的 mergeClaims 语义）；
//   - 已有人工裁决（resolution != null）→ 原样保留，绝不覆盖。
// 产物附带 confirmedByBoth 统计：只有 field-mismatch/merge 行（两遍都提出同一 claim）算"双遍确认"，
// 单侧 claim 一律标记为未确认，供报告如实披露。

export const RULE_VERSION = 'union-policy@v1';

/** 按 union 策略回填裁决表的 resolution；返回 {rows, stats}（不修改入参）。 */
export function applyUnionPolicy(worksheet = {}, { rule = RULE_VERSION } = {}) {
  const rows = (worksheet?.rows ?? []).filter(Boolean);
  const byResolution = { a: 0, b: 0, merge: 0, both: 0 };
  let preserved = 0;
  const out = rows.map((r) => {
    if (r.resolution != null) {
      preserved += 1;
      if (byResolution[r.resolution] != null) byResolution[r.resolution] += 1;
      return { ...r, adjudicatedBy: r.adjudicatedBy ?? 'human' };
    }
    let res;
    if (r.kind === 'claim-only-in-A') res = 'a';
    else if (r.kind === 'claim-only-in-B') res = 'b';
    else res = 'merge';
    byResolution[res] += 1;
    return { ...r, resolution: res, adjudicatedBy: rule };
  });
  const stats = {
    rule,
    rows: out.length,
    preserved,
    byResolution,
    confirmedByBoth: byResolution.merge + byResolution.both,
    singleSided: byResolution.a + byResolution.b,
  };
  return { rows: out, stats };
}

/** 从裁决后的 goldset 统计"双遍确认"与"单遍" claim 数（报告用）。 */
export function goldsetConfirmationStats(goldset) {
  const scenarios = goldset?.scenarios ?? [];
  let total = 0;
  let both = 0;
  let single = 0;
  for (const s of scenarios) {
    for (const g of s.gold ?? []) {
      total += 1;
      if (g.confirmedByBoth) both += 1;
      else single += 1;
    }
  }
  return { total, confirmedByBoth: both, singleSided: single, bothRate: total === 0 ? null : both / total };
}
