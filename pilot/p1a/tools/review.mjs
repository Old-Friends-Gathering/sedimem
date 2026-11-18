// B2 复核骨架：只读 list/show；accept/reject 为 P1b 桩（完整复核流程属 P1b，计划 §8）。
export function listCandidates(cands, { status, scope } = {}) {
  return cands.filter((c) => (!status || c.status === status) && (!scope || c.scope === scope));
}

export function showCandidate(cands, candidateId) {
  const c = cands.find((x) => x.candidateId === candidateId);
  if (!c) throw Object.assign(new Error(`candidate ${candidateId} 不存在`), { code: 'E_NOT_FOUND' });
  return c;
}

export function decideCandidate(_cands, _candidateId, _decision, _opts) {
  throw Object.assign(new Error('accept/reject 属 P1b 复核流程，B2 仅提供只读骨架'), { code: 'E_NOT_IMPLEMENTED_P1B' });
}

export async function main() {
  const { readFileSync } = await import('node:fs');
  const [cmd, file, ...rest] = process.argv.slice(2);
  if (!file || !['list', 'show'].includes(cmd)) {
    console.error('usage: node review.mjs list <candidates.jsonl> [--status s] [--scope sc] | show <candidates.jsonl> <candidateId>');
    process.exit(1);
  }
  const cands = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  if (cmd === 'list') {
    const opts = {};
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--status') opts.status = rest[++i];
      if (rest[i] === '--scope') opts.scope = rest[++i];
    }
    for (const c of listCandidates(cands, opts)) console.log([c.candidateId, c.status, c.type, c.scope, c.claim.slice(0, 60)].join('  '));
  } else {
    console.log(JSON.stringify(showCandidate(cands, rest[0]), null, 2));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
