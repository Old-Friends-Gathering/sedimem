// R2-F4/F5/F6 修订：
// F4 多样化 assistant 填充句（53 处逐字模板 → 按 scenarioId+index 确定性换入自然回应池，跳过 gold 证据事件）
// F5 truncation-gap 场景追加具名 bait 拒绝事件（缺失计划的实体名出现在后续事件，抽取器不得外推）
// F6 timezone 场景删除对话内消解句（7 个安全场景：gold 不引用消解事件，绝对日期只能靠 queryTime 推出）
import fs from 'node:fs';
import path from 'node:path';

const dir = new URL('../corpus/', import.meta.url).pathname;

const ZH_POOL = [
  '好，这条我先记下要点，细节以你确认为准。',
  '收到，我会只在有出处的情况下更新记录。',
  '明白，我按你说的范围整理，不自行补充。',
  '好的，我先整理这一段，稍后你复核。',
  '了解，这段我按上下文如实处理。',
  '行，我先记这个结论，其他先不动。',
  '明白，我会标注这部分的来源再入库。',
];
const EN_POOL = [
  'Got it — I will note only what is supported here.',
  'Understood, keeping this scoped to what you confirmed.',
  'Makes sense, I will record this faithfully.',
  'Okay, noted for this session.',
  'Right, I will keep the record aligned with what was said.',
  'Fine, capturing the essentials only.',
  'Understood — nothing beyond the stated facts.',
];

// F5：每个 truncation-gap 场景的具名 bait（缺失计划的「其他步骤」，不得被外推成已完成）
const TRU_BAIT = {
  'fam-deploy-rollout': ['canary 扩量到 50%', '暂停回滚阈值调整'],
  'fam-db-performance': ['慢查询治理批次二', '索引重建窗口申请'],
  'fam-data-pipeline': ['下游分区回填', '幂等键迁移'],
  'fam-ops-oncall': ['值班表季度轮换', '告警阈值复核'],
  'fam-billing-refund': ['退款批量补发名单', '对账差异清单'],
  'fam-auth-migration': ['旧密钥轮换', 'DNS 切换窗口'],
  'fam-mobile-crash': ['dSYM 补传', '崩溃白名单更新'],
  'fam-api-rate-limit': ['配额分层方案', 'SDK 限流退避参数'],
  'fam-ml-experiments': ['对照实验复跑', '特征快照刷新'],
  'fam-docs-site': ['版本化链接重定向', '站点地图重建'],
  'fam-security-audit': ['权限最小化整改', '密钥扫描复跑'],
  'fam-incident-response': ['复盘行动项分派', 'Runbook 更新'],
  'fam-design-review': ['设计系统组件对齐', '可用性测试排期'],
  'fam-data-migration': ['双写切换演练', '回滚预案评审'],
  'fam-mobile-release': ['灰度放量计划', '商店素材更新'],
};
const TRU_TEMPLATES = [
  (b) => `Understood — the earlier plan had more steps (${b[0]}, ${b[1]}), but those are lost to the gap; I am not recording them as done or scheduled.`,
  (b) => `Noted — beyond what you just confirmed (${b[0]} was mentioned before the cut), the rest (${b[1]}) stays unrecorded until you restate it.`,
  (b) => `Ack — I can only account for what survived; items like ${b[0]} and ${b[1]} are missing from context and will not appear in my notes.`,
];
const TRU_TEMPLATES_ZH = [
  (b) => `明白——之前的计划还有 ${b[0]}、${b[1]} 这些步骤，但都随上下文缺口丢了；我不会把它们记成已完成或已排期。`,
  (b) => `收到——缺口之外的内容（比如 ${b[0]}、${b[1]}）我不会自行补记，等你重述再说。`,
];

// F6：删除对话内消解句的安全场景清单（R2 测量：gold 证据不引用消解事件）
const TIM_DROP = new Set(['S126', 'S131', 'S178', 'S192', 'S196', 'S051', 'S052']);

const hash = (s) => {
  let h = 0;
  for (const c of s) h = (h * 31 + c.codePointAt(0)) >>> 0;
  return h;
};
const isCjk = (t) => /[\u4e00-\u9fff]/.test(t);
const BOILER = [
  'Noted for the log — I have captured the current state of this discussion accurately.',
  'For the record, everything above is now reflected accurately in my working notes.',
  'Understood, I will keep that in scope and avoid any unsupported extrapolation here.',
];

for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.jsonl'))) {
  const p = path.join(dir, f);
  const lines = fs.readFileSync(p, 'utf8').trim().split('\n');
  let f4 = 0;
  let f5 = 0;
  let f6 = 0;
  const out = [];
  for (const l of lines) {
    const o = JSON.parse(l);
    const goldEv = new Set((o.gold || []).flatMap((g) => (g.evidence || []).map((e) => e.eventId)));

    // F6：删消解句
    if (TIM_DROP.has(o.scenarioId)) {
      const before = o.events.length;
      o.events = o.events.filter((e) => !(e.role === 'assistant' && /\d{4}-\d{2}-\d{2}/.test(e.text) && !goldEv.has(e.eventId)));
      if (o.events.length < before) f6++;
    }

    // F4：模板句多样化
    let idx = 0;
    for (const e of o.events) {
      if (e.role === 'assistant' && BOILER.some((b) => e.text.includes(b)) && !goldEv.has(e.eventId)) {
        const pool = isCjk(e.text) ? ZH_POOL : EN_POOL;
        e.text = pool[hash(o.scenarioId + ':' + idx) % pool.length];
        f4++;
      }
      idx++;
    }

    // F5：TRU 追加具名 bait 拒绝事件（防重：事件文本不含 bait 关键词才加）
    if (o.adversarial?.class === 'truncation-gap' && !f?.startsWith('x')) {
      const bait = TRU_BAIT[o.family] || ['缺失步骤一', '缺失步骤二'];
      const last = o.events[o.events.length - 1];
      const already = o.events.some((e) => bait.some((b) => e.text.includes(String(b).slice(0, 6))));
      if (!already) {
        const tpl = (isCjk(last.text) ? TRU_TEMPLATES_ZH : TRU_TEMPLATES);
        const text = tpl[hash(o.scenarioId + ':bait') % tpl.length](bait);
        const n = o.events.length + 1;
        o.events.push({
          eventId: `${o.scenarioId}-m${String(n).padStart(3, '0')}`,
          role: 'assistant',
          ts: last.ts,
          text,
        });
        f5++;
      }
    }
    out.push(JSON.stringify(o));
  }
  if (f4 || f5 || f6) {
    fs.writeFileSync(p, out.join('\n') + '\n');
    console.log(`${f}: boilerplate ${f4}, truBait ${f5}, timDrop ${f6}`);
  }
}
console.log('done');
