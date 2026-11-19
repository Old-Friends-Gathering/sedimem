// granularity-check 单测 + 校准集结构断言
// 规格：docs/design/v2.0/06-annotation-spec.md §1.1
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  RULESET_VERSION,
  normalizeText,
  normalizeValue,
  splitHints,
  isAtomic,
  isAclaim,
  sameClaim,
  checkClaimGranularity,
  countSplitParts,
  sampleFingerprint,
  evaluateCalibration,
} from '../tools/granularity-check.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CALIBRATION = join(HERE, '..', 'granularity', 'calibration.jsonl');

function loadCalibration() {
  return readFileSync(CALIBRATION, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

test('规则集版本冻结为 granularity@v1（改规则必须升版本并重跑参考集）', () => {
  assert.equal(RULESET_VERSION, 'granularity@v1');
});

test('归一化：全半角、空白、单位写法统一', () => {
  assert.equal(normalizeText('  端口是８０８０。 '), '端口是8080');
  assert.equal(normalizeValue('30 秒'), '30s');
  assert.equal(normalizeValue('30 s'), '30s');
  assert.equal(normalizeValue('３０秒'), '30s');
});

test('拆分提示：S1/S2/S3 判需拆，S4/S5/S6 判整体一条', () => {
  assert.deepEqual(splitHints('端口是 8080 而且超时改成 30 秒'), ['S1']);
  assert.deepEqual(splitHints('A 部署在 cn，B 部署在 us'), ['S2']);
  assert.deepEqual(splitHints('端口 8080、超时 30s'), ['S3']);
  assert.deepEqual(splitHints('如果切换流量，QPS 会从 100 升到 200'), ['S4']);
  assert.deepEqual(splitHints('根据文档，端口是 8080'), ['S5']);
  assert.deepEqual(splitHints('cn 节点比 us 节点快 3 倍'), ['S6']);
});

test('审核回归 F2：形态标记不豁免复合检查（S4/S5/S6 与 S1–S3 并存时仍判需拆）', () => {
  assert.deepEqual(splitHints('如果端口是 8080，那么超时是 30 秒'), ['S4', 'S2']);
  assert.deepEqual(splitHints('文档说端口是 8080，超时是 30 秒'), ['S5', 'S2']);
  assert.equal(isAtomic('如果端口是 8080，那么超时是 30 秒'), false);
  assert.equal(isAtomic('文档说端口是 8080，超时是 30 秒'), false);
});

test('审核回归 F3：共享谓语的宾语/主语并列判 S1b，同一性判断句不拆', () => {
  assert.deepEqual(splitHints('8080 和 8081 都已开放'), ['S1b']);
  assert.deepEqual(splitHints('nginx 服务支持 http 和 https'), ['S1b']);
  assert.equal(isAtomic('8080 和 8081 都已开放'), false);
  assert.deepEqual(splitHints('A 和 B 是同一个服务'), []);
  assert.equal(isAtomic('A 和 B 是同一个服务'), true);
});

test('审核回归 F2/F3：多个比较结构判 S6b（每个比较一条）', () => {
  assert.deepEqual(splitHints('A 比 B 快 3 倍，也比 C 快'), ['S6', 'S6b']);
  assert.equal(isAtomic('A 比 B 快 3 倍，也比 C 快'), false);
  assert.equal(countSplitParts('A 比 B 快 3 倍，也比 C 快'), 2);
});

test('审核回归 F9：expectedClaims 实算而非硬编码 2（三路拆分）', () => {
  assert.equal(countSplitParts('端口 8080、超时 30s、重试 3 次'), 3);
  assert.equal(countSplitParts('A 部署在 cn，B 部署在 us，C 部署在 jp'), 3);
});

test('审核回归 F11：词边界——finished/completed 等英文谓词不被 is/are 子串误判', () => {
  assert.deepEqual(splitHints('Customers table copy finished with 12.4M rows and no mismatches'), []);
  assert.equal(isAtomic('Customers table copy finished with 12.4M rows and no mismatches'), true);
});

test('原子性：复合句不是原子，条件句整体是原子', () => {
  assert.equal(isAtomic('端口是 8080，而且超时改成 30 秒'), false);
  assert.equal(isAtomic('如果切换流量，QPS 会从 100 升到 200'), true);
  assert.equal(isAtomic('db-primary-01 的端口是 8080'), true);
});

test('A3 可记性：过程叙述与寒暄不记，工具结论与属性陈述要记', () => {
  assert.equal(isAclaim('我先看一下日志'), false);
  assert.equal(isAclaim('谢谢，辛苦了'), false);
  assert.equal(isAclaim('health 接口返回 degraded'), true);
  assert.equal(isAclaim('端口是 8080'), true);
  assert.equal(isAclaim('服务不支持 8081'), true);
});

test('同一性 I1：判定键与断言框架一致 ⇒ 同一条（措辞不同不算两条）', () => {
  const a = { scope: 'repo:demo', assertion: { subject: '端口', predicate: '是', value: '8080', speechAct: 'state', negated: false } };
  const b = { scope: 'repo:demo', assertion: { subject: '端口', predicate: '是', value: '8080', speechAct: 'state', negated: false } };
  assert.equal(sameClaim(a, b), 'same');
});

test('同一性 I2：判定键一致但 speechAct/negated 不同 ⇒ 不同条', () => {
  const base = { scope: 'repo:demo', assertion: { subject: '端口', predicate: '是', value: '8081', speechAct: 'state', negated: false } };
  const negated = { ...base, assertion: { ...base.assertion, negated: true } };
  const suggested = { ...base, assertion: { ...base.assertion, speechAct: 'suggest' } };
  assert.equal(sameClaim(base, negated), 'different');
  assert.equal(sameClaim(base, suggested), 'different');
});

test('同一性 I3：一侧判定键缺字段 ⇒ 不同粒度（子命题/超集）', () => {
  const full = { scope: 'repo:demo', assertion: { subject: '端口', predicate: '是', value: '8080' } };
  const bare = { scope: 'repo:demo', assertion: { subject: '端口' } };
  assert.equal(sameClaim(full, bare), 'subsumed');
});

test("审核回归 F5：显式空串 ≠ 字段缺失（'超时未设置' 与 '超时是 30s' 是不同条）", () => {
  const empty = { scope: 'repo:demo', assertion: { subject: '超时', predicate: '为', value: '' } };
  const valued = { scope: 'repo:demo', assertion: { subject: '超时', predicate: '为', value: '30s' } };
  assert.equal(sameClaim(empty, valued), 'different');
  const missing = { scope: 'repo:demo', assertion: { subject: '超时', predicate: '为' } };
  assert.equal(sameClaim(missing, valued), 'subsumed');
});

test('审核回归 F10/F11：义务类命题可记，过程叙述不可记', () => {
  assert.equal(isAclaim('慢查询与索引变更必须先在影子库压测再上生产'), true);
  assert.equal(isAtomic('慢查询与索引变更必须先在影子库压测再上生产'), true);
  assert.equal(isAclaim('我先看一下日志'), false);
});

test('单条诊断：超长与复合命题都要报出来', () => {
  const long = '端口是 8080'.repeat(15);
  assert.ok(checkClaimGranularity({ claim: long }, { maxChars: 100 }).includes('claim-too-long'));
  const compound = checkClaimGranularity({ claim: '端口是 8080，而且超时改成 30 秒' });
  assert.ok(compound.some((p) => p.startsWith('must-split')));
});

test('真实校准集：18 条全部通过且规则覆盖齐全', () => {
  const records = loadCalibration();
  assert.equal(records.length, 18);
  assert.deepEqual(evaluateCalibration(records), []);
  const hits = new Set(records.flatMap((r) => r.hits));
  for (const rule of ['S1', 'S2', 'S3', 'S4', 'S5', 'S6']) assert.ok(hits.has(rule), `缺 ${rule} 样本`);
  const verdicts = new Set(records.map((r) => r.verdict));
  for (const v of ['must-split', 'valid-atomic', 'not-a-claim']) assert.ok(verdicts.has(v), `缺 ${v} 样本`);
  // 审核 F1：≥4 例由独立审核者按规范文字推导（防作者自证循环）
  const independent = records.filter((r) => r.source === 'independent-audit');
  assert.ok(independent.length >= 4, `独立审核样本应 ≥4，实际 ${independent.length}`);
  // 审核 F9：≥1 例三路拆分 + 全量指纹
  assert.ok(records.some((r) => r.expectedClaims === 3), '缺三路拆分样本');
  for (const r of records) assert.equal(r.textHash, sampleFingerprint(r.text), `${r.calibrationId} 指纹不符`);
  // U1–U3 各至少一例：不可拆形态（连字符专名 / 数值单位 / 否定）
  assert.ok(records.some((r) => r.text.includes('db-primary-01')));
  assert.ok(records.some((r) => /30\s*s/.test(r.text)));
  assert.ok(records.some((r) => r.text.includes('不支持')));
});

test('校准集是可证伪的：篡改期望值必须报错', () => {
  const bad = loadCalibration().map((r) =>
    r.calibrationId === 'cal-01' ? { ...r, expectedClaims: 1 } : r,
  );
  const problems = evaluateCalibration(bad);
  assert.ok(problems.some((p) => p.includes('cal-01')), '篡改后应报 cal-01');
});

test('校准集是可证伪的：替换 text 但不更新指纹必须报错（审核 F9）', () => {
  const bad = loadCalibration().map((r) =>
    r.calibrationId === 'cal-01' ? { ...r, text: '端口是 9000' } : r,
  );
  const problems = evaluateCalibration(bad);
  assert.ok(problems.some((p) => p.includes('指纹')), '换文本应报指纹不符');
});
