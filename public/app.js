'use strict';
/* 社团章程修订平台 —— 原生 JS 单页前端 */

const state = {
  view: 'drafts',
  overview: null,
  draftId: null,
  draft: null,
  versionId: null,
  version: null,
  versionContext: null, // 时点查询时记录 {at}
  schedule: null,
  pollTimer: null,
};

const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
};

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || data.error || `HTTP ${res.status}`);
    err.payload = data;
    err.status = res.status;
    throw err;
  }
  return data;
}

function toast(message, kind = '') {
  const t = $('#toast');
  t.textContent = message;
  t.className = `toast ${kind}`;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => t.classList.add('hidden'), 3600);
}

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// UTC 完整时刻（排程一律按 UTC 展示与提交）
function fmtUtc(iso) {
  if (!iso) return '—';
  return iso.replace(/\.\d{3}Z$/, 'Z');
}
function fmtUtcLocal(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}
function utcOffset(ms) {
  return new Date(Date.now() + ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
function versionStatus(v) {
  return v.status || 'effective';
}
function statusBadge(status) {
  if (status === 'scheduled') return el('span', { class: 'badge scheduled' }, '待生效');
  if (status === 'canceled') return el('span', { class: 'badge canceled' }, '已取消');
  return el('span', { class: 'badge effective' }, '生效中');
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function modal({ title, body, footer, wide }) {
  closeModal();
  const root = $('#modalRoot');
  const backdrop = el('div', { class: 'modal-backdrop', onclick: (e) => { if (e.target === backdrop) closeModal(); } });
  const m = el('div', { class: 'modal', style: wide ? 'max-width:860px' : '' },
    el('div', { class: 'modal-hd' },
      el('h3', {}, title),
      el('button', { class: 'close-x', onclick: closeModal, html: '&times;' }),
    ),
    el('div', { class: 'modal-bd' }, body),
    footer ? el('div', { class: 'modal-ft' }, footer) : null,
  );
  backdrop.appendChild(m);
  root.appendChild(backdrop);
  return m;
}
function closeModal() {
  $('#modalRoot').innerHTML = '';
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------
async function refresh() {
  state.overview = await api('GET', '/api/overview');
  $('#charterTitle').textContent = state.overview.charter_title;
  if (state.view === 'schedule' && !state.versionId) {
    state.schedule = await api('GET', '/api/schedule');
  }
  await render();
}

async function render() {
  if (!state.overview) return;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === state.view));
  const main = $('#main');
  main.innerHTML = '';
  if (!state.overview.initialized) {
    stopPolling();
    main.appendChild(renderInit());
    return;
  }
  if (state.view === 'drafts') {
    stopPolling();
    main.appendChild(state.draftId ? renderDraft() : renderDraftList());
  } else if (state.view === 'schedule') {
    startPolling();
    main.appendChild(renderSchedule());
  } else {
    stopPolling();
    main.appendChild(state.versionId ? renderVersion() : renderHistory());
  }
}

function stopPolling() {
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}
function startPolling() {
  stopPolling();
  // 排程页定时刷新：到点版本会自动转入生效，页面无需手动刷新
  state.pollTimer = setInterval(async () => {
    try {
      state.overview = await api('GET', '/api/overview');
      state.schedule = await api('GET', '/api/schedule');
      if (state.view === 'schedule' && !state.versionId) await render();
    } catch {}
  }, 5000);
}

document.querySelectorAll('.tab').forEach((t) =>
  t.addEventListener('click', async () => {
    state.view = t.dataset.view;
    state.draftId = null;
    state.versionId = null;
    state.versionContext = null;
    await render();
  }),
);

// ---------------------------------------------------------------------------
// 首版录入
// ---------------------------------------------------------------------------
function renderInit() {
  const panel = el('div', { class: 'panel' });
  panel.appendChild(el('div', { class: 'panel-hd' }, el('h2', {}, '录入首版章程')));
  const bd = el('div', { class: 'panel-bd' });
  panel.appendChild(bd);

  const titleInput = el('input', { type: 'text', value: 'XX社团章程', placeholder: '章程名称' });
  bd.appendChild(el('label', { class: 'fld' }, el('span', {}, '章程名称'), titleInput));

  const clauseBox = el('div', {});
  const refBox = el('div', {});
  const rows = [];

  function addClauseRow(c = {}) {
    const key = el('input', { type: 'text', value: c.key || '', placeholder: '稳定标识，如 A / art-1', style: 'width:170px' });
    const ttl = el('input', { type: 'text', value: c.title || '', placeholder: '条款标题' });
    const body = el('textarea', {}, c.body || '');
    const row = el('div', { class: 'clause' },
      el('div', { class: 'clause-hd' },
        el('span', { class: 'muted small' }, '条款顺序即下方排列顺序，可随时调整'),
        el('div', { style: 'flex:1' }),
        el('button', {
          class: 'btn danger small', onclick: () => { row.remove(); rows.splice(rows.indexOf(row), 1); },
        }, '删除'),
      ),
      el('div', { class: 'panel-bd' },
        el('div', { class: 'grid2' },
          el('label', { class: 'fld' }, el('span', {}, '稳定标识 *'), key),
          el('label', { class: 'fld' }, el('span', {}, '标题 *'), ttl),
        ),
        el('label', { class: 'fld' }, el('span', {}, '正文 *'), body),
      ),
    );
    row._fields = { key, ttl, body };
    rows.push(row);
    clauseBox.appendChild(row);
  }

  const refRows = [];
  function addRefRow(r = {}) {
    const src = el('input', { type: 'text', value: r.source || '', placeholder: '来源标识', style: 'width:150px' });
    const tgt = el('input', { type: 'text', value: r.target || '', placeholder: '目标标识', style: 'width:150px' });
    const lbl = el('input', { type: 'text', value: r.label || '', placeholder: '关系（可选），如 参见' });
    const row = el('div', { style: 'display:flex;gap:8px;align-items:center;margin-bottom:8px' },
      src, el('span', { class: 'muted' }, '→'), tgt, lbl,
      el('button', { class: 'btn ghost small', onclick: () => { row.remove(); refRows.splice(refRows.indexOf(row), 1); } }, '移除'),
    );
    row._fields = { src, tgt, lbl };
    refRows.push(row);
    refBox.appendChild(row);
  }

  bd.append(
    el('p', { class: 'muted small' }, '先逐条录入条款（标识一旦发布将保持稳定，草案的编辑/移动/删除均以标识跟踪），再登记条款之间的引用。'),
    clauseBox,
    el('button', { class: 'btn secondary', onclick: () => addClauseRow() }, '+ 添加条款'),
    el('h3', { style: 'margin:18px 0 8px;font-size:14px' }, '条款间引用'),
    refBox,
    el('button', { class: 'btn secondary', onclick: () => addRefRow() }, '+ 添加引用'),
  );

  // 示例数据
  addClauseRow({ key: 'A', title: '总则', body: '本社团名称为登山社，宗旨为组织安全、健康的登山与户外活动。' });
  addClauseRow({ key: 'B', title: '会员', body: '凡承认本章程、履行登记手续者，得为本社会员。会员义务参见 A，退出办法见 C。' });
  addClauseRow({ key: 'C', title: '退出', body: '会员可随时书面申请退出；严重违反章程者由理事会依 D 处理。' });
  addClauseRow({ key: 'D', title: '纪律', body: '理事会对违纪行为进行审议，相关程序参照 B 的会员义务条款。' });
  addRefRow({ source: 'B', target: 'A', label: '参见' });
  addRefRow({ source: 'B', target: 'C', label: '退出办法' });
  addRefRow({ source: 'C', target: 'D', label: '处理依据' });
  addRefRow({ source: 'D', target: 'B', label: '程序参照' });

  const errBox = el('div', { style: 'margin-top:12px' });
  bd.appendChild(errBox);
  bd.appendChild(el('div', { style: 'margin-top:14px;display:flex;gap:10px' },
    el('button', {
      class: 'btn',
      onclick: async () => {
        errBox.innerHTML = '';
        const payload = {
          charter_title: titleInput.value.trim(),
          clauses: rows.map((r) => ({
            key: r._fields.key.value.trim(),
            title: r._fields.ttl.value.trim(),
            body: r._fields.body.value,
          })),
          refs: refRows.map((r) => ({
            source: r._fields.src.value.trim(),
            target: r._fields.tgt.value.trim(),
            label: r._fields.lbl.value.trim(),
          })),
          note: '首版发布',
        };
        try {
          await api('POST', '/api/initialize', payload);
          toast('首版章程已发布（不可变版本 v1）', 'ok');
          await refresh();
        } catch (e) {
          errBox.appendChild(renderIssueList(e.payload.issues || [{ message: e.message }]));
        }
      },
    }, '发布首版（生成不可变 v1）'),
  ));

  return panel;
}

function renderIssueList(issues) {
  const box = el('div', {});
  for (const i of issues) {
    box.appendChild(el('div', { class: `issue ${i.level === 'warning' ? 'warning' : 'error'}` },
      el('span', {}, i.level === 'warning' ? '⚠️' : '⛔'),
      el('span', {}, i.message || JSON.stringify(i)),
    ));
  }
  return box;
}

// ---------------------------------------------------------------------------
// 草案列表
// ---------------------------------------------------------------------------
function renderDraftList() {
  const wrap = el('div', {});
  const ov = state.overview;

  const stats = el('div', { class: 'stat-row' },
    stat(`v${ov.current_effective_version_id ?? '-'}`, '当前生效版本'),
    stat(ov.pending?.length || 0, '待生效版本'),
    stat(ov.drafts.filter((d) => d.status === 'open').length, '进行中草案'),
    stat(ov.latest_version_id ? `v${ov.latest_version_id}` : '-', '最新发布版'),
  );
  wrap.appendChild(stats);

  if (ov.pending?.length) {
    wrap.appendChild(el('div', { class: 'panel schedule-banner' },
      el('div', { class: 'panel-bd' },
        el('div', { style: 'display:flex;align-items:center;gap:10px;flex-wrap:wrap' },
          el('span', { class: 'badge scheduled' }, '定时生效排程中'),
          el('span', {},
            `当前生效 v${ov.current_effective_version_id}；${ov.pending.length} 个版本排队待生效，下一个 v${ov.pending[0].id} 于 ${fmtUtcLocal(ov.pending[0].effective_at)} 生效。`),
          el('div', { style: 'flex:1' }),
          el('button', {
            class: 'btn secondary small',
            onclick: async () => { state.view = 'schedule'; await render(); },
          }, '查看 / 操作排程'),
        ),
      ),
    ));
  }

  const panel = el('div', { class: 'panel' });
  const baselineSel = el('select', {},
    ...ov.versions.map((v) => el('option', { value: v.id }, `v${v.id} · ${v.note}（${fmtTime(v.created_at)}）`)),
  );
  baselineSel.value = String(ov.latest_version_id);
  const nameInput = el('input', { type: 'text', placeholder: '草案名称（可选）', style: 'width:240px' });
  panel.appendChild(el('div', { class: 'panel-hd' },
    el('h2', {}, '从已发布版本创建草案'),
  ));
  panel.appendChild(el('div', { class: 'panel-bd' },
    el('div', { style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap' },
      el('span', {}, '基线版本'), baselineSel, nameInput,
      el('button', {
        class: 'btn',
        onclick: async () => {
          try {
            const d = await api('POST', '/api/drafts', {
              baseline_id: parseInt(baselineSel.value, 10),
              name: nameInput.value.trim(),
            });
            state.draftId = d.id;
            state.view = 'drafts';
            await refresh();
          } catch (e) { toast(e.message, 'err'); }
        },
      }, '创建草案'),
    ),
  ));
  wrap.appendChild(panel);

  const listPanel = el('div', { class: 'panel' },
    el('div', { class: 'panel-hd' }, el('h2', {}, '全部草案')),
  );
  const bd = el('div', { class: 'panel-bd' });
  listPanel.appendChild(bd);
  if (!ov.drafts.length) {
    bd.appendChild(el('div', { class: 'empty' }, el('div', { class: 'big' }, '📝'), '还没有草案'));
  } else {
    for (const d of ov.drafts) {
      const baseline = ov.versions.find((v) => v.id === d.baseline_id);
      const stale = d.status === 'open' && d.baseline_id !== ov.latest_version_id;
      bd.appendChild(el('div', { class: 'draft-card' },
        el('div', {},
          el('div', { style: 'display:flex;gap:8px;align-items:center' },
            el('strong', {}, d.name),
            el('span', { class: `badge ${d.status}` }, d.status === 'open' ? '进行中' : '已发布'),
            stale ? el('span', { class: 'badge warn', title: '发布时将先把改动重放到最新版' }, '基线落后于最新版') : null,
          ),
          el('div', { class: 'meta' },
            `基线 v${d.baseline_id} · ${baseline ? baseline.note : ''} · ${d.clause_count} 条 · 更新于 ${fmtTime(d.updated_at)}`),
        ),
        el('div', { style: 'display:flex;gap:8px' },
          d.status === 'open'
            ? el('button', { class: 'btn', onclick: async () => { state.draftId = d.id; await refresh(); } }, '打开编辑')
            : null,
        ),
      ));
    }
  }
  wrap.appendChild(listPanel);
  return wrap;
}

function stat(num, lbl) {
  return el('div', { class: 'stat' }, el('div', { class: 'num' }, String(num)), el('div', { class: 'lbl' }, lbl));
}

// ---------------------------------------------------------------------------
// 草案编辑
// ---------------------------------------------------------------------------
async function openDraft(id) {
  state.draft = await api('GET', `/api/drafts/${id}?diff=1`);
}

function renderDraft() {
  const wrap = el('div', {});
  if (!state.draft || state.draft.id !== state.draftId) {
    openDraft(state.draftId).then(render).catch((e) => toast(e.message, 'err'));
    return wrap;
  }
  const d = state.draft;
  const ov = state.overview;
  const stale = d.baseline_id !== ov.latest_version_id;

  wrap.appendChild(el('div', { class: 'breadcrumb' },
    el('a', { onclick: async () => { state.draftId = null; await refresh(); } }, '草案列表'),
    ` / ${esc(d.name)}`,
  ));

  // 概要
  const panel = el('div', { class: 'panel' });
  const nameInput = el('input', { type: 'text', value: d.name, style: 'width:260px' });
  panel.appendChild(el('div', { class: 'panel-hd' },
    el('div', { style: 'display:flex;align-items:center;gap:10px;flex-wrap:wrap' },
      el('h2', {}, d.name),
      el('span', { class: `badge ${d.status}` }, d.status === 'open' ? '进行中' : '已发布'),
      stale ? el('span', { class: 'badge warn' }, `基线 v${d.baseline_id}，最新发布版 v${ov.latest_version_id}：发布时自动重放`) : null,
    ),
    el('div', { style: 'display:flex;gap:8px' },
      el('button', {
        class: 'btn secondary small',
        onclick: async () => {
          try { await api('PATCH', `/api/drafts/${d.id}`, { name: nameInput.value }); await refresh(); }
          catch (e) { toast(e.message, 'err'); }
        },
      }, '保存名称'),
      el('button', {
        class: d.publishable && d.status === 'open' ? 'btn' : 'btn',
        disabled: !d.publishable || d.status !== 'open',
        onclick: () => openPublish(d.id),
        style: !d.publishable || d.status !== 'open' ? '' : '',
      }, d.status === 'published' ? '已发布' : '发布为新版本'),
    ),
  ));
  panel.appendChild(el('div', { class: 'panel-bd' },
    el('div', { style: 'display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:6px' },
      el('span', {}, '名称'), nameInput,
      el('span', { class: 'muted small' },
        `基线 v${d.baseline_id} · ${d.clauses?.length ?? 0} 条 · 更新 ${fmtTime(d.updated_at)}`),
    ),
    renderDiffSummary(d),
  ));
  wrap.appendChild(panel);

  // 问题
  if (d.issues.length) {
    const ip = el('div', { class: 'panel' },
      el('div', { class: 'panel-hd' },
        el('h2', {}, '草案问题'),
        d.publishable ? el('span', { class: 'badge ok' }, '可以发布') : el('span', { class: 'badge err' }, '不可发布'),
      ),
      el('div', { class: 'panel-bd' }, renderIssueList(d.issues)),
    );
    wrap.appendChild(ip);
  }

  const wrapGrid = el('div', { class: 'grid2' });

  // 条款
  const cp = el('div', { class: 'panel' });
  cp.appendChild(el('div', { class: 'panel-hd' },
    el('h2', {}, `条款（${d.clauses.length}）`),
    d.status === 'open' ? el('button', { class: 'btn secondary small', onclick: () => openAddClause(d.id) }, '+ 新增条款') : null,
  ));
  const cbd = el('div', { class: 'panel-bd' });
  cp.appendChild(cbd);
  d.clauses.forEach((c, i) => cbd.appendChild(renderDraftClause(d, c, i)));
  wrapGrid.appendChild(cp);

  // 引用
  const rp = el('div', { class: 'panel' });
  rp.appendChild(el('div', { class: 'panel-hd' },
    el('h2', {}, `条款间引用（${d.refs.length}）`),
    d.status === 'open' ? el('button', { class: 'btn secondary small', onclick: () => openAddRef(d.id) }, '+ 新增引用') : null,
  ));
  const rbd = el('div', { class: 'panel-bd' });
  rp.appendChild(rbd);
  rbd.appendChild(el('p', { class: 'muted small' },
    '引用可指向暂不存在的条款（悬空引用），系统会明确标记并阻止发布；删除条款后其相关引用也会在此列出。'));
  if (!d.refs.length) rbd.appendChild(el('div', { class: 'empty small' }, '暂无引用'));
  const clauseKeys = new Set(d.clauses.map((c) => c.key));
  for (const r of d.refs) {
    const dangling = !clauseKeys.has(r.source) || !clauseKeys.has(r.target);
    rbd.appendChild(el('div', { style: 'display:flex;align-items:center;gap:8px;margin-bottom:7px' },
      el('span', { class: `ref-tag ${dangling ? 'dangling' : ''}` },
        el('span', { class: 'key-chip' }, r.source),
        '→',
        el('span', { class: 'key-chip' }, r.target),
        r.label ? el('span', {}, `（${r.label}）`) : null,
        dangling ? el('span', { class: 'badge err' }, '悬空') : null,
      ),
      d.status === 'open'
        ? el('button', {
            class: 'icon-btn', title: '删除引用',
            onclick: async () => {
              try { await api('DELETE', `/api/drafts/${d.id}/refs/${r.ordinal}`); await refresh(); toast('引用已删除', 'ok'); }
              catch (e) { toast(e.message, 'err'); }
            },
          }, '✕')
        : null,
    ));
  }
  wrapGrid.appendChild(rp);
  wrap.appendChild(wrapGrid);
  return wrap;
}

function renderDiffSummary(d) {
  const diff = d.diff || {};
  const chips = [];
  if (diff.added?.length) chips.push(el('span', { class: 'badge ok' }, `新增 ${diff.added.length} 条：${diff.added.join('、')}`));
  if (diff.deleted?.length) chips.push(el('span', { class: 'badge err' }, `删除 ${diff.deleted.length} 条：${diff.deleted.join('、')}`));
  if (diff.changed?.length) chips.push(el('span', { class: 'badge warn' }, `修改 ${diff.changed.length} 条：${diff.changed.map((c) => c.key).join('、')}`));
  if ((diff.refs_added_count || 0) + (diff.refs_removed_count || 0)) {
    chips.push(el('span', { class: 'badge neutral' }, `引用 +${diff.refs_added_count} / −${diff.refs_removed_count}`));
  }
  if (!chips.length) chips.push(el('span', { class: 'muted small' }, '与基线无差异'));
  const box = el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-top:10px' }, chips);

  // 详情查看按钮
  const detailBtn = el('button', {
    class: 'btn ghost small', style: 'margin-top:8px',
    onclick: () => openDiffDetail(d),
  }, '查看相对基线 v' + d.baseline_id + ' 的正文差异');
  return el('div', {}, box, detailBtn);
}

function renderDraftClause(d, c, i) {
  const change = (d.diff?.changed || []).find((x) => x.key === c.key);
  const isAdded = (d.diff?.added || []).includes(c.key);
  const glow = isAdded ? 'added-glow' : change ? 'changed-glow' : '';

  const outgoing = d.refs.filter((r) => r.source === c.key);
  const clauseKeys = new Set(d.clauses.map((x) => x.key));

  const head = el('div', { class: 'clause-hd' },
    el('span', { class: 'ord' }, `#${i + 1}`),
    el('span', { class: 'key-chip' }, c.key),
    el('span', { class: 'title' }, c.title),
    isAdded ? el('span', { class: 'badge ok' }, '新增') : null,
    change?.body ? el('span', { class: 'badge warn' }, '正文修改') : null,
    change?.position ? el('span', { class: 'badge warn' }, '已移动') : null,
    change?.edges ? el('span', { class: 'badge neutral' }, '引用变化') : null,
  );
  if (d.status === 'open') {
    head.appendChild(el('div', { style: 'flex:1' }));
    head.appendChild(el('div', { class: 'move-controls' },
      el('button', { class: 'icon-btn', title: '上移', onclick: () => moveClause(d.id, c.key, i - 1) }, '↑'),
      el('button', { class: 'icon-btn', title: '下移', onclick: () => moveClause(d.id, c.key, i + 1) }, '↓'),
    ));
    head.appendChild(el('button', { class: 'btn secondary small', onclick: () => openEditClause(d.id, c) }, '编辑'));
    head.appendChild(el('button', { class: 'btn danger small', onclick: () => deleteClause(d.id, c) }, '删除'));
  }

  const bd = el('div', { class: 'clause-bd' },
    el('div', { class: 'clause-body' }, c.body),
    outgoing.length ? el('div', { class: 'refs-line' }, '引用：',
      ...outgoing.map((r) => el('span', { class: `ref-tag ${clauseKeys.has(r.target) ? '' : 'dangling'}` },
        '→ ', el('span', { class: 'key-chip' }, r.target), r.label ? `（${r.label}）` : '',
        !clauseKeys.has(r.target) ? el('span', { class: 'badge err' }, '目标悬空') : null,
      )),
    ) : null,
  );
  return el('div', { class: `clause ${glow}` }, head, bd);
}

async function moveClause(draftId, key, newOrdinal) {
  try {
    await api('POST', `/api/drafts/${draftId}/clauses/${encodeURIComponent(key)}/move`, { ordinal: newOrdinal });
    await refresh();
  } catch (e) { toast(e.message, 'err'); }
}

async function deleteClause(draftId, c) {
  if (!confirm(`删除条款「${c.key} ${c.title}」？\n其相关引用会保留为悬空引用（草案仍可暂存，但不能发布，直到删除悬空引用或重建同标识条款）。`)) return;
  try {
    await api('DELETE', `/api/drafts/${draftId}/clauses/${encodeURIComponent(c.key)}`);
    await refresh();
    toast('条款已删除；引用暂存为悬空状态', 'ok');
  } catch (e) { toast(e.message, 'err'); }
}

// ---------------------------------------------------------------------------
// 弹窗：新增/编辑条款、新增引用、差异详情、发布
// ---------------------------------------------------------------------------
function openAddClause(draftId) {
  const key = el('input', { type: 'text', placeholder: '如 E / art-5' });
  const ttl = el('input', { type: 'text', placeholder: '条款标题' });
  const body = el('textarea', { placeholder: '条款正文' });
  const err = el('div', {});
  modal({
    title: '新增条款（新稳定标识）',
    body: el('div', {},
      el('p', { class: 'muted small' }, '标识在后续所有版本中保持稳定；条款会追加到末尾，可用 ↑/↓ 调整位置。'),
      el('label', { class: 'fld' }, el('span', {}, '稳定标识 *'), key),
      el('label', { class: 'fld' }, el('span', {}, '标题 *'), ttl),
      el('label', { class: 'fld' }, el('span', {}, '正文 *'), body),
      err,
    ),
    footer: [
      el('button', { class: 'btn ghost', onclick: closeModal }, '取消'),
      el('button', {
        class: 'btn', onclick: async () => {
          err.innerHTML = '';
          try {
            await api('POST', `/api/drafts/${draftId}/clauses`, {
              key: key.value, title: ttl.value, body: body.value,
            });
            closeModal(); await refresh(); toast('条款已新增', 'ok');
          } catch (e) { err.appendChild(renderIssueList([{ message: e.message }])); }
        },
      }, '添加'),
    ],
  });
}

function openEditClause(draftId, c) {
  const ttl = el('input', { type: 'text', value: c.title });
  const body = el('textarea', {}, c.body);
  const err = el('div', {});
  modal({
    title: `编辑条款 ${c.key}（标识不可修改）`,
    body: el('div', {},
      el('label', { class: 'fld' }, el('span', {}, '标题 *'), ttl),
      el('label', { class: 'fld' }, el('span', {}, '正文 *'), body),
      err,
    ),
    footer: [
      el('button', { class: 'btn ghost', onclick: closeModal }, '取消'),
      el('button', {
        class: 'btn', onclick: async () => {
          try {
            await api('PUT', `/api/drafts/${draftId}/clauses/${encodeURIComponent(c.key)}`, {
              title: ttl.value, body: body.value,
            });
            closeModal(); await refresh(); toast('条款已保存', 'ok');
          } catch (e) { err.innerHTML = ''; err.appendChild(renderIssueList([{ message: e.message }])); }
        },
      }, '保存'),
    ],
  });
}

function openAddRef(draftId) {
  const src = el('input', { type: 'text', placeholder: '来源条款标识', list: 'keyOpts' });
  const tgt = el('input', { type: 'text', placeholder: '目标条款标识', list: 'keyOpts' });
  const lbl = el('input', { type: 'text', placeholder: '关系标签（可选），如 参见 / 依据' });
  const err = el('div', {});
  const opts = el('datalist', { id: 'keyOpts' }, ...state.draft.clauses.map((c) => el('option', { value: c.key })));
  modal({
    title: '新增条款引用',
    body: el('div', {},
      el('p', { class: 'muted small' }, '允许引用暂不存在的条款：会被标记为悬空引用并阻止发布，直到对应条款被建立。'),
      opts,
      el('div', { class: 'grid2' },
        el('label', { class: 'fld' }, el('span', {}, '来源标识 *'), src),
        el('label', { class: 'fld' }, el('span', {}, '目标标识 *'), tgt),
      ),
      el('label', { class: 'fld' }, el('span', {}, '关系标签'), lbl),
      err,
    ),
    footer: [
      el('button', { class: 'btn ghost', onclick: closeModal }, '取消'),
      el('button', {
        class: 'btn', onclick: async () => {
          try {
            await api('POST', `/api/drafts/${draftId}/refs`, { source: src.value, target: tgt.value, label: lbl.value });
            closeModal(); await refresh(); toast('引用已暂存', 'ok');
          } catch (e) { err.innerHTML = ''; err.appendChild(renderIssueList([{ message: e.message }])); }
        },
      }, '添加引用'),
    ],
  });
}

function segmentsHtml(segs) {
  if (!segs) return null;
  return segs.map((s) => {
    if (s.op === 'equal') return esc(s.text);
    if (s.op === 'ins') return `<ins>${esc(s.text)}</ins>`;
    return `<del>${esc(s.text)}</del>`;
  }).join('');
}

function openDiffDetail(d) {
  const body = el('div', {});
  const diff = d.diff || {};
  const sec = (title, badgeCls, keys) => {
    if (!keys?.length) return null;
    return el('div', { style: 'margin-bottom:14px' },
      el('h4', { style: 'margin:0 0 6px' }, title, el('span', { class: `badge ${badgeCls}`, style: 'margin-left:8px' }, String(keys.length))),
      el('div', {}, keys.join('、')),
    );
  };
  const appendIf = (node) => { if (node) body.appendChild(node); };
  appendIf(sec('新增条款', 'ok', diff.added));
  appendIf(sec('删除条款', 'err', diff.deleted));

  if (d.diff?.changed_detail?.length) {
    body.appendChild(el('h4', {}, '修改条款（正文/标题逐字差异）'));
    for (const c of d.diff.changed_detail) {
      const box = el('div', { class: 'clause' });
      const hd = el('div', { class: 'clause-hd' }, el('span', { class: 'key-chip' }, c.key), el('strong', {}, c.title));
      box.appendChild(hd);
      const cbody = el('div', { class: 'clause-bd' });
      if (c.titleSegments) cbody.appendChild(el('div', {}, el('span', { class: 'muted small' }, '标题：'), el('span', { html: segmentsHtml(c.titleSegments) })));
      if (c.bodySegments) cbody.appendChild(el('div', { style: 'margin-top:6px' }, el('span', { class: 'muted small' }, '正文：'), el('div', { html: segmentsHtml(c.bodySegments) })));
      if (c.oldRefs?.length || c.newRefs?.length) {
        cbody.appendChild(el('div', { class: 'refs-line' }, '引用变化：',
          ...c.oldRefs.filter((o) => !c.newRefs.some((n) => n.target === o.target && n.label === o.label)).map((r) => el('del', {}, ` →${r.target} `)),
          ...c.newRefs.filter((n) => !c.oldRefs.some((o) => o.target === n.target && o.label === n.label)).map((r) => el('ins', {}, ` →${r.target} `)),
        ));
      }
      box.appendChild(cbody);
      body.appendChild(box);
    }
  }
  if (diff.refs_added?.length || diff.refs_removed?.length) {
    body.appendChild(el('h4', {}, '引用变化'));
    for (const r of diff.refs_removed || []) body.appendChild(el('div', {}, el('del', {}, `${r.source} → ${r.target}${r.label ? '（' + r.label + '）' : ''}`)));
    for (const r of diff.refs_added || []) body.appendChild(el('div', {}, el('ins', {}, `${r.source} → ${r.target}${r.label ? '（' + r.label + '）' : ''}`)));
  }
  modal({ title: `相对基线 v${d.baseline_id} 的差异`, body, wide: true, footer: [el('button', { class: 'btn ghost', onclick: closeModal }, '关闭')] });
}

function openPublish(draftId) {
  const note = el('input', { type: 'text', placeholder: '本版说明（可选）' });
  const queuedInit = (state.overview.pending?.length || 0) > 0;
  const when = el('select', {},
    el('option', { value: 'now' }, '即时生效（发布后立即成为当前生效版）'),
    el('option', { value: 'future' }, '定时生效（指定晚于当前时间的 UTC 时刻）'),
  );
  if (queuedInit) when.value = 'future';
  const atInput = el('input', { type: 'text', placeholder: 'ISO-8601 / UTC，如 2027-01-01T00:00:00Z', style: 'font-family:ui-monospace,Menlo,monospace' });
  const quick = el('div', { class: 'quick-row', style: queuedInit ? 'display:flex;gap:6px;flex-wrap:wrap;margin-top:6px' : 'display:none' },
    ...[['1 小时后', 3600e3], ['明天 00:00 UTC', null], ['+1 周', 7 * 86400e3]].map(([label, ms]) =>
      el('button', {
        class: 'btn ghost small', type: 'button',
        onclick: () => {
          if (ms === null) {
            const d = new Date();
            d.setUTCHours(24, 0, 0, 0);
            atInput.value = d.toISOString().replace(/\.\d{3}Z$/, 'Z');
          } else {
            atInput.value = utcOffset(ms);
          }
        },
      }, label)),
    el('span', { class: 'muted small', id: 'atHint' }, ''),
  );
  const atBox = el('label', { class: 'fld', style: queuedInit ? '' : 'display:none' },
    el('span', {}, 'UTC 生效时刻 *'),
    atInput,
    quick,
  );
  when.addEventListener('change', () => {
    const future = when.value === 'future';
    atBox.style.display = future ? '' : 'none';
    quick.style.display = future ? 'flex' : 'none';
    quick.style.gap = '6px';
    quick.style.flexWrap = 'wrap';
  });
  const err = el('div', {});
  const ov = state.overview;
  const d = state.draft;
  const willReplay = d.baseline_id !== ov.latest_version_id;
  const queued = ov.pending?.length || 0;
  modal({
    title: '发布草案为新版本',
    body: el('div', {},
      queued
        ? el('div', { class: 'issue warning', style: 'margin-bottom:10px' },
            el('span', {}, '🕒'),
            el('div', {},
              el('div', {}, `当前有 ${queued} 个待生效版本（下一个 v${ov.pending[0].id}：${fmtUtcLocal(ov.pending[0].effective_at)}）。`),
              el('div', { class: 'small muted' }, '队列未清空时不允许即时发布；请指定晚于上一待生效版本的 UTC 时刻，按发布顺序严格递增。'),
            ))
        : null,
      el('p', { class: 'muted small' },
        willReplay
          ? `基线 v${d.baseline_id} 已落后于最新发布版 v${ov.latest_version_id}：系统将在一个原子事务中，把本草案相对基线的不相交条款改动重放到最新版。若同一条款被双方改动，或重放后产生悬空引用，发布将被拒绝并说明冲突，草案原样保留。`
          : '将在一个原子事务中生成不可变的新版本；发布后历史可完整还原该版顺序、正文与引用。'),
      el('label', { class: 'fld' }, el('span', {}, '版本说明'), note),
      el('label', { class: 'fld' }, el('span', {}, '生效方式'), when),
      atBox,
      el('p', { class: 'muted small' },
        '定时发布同样立即写入不可变版本快照并进入“待生效”队列；生效前可在「生效排程」页携排程修订号改期或取消。'),
      err,
    ),
    footer: [
      el('button', { class: 'btn ghost', onclick: closeModal }, '取消'),
      el('button', {
        class: 'btn',
        onclick: async () => {
          const payload = { note: note.value };
          if (when.value === 'future') payload.effective_at = atInput.value.trim();
          try {
            const r = await api('POST', `/api/drafts/${draftId}/publish`, payload);
            closeModal();
            if (r.scheduled) {
              toast(`已生成不可变 v${r.version_id}，将于 ${fmtUtcLocal(r.effective_at)} 生效`, 'ok');
            } else {
              toast(`已原子发布：v${r.version_id}${r.replayed ? '（已重放到最新版）' : ''}`, 'ok');
            }
            state.draftId = null;
            await refresh();
          } catch (e) {
            err.innerHTML = '';
            const p = e.payload || {};
            if (p.error === 'CONFLICT') {
              err.appendChild(renderPublishConflict(p));
            } else if (p.schedule) {
              err.appendChild(el('div', { class: 'issue error' }, el('span', {}, '🕒'),
                el('div', {},
                  el('div', {}, el('strong', {}, p.message || '不符合排程规则')),
                  el('div', { class: 'small muted' }, `当前排程修订号 ${p.schedule.schedule_revision}；队列：${
                    p.schedule.queue.length
                      ? p.schedule.queue.map((q) => `v${q.id}@${fmtUtc(q.effective_at)}`).join('，')
                      : '空'}`),
                )));
            } else {
              err.appendChild(renderIssueList(p.issues || [{ message: e.message }]));
            }
          }
        },
      }, '确认发布'),
    ],
  });
}

function renderPublishConflict(p) {
  const box = el('div', {});
  box.appendChild(el('div', { class: 'issue error' }, el('span', {}, '⛔'),
    el('span', {}, '发布被拒绝，草案已完整保留。请对照下列冲突修改草案后重新发布。')));
  for (const c of p.conflicts || []) {
    box.appendChild(el('div', { class: 'issue error' }, el('span', {}, '⚔️'),
      el('div', {},
        el('div', {}, el('strong', {}, `条款冲突 · ${c.key}（${c.kind}）`)),
        el('div', { class: 'small muted' }, c.message),
      )));
  }
  for (const dg of p.dangling || []) {
    box.appendChild(el('div', { class: 'issue error' }, el('span', {}, '🔗'),
      el('div', {},
        el('div', {}, el('strong', {}, '重放后引用悬空')),
        el('div', { class: 'small muted' }, dg.message),
      )));
  }
  return box;
}

// ---------------------------------------------------------------------------
// 生效排程：当前生效版 / 待生效顺序 / 已取消；改期、取消、时点查询
// ---------------------------------------------------------------------------
async function openSchedule() {
  state.schedule = await api('GET', '/api/schedule');
}

function renderSchedule() {
  const wrap = el('div', {});
  if (!state.schedule) {
    openSchedule().then(render).catch((e) => toast(e.message, 'err'));
    return wrap;
  }
  const s = state.schedule;
  const ov = state.overview;

  wrap.appendChild(el('div', { class: 'stat-row' },
    stat(`v${s.current_effective_version_id ?? '-'}`, '当前生效版本'),
    stat(s.queue.length, '待生效版本'),
    stat(s.canceled.length, '已取消（保留快照）'),
  ));

  // 时点查询
  const atInput = el('input', { type: 'text', placeholder: '留空查询当前；或填 UTC 时刻，如 2027-06-01T00:00:00Z', style: 'font-family:ui-monospace,Menlo,monospace' });
  const queryPanel = el('div', { class: 'panel' },
    el('div', { class: 'panel-hd' }, el('h2', {}, '按时点查询当时生效版本')),
    el('div', { class: 'panel-bd' },
      el('div', { style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap' },
        el('span', { class: 'key-chip' }, 'UTC'), atInput,
        el('button', {
          class: 'btn secondary small', type: 'button',
          onclick: () => { atInput.value = utcOffset(3600e3); },
        }, '+1 小时'),
        el('button', {
          class: 'btn secondary small', type: 'button',
          onclick: () => { atInput.value = utcOffset(7 * 86400e3); },
        }, '+1 周'),
        el('button', {
          class: 'btn', type: 'button',
          onclick: async () => {
            const q = atInput.value.trim() ? `?at=${encodeURIComponent(atInput.value.trim())}` : '';
            try {
              const r = await api('GET', `/api/effective${q}`);
              state.versionId = r.version_id;
              state.versionContext = { at: r.at, asOfPast: r.as_of_past };
              state.version = r.version;
              await render();
            } catch (e) { toast(e.payload?.message || e.message, 'err'); }
          },
        }, '查询'),
      ),
      el('p', { class: 'muted small', style: 'margin-bottom:0;margin-top:8px' },
        '返回该时点生效版本的完整条款、顺序与引用。已发生时点的结果不会因后续改期或取消而改变。'),
    ),
  );
  wrap.appendChild(queryPanel);

  // 待生效队列
  const queuePanel = el('div', { class: 'panel' },
    el('div', { class: 'panel-hd' },
      el('h2', {}, '待生效队列（按发布顺序，生效时刻严格递增）'),
      el('span', { class: 'muted small' }, `排程修订号 #${s.schedule_revision} · 服务器时间 ${fmtUtc(s.now)}`),
    ),
  );
  const qbd = el('div', { class: 'panel-bd' });
  queuePanel.appendChild(qbd);
  if (!s.queue.length) {
    qbd.appendChild(el('div', { class: 'empty small' }, '队列为空：新发布默认即时生效'));
  } else {
    const tbl = el('table', { class: 'list' },
      el('thead', {}, el('tr', {},
        el('th', {}, '顺序'), el('th', {}, '版本'), el('th', {}, '说明'),
        el('th', {}, 'UTC 生效时刻'), el('th', {}, '操作'),
      )),
      el('tbody', {},
        ...s.queue.map((q) => el('tr', {},
          el('td', {}, `#${q.position}`),
          el('td', {}, el('strong', {}, `v${q.id}`)),
          el('td', {}, q.note),
          el('td', { class: 'small' }, fmtUtcLocal(q.effective_at)),
          el('td', {},
            el('div', { style: 'display:flex;gap:6px' },
              el('button', { class: 'btn secondary small', onclick: () => { state.versionId = q.id; state.versionContext = null; openVersionAndRender(); } }, '查看快照'),
              el('button', { class: 'btn secondary small', onclick: () => openReschedule(q, s.schedule_revision) }, '改期'),
              el('button', { class: 'btn danger small', onclick: () => openCancel(q, s.schedule_revision) }, '取消'),
            ),
          ),
        )),
      ),
    );
    qbd.appendChild(tbl);
    qbd.appendChild(el('p', { class: 'muted small' },
      '改期不得越过相邻版本或落到过去；操作须携带读取时的排程修订号，若期间排程已被改动将整次拒绝并返回当前排程。'));
  }
  wrap.appendChild(queuePanel);

  // 已取消
  if (s.canceled.length) {
    const cPanel = el('div', { class: 'panel' },
      el('div', { class: 'panel-hd' }, el('h2', {}, `已取消版本（${s.canceled.length}，不可变快照保留可查）`)),
    );
    const cbd = el('div', { class: 'panel-bd' });
    cPanel.appendChild(cbd);
    cbd.appendChild(el('table', { class: 'list' },
      el('thead', {}, el('tr', {},
        el('th', {}, '版本'), el('th', {}, '原定生效时刻（UTC）'), el('th', {}, '取消时间（UTC）'), el('th', {}, '说明'), el('th', {}),
      )),
      el('tbody', {},
        ...[...s.canceled].reverse().map((c) => el('tr', {},
          el('td', {}, el('strong', {}, `v${c.id}`)),
          el('td', { class: 'small' }, fmtUtcLocal(c.effective_at)),
          el('td', { class: 'small' }, fmtUtcLocal(c.canceled_at)),
          el('td', {}, c.note),
          el('td', {}, el('button', { class: 'btn secondary small', onclick: () => { state.versionId = c.id; state.versionContext = null; openVersionAndRender(); } }, '查看快照')),
        )),
      ),
    ));
    wrap.appendChild(cPanel);
  }
  return wrap;
}

function scheduleErrorBox(err, e) {
  const p = e.payload || {};
  err.innerHTML = '';
  err.appendChild(el('div', { class: 'issue error' },
    el('span', {}, p.error === 'STALE_REVISION' ? '🔖' : '⛔'),
    el('div', {},
      el('div', {}, el('strong', {}, p.message || e.message)),
      p.schedule ? el('div', { class: 'small muted' },
        `当前排程修订号 #${p.schedule.schedule_revision}；队列：${
          p.schedule.queue.length
            ? p.schedule.queue.map((q) => `v${q.id}@${fmtUtc(q.effective_at)}`).join('，')
            : '空（请重开弹窗获取最新限制）'}`) : null,
    ),
  ));
}

function openReschedule(q, rev) {
  const atInput = el('input', { type: 'text', value: q.effective_at, style: 'font-family:ui-monospace,Menlo,monospace' });
  const err = el('div', {});
  modal({
    title: `改期 v${q.id}（${q.note}）`,
    body: el('div', {},
      el('p', { class: 'muted small' }, '输入新的 UTC 生效时刻（ISO-8601）。必须晚于当前时间，且不得越过队列中的相邻版本。'),
      el('div', { class: 'quick-row', style: 'display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap' },
        el('button', { class: 'btn ghost small', type: 'button', onclick: () => { atInput.value = utcOffset(3600e3); } }, '+1 小时'),
        el('button', { class: 'btn ghost small', type: 'button', onclick: () => { atInput.value = utcOffset(86400e3); } }, '+1 天'),
        el('button', { class: 'btn ghost small', type: 'button', onclick: () => { atInput.value = utcOffset(7 * 86400e3); } }, '+1 周'),
      ),
      el('label', { class: 'fld' }, el('span', {}, '新 UTC 生效时刻 *'), atInput),
      el('div', { class: 'muted small' }, `本次操作携带读取时的排程修订号 #${rev}；若期间排程被改动，操作将被拒绝并返回当前排程。`),
      err,
    ),
    footer: [
      el('button', { class: 'btn ghost', onclick: closeModal }, '取消'),
      el('button', {
        class: 'btn',
        onclick: async () => {
          try {
            const r = await api('POST', `/api/versions/${q.id}/reschedule`, {
              effective_at: atInput.value.trim(),
              schedule_revision: rev,
            });
            closeModal();
            toast(`v${q.id} 已改期至 ${fmtUtcLocal(r.effective_at)}`, 'ok');
            state.schedule = r.schedule ? normalizeSchedule(r.schedule) : state.schedule;
            await refresh();
          } catch (e) { scheduleErrorBox(err, e); }
        },
      }, '确认改期'),
    ],
  });
}

function openCancel(q, rev) {
  const err = el('div', {});
  modal({
    title: `取消待生效版本 v${q.id}`,
    body: el('div', {},
      el('p', {}, `确定取消 v${q.id}（${q.note}）？它原定 ${fmtUtcLocal(q.effective_at)} 生效。`),
      el('p', { class: 'muted small' },
        '取消后该版本不会生效，但其不可变快照仍保留在发布历史中可查；当前生效版继续有效。此操作需匹配排程修订号。'),
      err,
    ),
    footer: [
      el('button', { class: 'btn ghost', onclick: closeModal }, '再想想'),
      el('button', {
        class: 'btn danger',
        onclick: async () => {
          try {
            const r = await api('POST', `/api/versions/${q.id}/cancel`, { schedule_revision: rev });
            closeModal();
            toast(`v${q.id} 已取消，快照保留`, 'ok');
            state.schedule = r.schedule ? normalizeSchedule(r.schedule) : state.schedule;
            await refresh();
          } catch (e) { scheduleErrorBox(err, e); }
        },
      }, '确认取消'),
    ],
  });
}

// 把 API 返回的 schedule（带 ms 字段）归一为页面使用的形态
function normalizeSchedule(s) {
  return {
    now: s.now,
    schedule_revision: s.schedule_revision,
    current_effective_version_id: s.current_effective_version_id,
    queue: s.queue.map((q) => ({ ...q })),
    canceled: s.canceled,
  };
}

// ---------------------------------------------------------------------------
// 发布历史 & 版本还原
// ---------------------------------------------------------------------------
function renderHistory() {
  const wrap = el('div', {});
  const versions = state.overview.versions;
  const panel = el('div', { class: 'panel' },
    el('div', { class: 'panel-hd' }, el('h2', {}, `发布历史（${versions.length} 个不可变版本）`)),
  );
  const bd = el('div', { class: 'panel-bd' });
  panel.appendChild(bd);
  const tbl = el('table', { class: 'list' },
    el('thead', {}, el('tr', {},
      el('th', {}, '版本'), el('th', {}, '状态'), el('th', {}, '说明'), el('th', {}, '基线'),
      el('th', {}, '来源草案'), el('th', {}, '发布时间'), el('th', {}, 'UTC 生效时刻'), el('th', {}),
    )),
    el('tbody', {},
      ...[...versions].reverse().map((v) => {
        const src = v.draft_id ? `草案 #${v.draft_id}` : v.note === '首版发布' ? '首版录入' : '—';
        const status = versionStatus(v);
        return el('tr', { class: status === 'canceled' ? 'row-canceled' : '' },
          el('td', {}, el('strong', {}, `v${v.id}`)),
          el('td', {}, statusBadge(status)),
          el('td', {}, v.note),
          el('td', {}, v.baseline_id ? `v${v.baseline_id}` : '—'),
          el('td', {}, src),
          el('td', { class: 'muted small' }, fmtTime(v.created_at)),
          el('td', { class: 'small muted' }, status === 'effective' && !v.activated_at ? fmtTime(v.effective_at) : fmtUtcLocal(v.effective_at)),
          el('td', {}, el('button', { class: 'btn secondary small', onclick: async () => { state.versionId = v.id; state.versionContext = null; await openVersionAndRender(); } }, '查看 / 还原')),
        );
      }),
    ),
  );
  bd.appendChild(tbl);
  wrap.appendChild(panel);
  return wrap;
}

async function openVersionAndRender(compare) {
  const q = compare ? `?compare=${compare}` : '';
  state.version = await api('GET', `/api/versions/${state.versionId}${q}`);
  // 排程/时点上下文下查看版本时保持 schedule 视图（轮询、返回按钮据此处理）
  await render();
}

function renderVersion() {
  const wrap = el('div', {});
  if (!state.version || state.version.id !== state.versionId) {
    openVersionAndRender().catch((e) => toast(e.message, 'err'));
    return wrap;
  }
  const v = state.version;
  const ctx = state.versionContext;
  wrap.appendChild(el('div', { class: 'breadcrumb' },
    el('a', {
      onclick: async () => {
        const backToSchedule = ctx || state.view === 'schedule';
        state.versionId = null;
        state.versionContext = null;
        state.view = backToSchedule ? 'schedule' : 'history';
        await refresh();
      },
    }, (ctx || state.view === 'schedule') ? '返回生效排程' : '发布历史'),
    ctx ? ` / 时点查询 ${fmtUtc(ctx.at)} / v${v.id}` : ` / v${v.id}（不可变快照）`,
  ));

  if (ctx) {
    wrap.appendChild(el('div', { class: `panel ${ctx.asOfPast ? 'effective-banner' : 'schedule-banner'}` },
      el('div', { class: 'panel-bd', style: 'padding:10px 18px' },
        el('div', { style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap' },
          el('span', { class: 'badge effective' }, '当时生效版本'),
          el('strong', {}, `v${v.id}`),
          el('span', { class: 'muted small' },
            ctx.asOfPast
              ? `这是已发生时点（${fmtUtcLocal(ctx.at)}）的结果，后续改期或取消不会改变它。`
              : `这是未来时点（${fmtUtcLocal(ctx.at)}）按当前排程推算的结果。`),
        ),
      ),
    ));
  }

  const versions = state.overview.versions;
  const compareSel = el('select', {},
    el('option', { value: '' }, '不比较'),
    ...versions.filter((x) => x.id !== v.id).map((x) => el('option', { value: x.id }, `与 v${x.id} 比较`)),
  );
  if (v.compare_to) compareSel.value = String(v.compare_to);
  compareSel.addEventListener('change', () => openVersionAndRender(compareSel.value || null));

  const changedKeys = new Set((v.diff?.changed || []).map((c) => c.key));
  const addedKeys = new Set(v.diff?.added || []);
  const deletedKeys = new Set(v.diff?.deleted || []);

  const panel = el('div', { class: 'panel' });
  const vStatus = versionStatus(v);
  panel.appendChild(el('div', { class: 'panel-hd' },
    el('div', {},
      el('div', { style: 'display:flex;gap:8px;align-items:center' },
        el('h2', { style: 'margin:0' }, `v${v.id} · ${v.note}`),
        statusBadge(vStatus),
      ),
      el('div', { class: 'muted small' },
        `发布于 ${fmtTime(v.created_at)} · 生效时刻 ${fmtUtcLocal(v.effective_at)} · 基线 ${v.baseline_id ? 'v' + v.baseline_id : '无'} · 完全还原该版顺序、正文与引用`),
    ),
    el('div', { class: 'compare-picker' }, compareSel),
  ));

  const bd = el('div', { class: 'panel-bd' });
  panel.appendChild(bd);

  if (v.diff) {
    const chips = [
      v.diff.added.length ? el('span', { class: 'badge ok' }, `新增 ${v.diff.added.length}`) : null,
      v.diff.deleted.length ? el('span', { class: 'badge err' }, `删除 ${v.diff.deleted.length}`) : null,
      v.diff.changed.length ? el('span', { class: 'badge warn' }, `修改 ${v.diff.changed.length}`) : null,
    ].filter(Boolean);
    if (chips.length) bd.appendChild(el('div', { style: 'display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap' }, chips));

    if (v.diff.deleted.length) {
      const tb = el('div', { class: 'panel deleted-glow', style: 'margin-bottom:14px' },
        el('div', { class: 'panel-bd' },
          el('strong', { style: 'color:var(--red)' }, '本版已删除（相对比较基线）：'),
          el('div', { class: 'small' }, [...deletedKeys].join('、')),
        ));
      bd.appendChild(tb);
    }
  }

  const details = new Map((v.changed_detail || []).map((c) => [c.key, c]));
  v.clauses.forEach((c, i) => {
    const node = el('div', { class: 'clause' });
    const cls = addedKeys.has(c.key) ? 'added-glow' : changedKeys.has(c.key) ? 'changed-glow' : '';
    if (cls) node.classList.add(cls);
    const hd = el('div', { class: 'clause-hd' },
      el('span', { class: 'ord' }, `#${i + 1}`),
      el('span', { class: 'key-chip' }, c.key),
      el('span', { class: 'title' }, c.title),
      addedKeys.has(c.key) ? el('span', { class: 'badge ok' }, '新增') : null,
      changedKeys.has(c.key) ? el('span', { class: 'badge warn' }, '修改') : null,
    );
    node.appendChild(hd);
    const detail = details.get(c.key);
    const bodyHtml = detail?.bodySegments ? segmentsHtml(detail.bodySegments) : esc(c.body);
    const titleHtml = detail?.titleSegments ? segmentsHtml(detail.titleSegments) : null;
    const cb = el('div', { class: 'clause-bd' });
    if (titleHtml) cb.appendChild(el('div', { style: 'margin-bottom:4px' }, el('span', { html: titleHtml })));
    cb.appendChild(el('div', { class: 'clause-body', html: bodyHtml }));
    const outgoing = v.refs.filter((r) => r.source === c.key);
    if (outgoing.length) cb.appendChild(el('div', { class: 'refs-line' }, '引用：',
      ...outgoing.map((r) => el('span', { class: 'ref-tag' }, '→ ', el('span', { class: 'key-chip' }, r.target), r.label ? `（${r.label}）` : ''))));
    node.appendChild(cb);
    bd.appendChild(node);
  });

  if (v.diff?.refs_added?.length || v.diff?.refs_removed?.length) {
    bd.appendChild(el('h4', {}, '引用变化'));
    for (const r of v.diff.refs_removed || []) bd.appendChild(el('div', {}, el('del', {}, `${r.source} → ${r.target}${r.label ? '（' + r.label + '）' : ''}`)));
    for (const r of v.diff.refs_added || []) bd.appendChild(el('div', {}, el('ins', {}, `${r.source} → ${r.target}${r.label ? '（' + r.label + '）' : ''}`)));
  }

  wrap.appendChild(panel);
  return wrap;
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
refresh().catch((e) => toast('加载失败：' + e.message, 'err'));
