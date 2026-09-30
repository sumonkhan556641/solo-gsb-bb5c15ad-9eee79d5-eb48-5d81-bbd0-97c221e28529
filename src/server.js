'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const {
  openDb,
  loadVersionState,
  loadDraftState,
  getVersionMeta,
  listVersions,
  listPending,
  getScheduleRevision,
  bumpScheduleRevision,
  activateDueVersions,
  rescheduleVersion,
  cancelVersion,
  listDrafts,
  getDraftMeta,
  insertVersion,
  snapshotDraft,
  replaceDraftContent,
  loadDraftMoved,
  saveDraftMoved,
} = require('./db');
const {
  keyError,
  validateState,
  hasBlockingIssues,
  replayDraft,
  diffStates,
  textDiff,
  parseEffectiveAt,
  validateSchedulePublish,
  validateReschedule,
  pickEffectiveVersion,
} = require('./model');

const PORT = parseInt(process.env.PORT || '3000', 10);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'charter.db');

const db = openDb(DB_PATH);

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 5 * 1024 * 1024) reject(new Error('BODY_TOO_LARGE'));
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('BAD_JSON'));
      }
    });
    req.on('error', reject);
  });
}

function serializeState(state) {
  return {
    order: state.order,
    clauses: state.order.map((k) => state.clauses.get(k)),
    refs: state.edges.map((e, i) => ({ id: null, ordinal: i, ...e })),
  };
}

function getCharterTitle() {
  const row = db.prepare('SELECT charter_title FROM meta WHERE id = 1').get();
  return row ? row.charter_title : '社团章程';
}

function setCharterTitle(title) {
  db.prepare(
    `INSERT INTO meta (id, charter_title) VALUES (1, ?)
     ON CONFLICT(id) DO UPDATE SET charter_title = excluded.charter_title`,
  ).run(title);
}

