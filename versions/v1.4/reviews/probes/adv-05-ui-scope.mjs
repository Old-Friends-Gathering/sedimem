// adv-05: UI scope 攻击面 — resolveScope 对非法/超长/换行/穿越 scope；hash 提取正则。
import { SCOPE_PATTERN, resolveScope } from '../../ui/scope.js';
const out = [];
const avail = ['repo:a', 'dir:b'];

// localStorage / ?scope= 候选值（app.js currentScope() 会 decodeURIComponent）
const cases = [
  ['repo:../../etc', '路径穿越'],
  ['repo:a\nrepo:b', '带换行（localStorage 直接塞）'],
  ['repo:' + 'x'.repeat(100), '超长(>64)'],
  ['repo:A B C', '大写+空格'],
  ['', '空串'],
  ['repo:a', '合法'],
  ['#"><img src=x>', 'HTML 注入形状'],
];
for (const [v, label] of cases) {
  const r = resolveScope({ storedScope: v, available: avail });
  out.push(`stored=${JSON.stringify(v).slice(0, 40)} (${label}) → scope=${JSON.stringify(r.scope)} source=${r.source} fallback=${r.fallbackReason ?? '-'}`);
}
// available 列表本身被污染（服务端被攻破场景）
const r2 = resolveScope({ storedScope: '', available: ['repo:ok', 'repo:../../x'] });
out.push(`available 含穿越项 → 选中=${JSON.stringify(r2.scope)}（列表项先过 SCOPE_PATTERN: ${avail.filter((s) => SCOPE_PATTERN.test(s))} 过滤生效）`);
// available 为空（/api/scopes 挂）时只做形状校验
const r3 = resolveScope({ storedScope: 'repo:weird-but-shape-ok', available: [] });
out.push(`available 空 + stored 形状合法 → scope=${JSON.stringify(r3.scope)}（放行，可访问任意形状合法库）`);
console.log(out.join('\n'));
