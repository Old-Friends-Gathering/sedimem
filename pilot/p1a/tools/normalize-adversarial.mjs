// 归一化 adversarial 形态：target 字符串 → {eventId}（取非 active gold 的证据事件，回退首 gold 证据事件）；
// expectedOutcome 不在闭集 → 按类映射（LAT→block，NEG/SUG→emit-with-flag，其余→block）。
import fs from 'node:fs';
import path from 'node:path';

const dir = new URL('../corpus/', import.meta.url).pathname;
const OUTCOME_BY_CLASS = {
  negation: 'emit-with-flag',
  'suggestion-not-accepted': 'emit-with-flag',
};
const ERROR_BY_CLASS = {
  negation: 'negation-flip',
  'suggestion-not-accepted': 'suggestion-promoted',
  'later-correction': 'retract-treated-current',
  'tool-failure': 'not-done-became-done',
  'same-name-cross-project': 'cross-scope-leak',
  'cross-paragraph-reference': 'speaker-misattribution',
  'conditional-hypothetical': 'unsupported-fact',
  'timezone-relative-date': 'unsupported-fact',
  injection: 'unsupported-fact',
  'truncation-gap': 'unsupported-fact',
};

for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.jsonl'))) {
  const p = path.join(dir, f);
  const lines = fs.readFileSync(p, 'utf8').trim().split('\n');
  let changed = 0;
  const out = lines.map((l) => {
    const o = JSON.parse(l);
    const a = o.adversarial;
    if (!a) return l;
    let dirty = false;
    if (typeof a.target === 'string') {
      const evIds = new Set((o.events || []).map((e) => e.eventId));
      const pick =
        (o.gold || []).find((g) => g.status && g.status !== 'active') ||
        (o.gold || [])[0] ||
        {};
      let ev = pick?.evidence?.[0]?.eventId;
      if (!ev || !evIds.has(ev)) {
        const users = (o.events || []).filter((e) => e.role === 'user');
        ev = users.length ? users[users.length - 1].eventId : [...evIds][0];
      }
      const quote = (pick?.evidence?.[0]?.eventId === ev && pick?.evidence?.[0]?.quote) || undefined;
      a.target = quote ? { eventId: ev, quote } : { eventId: ev };
      dirty = true;
    }
    if (!['block', 'emit-with-flag'].includes(a.expectedOutcome)) {
      a.expectedOutcome = OUTCOME_BY_CLASS[a.class] || 'block';
      dirty = true;
    }
    const severes = new Set([
      'unsupported-fact',
      'negation-flip',
      'speaker-misattribution',
      'suggestion-promoted',
      'retract-treated-current',
      'not-done-became-done',
      'cross-scope-leak',
    ]);
    if (!severes.has(a.expectedErrorClass)) {
      a.expectedErrorClass = ERROR_BY_CLASS[a.class] || 'unsupported-fact';
      dirty = true;
    }
    if (dirty) {
      changed++;
      return JSON.stringify(o);
    }
    return l;
  });
  if (changed) {
    fs.writeFileSync(p, out.join('\n') + '\n');
    console.log(`${f}: normalized ${changed}`);
  }
}
console.log('done');
