import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createEventLog,
  runStatus,
  verdictAllowed,
} from '../tools/pipeline-events.mjs';

// ---------- helpers ----------

let clockNow = 0;
const clock = () => clockNow++;

function fullExtraction(over = {}) {
  return {
    runId: 'run-1',
    rangeId: 'range-1',
    candidates: 3,
    stageDurations: { extract: 10 },
    failureCounts: {},
    ...over,
  };
}
function fullUsage(over = {}) {
  return {
    runId: 'run-1',
    inputTokens: 100,
    outputTokens: 50,
    pricingVersion: 'p1',
    amountCny: 0.42,
    retries: 0,
    ...over,
  };
}
function fullDecision(over = {}) {
  return {
    runId: 'run-1',
    opId: 'op-1',
    decider: 'rules',
    reason: 'ok',
    rulesHit: ['r1'],
    decision: 'accept',
    ...over,
  };
}

function fullLog() {
  const log = createEventLog({ clock });
  log.record('extraction', fullExtraction());
  log.record('usage', fullUsage());
  log.record('decision', fullDecision());
  return log;
}

// ---------- 1. success ----------

test('three complete kinds → success/success, no missing', () => {
  const log = fullLog();
  const r = runStatus(log, 'run-1');
  assert.equal(r.status, 'success');
  assert.equal(r.observability, 'success');
  assert.deepEqual(r.missing, []);
  assert.equal('degradedReason' in r, false);
});

// ---------- 2. missing per kind ----------

test('missing usage → incomplete/missing with ["usage"]', () => {
  const log = createEventLog({ clock });
  log.record('extraction', fullExtraction());
  log.record('decision', fullDecision());
  const r = runStatus(log, 'run-1');
  assert.equal(r.status, 'incomplete');
  assert.equal(r.observability, 'missing');
  assert.deepEqual(r.missing, ['usage']);
});

test('missing decision → incomplete/missing with ["decision"]', () => {
  const log = createEventLog({ clock });
  log.record('extraction', fullExtraction());
  log.record('usage', fullUsage());
  const r = runStatus(log, 'run-1');
  assert.equal(r.status, 'incomplete');
  assert.deepEqual(r.missing, ['decision']);
});

test('missing extraction → incomplete/missing with ["extraction"]', () => {
  const log = createEventLog({ clock });
  log.record('usage', fullUsage());
  log.record('decision', fullDecision());
  const r = runStatus(log, 'run-1');
  assert.equal(r.status, 'incomplete');
  assert.deepEqual(r.missing, ['extraction']);
});

test('missing multiple kinds → all listed, stable order', () => {
  const log = createEventLog({ clock });
  log.record('usage', fullUsage());
  const r = runStatus(log, 'run-1');
  assert.deepEqual(r.missing, ['extraction', 'decision']);
});

// ---------- 3. amountCny null / absent ----------

test('usage.amountCny = null → counts as usage missing, never 0', () => {
  const log = createEventLog({ clock });
  log.record('extraction', fullExtraction());
  log.record('decision', fullDecision());
  log.record('usage', fullUsage({ amountCny: null }));
  const r = runStatus(log, 'run-1');
  assert.equal(r.status, 'incomplete');
  assert.equal(r.observability, 'missing');
  assert.deepEqual(r.missing, ['usage']);
  assert.equal(r.missing.includes(0), false);
});

test('usage 缺 amountCny 键 → E_EVENT_FIELDS:amountCny（成本未知须显式 null）', () => {
  const log = createEventLog({ clock });
  const { amountCny, ...rest } = fullUsage();
  assert.equal(amountCny, 0.42);
  assert.throws(() => log.record('usage', rest), /E_EVENT_FIELDS:amountCny/);
});

test('usage amountCny=null → 记入 missing 且不填 0', () => {
  const log = createEventLog({ clock });
  log.record('extraction', fullExtraction());
  log.record('decision', fullDecision());
  log.record('usage', { ...fullUsage(), amountCny: null });
  const st = runStatus(log, 'run-1');
  assert.equal(st.observability, 'missing');
  assert.ok(st.missing.includes('usage'));
  assert.equal(log.all().some((e) => e.kind === 'usage' && e.amountCny === 0), false);
});

// ---------- 4. policy-blocked ----------

test('decision reason policy-blocked → policy-blocked/failure', () => {
  const log = createEventLog({ clock });
  log.record('extraction', fullExtraction());
  log.record('usage', fullUsage());
  log.record('decision', fullDecision({ reason: 'policy-blocked' }));
  const r = runStatus(log, 'run-1');
  assert.equal(r.status, 'policy-blocked');
  assert.equal(r.observability, 'failure');
  assert.deepEqual(r.missing, []);
});

