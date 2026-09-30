'use strict';
// 纯逻辑测试：node test/model.test.js
const assert = require('assert');
const {
  buildState,
  touchedClauses,
  replayDraft,
  validateState,
  hasBlockingIssues,
  diffStates,
  movedKeys,
  textDiff,
  parseEffectiveAt,
  validateSchedulePublish,
  validateReschedule,
  pickEffectiveVersion,
} = require('../src/model');

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

function S(order, clauses, edges = []) {
  return buildState({
    order,
    clauses: clauses.map(([key, title, body]) => ({ key, title, body: body || title })),
    edges,
  });
}

const baseline = S(
  ['A', 'B', 'C'],
  [
    ['A', '总则'],
    ['B', '会员'],
    ['C', '附则'],
  ],
  [{ source: 'A', target: 'B', label: '见' }],
);

test('不相交改动可重放：草案改 A，最新版改 C', () => {
  const draft = S(
    ['A', 'B', 'C'],
    [
      ['A', '总则修订', '新内容'],
      ['B', '会员'],
      ['C', '附则'],
    ],
    [{ source: 'A', target: 'B', label: '见' }],
  );
  const latest = S(
    ['A', 'B', 'C'],
    [
      ['A', '总则'],
      ['B', '会员'],
      ['C', '附则修订'],
    ],
    [{ source: 'A', target: 'B', label: '见' }],
  );
  const r = replayDraft({ baseline, latest, draft });
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(r.merged.clauses.get('A').title, '总则修订');
  assert.strictEqual(r.merged.clauses.get('C').title, '附则修订');
});

test('同一条款双方改动 -> modify-modify 冲突', () => {
  const draft = S(['A', 'B', 'C'], [['A', '总则X'], ['B', '会员'], ['C', '附则']], baseline.edges);
  const latest = S(['A', 'B', 'C'], [['A', '总则Y'], ['B', '会员'], ['C', '附则']], baseline.edges);
  const r = replayDraft({ baseline, latest, draft });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.conflicts[0].kind, 'modify-modify');
  assert.strictEqual(r.conflicts[0].key, 'A');
});

test('双方同样修改（收敛）不冲突', () => {
  const draft = S(['A', 'B', 'C'], [['A', '总则X'], ['B', '会员'], ['C', '附则']], baseline.edges);
  const latest = S(['A', 'B', 'C'], [['A', '总则X'], ['B', '会员'], ['C', '附则']], baseline.edges);
  const r = replayDraft({ baseline, latest, draft });
  assert.ok(r.ok);
});

test('草案删除、最新版修改 -> delete-modify 冲突', () => {
  const draft = S(['B', 'C'], [['B', '会员'], ['C', '附则']], []);
  const latest = S(['A', 'B', 'C'], [['A', '总则X'], ['B', '会员'], ['C', '附则']], baseline.edges);
  const r = replayDraft({ baseline, latest, draft });
  assert.strictEqual(r.ok, false);
  assert.ok(r.conflicts.some((c) => c.kind === 'delete-modify' && c.key === 'A'));
});

test('双方都删除 A -> 收敛，结果不含 A', () => {
  const draft = S(['B', 'C'], [['B', '会员'], ['C', '附则']], []);
  const latest = S(['B', 'C'], [['B', '会员'], ['C', '附则']], []);
  const r = replayDraft({ baseline, latest, draft });
  assert.ok(r.ok, JSON.stringify(r.conflicts));
  assert.ok(!r.merged.clauses.has('A'));
  assert.deepStrictEqual(r.merged.order, ['B', 'C']);
});

