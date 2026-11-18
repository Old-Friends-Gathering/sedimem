// exit-check.mjs —— P1a 出口核验（机算，不靠人肉读文档）
// 规格：docs/plans/v2.0-p1.md §0.2/§7.1（放行条件与冻结项）、docs/design/v2.0/README.md 冻结核验表、
//       pilot/p1a/config/eval-manifest.json thresholds.corpus（exit 作用域数字）。
// 语义：失败项（ok=false 且 !pending）→ 出口未达成；pending 项 = 已达成前置、但缺外部输入（双标注）。
// 不判定抽取质量（那是 P1b 的事），只核「规格/语料/冻结/标注」四类放行条件是否齐备。
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { validateCorpus } from './corpus-validate.mjs';
import { validateSplit } from './split-corpus.mjs';

/** 解析冻结核验表：| 序号 | 名称 | 规格 | 证据 | 状态 | → {id, frozen} */
export function parseFrozenTable(readmeText) {
  const rows = [];
  for (const line of String(readmeText ?? '').split('\n')) {
    if (!line.trim().startsWith('|')) continue;
    const cells = line.split('|').map((c) => c.trim());
    if (cells.length < 6) continue;
    const id = cells[1];
    if (!/^\d+[a-z]?$/.test(id)) continue;
    const status = cells[cells.length - 2] ?? '';
    rows.push({ id, status, frozen: /frozen/i.test(status) });
  }
  return rows;
}

const val = (o, stage) => (o && stage === 'pilot' && 'pilot' in o ? o.pilot : o?.exitLevel);
const scopeOf = (o, stage) => (stage === 'pilot' ? o?.pilotScope ?? 'full' : o?.exitScope ?? 'test');

/**
 * 核验 P1a 出口条件（纯函数，便于 TDD）。
 * @returns {{checks:Array, ok:boolean, pending:Array, blockedBy:Array}}
 */
export function evaluateExit({ scenarios, manifest, frozenRows, annotation = {} }) {
  const stage = manifest?.stage ?? 'exit';
  const t = manifest?.thresholds ?? {};
  const corpus = t.corpus ?? {};
  const checks = [];
  const add = (id, title, ok, detail, pending = false, caveat = undefined) =>
    checks.push(caveat ? { id, title, ok, detail, pending, caveat } : { id, title, ok, detail, pending });

  const inSplit = (s, name) => s.split === name;
  const total = scenarios.length;
  const gold = scenarios.reduce((n, s) => n + (s.gold?.length ?? 0), 0);
  const dev = scenarios.filter((s) => inSplit(s, 'dev')).length;
  const test = scenarios.filter((s) => inSplit(s, 'test')).length;

  const needTotal = val(corpus.minScenariosTotal, stage) ?? 0;
  add('corpus-scenarios', '场景总数', total >= needTotal, `${total} / 需要 ≥${needTotal}`);
  const needGold = val(corpus.minGoldClaims, stage) ?? 0;
  add('corpus-gold', 'gold 命题总数', gold >= needGold, `${gold} / 需要 ≥${needGold}`);
  const needDev = val(corpus.minScenariosDev, stage) ?? 0;
  const needTest = val(corpus.minScenariosTest, stage) ?? 0;
  add('corpus-split', 'dev/test 拆分', dev >= needDev && test >= needTest, `dev ${dev}≥${needDev}、test ${test}≥${needTest}`);
  const scopeOfZh = scopeOf(corpus.minTestZh, stage);
  const zhPool = scenarios.filter((s) => s.language === 'zh' || s.language === 'mixed');
  const enPool = scenarios.filter((s) => s.language === 'en' || s.language === 'mixed');
  const pick = (pool, scope) => (scope === 'test' ? pool.filter((s) => inSplit(s, 'test')) : pool);
  const needZh = val(corpus.minTestZh, stage) ?? 0;
  const needEn = val(corpus.minTestEn, stage) ?? 0;
  add('corpus-language', '中英配额', pick(zhPool, scopeOfZh).length >= needZh && pick(enPool, scopeOf(corpus.minTestEn, stage)).length >= needEn,
    `zh ${pick(zhPool, scopeOfZh).length}≥${needZh}、en ${pick(enPool, scopeOf(corpus.minTestEn, stage)).length}≥${needEn}（作用域 ${scopeOfZh}）`);
  const needRej = val(corpus.minNonRecordable, stage) ?? 0;
  const rej = scenarios.filter((s) => s.shouldReject).length;
  add('corpus-non-recordable', '无可记场景数', rej >= needRej, `${rej} / 需要 ≥${needRej}`);

  // 对抗配额：按类，作用域 test
  const advScope = scopeOf(corpus.minAdversarialPerClass, stage);
  const needPerClass = val(corpus.minAdversarialPerClass, stage) ?? 0;
  const classes = t.adversarialClasses ?? [];
  const byClass = new Map();
  for (const s of scenarios) {
    if (!s.adversarial?.class) continue;
    if (advScope === 'test' && !inSplit(s, 'test')) continue;
    byClass.set(s.adversarial.class, (byClass.get(s.adversarial.class) ?? 0) + 1);
  }
  const shortfall = classes.filter((c) => (byClass.get(c) ?? 0) < needPerClass);
  add('adversarial-quota', '对抗类配额', shortfall.length === 0,
    shortfall.length === 0
      ? `${classes.length} 类各 ≥${needPerClass}（作用域 ${advScope}）`
      : `不足：${shortfall.map((c) => `${c}=${byClass.get(c) ?? 0}`).join('、')}（需 ≥${needPerClass}）`);

  // 语料与切分校验（复用权威实现）
  const corpusRes = validateCorpus(scenarios, { manifest });
  add('corpus-valid', '语料结构校验', (corpusRes.errors ?? []).length === 0,
    (corpusRes.errors ?? []).length === 0 ? 'exit 校验 0 错误' : `${corpusRes.errors.length} 条错误：${corpusRes.errors.slice(0, 3).join('；')}`);
  const dice = t.nearDuplicateDice?.value ?? 0.85;
  const splitIssues = validateSplit(scenarios, { dice });
  add('split-valid', '切分校验（家族两端 + 跨集近重复）', splitIssues.length === 0,
    splitIssues.length === 0 ? `家族两端齐备、跨集 Dice <${dice}` : splitIssues.slice(0, 3).join('；'));

  // 九项冻结
  const frozen = frozenRows ?? [];
  const unfrozen = frozen.filter((r) => !r.frozen);
  add('frozen-decisions', '九项冻结', frozen.length >= 9 && unfrozen.length === 0,
    frozen.length < 9 ? `核验表只解析到 ${frozen.length} 行` : (unfrozen.length === 0 ? `${frozen.length} 项全部 frozen` : `未冻结：${unfrozen.map((r) => r.id).join('、')}`));

  // 双独立标注（pending：需要外部标注人，不算失败但阻塞出口）
  // 标注状态：dual-independent（两份人工盲评）为出口级；model-dual-blinded（两遍模型盲评 + 裁决）为降级满足，必须留 caveat
  const mode = annotation.mode ?? 'pilot';
  const hasPasses = Boolean(annotation.pass1 && annotation.pass2 && annotation.goldset);
  const dual = mode === 'dual-independent' && hasPasses;
  const degraded = mode === 'model-dual-blinded' && hasPasses;
  const detailBits = `pass1=${annotation.pass1 ? '✓' : '✗'}、pass2=${annotation.pass2 ? '✓' : '✗'}、goldset=${annotation.goldset ? '✓' : '✗'}`;
  if (dual) add('annotation-dual', '出口级 gold = 双人工独立标注 + 裁决', true, 'annotationMode=dual-independent');
  else if (degraded) add('annotation-dual', '出口级 gold = 双人工独立标注 + 裁决', true,
    `annotationMode=model-dual-blinded（${detailBits}）——两遍模型盲评 + 维护者裁决，**非人工双标注**，实验结论仍以人工双标注复核为硬前置`, false, 'model-dual-blinded');
  else add('annotation-dual', '出口级 gold = 双人工独立标注 + 裁决', false,
    `${detailBits}（待第二标注人 + 裁决留痕）`, true);

  const failed = checks.filter((c) => !c.ok && !c.pending);
  const pending = checks.filter((c) => c.pending);
  return {
    checks,
    ok: failed.length === 0 && pending.length === 0,
    pending,
    blockedBy: pending.map((c) => c.id),
    caveats: checks.filter((c) => c.caveat).map((c) => c.id),
  };
}

