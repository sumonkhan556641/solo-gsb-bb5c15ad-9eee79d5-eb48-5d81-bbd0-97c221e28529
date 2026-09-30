'use strict';
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { buildState } = require('./model');

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  charter_title TEXT NOT NULL DEFAULT '社团章程',
  schedule_revision INTEGER NOT NULL DEFAULT 0  -- 排程修订号：每次定时发布/改期/取消/到期生效 +1
);

-- 已发布版本（快照一经写入不可变）
-- status: scheduled（待生效）| effective（已生效，含即时发布）| canceled（定时版本生效前被取消）
CREATE TABLE IF NOT EXISTS versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  baseline_id INTEGER REFERENCES versions(id),
  draft_id INTEGER,
  moved_keys TEXT NOT NULL DEFAULT '[]',  -- 相对版本基线被显式移动过的条款标识
  status TEXT NOT NULL DEFAULT 'effective',
  effective_at TEXT,                      -- 生效时刻（UTC ISO）；历史库迁移时回填 created_at
  activated_at TEXT,                      -- 定时版本实际转入生效状态的时刻
  canceled_at TEXT                        -- 取消时刻（仅 status=canceled）
);

CREATE TABLE IF NOT EXISTS version_clauses (
  version_id INTEGER NOT NULL REFERENCES versions(id),
  ordinal INTEGER NOT NULL,
  key TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  PRIMARY KEY (version_id, ordinal),
  UNIQUE (version_id, key)
);

CREATE TABLE IF NOT EXISTS version_refs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id INTEGER NOT NULL REFERENCES versions(id),
  ordinal INTEGER NOT NULL,
  source TEXT NOT NULL,
  target TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT ''
);

-- 草案
CREATE TABLE IF NOT EXISTS drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  baseline_id INTEGER NOT NULL REFERENCES versions(id),
  created_from TEXT NOT NULL DEFAULT 'draft', -- initial | draft
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',       -- open | published
  moved_keys TEXT NOT NULL DEFAULT '[]'      -- 草案中被显式移动过的条款标识
);

CREATE TABLE IF NOT EXISTS draft_clauses (
  draft_id INTEGER NOT NULL REFERENCES drafts(id),
  ordinal INTEGER NOT NULL,
  key TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (draft_id, ordinal)
);
CREATE INDEX IF NOT EXISTS idx_draft_clauses_draft ON draft_clauses(draft_id);

CREATE TABLE IF NOT EXISTS draft_refs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  draft_id INTEGER NOT NULL REFERENCES drafts(id),
  ordinal INTEGER NOT NULL,
  source TEXT NOT NULL,
  target TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_draft_refs_draft ON draft_refs(draft_id);