test('non-run decisions with policy-blocked do not affect this run', () => {
  const log = createEventLog({ clock });
  log.record('extraction', fullExtraction());
  log.record('usage', fullUsage());
  log.record('decision', fullDecision({ reason: 'policy-blocked', runId: 'run-2' }));
  log.record('decision', fullDecision());
  const r = runStatus(log, 'run-1');
  assert.equal(r.status, 'success');
});

// ---------- 5. degraded ----------

test('extraction degradedReason → observability degraded, echoed back', () => {
  const log = createEventLog({ clock });
  log.record('extraction', fullExtraction({ degradedReason: 'semantic-disabled' }));
  log.record('usage', fullUsage());
  log.record('decision', fullDecision());
  const r = runStatus(log, 'run-1');
  assert.equal(r.status, 'success');
  assert.equal(r.observability, 'degraded');
  assert.equal(r.degradedReason, 'semantic-disabled');
  assert.deepEqual(r.missing, []);
});

test('degraded run is not verdict-allowed', () => {
  const log = createEventLog({ clock });
  log.record('extraction', fullExtraction({ degradedReason: 'semantic-disabled' }));
  log.record('usage', fullUsage());
  log.record('decision', fullDecision());
  const r = runStatus(log, 'run-1');
  assert.equal(verdictAllowed(r), false);
});

test('missing beats degraded when both present', () => {
  const log = createEventLog({ clock });
  log.record('extraction', fullExtraction({ degradedReason: 'semantic-disabled' }));
  log.record('decision', fullDecision());
  const r = runStatus(log, 'run-1');
  assert.equal(r.observability, 'missing');
  assert.deepEqual(r.missing, ['usage']);
  assert.equal('degradedReason' in r, false);
});

// ---------- 6. record validation ----------

test('unknown kind throws E_EVENT_KIND', () => {
  const log = createEventLog({ clock });
  assert.throws(() => log.record('audit', { runId: 'x' }), /E_EVENT_KIND/);
});

test('missing extraction field throws E_EVENT_FIELDS:<field>', () => {
  const log = createEventLog({ clock });
  assert.throws(
    () => log.record('extraction', fullExtraction({ candidates: undefined })),
    /E_EVENT_FIELDS:candidates/,
  );
});

test('usage amountCny=null 与缺失键口径一致：都不产生 0', () => {
  const log = createEventLog({ clock });
  log.record('extraction', fullExtraction());
  log.record('decision', fullDecision());
  log.record('usage', { ...fullUsage(), amountCny: null });
  const st = runStatus(log, 'run-1');
  assert.equal(st.observability, 'missing');
  assert.ok(st.missing.includes('usage'));
});

test('missing decision field rulesHit throws E_EVENT_FIELDS:rulesHit', () => {
  const log = createEventLog({ clock });
  assert.throws(
    () => log.record('decision', fullDecision({ rulesHit: undefined })),
    /E_EVENT_FIELDS:rulesHit/,
  );
});

// ---------- 7. log API: at/seq, ofRun, ofKind, all, size ----------

test('record returns written entry with at and seq', () => {
  clockNow = 1000;
  const log = createEventLog({ clock });
  const e = log.record('usage', fullUsage());
  assert.equal(e.at, 1000);
  assert.equal(e.seq, 1);
  assert.equal(e.kind, 'usage');
  assert.equal(e.runId, 'run-1');
  assert.equal(log.size(), 1);
  assert.equal(log.all().length, 1);
});

test('ofRun filters by runId in seq ascending order', () => {
  const log = createEventLog({ clock });
  log.record('extraction', fullExtraction({ runId: 'b' }));
  log.record('usage', fullUsage({ runId: 'a' }));
  log.record('decision', fullDecision({ runId: 'a' }));
  const a = log.ofRun('a');
  assert.equal(a.length, 2);
  assert.ok(a[0].seq < a[1].seq);
  assert.ok(a.every((x) => x.runId === 'a'));
  assert.deepEqual(log.ofKind('usage').map((x) => x.runId), ['a']);
});

// ---------- 8. verdictAllowed quadrant ----------

test('verdictAllowed quadrant', () => {
  assert.equal(verdictAllowed({ status: 'success', observability: 'success', missing: [] }), true);
  assert.equal(verdictAllowed({ status: 'success', observability: 'degraded', degradedReason: 'x' }), false);
  assert.equal(verdictAllowed({ status: 'incomplete', observability: 'missing', missing: ['usage'] }), false);
  assert.equal(verdictAllowed({ status: 'policy-blocked', observability: 'failure', missing: [] }), false);
});

// ---------- 9. empty log / unknown run ----------

test('unknown runId → all three kinds missing', () => {
  const log = fullLog();
  const r = runStatus(log, 'run-nope');
  assert.equal(r.status, 'incomplete');
  assert.deepEqual(r.missing, ['extraction', 'usage', 'decision']);
});