test('重放后引用悬空（草案删 B，但保留 A->B 引用为悬空暂存；最新版没动）-> 拒绝', () => {
  // 删除条款时入边保留在草案中（可暂存的悬空引用）
  const draft = S(
    ['A', 'C'],
    [
      ['A', '总则'],
      ['C', '附则'],
    ],
    [{ source: 'A', target: 'B', label: '见' }],
  );
  const latest = S(
    ['A', 'B', 'C'],
    [
      ['A', '总则'],
      ['B', '会员'],
      ['C', '附则'],
    ],
    [
      { source: 'A', target: 'B', label: '见' },
      { source: 'C', target: 'A', label: '' },
    ],
  );
  const r = replayDraft({ baseline, latest, draft });
  assert.strictEqual(r.ok, false);
  assert.ok(r.dangling.some((d) => d.source === 'A' && d.target === 'B'));
});

test('草案删除 B 且最新版也删除 B（引用一并消失）-> 不悬空', () => {
  const draft = S(['A', 'C'], [['A', '总则'], ['C', '附则']], []);
  const latest = S(['A', 'C'], [['A', '总则'], ['C', '附则']], []);
  const r = replayDraft({ baseline, latest, draft });
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(r.merged.edges.length, 0);
});

test('新增条款不相交：草案加 D，最新版加 E，顺序按锚点插入', () => {
  const draft = S(['A', 'B', 'C', 'D'], [['A', '总则'], ['B', '会员'], ['C', '附则'], ['D', '附则二']], baseline.edges);
  const latest = S(['A', 'E', 'B', 'C'], [['A', '总则'], ['E', '新增E'], ['B', '会员'], ['C', '附则']], baseline.edges);
  const r = replayDraft({ baseline, latest, draft });
  assert.ok(r.ok, JSON.stringify(r.conflicts));
  // E 在最新版的位置（A 后），D 由草案放置在末尾
  assert.deepStrictEqual(r.merged.order, ['A', 'E', 'B', 'C', 'D']);
});

test('双方新增同标识但内容不同 -> add-add 冲突', () => {
  const draft = S(['A', 'B', 'C', 'D'], [['A', '总则'], ['B', '会员'], ['C', '附则'], ['D', '草案的D']], baseline.edges);
  const latest = S(['A', 'B', 'C', 'D'], [['A', '总则'], ['B', '会员'], ['C', '附则'], ['D', '最新版的D']], baseline.edges);
  const r = replayDraft({ baseline, latest, draft });
  assert.strictEqual(r.ok, false);
  assert.ok(r.conflicts.some((c) => c.kind === 'add-add'));
});

test('草案移动 B 到末尾，最新版改 C：重放后 B 在末尾', () => {
  const draft = S(['A', 'C', 'B'], [['A', '总则'], ['B', '会员'], ['C', '附则']], baseline.edges);
  const latest = S(['A', 'B', 'C'], [['A', '总则'], ['B', '会员'], ['C', '附则X']], baseline.edges);
  const r = replayDraft({ baseline, latest, draft, draftMoved: new Set(['B']) });
  assert.ok(r.ok, JSON.stringify(r.conflicts));
  assert.deepStrictEqual(r.merged.order, ['A', 'C', 'B']);
  assert.strictEqual(r.merged.clauses.get('C').title, '附则X');
  assert.ok(r.mergedMoved.has('B'));
});

test('草案前移 C（显式移动 C），最新版只改 B 正文：不相交，可重放', () => {
  const draft = S(['A', 'C', 'B'], [['A', '总则'], ['B', '会员'], ['C', '附则']], baseline.edges);
  const latest = S(['A', 'B', 'C'], [['A', '总则'], ['B', '会员修订'], ['C', '附则']], baseline.edges);
  const r = replayDraft({ baseline, latest, draft, draftMoved: new Set(['C']) });
  assert.ok(r.ok, JSON.stringify(r.conflicts));
  assert.deepStrictEqual(r.merged.order, ['A', 'C', 'B']);
  assert.strictEqual(r.merged.clauses.get('B').title, '会员修订');
});