`;

function openDb(dbPath) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

// 轻量迁移：为早期库补齐后加的列
function migrate(db) {
  const addColumnIfMissing = (table, column, ddl) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!cols.some((c) => c.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    }
  };
  addColumnIfMissing('versions', 'moved_keys', "moved_keys TEXT NOT NULL DEFAULT '[]'");
  addColumnIfMissing('drafts', 'moved_keys', "moved_keys TEXT NOT NULL DEFAULT '[]'");
  addColumnIfMissing('versions', 'status', "status TEXT NOT NULL DEFAULT 'effective'");
  addColumnIfMissing('versions', 'effective_at', 'effective_at TEXT');
  addColumnIfMissing('versions', 'activated_at', 'activated_at TEXT');
  addColumnIfMissing('versions', 'canceled_at', 'canceled_at TEXT');
  addColumnIfMissing('meta', 'schedule_revision', 'schedule_revision INTEGER NOT NULL DEFAULT 0');
  // 早期库中的版本均为即时生效：用发布时间补齐生效时刻（历史时点查询语义不变）
  db.exec("UPDATE versions SET effective_at = created_at WHERE effective_at IS NULL");
}

function nowIso() {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// 读取
// ---------------------------------------------------------------------------
function loadVersionState(db, versionId) {
  const clauses = db
    .prepare('SELECT key, title, body FROM version_clauses WHERE version_id = ? ORDER BY ordinal')
    .all(versionId);
  const refs = db
    .prepare('SELECT source, target, label FROM version_refs WHERE version_id = ? ORDER BY ordinal')
    .all(versionId);
  return buildState({
    order: clauses.map((c) => c.key),
    clauses,
    edges: refs,
  });
}

function loadDraftState(db, draftId) {
  const rows = db
    .prepare('SELECT key, title, body, deleted FROM draft_clauses WHERE draft_id = ? ORDER BY ordinal')
    .all(draftId);
  const live = rows.filter((r) => !r.deleted);
  const refs = db
    .prepare('SELECT source, target, label FROM draft_refs WHERE draft_id = ? AND deleted = 0 ORDER BY ordinal')
    .all(draftId);
  return buildState({
    order: live.map((r) => r.key),
    clauses: live.map((r) => ({ key: r.key, title: r.title, body: r.body })),
    edges: refs,
  });
}

function getVersionMeta(db, versionId) {
  const row = db
    .prepare(
      `SELECT id, created_at, note, baseline_id, draft_id, moved_keys,
              status, effective_at, activated_at, canceled_at
       FROM versions WHERE id = ?`,
    )
    .get(versionId);
  if (row) row.moved_keys = JSON.parse(row.moved_keys || '[]');
  return row;
}

function listVersions(db) {
  return db
    .prepare(
      `SELECT id, created_at, note, baseline_id, draft_id, moved_keys,
              status, effective_at, activated_at, canceled_at
       FROM versions ORDER BY id`,
    )
    .all()
    .map((row) => ({ ...row, moved_keys: JSON.parse(row.moved_keys || '[]') }));
}

// 待生效队列：status=scheduled，按发布顺序（id 升序，与生效时刻递增顺序一致）
function listPending(db) {
  return db
    .prepare('SELECT id, note, effective_at FROM versions WHERE status = ? ORDER BY id')
    .all('scheduled')
    .map((r) => ({ ...r, effective_at_ms: Date.parse(r.effective_at) }));
}

function getScheduleRevision(db) {
  const row = db.prepare('SELECT schedule_revision FROM meta WHERE id = 1').get();
  return row ? row.schedule_revision : 0;
}

// 排程修订号 +1（调用方负责事务）
function bumpScheduleRevision(db) {
  db.prepare(
    `INSERT INTO meta (id, charter_title, schedule_revision) VALUES (1, '社团章程', 1)
     ON CONFLICT(id) DO UPDATE SET schedule_revision = schedule_revision + 1`,
  ).run();
}

// 到期生效：把 effective_at <= nowIso 的待生效版本批量翻转为 effective。
// 返回被激活的版本 id 列表（调用方在发生翻转时 bumpScheduleRevision）。
function activateDueVersions(db, now = nowIso()) {
  const due = db
    .prepare("SELECT id FROM versions WHERE status = 'scheduled' AND effective_at <= ? ORDER BY id")
    .all(now);
  if (due.length) {
    const mark = db.prepare('UPDATE versions SET status = ?, activated_at = ? WHERE id = ?');
    for (const v of due) mark.run('effective', now, v.id);
  }
  return due.map((v) => v.id);
}

function rescheduleVersion(db, versionId, effectiveAtIso) {
  db.prepare('UPDATE versions SET effective_at = ? WHERE id = ? AND status = ?').run(
    effectiveAtIso,
    versionId,
    'scheduled',
  );
}

function cancelVersion(db, versionId, now = nowIso()) {
  db.prepare('UPDATE versions SET status = ?, canceled_at = ? WHERE id = ? AND status = ?').run(
    'canceled',
    now,
    versionId,
    'scheduled',
  );
}

function listDrafts(db) {
  return db
    .prepare(
      `SELECT d.id, d.name, d.baseline_id, d.created_at, d.updated_at, d.status,
              (SELECT COUNT(*) FROM draft_clauses WHERE draft_id = d.id AND deleted = 0) AS clause_count
       FROM drafts d ORDER BY d.id`,
    )
    .all();
}

function getDraftMeta(db, draftId) {
  const row = db
    .prepare('SELECT id, name, baseline_id, created_at, updated_at, status, moved_keys FROM drafts WHERE id = ?')
    .get(draftId);
  if (row) row.moved_keys = JSON.parse(row.moved_keys || '[]');
  return row;
}

function loadDraftMoved(db, draftId) {
  const row = db.prepare('SELECT moved_keys FROM drafts WHERE id = ?').get(draftId);
  return new Set(row ? JSON.parse(row.moved_keys || '[]') : []);
}

function saveDraftMoved(db, draftId, movedSet) {
  db.prepare('UPDATE drafts SET moved_keys = ?, updated_at = ? WHERE id = ?').run(
    JSON.stringify([...movedSet]),
    nowIso(),
    draftId,
  );
}

// ---------------------------------------------------------------------------
// 写入（调用方负责事务）
// ---------------------------------------------------------------------------
function insertVersion(db, { note, baselineId, draftId, state, movedKeys = [], status = 'effective', effectiveAt = null }) {
  const createdAt = nowIso();
  // 即时发布：发布时刻即生效时刻；定时发布：由调用方给出 UTC 生效时刻
  const effectiveAtIso = status === 'scheduled' ? effectiveAt : createdAt;
  const info = db
    .prepare(
      `INSERT INTO versions
         (created_at, note, baseline_id, draft_id, moved_keys, status, effective_at)
       VALUES (?,?,?,?,?,?,?)`,
    )
    .run(createdAt, note || '', baselineId ?? null, draftId ?? null, JSON.stringify([...movedKeys]), status, effectiveAtIso);
  const versionId = info.lastInsertRowid;
  const insC = db.prepare(
    'INSERT INTO version_clauses (version_id, ordinal, key, title, body) VALUES (?,?,?,?,?)',
  );
  const insR = db.prepare(
    'INSERT INTO version_refs (version_id, ordinal, source, target, label) VALUES (?,?,?,?,?)',
  );
  state.order.forEach((key, i) => {
    const c = state.clauses.get(key);
    insC.run(versionId, i, key, c.title, c.body);
  });
  state.edges.forEach((e, i) => {
    insR.run(versionId, i, e.source, e.target, e.label || '');
  });
  return versionId;
}

function snapshotDraft(db, draftIdUnused, baselineId, name, state, { from, movedKeys = [] } = {}) {
  const ts = nowIso();
  const info = db
    .prepare(
      'INSERT INTO drafts (name, baseline_id, created_from, created_at, updated_at, moved_keys) VALUES (?,?,?,?,?,?)',
    )
    .run(name, baselineId, from || 'draft', ts, ts, JSON.stringify([...movedKeys]));
  const id = info.lastInsertRowid;
  replaceDraftContent(db, id, state);
  return id;
}

function replaceDraftContent(db, draftId, state) {
  db.prepare('DELETE FROM draft_clauses WHERE draft_id = ?').run(draftId);
  db.prepare('DELETE FROM draft_refs WHERE draft_id = ?').run(draftId);
  const insC = db.prepare(
    'INSERT INTO draft_clauses (draft_id, ordinal, key, title, body, deleted) VALUES (?,?,?,?,?,0)',
  );
  const insR = db.prepare(
    'INSERT INTO draft_refs (draft_id, ordinal, source, target, label, deleted) VALUES (?,?,?,?,?,0)',
  );
  state.order.forEach((key, i) => {
    const c = state.clauses.get(key);
    insC.run(draftId, i, key, c.title, c.body);
  });
  state.edges.forEach((e, i) => {
    insR.run(draftId, i, e.source, e.target, e.label || '');
  });
  db.prepare('UPDATE drafts SET updated_at = ? WHERE id = ?').run(nowIso(), draftId);
}

module.exports = {
  openDb,
  nowIso,
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
};
