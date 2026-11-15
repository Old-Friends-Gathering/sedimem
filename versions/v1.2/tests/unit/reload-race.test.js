// tests/unit/reload-race.test.js — 回归：_reload 的「全量读」与「水位」顺序
//
// 历史缺陷（I8 并发偶发红的根因）：旧实现先 loadScope() 全量读、再取 fileSize() 当水位。
// 若他进程恰在这两步之间追加一行，该行「读时没看到」且「水位已越过」→ 永久漏读，
// 同一条事实随后会被再判一次 created（active 出现 2 条、dupRatio 不再为 0）。
// 新实现改为先取 sizeBefore 再读，并允许重复消费靠快照相等去重。

import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createMemoryService } from '../../src/api/service.js';
import { JsonlStore } from '../../src/storage/jsonl-store.js';
import { createRecord } from '../../src/core/record.js';
import { systemClock } from '../../src/core/clock.js';

async function tmpHome(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'memo-reload-race-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('_reload：读取期间他进程追加的行不会被永久漏读（水位不越过未读内容）', async (t) => {
  const memoHome = await tmpHome(t);
  const scope = 'dir:race';
  const real = new JsonlStore({ memoHome });

  await real.append(createRecord({
    text: '基础事实：Node 22 是运行时下限',
    scope,
    source: { agent: 'cli' },
  }, { clock: systemClock }));

  // 模拟另一进程在「本进程全量读返回之后、取水位之前」追加一行（旧实现的漏洞窗口）
  const foreign = createRecord({
    text: '外部进程同时写入的另一条事实',
    scope,
    source: { agent: 'codex' },
  }, { clock: systemClock });

  let injected = false;
  const spyingStore = {
    fileSize: (s) => real.fileSize(s),
    loadScope: async (s) => {
      const recs = await real.loadScope(s);
      if (!injected) {
        injected = true;
        await real.append(foreign); // 关键：发生在全量读之后
      }
      return recs;
    },
    loadScopeIncremental: (s, o) => real.loadScopeIncremental(s, o),
    append: (r) => real.append(r),
    appendImmediate: (r) => real.appendImmediate(r),
    appendEvent: (e) => real.appendEvent(e),
    appendEventImmediate: (e) => real.appendEventImmediate(e),
  };

  const svc = await createMemoryService({ memoHome, scope, store: spyingStore });
  assert.equal(injected, true, '测试自身前提：注入必须发生');

  // 触发一次锁内增量重读：正确实现应把 foreign 补读进来
  await svc.write({ text: '第三条独立事实', source: { agent: 'cli' } });

  const s = await svc.stats();
  assert.equal(s.active, 3, `旧实现会漏读 foreign → active=2；正确实现 active=3（实际 ${s.active}）`);

  // 漏读还会导致「同一条事实被再判一次 created」：重写 foreign 的文本必须被识别为重复
  const again = await svc.write({ text: foreign.text, source: { agent: 'cli' } });
  assert.ok(
    again.action === 'noop_duplicate' || again.action === 'noop_same_value',
    `foreign 的文本应被识别为重复，实际 ${again.action}`,
  );
  assert.equal((await svc.stats()).active, 3, '重复写不得新增 active');
});

test('_refreshIncremental：重复消费同一快照不会污染版本链与索引', async (t) => {
  const memoHome = await tmpHome(t);
  const scope = 'dir:race2';
  const real = new JsonlStore({ memoHome });

  const rec = createRecord({ text: '同一条事实只应有一个版本', scope, source: { agent: 'cli' } },
    { clock: systemClock });
  await real.append(rec);

  // 水位故意回退到 0：模拟 _reload 回退 / 半行补齐后的重复消费
  const svc = await createMemoryService({ memoHome, scope });
  svc._readOffset = 0;

  await svc.write({ text: '另一条事实', source: { agent: 'cli' } });
  const versions = svc._versions.get(rec.id) ?? [];
  assert.equal(versions.length, 1, `同一快照重复消费后版本链仍应为 1 条（实际 ${versions.length}）`);

  const s = await svc.stats();
  assert.equal(s.active, 2);
  assert.equal(s.dupRatio, 0, '重复消费不得让 dupRatio 变正');
});