test('显式移动集合用于触碰判定（被动让位条款不算移动）', () => {
  const other = S(['A', 'C', 'B'], [['A', '总则'], ['B', '会员'], ['C', '附则']], baseline.edges);
  const t = touchedClauses(baseline, other, new Set(['C']));
  assert.ok(t.get('C').position); // C 被显式移动
  assert.strictEqual(t.get('B'), undefined); // B 只是被动让位
  assert.strictEqual(t.get('A'), undefined);
});

test('草案可暂存悬空引用：validate 报 error，阻止发布', () => {
  const s = S(['A'], [['A', '总则']], [{ source: 'A', target: 'ZZZ', label: '' }]);
  const issues = validateState(s);
  assert.ok(issues.some((i) => i.code === 'dangling-ref'));
  assert.ok(hasBlockingIssues(issues));
});

test('结构差异：新增/删除/修改分类', () => {
  const d = diffStates(
    baseline,
    S(['A', 'C'], [['A', '总则改'], ['C', '附则']], [{ source: 'C', target: 'A', label: '' }]),
  );
  assert.deepStrictEqual(d.deleted, ['B']);
  assert.ok(d.changed.some((c) => c.key === 'A' && c.body));
  assert.strictEqual(d.refsRemoved.length, 1);
  assert.strictEqual(d.refsAdded.length, 1);
});

test('textDiff 中文按字标注增删', () => {
  const segs = textDiff('社团章程', '社团新章程');
  const ins = segs.filter((s) => s.op === 'ins').map((s) => s.text).join('');
  const del = segs.filter((s) => s.op === 'del').map((s) => s.text).join('');
  assert.strictEqual(ins, '新');
  assert.strictEqual(del, '');
});

test('movedKeys 检测前驱锚点变化（交换中只标记后移者）', () => {
  assert.deepStrictEqual([...movedKeys(['A', 'B', 'C'], ['A', 'C', 'B'])], ['B']);
});

// ---------------------------------------------------------------------------
// 生效排程
// ---------------------------------------------------------------------------
const NOW = Date.parse('2026-09-30T00:00:00Z');
const T1 = Date.parse('2026-10-01T00:00:00Z');
const T2 = Date.parse('2026-11-01T00:00:00Z');
const T3 = Date.parse('2026-12-01T00:00:00Z');
const pend = (entries) => entries.map(([id, t]) => ({ id, effective_at_ms: t }));

test('parseEffectiveAt：未指定为 null，非法为 NaN，Z 与偏移均可解析', () => {
  assert.strictEqual(parseEffectiveAt(undefined), null);
  assert.strictEqual(parseEffectiveAt(''), null);
  assert.ok(Number.isNaN(parseEffectiveAt('not-a-time')));
  assert.strictEqual(parseEffectiveAt('2027-01-01T00:00:00Z'), Date.parse('2027-01-01T00:00:00Z'));
  assert.strictEqual(parseEffectiveAt('2027-01-01T08:00:00+08:00'), Date.parse('2027-01-01T00:00:00Z'));
});

test('发布：队列为空且未指定时刻 -> 即时生效', () => {
  const r = validateSchedulePublish({ pending: [], nowMs: NOW, atMs: null, queueEmpty: true });
  assert.strictEqual(r.ok, true);
});

test('发布：队列非空且未指定时刻 -> QUEUE_NOT_EMPTY', () => {
  const r = validateSchedulePublish({ pending: pend([[2, T1]]), nowMs: NOW, atMs: null, queueEmpty: false });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'QUEUE_NOT_EMPTY');
});

test('发布：时刻落在过去/当前 -> PAST_EFFECTIVE_AT', () => {
  assert.strictEqual(validateSchedulePublish({ pending: [], nowMs: NOW, atMs: NOW - 1, queueEmpty: true }).code, 'PAST_EFFECTIVE_AT');
  assert.strictEqual(validateSchedulePublish({ pending: [], nowMs: NOW, atMs: NOW, queueEmpty: true }).code, 'PAST_EFFECTIVE_AT');
});