function stateEqual(a, b) {
  if (a.order.length !== b.order.length) return false;
  if (a.order.some((k, i) => b.order[i] !== k)) return false;
  const ea = new Set(a.edges.map((e) => `${e.source}->${e.target}#${e.label || ''}`));
  const eb = new Set(b.edges.map((e) => `${e.source}->${e.target}#${e.label || ''}`));
  if (ea.size !== eb.size) return false;
  for (const k of ea) if (!eb.has(k)) return false;
  for (const k of a.order) {
    const x = a.clauses.get(k);
    const y = b.clauses.get(k);
    if (x.title !== y.title || x.body !== y.body) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// 生效排程
// ---------------------------------------------------------------------------
// 懒到期：任何请求处理前先把到点的待生效版本翻转为 effective（与写入同在
// SQLite 事务内），单进程下足以保证时点查询与发布判定一致。
function tickScheduler() {
  const tx = db.transaction(() => {
    const activated = activateDueVersions(db);
    if (activated.length) bumpScheduleRevision(db);
    return activated;
  });
  return tx();
}

// 待生效队列的对外视图（顺序即发布顺序，生效时刻严格递增）
function schedulePayload() {
  const versions = listVersions(db);
  const nowIsoStr = new Date().toISOString();
  const current = pickEffectiveVersion(
    versions.map((v) => ({ ...v, effective_at_ms: v.effective_at ? Date.parse(v.effective_at) : null })),
    Date.now(),
  );
  const pending = listPending(db);
  const canceled = versions
    .filter((v) => v.status === 'canceled')
    .map((v) => ({
      id: v.id,
      note: v.note,
      created_at: v.created_at,
      effective_at: v.effective_at,
      canceled_at: v.canceled_at,
      baseline_id: v.baseline_id,
      draft_id: v.draft_id,
    }));
  return {
    now: nowIsoStr,
    schedule_revision: getScheduleRevision(db),
    current_effective_version_id: current ? current.id : null,
    queue: pending.map((p, i) => ({
      position: i + 1,
      id: p.id,
      note: p.note,
      effective_at: p.effective_at,
      effective_at_ms: p.effective_at_ms,
    })),
    canceled,
  };
}

// ---------------------------------------------------------------------------
// 业务处理
// ---------------------------------------------------------------------------
function apiOverview() {
  const versions = listVersions(db);
  const drafts = listDrafts(db);
  const schedule = schedulePayload();
  return {
    charter_title: getCharterTitle(),
    initialized: versions.length > 0,
    // 最新发布版：不可变版本序列的最后一个（含待生效/已取消，草案基线与重放仍以它为准）
    latest_version_id: versions.length ? versions[versions.length - 1].id : null,
    current_effective_version_id: schedule.current_effective_version_id,
    schedule_revision: schedule.schedule_revision,
    pending: schedule.queue,
    versions,
    drafts,
  };
}

function handleInitial(body) {
  if (listVersions(db).length > 0) {
    return { status: 409, payload: { error: 'ALREADY_INITIALIZED', message: '首版章程已存在，请从已发布版本创建草案' } };
  }
  // 首版始终即时生效；首版之前没有“当前生效版”，不允许出现待生效真空
  if (parseEffectiveAt(body.effective_at) !== null) {
    return {
      status: 400,
      payload: { error: 'INITIAL_MUST_BE_IMMEDIATE', message: '首版章程必须即时生效，不能指定未来生效时刻；定时生效用于首版之后的修订发布' },
    };
  }
  const title = String(body.charter_title || '社团章程').slice(0, 100);
  const clausesInput = Array.isArray(body.clauses) ? body.clauses : [];
  const refsInput = Array.isArray(body.refs) ? body.refs : [];

  if (!clausesInput.length) {
    return { status: 400, payload: { error: 'EMPTY', message: '至少需要录入一个条款' } };
  }

  const state = inputToState(clausesInput, refsInput);
  if (!state.ok) return { status: 400, payload: { error: 'VALIDATION', issues: state.issues } };

  const issues = validateState(state.state);
  const blocking = issues.filter((i) => i.level === 'error');
  if (blocking.length) {
    return { status: 400, payload: { error: 'VALIDATION', issues: blocking } };
  }

  const tx = db.transaction(() => {
    setCharterTitle(title);
    return insertVersion(db, { note: body.note || '首版发布', baselineId: null, state: state.state });
  });
  const id = tx();
  return { status: 201, payload: { version_id: id } };
}

function inputToState(clausesInput, refsInput) {
  const issues = [];
  const clauses = [];
  const order = [];
  const seen = new Set();
  clausesInput.forEach((c, i) => {
    const key = String(c.key || '').trim();
    const title = String(c.title || '').trim();
    const text = String(c.body ?? '');
    const kerr = keyError(key);
    if (kerr) issues.push({ code: 'bad-key', ordinal: i, key, message: `标识无效：${kerr}` });
    if (seen.has(key)) issues.push({ code: 'duplicate-key', key, message: `标识重复：${key}` });
    seen.add(key);
    if (!title) issues.push({ code: 'empty-title', key, message: `条款「${key || i}」缺少标题` });
    if (!text.trim()) issues.push({ code: 'empty-body', key, message: `条款「${key || i}」正文为空` });
    order.push(key);
    clauses.push({ key, title, body: text });
  });

  const refs = refsInput.map((r) => ({
    source: String(r.source || '').trim(),
    target: String(r.target || '').trim(),
    label: String(r.label || '').trim(),
  }));

  const { buildState } = require('./model');
  const state = buildState({ order, clauses, edges: refs });
  if (issues.length) return { ok: false, issues };

  const stateIssues = validateState(state).filter((i) => i.level === 'error');
  if (stateIssues.length) return { ok: false, issues: stateIssues };
  return { ok: true, state };
}

function handleCreateDraft(body) {
  const versions = listVersions(db);
  if (!versions.length) {
    return { status: 409, payload: { error: 'NO_VERSION', message: '还没有已发布版本，请先录入首版章程' } };
  }
  const baselineId = parseInt(body.baseline_id, 10) || versions[versions.length - 1].id;
  const meta = getVersionMeta(db, baselineId);
  if (!meta) return { status: 404, payload: { error: 'NOT_FOUND', message: '基线版本不存在' } };
  const name = String(body.name || '').trim() || `基于 v${baselineId} 的草案`;

  const state = loadVersionState(db, baselineId);
  const draftId = snapshotDraft(db, null, baselineId, name, state);
  return { status: 201, payload: draftDetail(draftId) };
}

function draftDetail(draftId, { withTextDiff = false } = {}) {
  const meta = getDraftMeta(db, draftId);
  if (!meta) return null;
  const state = loadDraftState(db, draftId);
  const baseline = loadVersionState(db, meta.baseline_id);
  const issues = validateState(state);
  const movedSet = new Set(meta.moved_keys.filter((k) => state.clauses.has(k)));
  const diff = diffStates(baseline, state, movedSet);
  const detail = {
    ...meta,
    clauses: state.order.map((k, i) => ({ ordinal: i, ...state.clauses.get(k) })),
    refs: state.edges.map((e, i) => ({ ordinal: i, ...e })),
    issues,
    publishable: !hasBlockingIssues(issues),
    diff: summarizeDiff(diff),
  };
  if (withTextDiff) {
    detail.diff.changed_detail = diff.changed.map((c) => {
      const b = baseline.clauses.get(c.key);
      const d = state.clauses.get(c.key);
      return {
        ...c,
        titleSegments: c.body || b.title !== d.title ? textDiff(b.title, d.title) : null,
        bodySegments: c.body ? textDiff(b.body, d.body) : null,
        oldRefs: baseline.edges.filter((e) => e.source === c.key),
        newRefs: state.edges.filter((e) => e.source === c.key),
      };
    });
    detail.diff.refs_added = diff.refsAdded;
    detail.diff.refs_removed = diff.refsRemoved;
  }
  return detail;
}

function summarizeDiff(diff) {
  return {
    added: diff.added,
    deleted: diff.deleted,
    changed: diff.changed,
    moved: diff.moved,
    refs_added_count: diff.refsAdded.length,
    refs_removed_count: diff.refsRemoved.length,
  };
}

// ---------------------------------------------------------------------------
// 草案编辑
// ---------------------------------------------------------------------------
// fn(state, movedSet) 可直接修改条款状态与显式移动集合
function mutateDraft(draftId, fn) {
  const meta = getDraftMeta(db, draftId);
  if (!meta) return { status: 404, payload: { error: 'NOT_FOUND', message: '草案不存在' } };
  if (meta.status !== 'open') {
    return { status: 409, payload: { error: 'CLOSED', message: '草案已发布，不能再修改' } };
  }
  const state = loadDraftState(db, draftId);
  const movedSet = new Set(meta.moved_keys);
  const result = fn(state, movedSet);
  if (result && result.error) return { status: result.status || 400, payload: result.payload };
  // 移动记录只保留存活条款
  for (const k of [...movedSet]) if (!state.clauses.has(k)) movedSet.delete(k);
  const tx = db.transaction(() => {
    replaceDraftContent(db, draftId, state);
    saveDraftMoved(db, draftId, movedSet);
  });
  tx();
  return { status: 200, payload: draftDetail(draftId) };
}

function draftRoutes(method, url, body, query) {
  const draftMatch = url.match(/^\/api\/drafts\/(\d+)(\/.*)?$/);
  if (!draftMatch) return null;
  const draftId = parseInt(draftMatch[1], 10);
  const sub = draftMatch[2] || '';

  if (method === 'GET' && sub === '') {
    const detail = draftDetail(draftId, { withTextDiff: query.diff === '1' });
    return detail ? { status: 200, payload: detail } : { status: 404, payload: { error: 'NOT_FOUND' } };
  }

  if (method === 'PATCH' && sub === '') {
    const meta = getDraftMeta(db, draftId);
    if (!meta) return { status: 404, payload: { error: 'NOT_FOUND' } };
    const name = String(body.name || '').trim();
    if (!name) return { status: 400, payload: { error: 'VALIDATION', message: '草案名称不能为空' } };
    db.prepare('UPDATE drafts SET name = ?, updated_at = ? WHERE id = ?').run(
      name,
      new Date().toISOString(),
      draftId,
    );
    return { status: 200, payload: draftDetail(draftId) };
  }

  if (method === 'POST' && sub === '/publish') return handlePublish(draftId, body);

  if (sub === '/clauses' || sub.startsWith('/clauses/')) {
    return clauseRoutes(method, sub, body, draftId);
  }
  if (sub === '/refs' || sub.startsWith('/refs/')) {
    return refRoutes(method, sub, body, draftId);
  }
  return { status: 404, payload: { error: 'NOT_FOUND', message: '未知的草案资源' } };
}

function clauseRoutes(method, sub, body, draftId) {
  if (method === 'POST' && sub === '/clauses') {
    const key = String(body.key || '').trim();
    const title = String(body.title || '').trim();
    const text = String(body.body ?? '');
    return mutateDraft(draftId, (state) => {
      const kerr = keyError(key);
      if (kerr) return { error: true, payload: { error: 'VALIDATION', message: kerr } };
      if (state.clauses.has(key))
        return { error: true, payload: { error: 'DUP_KEY', message: `条款标识「${key}」已存在` } };
      if (!title) return { error: true, payload: { error: 'VALIDATION', message: '标题不能为空' } };
      if (!text.trim()) return { error: true, payload: { error: 'VALIDATION', message: '正文不能为空' } };
      state.order.push(key);
      state.clauses.set(key, { key, title, body: text });
    });
  }

  // 具体条款资源：/clauses/:key 或 /clauses/:key/move
  const m = sub.match(/^\/clauses\/([^/]+)(\/move)?$/);
  if (sub.startsWith('/clauses/') && !m) return { status: 404, payload: { error: 'NOT_FOUND' } };
  const key = decodeURIComponent(m[1]);

  if (m[2] === '/move' && method === 'POST') {
    return mutateDraft(draftId, (state, movedSet) => {
      if (!state.clauses.has(key)) return { error: true, payload: { error: 'NOT_FOUND', message: '条款不存在' } };
      const oldOrder = [...state.order];
      const idx = state.order.indexOf(key);
      state.order.splice(idx, 1);
      if (typeof body.ordinal === 'number') {
        const target = Math.max(0, Math.min(body.ordinal, state.order.length));
        state.order.splice(target, 0, key);
      } else {
        const after = body.after === undefined ? null : String(body.after);
        if (after === null || after === '') {
          state.order.unshift(key);
        } else {
          const at = state.order.indexOf(after);
          if (at === -1) return { error: true, payload: { error: 'BAD_ANCHOR', message: '锚点条款不存在' } };
          state.order.splice(at + 1, 0, key);
        }
      }
      // 只有顺序真的发生变化才记录显式移动
      if (state.order.some((k, i) => oldOrder[i] !== k)) movedSet.add(key);
    });
  }

  if (method === 'PUT') {
    const title = String(body.title || '').trim();
    const text = String(body.body ?? '');
    return mutateDraft(draftId, (state) => {
      if (!state.clauses.has(key)) return { error: true, payload: { error: 'NOT_FOUND', message: '条款不存在' } };
      if (!title) return { error: true, payload: { error: 'VALIDATION', message: '标题不能为空' } };
      if (!text.trim()) return { error: true, payload: { error: 'VALIDATION', message: '正文不能为空' } };
      state.clauses.set(key, { key, title, body: text });
    });
  }

  if (method === 'DELETE') {
    return mutateDraft(draftId, (state) => {
      if (!state.clauses.has(key)) return { error: true, payload: { error: 'NOT_FOUND', message: '条款不存在' } };
      state.order.splice(state.order.indexOf(key), 1);
      // 删除条款：其出边保留在草案中并成为悬空引用（可暂存、阻止发布、可重新建回同标识条款消除）
      state.clauses.delete(key);
    });
  }

  return { status: 405, payload: { error: 'METHOD_NOT_ALLOWED' } };
}

function refRoutes(method, sub, body, draftId) {
  if (method === 'POST' && sub === '/refs') {
    const source = String(body.source || '').trim();
    const target = String(body.target || '').trim();
    const label = String(body.label || '').trim();
    return mutateDraft(draftId, (state) => {
      const skerr = keyError(source);
      if (skerr) return { error: true, payload: { error: 'VALIDATION', message: `来源标识无效：${skerr}` } };
      const tkerr = keyError(target);
      if (tkerr) return { error: true, payload: { error: 'VALIDATION', message: `目标标识无效：${tkerr}` } };
      const dup = state.edges.some((e) => e.source === source && e.target === target && (e.label || '') === label);
      if (dup) return { error: true, payload: { error: 'DUP_REF', message: '相同引用已存在' } };
      // 允许暂存指向尚不存在条款的引用
      state.edges.push({ source, target, label });
    });
  }
  const m = sub.match(/^\/refs\/(\d+)$/);
  if (m && method === 'DELETE') {
    const refOrdinal = parseInt(m[1], 10);
    return mutateDraft(draftId, (state) => {
      if (refOrdinal < 0 || refOrdinal >= state.edges.length)
        return { error: true, payload: { error: 'NOT_FOUND', message: '引用不存在' } };
      state.edges.splice(refOrdinal, 1);
    });
  }
  return { status: 404, payload: { error: 'NOT_FOUND' } };
}

// ---------------------------------------------------------------------------
// 发布：重放 / 冲突拒绝 / 原子快照；可指定未来 UTC 生效时刻进入待生效队列
// ---------------------------------------------------------------------------
function handlePublish(draftId, body) {
  const meta = getDraftMeta(db, draftId);
  if (!meta) return { status: 404, payload: { error: 'NOT_FOUND', message: '草案不存在' } };
  if (meta.status !== 'open') {
    return { status: 409, payload: { error: 'CLOSED', message: '草案已发布' } };
  }

  const note = String(body.note || '').trim() || `发布草案：${meta.name}`;

  // 生效时刻在事务外解析；发布规则在事务内（BEGIN IMMEDIATE 后的一致视图）判定
  let atMs;
  try {
    atMs = parseEffectiveAt(body.effective_at);
  } catch {
    atMs = NaN;
  }
  if (Number.isNaN(atMs)) {
    return {
      status: 400,
      payload: {
        error: 'BAD_EFFECTIVE_AT',
        message: '生效时刻不是合法时间，请使用 ISO-8601 / UTC 时间（如 2027-01-01T00:00:00Z）',
      },
    };
  }
  const scheduled = atMs !== null;

  const publish = db.transaction(() => {
    const nowMs = Date.now();
    const pending = listPending(db);
    const versions = listVersions(db);
    const latestId = versions[versions.length - 1].id;
    const latestMeta = getVersionMeta(db, latestId);

    // 1) 排程规则：队列非空时必须指定时刻且严格递增；队列为空且未指定 -> 即时生效
    const check = validateSchedulePublish({ pending, nowMs, atMs, queueEmpty: pending.length === 0 });
    if (!check.ok) {
      // QUEUE_NOT_EMPTY / NON_INCREASING_TIME 是与当前排程冲突（409）；
      // PAST_EFFECTIVE_AT / BAD_EFFECTIVE_AT 属于请求参数非法（400）
      const badRequest = check.code === 'PAST_EFFECTIVE_AT' || check.code === 'BAD_EFFECTIVE_AT';
      return {
        status: badRequest ? 400 : 409,
        payload: {
          error: check.code,
          message: check.message,
          schedule_revision: getScheduleRevision(db),
          schedule: schedulePayloadInTx(nowMs, pending),
        },
      };
    }

    const draftState = loadDraftState(db, draftId);
    const draftMoved = new Set(loadDraftMoved(db, draftId));
    const baselineState = loadVersionState(db, meta.baseline_id);
    const latestState = loadVersionState(db, latestId);

    // 2) 草案自身的结构问题（悬空引用等）：拒绝发布，草案原样保留
    const issues = validateState(draftState).filter((i) => i.level === 'error');
    if (issues.length) {
      return { status: 409, payload: { error: 'DRAFT_INVALID', message: '草案存在必须修复的问题，已保留草案', issues } };
    }

    const status = scheduled ? 'scheduled' : 'effective';
    const effectiveAtIso = scheduled ? new Date(atMs).toISOString() : null;

    // 3) 重放到最新版（最新发布版可能本身仍待生效，照样以其为合并目标）
    let mergedState;
    let mergedMoved;
    let replayed = false;
    if (meta.baseline_id === latestId) {
      if (stateEqual(draftState, latestState) && draftMoved.size === 0) {
        return { status: 400, payload: { error: 'NO_CHANGES', message: '草案与最新版完全一致，无需发布' } };
      }
      mergedState = draftState;
      mergedMoved = new Set(latestMeta.moved_keys);
      for (const k of draftMoved) if (draftState.clauses.has(k)) mergedMoved.add(k);
    } else {
      // 最新版相对本草案基线累积移动过的条款（基线之后各版移动记录的并集）
      const latestMovedKeys = new Set();
      for (const v of versions) {
        if (v.id > meta.baseline_id && v.id <= latestId) {
          for (const k of v.moved_keys) latestMovedKeys.add(k);
        }
      }

      const result = replayDraft({
        baseline: baselineState,
        latest: latestState,
        draft: draftState,
        draftMoved,
        latestMovedKeys,
      });
      if (!result.ok) {
        return {
          status: 409,
          payload: {
            error: 'CONFLICT',
            message: '发布被拒绝：与最新发布版存在冲突，草案已保留',
            conflicts: result.conflicts,
            dangling: result.dangling,
          },
        };
      }
      if (stateEqual(result.merged, latestState)) {
        return { status: 400, payload: { error: 'NO_CHANGES', message: '改动已全部包含在最新版中，无需发布' } };
      }
      mergedState = result.merged;
      mergedMoved = result.mergedMoved;
      replayed = true;
    }

    // 4) 原子写入不可变版本：即时版 status=effective；定时版只追加 scheduled 快照
    const newId = insertVersion(db, {
      note,
      baselineId: latestId,
      draftId,
      state: mergedState,
      movedKeys: mergedMoved,
      status,
      effectiveAt: effectiveAtIso,
    });
    db.prepare('UPDATE drafts SET status = ? WHERE id = ?').run('published', draftId);
    if (scheduled) bumpScheduleRevision(db);

    return {
      status: 201,
      payload: {
        version_id: newId,
        replayed,
        ...(replayed ? { baseline_latest_id: latestId } : {}),
        scheduled,
        status,
        effective_at: scheduled ? effectiveAtIso : new Date(nowMs).toISOString(),
        schedule_revision: getScheduleRevision(db),
      },
    };
  });

  db.pragma('foreign_keys = ON');
  // BEGIN IMMEDIATE：与并发发布/改期串行化，保证原子且可重复读
  db.prepare('BEGIN IMMEDIATE').run();
  try {
    const out = publish();
    if (out.status === 201) db.prepare('COMMIT').run();
    else db.prepare('ROLLBACK').run();
    return out;
  } catch (err) {
    try {
      db.prepare('ROLLBACK').run();
    } catch {}
    throw err;
  }
}

// 事务内构造排程快照（不重新查时钟、不嵌套事务），用于拒绝响应返回“当前排程”
function schedulePayloadInTx(nowMs, pending) {
  const versions = listVersions(db);
  const current = pickEffectiveVersion(
    versions.map((v) => ({ ...v, effective_at_ms: v.effective_at ? Date.parse(v.effective_at) : null })),
    nowMs,
  );
  return {
    now: new Date(nowMs).toISOString(),
    schedule_revision: getScheduleRevision(db),
    current_effective_version_id: current ? current.id : null,
    queue: pending.map((p, i) => ({
      position: i + 1,
      id: p.id,
      note: p.note,
      effective_at: p.effective_at,
      effective_at_ms: p.effective_at_ms,
    })),
    canceled: versions
      .filter((v) => v.status === 'canceled')
      .map((v) => ({
        id: v.id,
        note: v.note,
        created_at: v.created_at,
        effective_at: v.effective_at,
        canceled_at: v.canceled_at,
      })),
  };
}

// ---------------------------------------------------------------------------
// 版本查看（还原顺序、正文、引用）
// ---------------------------------------------------------------------------
function versionDetail(versionId, query) {
  const meta = getVersionMeta(db, versionId);
  if (!meta) return null;
  const state = loadVersionState(db, versionId);
  const payload = {
    ...meta,
    clauses: state.order.map((k, i) => ({ ordinal: i, ...state.clauses.get(k) })),
    refs: state.edges.map((e, i) => ({ ordinal: i, ...e })),
  };
  if (query.compare) {
    const otherId = parseInt(query.compare, 10);
    if (getVersionMeta(db, otherId)) {
      const other = loadVersionState(db, otherId);
      // 比较基线之后各版本显式移动记录的并集，仅保留本版存活条款
      const explicitMoved = new Set();
      for (const v of listVersions(db)) {
        if (v.id > otherId && v.id <= versionId) {
          for (const k of v.moved_keys) if (state.clauses.has(k)) explicitMoved.add(k);
        }
      }
      const diff = diffStates(other, state, explicitMoved);
      payload.compare_to = otherId;
      payload.diff = {
        added: diff.added,
        deleted: diff.deleted,
        changed: diff.changed,
        moved: diff.moved,
        refs_added: diff.refsAdded,
        refs_removed: diff.refsRemoved,
      };
      payload.changed_detail = diff.changed.map((c) => {
        const b = other.clauses.get(c.key);
        const d = state.clauses.get(c.key);
        return {
          ...c,
          titleSegments: textDiff(b.title, d.title),
          bodySegments: c.body ? textDiff(b.body, d.body) : null,
        };
      });
    }
  }
  return payload;
}

// ---------------------------------------------------------------------------
// 排程操作：改期 / 取消（乐观锁：读取时拿到的 schedule_revision）
// ---------------------------------------------------------------------------
function revisionFromBody(body) {
  const n = Number(body.schedule_revision);
  return Number.isInteger(n) ? n : null;
}

function handleReschedule(versionId, body) {
  const rev = revisionFromBody(body);
  if (rev === null) {
    return {
      status: 400,
      payload: { error: 'REVISION_REQUIRED', message: '必须携带读取排程时获得的 schedule_revision', schedule: schedulePayload() },
    };
  }
  let atMs = NaN;
  try {
    atMs = parseEffectiveAt(body.effective_at);
  } catch {}
  if (atMs === null) {
    return { status: 400, payload: { error: 'EFFECTIVE_AT_REQUIRED', message: '改期必须指定新的 UTC 生效时刻' } };
  }

  const run = db.transaction(() => {
    const nowMs = Date.now();
    const meta = getVersionMeta(db, versionId);
    if (!meta) return { status: 404, payload: { error: 'NOT_FOUND', message: '版本不存在' } };

    if (getScheduleRevision(db) !== rev) {
      return {
        status: 409,
        payload: {
          error: 'STALE_REVISION',
          message: '排程修订号已过期（排程在此期间被其他操作改动），本次拒绝；请基于下方当前排程重试',
          schedule_revision: getScheduleRevision(db),
          schedule: schedulePayloadInTx(nowMs, listPending(db)),
        },
      };
    }

    if (meta.status === 'effective' || (meta.status === 'scheduled' && Date.parse(meta.effective_at) <= nowMs)) {
      return {
        status: 409,
        payload: {
          error: 'ALREADY_EFFECTIVE',
          message: '该版本已生效，不能改期',
          schedule_revision: getScheduleRevision(db),
          schedule: schedulePayloadInTx(nowMs, listPending(db)),
        },
      };
    }
    if (meta.status === 'canceled') {
      return {
        status: 409,
        payload: {
          error: 'ALREADY_CANCELED',
          message: '该版本已取消，不能改期',
          schedule_revision: getScheduleRevision(db),
          schedule: schedulePayloadInTx(nowMs, listPending(db)),
        },
      };
    }

    const pending = listPending(db);
    const check = validateReschedule({ pending, versionId, atMs, nowMs });
    if (!check.ok) {
      const badRequest = check.code === 'PAST_EFFECTIVE_AT' || check.code === 'BAD_EFFECTIVE_AT';
      return {
        status: badRequest ? 400 : 409,
        payload: {
          error: check.code,
          message: check.message,
          schedule_revision: getScheduleRevision(db),
          schedule: schedulePayloadInTx(nowMs, pending),
        },
      };
    }

    rescheduleVersion(db, versionId, new Date(atMs).toISOString());
    bumpScheduleRevision(db);
    return {
      status: 200,
      payload: {
        version_id: versionId,
        effective_at: new Date(atMs).toISOString(),
        schedule_revision: getScheduleRevision(db),
        schedule: schedulePayloadInTx(Date.now(), listPending(db)),
      },
    };
  });

  db.pragma('foreign_keys = ON');
  db.prepare('BEGIN IMMEDIATE').run();
  try {
    const out = run();
    if (out.status === 200) db.prepare('COMMIT').run();
    else db.prepare('ROLLBACK').run();
    return out;
  } catch (err) {
    try { db.prepare('ROLLBACK').run(); } catch {}
    throw err;
  }
}

function handleCancel(versionId, body) {
  const rev = revisionFromBody(body);
  if (rev === null) {
    return {
      status: 400,
      payload: { error: 'REVISION_REQUIRED', message: '必须携带读取排程时获得的 schedule_revision', schedule: schedulePayload() },
    };
  }

  const run = db.transaction(() => {
    const nowMs = Date.now();
    const meta = getVersionMeta(db, versionId);
    if (!meta) return { status: 404, payload: { error: 'NOT_FOUND', message: '版本不存在' } };

    if (getScheduleRevision(db) !== rev) {
      return {
        status: 409,
        payload: {
          error: 'STALE_REVISION',
          message: '排程修订号已过期（排程在此期间被其他操作改动），本次拒绝；请基于下方当前排程重试',
          schedule_revision: getScheduleRevision(db),
          schedule: schedulePayloadInTx(nowMs, listPending(db)),
        },
      };
    }

    if (meta.status === 'effective' || (meta.status === 'scheduled' && Date.parse(meta.effective_at) <= nowMs)) {
      return {
        status: 409,
        payload: {
          error: 'ALREADY_EFFECTIVE',
          message: '该版本已生效，不能取消',
          schedule_revision: getScheduleRevision(db),
          schedule: schedulePayloadInTx(nowMs, listPending(db)),
        },
      };
    }
    if (meta.status === 'canceled') {
      return {
        status: 409,
        payload: {
          error: 'ALREADY_CANCELED',
          message: '该版本此前已取消',
          schedule_revision: getScheduleRevision(db),
          schedule: schedulePayloadInTx(nowMs, listPending(db)),
        },
      };
    }

    cancelVersion(db, versionId);
    bumpScheduleRevision(db);
    return {
      status: 200,
      payload: {
        version_id: versionId,
        canceled: true,
        schedule_revision: getScheduleRevision(db),
        schedule: schedulePayloadInTx(Date.now(), listPending(db)),
      },
    };
  });

  db.pragma('foreign_keys = ON');
  db.prepare('BEGIN IMMEDIATE').run();
  try {
    const out = run();
    if (out.status === 200) db.prepare('COMMIT').run();
    else db.prepare('ROLLBACK').run();
    return out;
  } catch (err) {
    try { db.prepare('ROLLBACK').run(); } catch {}
    throw err;
  }
}

// ---------------------------------------------------------------------------
// 时点查询：?at= ISO-8601（默认当前时刻）。返回当时生效版本的完整条款、顺序与引用。
// 已发生时点的结果只由“effective_at <= at 且未取消”的版本决定，后续改期/取消
// 只影响未来时间戳，历史时点结果因此保持不变。
// ---------------------------------------------------------------------------
function handleEffective(query) {
  let atMs = Date.now();
  if (query.at) {
    const parsed = Date.parse(query.at);
    if (!Number.isFinite(parsed)) {
      return { status: 400, payload: { error: 'BAD_AT', message: 'at 参数不是合法时间，请使用 ISO-8601 / UTC 时间' } };
    }
    atMs = parsed;
  }
  const versions = listVersions(db);
  const picked = pickEffectiveVersion(
    versions.map((v) => ({ ...v, effective_at_ms: v.effective_at ? Date.parse(v.effective_at) : null })),
    atMs,
  );
  if (!picked) {
    return {
      status: 404,
      payload: {
        error: 'NO_EFFECTIVE_VERSION',
        message: versions.length
          ? '指定时点早于任何版本的生效时刻，当时尚无可生效章程'
          : '章程尚未发布首版',
        at: new Date(atMs).toISOString(),
      },
    };
  }
  const detail = versionDetail(picked.id, {});
  return {
    status: 200,
    payload: {
      at: new Date(atMs).toISOString(),
      as_of_past: atMs <= Date.now(),
      version_id: picked.id,
      version: detail,
    },
  };
}

// ---------------------------------------------------------------------------
// 路由 & 静态文件
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function serveStatic(req, res, urlPath) {
  let rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  rel = rel.split('?')[0];
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not Found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const url = parsed.pathname;
  const query = Object.fromEntries(parsed.searchParams);

  if (!url.startsWith('/api/')) return serveStatic(req, res, url);

  try {
    // 先把到点的待生效版本激活（单进程懒调度）
    tickScheduler();

    const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readJson(req) : {};
    let result;

    if (req.method === 'GET' && url === '/api/overview') result = { status: 200, payload: apiOverview() };
    else if (req.method === 'GET' && url === '/api/schedule') result = { status: 200, payload: schedulePayload() };
    else if (req.method === 'GET' && url === '/api/effective') result = handleEffective(query);
    else if (req.method === 'POST' && url === '/api/initialize') result = handleInitial(body);
    else if (req.method === 'GET' && /^\/api\/versions\/\d+$/.test(url)) {
      const id = parseInt(url.split('/').pop(), 10);
      const detail = versionDetail(id, query);
      result = detail ? { status: 200, payload: detail } : { status: 404, payload: { error: 'NOT_FOUND' } };
    } else if (req.method === 'POST' && /^\/api\/versions\/\d+\/reschedule$/.test(url)) {
      const id = parseInt(url.split('/')[3], 10);
      result = handleReschedule(id, body);
    } else if (req.method === 'POST' && /^\/api\/versions\/\d+\/cancel$/.test(url)) {
      const id = parseInt(url.split('/')[3], 10);
      result = handleCancel(id, body);
    } else if (req.method === 'POST' && url === '/api/drafts') result = handleCreateDraft(body);
    else result = draftRoutes(req.method, url, body, query);

    if (!result) result = { status: 404, payload: { error: 'NOT_FOUND', message: '未知接口' } };
    sendJson(res, result.status, result.payload);
  } catch (err) {
    if (err.message === 'BAD_JSON') return sendJson(res, 400, { error: 'BAD_JSON', message: '请求体不是合法 JSON' });
    if (err.message === 'BODY_TOO_LARGE') return sendJson(res, 413, { error: 'BODY_TOO_LARGE' });
    console.error(err);
    sendJson(res, 500, { error: 'INTERNAL', message: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`社团章程修订应用已启动: http://0.0.0.0:${PORT}`);
  console.log(`数据库: ${DB_PATH}`);
});
