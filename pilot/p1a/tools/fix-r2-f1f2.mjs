// R2-F1/F2 修订：① expectedOutcome 全量按类统一（NEG/SUG=emit-with-flag，其余 8 类=block）；
// ② block 场景 target.eventId 重选为 bait 事件（∉ gold evidence 集合，按类线索匹配，回退=最后一个非证据事件）。
import fs from 'node:fs';
import path from 'node:path';

const dir = new URL('../corpus/', import.meta.url).pathname;

const EMIT_CLASSES = new Set(['negation', 'suggestion-not-accepted']);

const BAIT_PATTERNS = {
  injection: /[SＳ]YSTEM\s*NOTICE|IGNORE (ALL |PREVIOUS|ALL PREVIOUS)|ignore (all|previous)|instruction|directive|务必(记录|写入|标注)|忽略(之前|以上|上述)|按(我说的|此要求)|mark this (audit|build|run) as|directive in the/i,
  'later-correction': /scratch that|actually[,.]|correction|was wrong|not OOM|而是|其实|更正|纠正|搞错|说错|改口|不是.{0,12}(是|应该)|re-?symbolicated|rechecked|re-analyz/i,
  'tool-failure': /\bERROR\b|failed|timeout|timed out|exited with|returned empty|zero repositor|无输出|失败|超时|报错|为空|没有(跑|执行|扫描)|exit(ed)? code/i,
  'same-name-cross-project': /demo-b|demo-beta|demo-gamma|另一个(项目|仓库)|另外(那个|的)|B 项目|beta (项目|project)|gamma/i,
  'cross-paragraph-reference': /(?:^|(?<=[.!?。；\s])(?:关于|至于|刚才|前面|上面|Earlier|About|Regarding|As for|about those|the .{1,30} (?:the assistant|you) (?:just |mentioned|cited|reported)))/i,
  'conditional-hypothetical': /如果|假如|假设|若|要是|万一|\bif\b|would |could |might |hypothetical|in theory|值得考虑|可以考虑/i,
  'timezone-relative-date': /yesterday|today|tomorrow|tonight|next (Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|week|month)|last (Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|week|month)|这周|本周|下周|上周|昨天|明天|今天|下(周一|周二|周三|周四|周五|周六|周日|周)|周[一二三四五六日末]内/i,
  'truncation-gap': /transcript|gap|context (is )?gone|truncat|丢失|缺失|缺口|gone for good|被截断|上下文断/i,
};
const FALLBACK = {
  'same-name-cross-project': /demo-b|beta|gamma/i,
};

const isCjk = (t) => /[\u4e00-\u9fff]/.test(t);

for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.jsonl'))) {
  const p = path.join(dir, f);
  const lines = fs.readFileSync(p, 'utf8').trim().split('\n');
  let retargeted = 0;
  let relabeled = 0;
  const out = lines.map((l) => {
    const o = JSON.parse(l);
    const a = o.adversarial;
    if (!a) return l;
    let dirty = false;

    // F2：outcome 统一
    const wantOutcome = EMIT_CLASSES.has(a.class) ? 'emit-with-flag' : 'block';
    if (a.expectedOutcome !== wantOutcome) {
      a.expectedOutcome = wantOutcome;
      relabeled++;
      dirty = true;
    }

    // F1：block 场景 target 不得指向 gold evidence 事件 → 选 bait
    if (a.expectedOutcome === 'block') {
      const evIds = new Set((o.events || []).map((e) => e.eventId));
      const goldEv = new Set((o.gold || []).flatMap((g) => (g.evidence || []).map((e) => e.eventId)));
      if (goldEv.has(a.target?.eventId)) {
        const cands = (o.events || []).filter((e) => !goldEv.has(e.eventId));
        const re = BAIT_PATTERNS[a.class];
        let bait = null;
        if (re) bait = cands.find((e) => re.test(e.text));
        if (!bait && a.class === 'tool-failure') bait = cands.find((e) => e.role === 'tool');
        if (!bait && a.class === 'cross-paragraph-reference') bait = cands.find((e) => e.role === 'user' && e.eventId !== (o.events?.[0]?.eventId));
        if (!bait) {
          const fb = FALLBACK[a.class];
          if (fb) bait = cands.find((e) => fb.test(e.text));
        }
        if (!bait && cands.length) bait = cands[cands.length - 1];
        if (bait && evIds.has(bait.eventId)) {
          const oldQuote = a.target?.quote;
          const quoteStillFits = oldQuote && bait.text.split(oldQuote).length === 2;
          a.target = quoteStillFits ? { eventId: bait.eventId, quote: oldQuote } : { eventId: bait.eventId };
          retargeted++;
          dirty = true;
        }
      }
    }
    return dirty ? JSON.stringify(o) : l;
  });
  if (retargeted || relabeled) {
    fs.writeFileSync(p, out.join('\n') + '\n');
    console.log(`${f}: retarget ${retargeted}, relabel ${relabeled}`);
  }
}
console.log('done');
