'use strict';
// 端到端 API 冒烟测试。用法：先启动服务，再 E2E_BASE=http://127.0.0.1:PORT node test/e2e.js
const base = process.env.E2E_BASE || 'http://127.0.0.1:3998';

let pass = 0;
function ok(cond, msg) {
  if (!cond) {
    console.error('✗ ' + msg);
    process.exit(1);
  }
  pass++;
  console.log('  ✓ ' + msg);
}

async function call(method, p, body, expected = 200) {
  const res = await fetch(base + p, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (res.status !== expected) {
    console.error(`✗ ${method} ${p} expected ${expected}, got ${res.status}:`, JSON.stringify(data));
    process.exit(1);
  }
  return data;
}

async function main() {
  // 全新库：未初始化
  let ov = await call('GET', '/api/overview');
  ok(ov.initialized === false, '空库未初始化');

  // 首版校验：悬空引用拒绝
  let rejected = await call('POST', '/api/initialize', {
    charter_title: '测试章程',
    clauses: [{ key: 'A', title: '一', body: '正文A' }],
    refs: [{ source: 'A', target: 'X', label: '' }],
  }, 400);
  ok(rejected.error === 'VALIDATION', '首版含悬空引用被拒绝');

  const init = await call('POST', '/api/initialize', {
    charter_title: '测试章程',
    clauses: [
      { key: 'A', title: '总则', body: 'AAA' },
      { key: 'B', title: '会员', body: 'BBB' },
      { key: 'C', title: '附则', body: 'CCC' },
    ],
    refs: [{ source: 'B', target: 'A', label: '参见' }],
  }, 201);
  ok(init.version_id === 1, '首版发布为 v1');

  await call('POST', '/api/initialize', {}, 409).catch(() => {});
  const again = await fetch(base + '/api/initialize', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  ok(again.status === 409, '不能重复初始化');

  // 草案1：新增 D + 移动 C 到 B 前（A,C,B），改 A 正文
  const d1 = await call('POST', '/api/drafts', { name: 'd1' }, 201);
  await call('POST', `/api/drafts/${d1.id}/clauses`, { key: 'D', title: '新条', body: 'DDD' });
  await call('PUT', `/api/drafts/${d1.id}/clauses/A`, { title: '总则', body: 'AAA-改' });
  await call('POST', `/api/drafts/${d1.id}/clauses/C/move`, { after: 'A' });
  let det = await call('GET', `/api/drafts/${d1.id}?diff=1`);
  ok(JSON.stringify(det.clauses.map((c) => c.key)) === JSON.stringify(['A', 'C', 'B', 'D']), 'd1 顺序为 A,C,B,D');
  ok(det.diff.added.includes('D') && det.diff.changed.some((c) => c.key === 'A'), 'd1 差异含新增D与修改A');
  // 发布 -> v2
  const pub2 = await call('POST', `/api/drafts/${d1.id}/publish`, { note: 'v2' }, 201);
  ok(pub2.version_id === 2 && pub2.replayed === false, 'd1 发布为 v2');
  det = await call('GET', `/api/drafts/${d1.id}`);
  ok(det.status === 'published', 'd1 状态变为 published');
  // 已发布草案不可再改
  const closed = await fetch(base + `/api/drafts/${d1.id}/clauses/B`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'x', body: 'y' }),
  });
  ok(closed.status === 409, '已发布草案禁止修改');

  // 草案2：基于 v1，改 B（v2 没动 B 的正文）→ 应重放成功
  const d2 = await call('POST', '/api/drafts', { name: 'd2', baseline_id: 1 }, 201);
  await call('PUT', `/api/drafts/${d2.id}/clauses/B`, { title: '会员', body: 'BBB-改' });
  const pub3 = await call('POST', `/api/drafts/${d2.id}/publish`, { note: 'v3' }, 201);
  ok(pub3.version_id === 3 && pub3.replayed === true, 'd2 不相交改动重放发布为 v3');
  const v3 = await call('GET', '/api/versions/3');
  ok(JSON.stringify(v3.clauses.map((c) => c.key)) === JSON.stringify(['A', 'C', 'B', 'D']), 'v3 顺序重放正确 A,C,B,D');
  ok(v3.clauses.find((c) => c.key === 'A').body === 'AAA-改', 'v3 保留 v2 的 A 修改');
  ok(v3.clauses.find((c) => c.key === 'B').body === 'BBB-改', 'v3 含 d2 的 B 修改');
  ok(v3.clauses.find((c) => c.key === 'D').body === 'DDD', 'v3 含 v2 新增的 D');

  // 草案3：基于 v1 改 A（A 已在 v2 被改）→ 冲突拒绝，草案保留
  const d3 = await call('POST', '/api/drafts', { name: 'd3', baseline_id: 1 }, 201);
  await call('PUT', `/api/drafts/${d3.id}/clauses/A`, { title: '总则', body: 'AAA-另改' });
  const conflict = await call('POST', `/api/drafts/${d3.id}/publish`, {}, 409);
  ok(conflict.error === 'CONFLICT' && conflict.conflicts[0].kind === 'modify-modify', '同条款双方改动被拒绝');
  det = await call('GET', `/api/drafts/${d3.id}`);
  ok(det.status === 'open', '冲突后草案保留为 open');

  // 草案4：基于 v3 删除 C，发布（没有入边指向 C）-> v4
  const d4 = await call('POST', '/api/drafts', { name: 'd4', baseline_id: 3 }, 201);
  // B->A 仍有效，删 C 不影响；C 无入边
  await call('DELETE', `/api/drafts/${d4.id}/clauses/C`);
  det = await call('GET', `/api/drafts/${d4.id}`);
  ok(det.publishable === true && det.clauses.length === 3, '删除无入边条款后仍可发布');
  const pub4 = await call('POST', `/api/drafts/${d4.id}/publish`, { note: 'v4' }, 201);
  ok(pub4.version_id === 4, 'd4 发布为 v4');

  // 草案5：删除 B（B 有入边吗？引用是 B->A：删 B 后 source 缺失 → 悬空暂存）
  const d5 = await call('POST', '/api/drafts', { name: 'd5', baseline_id: 4 }, 201);
  det = await call('DELETE', `/api/drafts/${d5.id}/clauses/B`);
  ok(det.publishable === false, '删 B 后引用 B->A 悬空，不可发布');
  ok(det.issues.some((i) => i.code === 'dangling-ref'), '问题清单标注悬空引用');
  const badPub = await call('POST', `/api/drafts/${d5.id}/publish`, {}, 409);
  ok(badPub.error === 'DRAFT_INVALID', '悬空草案发布被拒绝');

  // 暂存指向不存在目标的引用
  const d6 = await call('POST', '/api/drafts', { name: 'd6', baseline_id: 4 }, 201);
  await call('POST', `/api/drafts/${d6.id}/refs`, { source: 'A', target: 'ZZZ', label: '未来条款' });
  det = await call('GET', `/api/drafts/${d6.id}`);
  ok(det.issues.some((i) => i.code === 'dangling-ref' && i.target === 'ZZZ'), '可暂存指向缺失目标的引用并标红');

  // 重建同标识条款 ZZZ 后悬空消除
  await call('POST', `/api/drafts/${d6.id}/clauses`, { key: 'ZZZ', title: '未来', body: 'zzz' });
  det = await call('GET', `/api/drafts/${d6.id}`);
  ok(!det.issues.some((i) => i.level === 'error'), '建立同标识条款后悬空消除');

  // 草案删除与已发布版完全相同的改动 -> NO_CHANGES（改动已全部包含在最新版）
  const d7 = await call('POST', '/api/drafts', { name: 'd7', baseline_id: 3 }, 201);
  await call('DELETE', `/api/drafts/${d7.id}/clauses/C`);
  const samePub = await call('POST', `/api/drafts/${d7.id}/publish`, {}, 400);
  ok(samePub.error === 'NO_CHANGES', '双方都已删除 C 且无其他差异时返回无改动');

  // 历史还原：v1 顺序与引用
  const v1 = await call('GET', '/api/versions/1');
  ok(JSON.stringify(v1.clauses.map((c) => c.key)) === JSON.stringify(['A', 'B', 'C']), 'v1 历史顺序还原 A,B,C');
  ok(v1.clauses.find((c) => c.key === 'A').body === 'AAA', 'v1 正文还原（不可变）');
  ok(v1.refs.length === 1 && v1.refs[0].source === 'B' && v1.refs[0].target === 'A', 'v1 引用还原');

  // 版本对比 v1 -> v3
  const cmp = await call('GET', '/api/versions/3?compare=1');
  ok(cmp.diff.added.includes('D') && cmp.diff.moved.includes('C'), '版本对比检测新增 D 与移动 C');
  ok(Array.isArray(cmp.changed_detail) && cmp.changed_detail.some((c) => c.bodySegments), '版本对比含正文逐字差异');

  // 无改动发布
  const d8 = await call('POST', '/api/drafts', { name: 'd8-noop', baseline_id: 1 }, 201);
  const noop = await call('POST', `/api/drafts/${d8.id}/publish`, {}, 400);
  ok(noop.error === 'NO_CHANGES', '与最新版无差异时拒绝发布');

  console.log(`\n${pass} 项端到端断言全部通过`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
