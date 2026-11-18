/** 账本纯视图模型：段行/区间/徽标/截断；无 DOM，便于单测。 */
export const SUMMARY_MAX = 60;

const MODE_LABEL = { rules: 'rules', llm: 'llm' };
const MODE_CLASS = { rules: 'b-accent', llm: 'b-info' };

export function fmtNum(n) {
  const v = Number(n);
  return Number.isFinite(v) ? String(Math.trunc(v)) : '?';
}

/** 60 字截断（按码点，避免切断代理对）；空白折叠。 */
export function truncateSummary(text, max = SUMMARY_MAX) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  const chars = Array.from(clean);
  if (chars.length <= max) return clean;
  return `${chars.slice(0, max).join('')}…`;
}

/** 段区间文案（半开区间 → 闭区间展示）：`1–121`；异常 → '—'。 */
export function segmentRange(seg) {
  const from = Number(seg?.fromSeq);
  const to = Number(seg?.toSeq);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return '—';
  return `${fmtNum(from)}–${fmtNum(to - 1)}`;
}

/** 段来源徽标：rules / llm（未知模式兜底 rules）。 */
export function modeBadge(mode) {
  const m = String(mode ?? '');
  const key = m === 'llm' ? 'llm' : 'rules';
  return { key, label: MODE_LABEL[key], cls: MODE_CLASS[key] };
}

/** 段正文里的字符串列表（decisions/gotchas/nextSteps 可能为字符串或 {text}）。 */
export function textList(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (typeof item === 'string') {
      const t = item.trim();
      if (t) out.push(t);
      continue;
    }
    const t = item && typeof item === 'object' && typeof item.text === 'string' ? item.text.trim() : '';
    if (t) out.push(t);
  }
  return out;
}

/** 单段 → 行视图模型。 */
export function buildSegmentRow(seg) {
  const rec = seg && typeof seg === 'object' ? seg : {};
  const quarantined = rec.quarantined === true;
  const summary = String(rec.summary ?? '');
  return {
    id: typeof rec.id === 'string' ? rec.id : '',
    range: segmentRange(rec),
    mode: modeBadge(rec.mode),
    quarantined,
    quarantineLabel: quarantined ? '⚠ 隔离' : '',
    excerpt: truncateSummary(summary),
    summary,
    decisions: textList(rec.decisions),
    gotchas: textList(rec.gotchas),
    nextSteps: textList(rec.nextSteps),
    anchorShort: rec?.source?.sessionId ? `…${String(rec.source.sessionId).slice(-6)}` : '',
    anchorFull: rec?.source?.sessionId ? String(rec.source.sessionId) : '',
    when: (() => { const t = Date.parse(rec?.fromAt) || Date.parse(rec?.createdAt); if (!Number.isFinite(t)) return ''; return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(t)).slice(5).replace('T', ' '); })(),
    ordinal: 0,
  };
}

/** 段数组 → 行视图模型数组（过滤非对象项）。 */
export function buildSegmentRows(segments) {
  if (!Array.isArray(segments)) return [];
  return segments.filter((s) => s && typeof s === 'object').map((s, i) => {
    const row = buildSegmentRow(s);
    row.ordinal = i + 1;
    return row;
  });
}

