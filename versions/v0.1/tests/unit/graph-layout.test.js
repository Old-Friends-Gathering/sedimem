/**
 * graph-layout.test.js —— `ui/graph.js` 布局纯函数的单元测试（D 路 / W5）。
 *
 * 覆盖 docs/plans/v0.2-web-ui-plan.md §7 单元层要求：
 * 斥力/弹簧/向心推进后坐标为有限数、能量单调下降、同输入可复现、节点两两距离 > 0。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutTick } from '../../ui/layout.js';

/** 构造一个小图：5 个节点环 + 两条弹簧边 */
function makeNodes(count = 5) {
  const nodes = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    nodes.push({
      id: `n${i}`,
      kind: 'fact',
      status: 'active',
      hits: i,
      x: 300 + 30 * Math.cos(a),
      y: 300 + 30 * Math.sin(a),
      vx: 0,
      vy: 0,
    });
  }
  return nodes;
}
function makeEdges(nodes) {
  return [
    { from: nodes[0].id, to: nodes[1].id, type: 'same-entity', weight: 1 },
    { from: nodes[1].id, to: nodes[2].id, type: 'supersedes', weight: 1 },
  ];
}

test('tick 后所有节点坐标与速度均为有限数', () => {
  const nodes = makeNodes();
  const edges = makeEdges(nodes);
  let alpha = 1;
  for (let i = 0; i < 10; i++) {
    const out = layoutTick(nodes, edges, { alpha, width: 600, height: 600 });
    alpha = out.alpha;
    assert.ok(Number.isFinite(out.alpha), 'alpha 必须是有限数');
    assert.ok(Number.isFinite(out.energy), 'energy 必须是有限数');
  }
  for (const nd of nodes) {
    assert.ok(Number.isFinite(nd.x), `${nd.id}.x 有限`);
    assert.ok(Number.isFinite(nd.y), `${nd.id}.y 有限`);
    assert.ok(Number.isFinite(nd.vx), `${nd.id}.vx 有限`);
    assert.ok(Number.isFinite(nd.vy), `${nd.id}.vy 有限`);
  }
});

test('衰减阶段 50 帧内能量单调不增（容忍 1e-9）', () => {
  const nodes = makeNodes();
  const edges = makeEdges(nodes);
  // 先预热 80 帧让系统进入阻尼主导的衰减段（斥力已把节点推开、弹簧接近自然长度）
  let alpha = 1;
  for (let i = 0; i < 80; i++) {
    alpha = layoutTick(nodes, edges, { alpha, width: 600, height: 600 }).alpha;
  }
  let prev = layoutTick(nodes, edges, { alpha, width: 600, height: 600 }).energy;
  for (let i = 0; i < 50; i++) {
    const { energy } = layoutTick(nodes, edges, { alpha, width: 600, height: 600 });
    assert.ok(
      energy <= prev + 1e-9,
      `第 ${i} 帧能量应不增：prev=${prev} now=${energy}`,
    );
    prev = energy;
  }
});

test('同输入两次独立模拟结果完全可复现（无随机源）', () => {
  const run = () => {
    const nodes = makeNodes(4);
    const edges = makeEdges(nodes);
    let alpha = 1;
    const trace = [];
    for (let i = 0; i < 30; i++) {
      const out = layoutTick(nodes, edges, { alpha, width: 600, height: 600 });
      alpha = out.alpha;
      trace.push(nodes.map((nd) => [nd.x, nd.y, nd.vx, nd.vy]));
    }
    return trace;
  };
  assert.deepStrictEqual(run(), run());
});

test('任意帧后节点两两距离 > 0（重合输入也会被推开）', () => {
  // 极端输入：全部节点完全重合在同一点
  const nodes = Array.from({ length: 3 }, (_, i) => ({
    id: `z${i}`, x: 300, y: 300, vx: 0, vy: 0,
  }));
  const edges = [];
  let alpha = 1;
  for (let i = 0; i < 20; i++) {
    alpha = layoutTick(nodes, edges, { alpha, width: 600, height: 600 }).alpha;
    for (let a = 0; a < nodes.length; a++) {
      for (let b = a + 1; b < nodes.length; b++) {
        const d = Math.hypot(nodes[a].x - nodes[b].x, nodes[a].y - nodes[b].y);
        assert.ok(d > 0, `第 ${i} 帧 ${nodes[a].id}-${nodes[b].id} 距离必须 > 0，实际 ${d}`);
      }
    }
  }
  // 常规输入同样成立
  const nodes2 = makeNodes();
  alpha = 1;
  for (let i = 0; i < 20; i++) {
    alpha = layoutTick(nodes2, makeEdges(nodes2), { alpha, width: 600, height: 600 }).alpha;
  }
  for (let a = 0; a < nodes2.length; a++) {
    for (let b = a + 1; b < nodes2.length; b++) {
      assert.ok(Math.hypot(nodes2[a].x - nodes2[b].x, nodes2[a].y - nodes2[b].y) > 0);
    }
  }
});

test('固定节点（fx/fy）位置不动、速度清零，alpha 持续衰减', () => {
  const nodes = makeNodes(3);
  nodes[0].fx = 111;
  nodes[0].fy = 222;
  const edges = [];
  let alpha = 1;
  for (let i = 0; i < 15; i++) {
    const out = layoutTick(nodes, edges, { alpha, width: 600, height: 600 });
    assert.ok(out.alpha < alpha, 'alpha 每帧衰减');
    alpha = out.alpha;
  }
  assert.equal(nodes[0].x, 111);
  assert.equal(nodes[0].y, 222);
  assert.equal(nodes[0].vx, 0);
  assert.equal(nodes[0].vy, 0);
});

test('空图：不抛错，energy 为 0，alpha 仍衰减', () => {
  const out = layoutTick([], [], { alpha: 1 });
  assert.equal(out.energy, 0);
  assert.ok(out.alpha < 1);
});
