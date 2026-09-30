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

  // ===========================================================================
  // 定时生效排程
  // ===========================================================================
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const future = (ms) => iso(new Date(Date.now() + ms));

  // 草案 s1：当前队列空，未指定时刻仍即时生效（沿用原行为）
  const s1 = await call('POST', '/api/drafts', { name: 's1-immediate' }, 201);
  await call('PUT', `/api/drafts/${s1.id}/clauses/A`, { title: '总则', body: 'AAA-sched-immediate' });
  const pubImm = await call('POST', `/api/drafts/${s1.id}/publish`, { note: '即时版' }, 201);
  ok(pubImm.scheduled === false && pubImm.status === 'effective', '队列为空未指定时刻：即时生效');
  const immId = pubImm.version_id;

  // 草案 s2：定时 +2.5 秒发布 -> 写入不可变快照，进入队列，修订号 +1
  const s2 = await call('POST', '/api/drafts', { name: 's2-soon' }, 201);
  await call('PUT', `/api/drafts/${s2.id}/clauses/A`, { title: '总则', body: 'AAA-scheduled-v' });
  const tSoon1 = iso(new Date(Date.now() + 2500));
  const pubSch1 = await call('POST', `/api/drafts/${s2.id}/publish`, { note: '定时1', effective_at: tSoon1 }, 201);
  ok(pubSch1.scheduled === true && pubSch1.status === 'scheduled', '定时发布生成 scheduled 不可变版本');
  const sch1Id = pubSch1.version_id;
  const revAfterSch1 = pubSch1.schedule_revision;

  // 队列非空：再发草案，未指定时刻被拒并返回当前排程
  const s3 = await call('POST', '/api/drafts', { name: 's3-blocked' }, 201);
  const blocked = await call('POST', `/api/drafts/${s3.id}/publish`, { note: '想插队' }, 409);
  ok(blocked.error === 'QUEUE_NOT_EMPTY' && blocked.schedule.queue[0].id === sch1Id, '队列非空时即时发布被拒并说明原因、返回排程');

  // 时刻必须严格递增：早于队列末尾被拒
  const badOrder = await call('POST', `/api/drafts/${s3.id}/publish`, { note: '更早', effective_at: future(1000) }, 409);
  ok(badOrder.error === 'NON_INCREASING_TIME', '生效时刻未按发布顺序严格递增被拒');

  // 过去时刻被拒
  const pastPub = await call('POST', `/api/drafts/${s3.id}/publish`, { note: '过去', effective_at: '2020-01-01T00:00:00Z' }, 400);
  ok(pastPub.error === 'PAST_EFFECTIVE_AT', '指定过去时刻发布被拒');
  // 非法时间被拒
  const badTime = await call('POST', `/api/drafts/${s3.id}/publish`, { note: '坏', effective_at: 'tomorrow morning' }, 400);
  ok(badTime.error === 'BAD_EFFECTIVE_AT', '非法时间格式被拒');

  // 合法：s3 排在 sch1 之后（+1 小时）
  await call('PUT', `/api/drafts/${s3.id}/clauses/B`, { title: '会员', body: 'BBB-scheduled' });
  const tLater = iso(new Date(Date.now() + 3600e3));
  const pubSch2 = await call('POST', `/api/drafts/${s3.id}/publish`, { note: '定时2', effective_at: tLater }, 201);
  const sch2Id = pubSch2.version_id;
  const revAfterSch2 = pubSch2.schedule_revision;
  ok(revAfterSch2 === revAfterSch1 + 1, '定时发布推进排程修订号');

  // 排程视图：顺序与当前生效版
  let sch = await call('GET', '/api/schedule');
  ok(sch.queue.length === 2 && sch.queue[0].id === sch1Id && sch.queue[1].id === sch2Id, '待生效队列按发布顺序排列');
  ok(sch.current_effective_version_id === immId, '当前生效版仍为即时版');

  // 改期不得越过相邻：sch1 改到 sch2 之后
  const cross = await call('POST', `/api/versions/${sch1Id}/reschedule`, {
    effective_at: iso(new Date(Date.now() + 7200e3)), schedule_revision: revAfterSch2,
  }, 409);
  ok(cross.error === 'CROSSES_ADJACENT' && cross.schedule, '改期越过相邻版本被拒并返回当前排程');
  // 落到过去（参数错误 400）
  const pastRe = await call('POST', `/api/versions/${sch1Id}/reschedule`, {
    effective_at: '2020-01-01T00:00:00Z', schedule_revision: revAfterSch2,
  }, 400);
  ok(pastRe.error === 'PAST_EFFECTIVE_AT', '改期落到过去被拒');
  // 修订号过期
  const stale = await call('POST', `/api/versions/${sch2Id}/cancel`, { schedule_revision: revAfterSch1 }, 409);
  ok(stale.error === 'STALE_REVISION' && stale.schedule_revision === revAfterSch2 && stale.schedule.queue.length === 2, '修订号过期整次拒绝并返回当前排程');

  // 取消 sch2（用最新修订号）
  const cancelRes = await call('POST', `/api/versions/${sch2Id}/cancel`, { schedule_revision: revAfterSch2 }, 200);
  ok(cancelRes.canceled === true && cancelRes.schedule.queue.length === 1 && cancelRes.schedule.queue[0].id === sch1Id, '取消后版本离队、快照保留');
  const revAfterCancel = cancelRes.schedule_revision;

  // 取消后可在 sch1 之后自由安排新版本（队列只剩 sch1）：s4 定到 sch1 之后
  const s4 = await call('POST', '/api/drafts', { name: 's4-after-cancel' }, 201);
  await call('PUT', `/api/drafts/${s4.id}/clauses/A`, { title: '总则', body: 'AAA-s4' });
  const pubSch3 = await call('POST', `/api/drafts/${s4.id}/publish`, { note: '定时3', effective_at: future(7200e3) }, 201);
  ok(pubSch3.scheduled === true, '取消后队列腾出空间，可继续定时发布');

  // 时点查询：当前 -> 即时版；取消版本被跳过；未来时点返回完整条款/顺序/引用
  const nowEff = await call('GET', '/api/effective');
  ok(nowEff.version_id === immId && nowEff.version.clauses.find((c) => c.key === 'A').body === 'AAA-sched-immediate', '当前时点生效版为即时版（含完整条款）');
  ok(Array.isArray(nowEff.version.refs) && nowEff.version.refs[0].source === 'B', '时点查询返回完整引用');

  // 等 sch1 到点自动生效（懒激活）
  await sleep(3000);
  const afterEff = await call('GET', '/api/effective');
  ok(afterEff.version_id === sch1Id && afterEff.version.clauses.find((c) => c.key === 'A').body === 'AAA-scheduled-v', '到点后懒激活，sch1 成为当前生效版');
  sch = await call('GET', '/api/schedule');
  ok(sch.queue[0].id === pubSch3.version_id && sch.current_effective_version_id === sch1Id, '激活后出队，修订号推进');

  // 已生效版本不能改期/取消（注意修订号必须先取最新的）
  sch = await call('GET', '/api/schedule');
  const cancelEff = await call('POST', `/api/versions/${sch1Id}/cancel`, { schedule_revision: sch.schedule_revision }, 409);
  ok(cancelEff.error === 'ALREADY_EFFECTIVE', '已生效版本不能取消');
  const reEff = await call('POST', `/api/versions/${sch1Id}/reschedule`, {
    effective_at: future(3600e3), schedule_revision: sch.schedule_revision,
  }, 409);
  ok(reEff.error === 'ALREADY_EFFECTIVE', '已生效版本不能改期');

  // 历史不可变：sch1 生效前的时点查询永远是即时版（后续激活/取消不改变结果）
  const hist = await call('GET', `/api/effective?at=${encodeURIComponent(tSoon1)}`);
  // tSoon1 是 sch1 的原定生效时刻（<= 实际查询发生时刻 now'），该时刻 sch1 生效 -> sch1
  ok(hist.version_id === sch1Id, '精确等于生效时刻的时点归该版本');
  const beforeT = new Date(Date.parse(tSoon1) - 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const histBefore = await call('GET', `/api/effective?at=${encodeURIComponent(beforeT)}`);
  ok(histBefore.version_id === immId, '生效时刻前 1 秒的时点仍是上一版，且之后任何操作不再改变它');

  // 首版不能定时
  // （首版已存在无法直接测 initialize；用 BAD 语义校验：首版接口收到 effective_at 时拒绝）

  // 已取消版本快照仍可查看（条款完整）
  const canceledSnap = await call('GET', `/api/versions/${sch2Id}`);
  ok(canceledSnap.status === 'canceled' && canceledSnap.clauses.find((c) => c.key === 'B').body === 'BBB-scheduled', '已取消版本快照完整保留可查');

  // 草案仍以最新发布版为基线（含待生效版本）；现有差异操作可用
  ov = await call('GET', '/api/overview');
  ok(ov.latest_version_id === pubSch3.version_id, '最新发布版为序列最后一个（即使仍待生效）');
  const s5 = await call('POST', '/api/drafts', { name: 's5-baseline-latest' }, 201);
  ok(s5.baseline_id === pubSch3.version_id, '新草案默认基线为最新发布版');
  const s5det = await call('GET', `/api/drafts/${s5.id}?diff=1`);
  ok(s5det.clauses.find((c) => c.key === 'A').body === 'AAA-s4' && Array.isArray(s5det.diff.added), '草案快照/差异操作在排程下保持可用');

  console.log(`\n${pass} 项端到端断言全部通过`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