test('发布：时刻不晚于队列末尾 -> NON_INCREASING_TIME', () => {
  const r = validateSchedulePublish({ pending: pend([[2, T1], [3, T2]]), nowMs: NOW, atMs: T2, queueEmpty: false });
  assert.strictEqual(r.code, 'NON_INCREASING_TIME');
  assert.ok(validateSchedulePublish({ pending: pend([[2, T1], [3, T2]]), nowMs: NOW, atMs: T3, queueEmpty: false }).ok);
});

test('改期：不得越过前后相邻版本', () => {
  const q = pend([[2, T1], [3, T2], [4, T3]]);
  // v3 前移到 T1 或更早 -> 越过前邻 v2
  assert.strictEqual(validateReschedule({ pending: q, versionId: 3, atMs: T1, nowMs: NOW }).code, 'CROSSES_ADJACENT');
  // v3 后移到 T3 或更晚 -> 越过后邻 v4
  assert.strictEqual(validateReschedule({ pending: q, versionId: 3, atMs: T3, nowMs: NOW }).code, 'CROSSES_ADJACENT');
  // 队首 v2 只能在 T2 之前
  assert.strictEqual(validateReschedule({ pending: q, versionId: 2, atMs: T2, nowMs: NOW }).code, 'CROSSES_ADJACENT');
  // 合法窗口内通过
  assert.ok(validateReschedule({ pending: q, versionId: 3, atMs: Date.parse('2026-10-15T00:00:00Z'), nowMs: NOW }).ok);
});

test('改期：落到过去/当前拒绝；不在队列中拒绝', () => {
  const q = pend([[2, T1]]);
  assert.strictEqual(validateReschedule({ pending: q, versionId: 2, atMs: NOW, nowMs: NOW }).code, 'PAST_EFFECTIVE_AT');
  assert.strictEqual(validateReschedule({ pending: q, versionId: 9, atMs: T2, nowMs: NOW }).code, 'NOT_PENDING');
});

test('时点查询：取未取消且生效时刻 <= at 的最后一个版本', () => {
  const vs = [
    { id: 1, status: 'effective', effective_at_ms: 100 },
    { id: 2, status: 'scheduled', effective_at_ms: 200 },
    { id: 3, status: 'canceled', effective_at_ms: 300 },
    { id: 4, status: 'scheduled', effective_at_ms: 400 },
  ];
  assert.strictEqual(pickEffectiveVersion(vs, 50), null);
  assert.strictEqual(pickEffectiveVersion(vs, 100).id, 1);
  assert.strictEqual(pickEffectiveVersion(vs, 250).id, 2);
  // v3 已取消：at=350 时仍停在 v2
  assert.strictEqual(pickEffectiveVersion(vs, 350).id, 2);
  assert.strictEqual(pickEffectiveVersion(vs, 400).id, 4);
});

test('历史不可变：at <= now 的查询结果只含已生效版本，任何后续改期/取消都不触及', () => {
  // now=250：v1 已生效，v2(300)/v3(400) 仍在未来。历史 at=250 的结果只可能是 v1。
  const scheduled = [
    { id: 1, status: 'effective', effective_at_ms: 100 },
    { id: 2, status: 'scheduled', effective_at_ms: 300 },
    { id: 3, status: 'scheduled', effective_at_ms: 400 },
  ];
  assert.strictEqual(pickEffectiveVersion(scheduled, 250).id, 1);
  // v3 取消、v2 改期到 350：at=250 仍为 v1（改期/取消都只能产生 > now 的新时刻）
  const mutated = [
    { id: 1, status: 'effective', effective_at_ms: 100 },
    { id: 2, status: 'scheduled', effective_at_ms: 350 },
    { id: 3, status: 'canceled', effective_at_ms: 400 },
  ];
  assert.strictEqual(pickEffectiveVersion(mutated, 250).id, 1);
});

console.log(`\n${passed} 项测试全部通过`);
