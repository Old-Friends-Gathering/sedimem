// tests/unit/text.test.js — core/text.js 单点化后的行为契约（W2）。
// 覆盖：normalizeText（NFKC/全角、零宽、CJK 空格）、normalizeForMatch、
// tokenize 中英混排、charBigrams、containment 边界、signatureSimilarity 纯英文=0。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeText, normalizeForMatch, tokenize, containsCjk,
  containment, charBigrams, signatureSimilarity,
} from '../../src/core/text.js';

test('normalizeText：小写、全角→半角、去多余空白、去标点', () => {
  assert.equal(normalizeText('ＡＢＣ'), 'abc');
  assert.equal(normalizeText('  a   b  '), 'a b');
  assert.equal(normalizeText('Hello, World!'), 'hello world');
});

test('normalizeText：全角空格 U+3000 折叠为半角空格', () => {
  assert.equal(normalizeText('部署\u3000分支'), '部署 分支');
});

test('normalizeText：非字符串抛 E_INVALID_RECORD', () => {
  assert.throws(() => normalizeText(42), (e) => e.code === 'E_INVALID_RECORD');
});

test('normalizeForMatch：NFKC + 零宽/方向控制符删除', () => {
  assert.equal(normalizeForMatch('ＩＧＮＯＲＥ'), 'ignore');
  assert.equal(normalizeForMatch('忽\u200b略'), '忽略');
  assert.equal(normalizeForMatch('忽\u2060略'), '忽略');
  assert.equal(normalizeForMatch('忽\ufeff略'), '忽略');
});

test('normalizeForMatch：CJK 之间空白折叠', () => {
  assert.equal(normalizeForMatch('忽 略 之 前'), '忽略之前');
  // 拉丁词之间空格保留
  assert.equal(normalizeForMatch('ignore before'), 'ignore before');
});

test('normalizeForMatch：异体字折叠（畧→略、請→请）', () => {
  assert.equal(normalizeForMatch('畧'), '略');
  assert.equal(normalizeForMatch('請'), '请');
});

test('containsCjk：汉字 true、纯拉丁/空串 false', () => {
  assert.equal(containsCjk('部署分支'), true);
  assert.equal(containsCjk('deploy only'), false);
  assert.equal(containsCjk(''), false);
  assert.equal(containsCjk(null), false);
});

test('tokenize：中英混排（中文 2-gram + 英文去停用词）', () => {
  const t = tokenize('部署 deploy the branch');
  assert.ok(t.includes('部署') || t.includes('部'), JSON.stringify(t));
  assert.ok(t.includes('deploy'));
  assert.ok(!t.includes('the'), 'the 是停用词');
  assert.ok(t.includes('branch'));
});

test('tokenize：去重且保序', () => {
  const t = tokenize('部署部署 deploy deploy');
  assert.deepEqual(t.filter((x) => x === 'deploy'), ['deploy']);
  assert.ok(t.length >= 2);
});

test('tokenize：单个汉字按单字成 token', () => {
  assert.deepEqual(tokenize('池'), ['池']);
});

test('charBigrams：只在汉字段切 2-gram，单字成自身', () => {
  const g = charBigrams('部署分支');
  assert.ok(g.has('部署') && g.has('署分') && g.has('分支'));
  assert.equal(g.size, 3);
  assert.deepEqual([...charBigrams('池')], ['池']);
  assert.equal(charBigrams('english only').size, 0);
});

test('containment：包含关系 → 1（短句被长句吸收）', () => {
  assert.equal(containment('部署分支', '部署分支的策略与流程说明'), 1);
});

test('containment：空文本 → 0（避免空集误判全匹配）', () => {
  assert.equal(containment('', ''), 0);
  assert.equal(containment('部署', ''), 0);
  assert.equal(containment(null, null), 0);
});

test('containment：部分重叠取 min 口径', () => {
  // A={部署,署分}, B={部署,署分,分支,支策,策略} → 2/2 = 1? 用可分辨的例子：
  // a='ab cd'（token: ab, cd），b='ab cd ef'（ab, cd, ef）→ |A∩B|=2, min=2 → 1
  assert.equal(containment('ab cd', 'ab cd ef'), 1);
  // a='ab xy'，b='ab cd' → 1/2
  assert.equal(containment('ab xy', 'ab cd'), 0.5);
});

test('signatureSimilarity：中文改写高、无关中文低', () => {
  assert.ok(signatureSimilarity('部署脚本在 scripts/deploy.sh', '上线脚本位于 scripts/deploy.sh') > 0.15);
  assert.ok(signatureSimilarity('数据库连接池上限是 20', '发布窗口限定工作日晚上') < 0.15);
});

test('signatureSimilarity：纯英文 / 空串 → 0（英文交给 containment）', () => {
  assert.equal(signatureSimilarity('The cache backend is Redis', 'Deploy uses Kubernetes'), 0);
  assert.equal(signatureSimilarity('', ''), 0);
  assert.equal(signatureSimilarity('部署', 'deploy only'), 0);
});

test('旧入口 re-export 同源：hash.js / conflict.js / suspicious.js 与 core/text.js 一致', async () => {
  const h = await import('../../src/core/hash.js');
  const c = await import('../../src/hygiene/conflict.js');
  const s = await import('../../src/hygiene/suspicious.js');
  assert.deepEqual(h.tokenize('部署 deploy'), tokenize('部署 deploy'));
  assert.equal(c.textSimilarity('部署分支', '部署分支'), containment('部署分支', '部署分支'));
  assert.equal(c.charBigrams('池').size, charBigrams('池').size);
  assert.equal(c.parseComparable('3/1').type, 'date');
  assert.equal(s.normalizeForMatch('畧'), normalizeForMatch('畧'));
});