export function renderExitReport(result) {
  const icon = (c) => (c.caveat ? '⚠️' : c.ok ? '✅' : c.pending ? '⏳' : '❌');
  const lines = ['P1a 出口核验', ''];
  for (const c of result.checks) lines.push(`${icon(c)} ${c.id.padEnd(22)} ${c.title} — ${c.detail}`);
  const failed = result.checks.filter((c) => !c.ok && !c.pending).length;
  const caveatCount = (result.caveats ?? []).length;
  lines.push('', `结论：${result.ok ? '出口条件齐备' : `失败 ${failed} 项、待完成 ${result.pending.length} 项`}${caveatCount > 0 ? `（降级声明 ${caveatCount} 项）` : ''}`);
  if (result.pending.length > 0) lines.push(`阻塞出口：${result.blockedBy.join('、')}`);
  return lines.join('\n');
}

// ---------- CLI ----------
function loadJsonlDir(dir) {
  const out = [];
  for (const f of readdirSync(dir).filter((x) => x.startsWith('scenarios-') && x.endsWith('.jsonl')).sort()) {
    for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
      if (line.trim()) out.push(JSON.parse(line));
    }
  }
  return out;
}

function main() {
  const root = process.argv[2] ?? '.';
  const p = (rel) => join(root, rel);
  // 出口核验一律按 exit 作用域的数字判定（manifest 里的 pilot 数字只是 pilot 阶段配额）
  const manifest = { ...JSON.parse(readFileSync(p('pilot/p1a/config/eval-manifest.json'), 'utf8')), stage: 'exit' };
  const scenarios = loadJsonlDir(p('pilot/p1a/corpus'));
  const readme = existsSync(p('docs/design/v2.0/README.md')) ? readFileSync(p('docs/design/v2.0/README.md'), 'utf8') : '';
  const blind = p('pilot/p1a/out/blind');
  const goldsetFile = join(blind, 'goldset-v1.json');
  const hasGoldset = existsSync(goldsetFile);
  let goldsetMode = 'pilot';
  if (hasGoldset) {
    try {
      goldsetMode = JSON.parse(readFileSync(goldsetFile, 'utf8')).annotationMode ?? 'pilot';
    } catch {
      goldsetMode = 'pilot';
    }
  }
  const annotation = {
    pass1: existsSync(join(blind, 'pass1.jsonl')),
    pass2: existsSync(join(blind, 'pass2.jsonl')),
    goldset: hasGoldset,
    mode: goldsetMode,
  };
  const result = evaluateExit({ scenarios, manifest, frozenRows: parseFrozenTable(readme), annotation });
  console.log(renderExitReport(result));
  console.log('');
  console.log(JSON.stringify({ ok: result.ok, pending: result.blockedBy, checks: result.checks.length }, null, 2));
  process.exit(result.ok ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
