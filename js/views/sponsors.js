/**
 * Sponsors (migration 015): sponsorships and donations as cards on a kanban board.
 *   #/sponsors        — the board (one column per stage) or a searchable list of
 *                       every sponsor in every season, so future teams can find
 *                       similar sponsors and see what worked.
 *   #/sponsors/:id    — one card: details, "About this sponsor", "Tips for next
 *                       time", watchers, notes & history, renew for next season.
 * Moving a card to a "money received" stage adds a row to the chosen Finances
 * sheet (once). Watchers get an email / Teams message when a card moves or gets
 * a note. Viewing needs sponsors.view; changing, sponsors.edit.
 */
import { api } from '../api.js';
import { auth } from '../auth.js';
import { esc, fmtMoney, fmtDate, fmtDateTime, errorBox, setFlash, takeFlash, renderRichText } from '../ui.js';
import { guardLeaving, releaseGuard } from '../leaveGuard.js';

const STAGE_KINDS = [
  ['open', 'Working on it'],
  ['received', 'Money received (adds it to Finances)'],
  ['done', 'Done'],
  ['lost', 'Not happening'],
];
const DEFAULT_STAGES = [
  { key: 'prospect', label: 'Prospect', kind: 'open' },
  { key: 'contacted', label: 'Contacted', kind: 'open' },
  { key: 'talks', label: 'In talks', kind: 'open' },
  { key: 'committed', label: 'Committed', kind: 'open' },
  { key: 'received', label: 'Received', kind: 'received' },
  { key: 'thanked', label: 'Thanked', kind: 'done' },
  { key: 'declined', label: 'Not this year', kind: 'lost' },
];

/** The board's settings with defaults filled in. */
export function sponsorSettings(config) {
  const s = config.sponsors || {};
  return {
    stages: Array.isArray(s.stages) && s.stages.length ? s.stages : DEFAULT_STAGES,
    kinds: Array.isArray(s.kinds) ? s.kinds : [],
    income: s.income || {},
  };
}

// Kept while moving around the app.
const view = { mode: 'board', season: '', q: '', who: '' };

const today = () => new Date().toISOString().slice(0, 10);
const initials = (name) => String(name || '?').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
const canEdit = () => auth.can('sponsors.edit');
const isOpen = (stages, card) => ['open', undefined].includes(stages.find((s) => s.key === card.stage)?.kind);

/** People who can see the board (so they can watch or lead a card). */
async function boardPeople() {
  const [people, grants] = await Promise.all([api.listProfiles(), api.listRolePermissions().catch(() => [])]);
  const roles = new Set(grants.filter((g) => ['sponsors.view', 'sponsors.edit'].includes(g.permission)).map((g) => g.role));
  return { all: people, viewers: people.filter((p) => (p.roles || []).some((r) => roles.has(r))) };
}

// ---- Board / list ----------------------------------------------------------------------

export async function renderSponsors(el, { config, rerender, reloadConfig }) {
  let cards;
  try {
    cards = await api.listSponsorCards();
  } catch {
    el.innerHTML = `<div class="page-header"><div><h1>Sponsors</h1></div></div>
      <div class="alert alert-info">The Sponsors board needs database update <code>015_sponsors.sql</code>.</div>`;
    return;
  }
  const { stages, kinds } = sponsorSettings(config);
  const { all: people } = await boardPeople();
  const nameOf = (id) => people.find((p) => p.id === id)?.full_name || '';
  const seasons = [...new Set([config.season, ...cards.map((c) => c.season)].filter(Boolean))].sort().reverse();
  if (!view.season || (view.season !== 'all' && !seasons.includes(view.season))) view.season = config.season || seasons[0] || 'all';
  if (view.mode === 'board' && view.season === 'all') view.season = config.season;
  const me = auth.user.id;

  const matches = (c) => {
    const words = view.q.toLowerCase().split(/\s+/).filter(Boolean);
    const text = [c.name, c.kind, c.contact_name, c.contact_email, c.website, ...(c.tags || []), c.description, c.playbook, nameOf(c.owner_id), c.season]
      .join(' ')
      .toLowerCase();
    return (
      words.every((w) => text.includes(w)) &&
      (view.season === 'all' || c.season === view.season) &&
      (!view.who || (view.who === 'mine' ? c.owner_id === me : c.watchers.includes(me)))
    );
  };

  el.innerHTML = `
    ${takeFlash()}
    <div class="page-header">
      <div>
        <h1>Sponsors</h1>
        <p class="subtitle">Sponsorships and donations, from first contact to thank-you. Every season stays here for the next team.</p>
      </div>
      <div class="card-actions">
        ${canEdit() ? '<button type="button" class="btn btn-primary" id="new-card">+ New sponsor</button>' : ''}
        ${canEdit() ? '<button type="button" class="btn" id="board-settings">Board settings</button>' : ''}
      </div>
    </div>
    <div id="settings-box"></div>
    <div class="toolbar">
      <div class="segmented" role="tablist" aria-label="View">
        <button type="button" role="tab" data-mode="board" aria-selected="${view.mode === 'board'}">Board</button>
        <button type="button" role="tab" data-mode="list" aria-selected="${view.mode === 'list'}">All sponsors</button>
      </div>
      <input type="search" id="sp-q" placeholder="Search names, contacts, tags, notes…" value="${esc(view.q)}" aria-label="Search sponsors">
      <select id="sp-season" aria-label="Season">
        ${view.mode === 'list' ? `<option value="all" ${view.season === 'all' ? 'selected' : ''}>Every season</option>` : ''}
        ${seasons.map((s) => `<option value="${esc(s)}" ${s === view.season ? 'selected' : ''}>${esc(s)}</option>`).join('')}
      </select>
      <select id="sp-who" aria-label="Whose">
        <option value="">Everyone's</option>
        <option value="mine" ${view.who === 'mine' ? 'selected' : ''}>I'm leading</option>
        <option value="watching" ${view.who === 'watching' ? 'selected' : ''}>I'm watching</option>
      </select>
    </div>
    <div id="sp-errors"></div>
    <div id="sp-body"></div>`;

  const errors = el.querySelector('#sp-errors');
  const body = el.querySelector('#sp-body');

  const cardHtml = (c) => {
    const due = c.follow_up && c.follow_up <= today() && isOpen(stages, c);
    return `<article class="kcard" data-card="${esc(c.id)}" ${canEdit() ? 'draggable="true"' : ''}>
      <a class="kcard-name" href="#/sponsors/${esc(c.id)}">${esc(c.name)}</a>
      <div class="kcard-meta">
        ${c.kind ? `<span class="chip">${esc(c.kind.replace(/ \(.*/, ''))}</span>` : ''}
        ${c.amount !== null && c.amount !== undefined ? `<strong>${fmtMoney(c.amount)}</strong>` : ''}
      </div>
      ${(c.tags || []).length ? `<div class="kcard-tags">${c.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>` : ''}
      <div class="kcard-foot">
        ${c.owner_id ? `<span class="avatar" title="Lead: ${esc(nameOf(c.owner_id))}">${esc(initials(nameOf(c.owner_id)))}</span>` : ''}
        ${c.follow_up ? `<span class="${due ? 'late-tag' : 'muted small'}" title="Follow up">↻ ${fmtDate(c.follow_up)}</span>` : ''}
        ${c.watchers.length ? `<span class="muted small" title="${c.watchers.length} watching">👁 ${c.watchers.length}</span>` : ''}
        ${canEdit() ? `<select class="kcard-move" data-move="${esc(c.id)}" aria-label="Move ${esc(c.name)} to">${stages
          .map((s) => `<option value="${esc(s.key)}" ${s.key === c.stage ? 'selected' : ''}>${esc(s.label)}</option>`)
          .join('')}</select>` : ''}
      </div>
    </article>`;
  };

  const drawBoard = () => {
    const shown = cards.filter(matches);
    body.innerHTML = `<div class="kanban">${stages
      .map((s) => {
        const list = shown.filter((c) => c.stage === s.key).sort((a, b) => a.position - b.position);
        const total = list.reduce((sum, c) => sum + (Number(c.amount) || 0), 0);
        return `<section class="kanban-col kind-${esc(s.kind || 'open')}" data-stage="${esc(s.key)}" aria-label="${esc(s.label)}">
          <header><h2>${esc(s.label)}</h2><span class="muted small">${list.length}${total ? ` · ${fmtMoney(total)}` : ''}</span></header>
          <div class="kanban-cards" data-drop="${esc(s.key)}">${list.map(cardHtml).join('') || '<p class="kanban-empty muted small">Nothing here.</p>'}</div>
          ${canEdit() ? `<form class="kanban-add" data-add="${esc(s.key)}"><input type="text" placeholder="+ Add a sponsor" aria-label="Add a sponsor to ${esc(s.label)}" maxlength="120"></form>` : ''}
        </section>`;
      })
      .join('')}</div>
      <p class="hint hide-touch">Drag cards between columns. Click a card for its details, notes and history.</p>`;
  };

  const drawList = () => {
    const shown = cards.filter(matches).sort((a, b) => (b.season || '').localeCompare(a.season || '') || a.name.localeCompare(b.name));
    const stageLabel = (k) => stages.find((s) => s.key === k)?.label || k;
    const total = shown.reduce((s, c) => s + (['received', 'done'].includes(stages.find((x) => x.key === c.stage)?.kind) ? Number(c.amount) || 0 : 0), 0);
    body.innerHTML = shown.length
      ? `<p class="muted small">${shown.length} sponsor card${shown.length === 1 ? '' : 's'}${total ? ` · ${fmtMoney(total)} received` : ''}</p>
        <div class="table-wrap"><table class="table stack-mobile sponsor-list">
          <thead><tr><th>Sponsor</th><th>Season</th><th>Type</th><th>Stage</th><th class="num">Amount</th><th>Lead</th><th>Tags</th></tr></thead>
          <tbody>${shown
            .map(
              (c) => `<tr class="clickable" data-href="#/sponsors/${esc(c.id)}">
                <td class="cell-primary" data-label=""><a class="title-link" href="#/sponsors/${esc(c.id)}">${esc(c.name)}</a>${
                  c.playbook ? ' <span class="field-tag" title="Has tips for next time">Tips</span>' : ''}</td>
                <td data-label="Season">${esc(c.season || '—')}</td>
                <td data-label="Type">${esc(c.kind || '—')}</td>
                <td data-label="Stage">${esc(stageLabel(c.stage))}</td>
                <td class="num" data-label="Amount">${c.amount !== null && c.amount !== undefined ? fmtMoney(c.amount) : '—'}</td>
                <td data-label="Lead">${esc(nameOf(c.owner_id) || '—')}</td>
                <td data-label="Tags">${(c.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join(' ') || '—'}</td>
              </tr>`
            )
            .join('')}</tbody></table></div>`
      : '<div class="empty">No sponsors match. Try another season or search.</div>';
  };

  const draw = () => (view.mode === 'board' ? drawBoard() : drawList());

  const create = async (stage, name) => {
    try {
      const id = await api.saveSponsorCard(null, { name, stage, season: view.season !== 'all' ? view.season : config.season });
      return id;
    } catch (err) {
      errors.innerHTML = errorBox(err);
      return null;
    }
  };

  // Moving: drag and drop (desktop) or the small menu on each card (phones).
  const move = async (id, stage, beforeId) => {
    const card = cards.find((c) => c.id === id);
    const col = cards.filter((c) => c.stage === stage && c.id !== id).sort((a, b) => a.position - b.position);
    const i = beforeId ? col.findIndex((c) => c.id === beforeId) : col.length;
    const prev = col[i - 1]?.position ?? (col[0]?.position ?? 1) - 1;
    const next = col[i]?.position ?? prev + 2;
    const position = (prev + next) / 2;
    const before = { stage: card.stage, position: card.position };
    Object.assign(card, { stage, position });
    draw();
    try {
      await api.moveSponsorCard(id, stage, position);
      errors.innerHTML = '';
      const kind = stages.find((s) => s.key === stage)?.kind;
      if (before.stage !== stage && kind === 'received' && card.amount) {
        const label = stages.find((s) => s.key === stage).label;
        setFlash(sponsorSettings(config).income.sheet
          ? `${card.name} moved to ${label}. Its ${fmtMoney(card.amount)} is now in the Finances income sheet (once per card).`
          : `${card.name} moved to ${label}. To log money like this in Finances automatically, choose an income sheet in Board settings.`);
        rerender();
      }
    } catch (err) {
      Object.assign(card, before);
      draw();
      errors.innerHTML = errorBox(err);
    }
  };

  let dragging = null;
  el.addEventListener('dragstart', (e) => {
    const card = e.target.closest?.('.kcard');
    if (!card) return;
    dragging = card.dataset.card;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragging);
    card.classList.add('is-dragging');
  });
  el.addEventListener('dragend', () => {
    dragging = null;
    el.querySelectorAll('.is-dragging, .is-over').forEach((n) => n.classList.remove('is-dragging', 'is-over'));
  });
  el.addEventListener('dragover', (e) => {
    const zone = e.target.closest?.('[data-drop]');
    if (!zone || !dragging) return;
    e.preventDefault();
    el.querySelectorAll('.is-over').forEach((n) => n !== zone && n.classList.remove('is-over'));
    zone.classList.add('is-over');
  });
  el.addEventListener('drop', (e) => {
    const zone = e.target.closest?.('[data-drop]');
    if (!zone || !dragging) return;
    e.preventDefault();
    const after = [...zone.querySelectorAll('.kcard:not(.is-dragging)')].find((n) => e.clientY < n.getBoundingClientRect().top + n.offsetHeight / 2);
    move(dragging, zone.dataset.drop, after?.dataset.card);
  });

  el.addEventListener('change', (e) => {
    if (e.target.dataset.move) return move(e.target.dataset.move, e.target.value);
    if (e.target.id === 'sp-season') {
      view.season = e.target.value;
      return draw();
    }
    if (e.target.id === 'sp-who') {
      view.who = e.target.value;
      return draw();
    }
  });
  el.querySelector('#sp-q').addEventListener('input', (e) => {
    view.q = e.target.value;
    draw();
  });
  el.addEventListener('submit', async (e) => {
    const form = e.target.closest('[data-add]');
    if (!form) return;
    e.preventDefault();
    const name = form.querySelector('input').value.trim();
    if (!name) return;
    const id = await create(form.dataset.add, name);
    if (id) {
      cards = await api.listSponsorCards();
      draw();
      el.querySelector(`[data-add="${CSS.escape(form.dataset.add)}"] input`)?.focus();
    }
  });
  el.addEventListener('click', async (e) => {
    const row = e.target.closest('tr[data-href]');
    if (row && !e.target.closest('a')) location.hash = row.dataset.href;
    const btn = e.target.closest('button');
    if (!btn) return;
    if (btn.dataset.mode) {
      view.mode = btn.dataset.mode;
      if (view.mode === 'board' && view.season === 'all') view.season = config.season;
      return rerender();
    }
    if (btn.id === 'new-card') {
      const name = prompt('Sponsor or donor name:')?.trim();
      if (!name) return;
      const id = await create(stages[0].key, name);
      if (id) location.hash = `#/sponsors/${id}`;
    }
    if (btn.id === 'board-settings') {
      btn.hidden = true;
      openSettings(el.querySelector('#settings-box'), { config, reloadConfig, rerender, onDone: () => (btn.hidden = false) });
    }
  });

  draw();
}

// ---- Board settings: stages, kinds, where received money goes ----------------------------

async function openSettings(box, { config, reloadConfig, rerender, onDone }) {
  const current = sponsorSettings(config);
  const state = { stages: structuredClone(current.stages), kinds: [...current.kinds], income: structuredClone(current.income) };
  const sheets = auth.can('finances.view') || auth.can('finances.edit') ? await api.listFinanceSheets().catch(() => []) : [];
  const keyFor = (label) => {
    const base = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'stage';
    let key = base;
    for (let n = 2; state.stages.some((s) => s.key === key); n++) key = `${base}_${n}`;
    return key;
  };
  /** Which columns of the income sheet get the date, sponsor, type and amount (matched by name and type). */
  const mapColumns = (sheet) => {
    const cols = sheet?.columns || [];
    const find = (re, types) => cols.find((c) => re.test(c.label) && (!types || types.includes(c.type)))?.key;
    return Object.fromEntries(
      Object.entries({
        date: find(/date/i, ['date', 'text']),
        from: find(/from|sponsor|donor|name|who/i, ['text', 'select']),
        type: find(/type|kind|category/i, ['select', 'text']),
        amount: find(/amount|total|\$|money/i, ['money', 'number']) || cols.find((c) => c.type === 'money')?.key,
        received: find(/received|paid/i, ['checkbox']),
        notes: find(/note|memo|description/i, ['text']),
      }).filter(([, v]) => v)
    );
  };

  const draw = () => {
    const sheet = sheets.find((s) => s.id === state.income.sheet);
    box.innerHTML = `<section class="card">
      <h2>Board settings</h2>
      <h3 class="sub-heading">Stages</h3>
      <ol class="stage-list">${state.stages
        .map(
          (s, i) => `<li data-i="${i}">
            <span class="col-move">
              <button type="button" class="icon-btn" data-stage-move="-1" ${i === 0 ? 'disabled' : ''} aria-label="Move ${esc(s.label)} left">←</button>
              <button type="button" class="icon-btn" data-stage-move="1" ${i === state.stages.length - 1 ? 'disabled' : ''} aria-label="Move ${esc(s.label)} right">→</button>
            </span>
            <input type="text" data-stage-label value="${esc(s.label)}" maxlength="40" aria-label="Stage name">
            <select data-stage-kind aria-label="What this stage means">${STAGE_KINDS.map(([k, l]) => `<option value="${k}" ${k === (s.kind || 'open') ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
            <button type="button" class="icon-btn" data-stage-del aria-label="Delete stage ${esc(s.label)}" title="Delete stage">&times;</button>
          </li>`
        )
        .join('')}</ol>
      <button type="button" class="btn btn-sm" id="stage-add">+ Add stage</button>
      <p class="hint">Cards in a deleted stage move to the first stage. The first stage is where new sponsors start.</p>

      <h3 class="sub-heading">Types</h3>
      <textarea id="kinds" rows="4" placeholder="One per line">${esc(state.kinds.join('\n'))}</textarea>

      <h3 class="sub-heading">When money is received</h3>
      ${sheets.length
        ? `<div class="field"><label for="income-sheet">Add a row to this Finances sheet</label>
            <select id="income-sheet"><option value="">Don't add anything</option>${sheets.map((s) => `<option value="${esc(s.id)}" ${s.id === state.income.sheet ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>
            ${sheet ? `<div class="hint">Fills in: ${Object.entries(state.income.columns || {}).map(([k, key]) => `${esc({ date: 'date', from: 'sponsor name', type: 'type', amount: 'amount', received: 'received ✓', notes: 'a note' }[k])} → ${esc(sheet.columns.find((c) => c.key === key)?.label || '?')}`).join(', ') || 'nothing (no matching columns)'}.
              Matched by column names; rename columns in Finances to change it.</div>` : ''}</div>`
        : '<p class="muted small">Someone with Finances access can choose a sheet (e.g. "Income") here, so money received is logged there automatically.</p>'}
      <div id="set-errors"></div>
      <div class="form-actions">
        <button type="button" class="btn btn-ghost" id="set-cancel">Cancel</button>
        <button type="button" class="btn btn-primary" id="set-save">Save board settings</button>
      </div>
    </section>`;
  };

  box.oninput = (e) => {
    const li = e.target.closest('li[data-i]');
    if (li && e.target.matches('[data-stage-label]')) state.stages[Number(li.dataset.i)].label = e.target.value;
    if (e.target.id === 'kinds') state.kinds = e.target.value.split('\n').map((s) => s.trim()).filter(Boolean);
  };
  box.onchange = (e) => {
    const li = e.target.closest('li[data-i]');
    if (li && e.target.matches('[data-stage-kind]')) state.stages[Number(li.dataset.i)].kind = e.target.value;
    if (e.target.id === 'income-sheet') {
      const sheet = sheets.find((s) => s.id === e.target.value);
      state.income = sheet ? { sheet: sheet.id, columns: mapColumns(sheet) } : {};
      draw();
    }
  };
  box.onclick = async (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const li = btn.closest('li[data-i]');
    const i = li ? Number(li.dataset.i) : -1;
    if (btn.dataset.stageMove) {
      const to = i + Number(btn.dataset.stageMove);
      [state.stages[i], state.stages[to]] = [state.stages[to], state.stages[i]];
      draw();
    } else if (btn.hasAttribute('data-stage-del')) {
      if (state.stages.length === 1) return alert('The board needs at least one stage.');
      if (!confirm(`Delete the stage "${state.stages[i].label}"? Its cards move to the first stage.`)) return;
      state.stages.splice(i, 1);
      draw();
    } else if (btn.id === 'stage-add') {
      state.stages.push({ key: keyFor('New stage'), label: 'New stage', kind: 'open' });
      draw();
      [...box.querySelectorAll('[data-stage-label]')].pop()?.select();
    } else if (btn.id === 'set-cancel') {
      box.innerHTML = '';
      onDone();
    } else if (btn.id === 'set-save') {
      if (state.stages.some((s) => !s.label.trim())) {
        box.querySelector('#set-errors').innerHTML = errorBox(new Error('Every stage needs a name.'));
        return;
      }
      btn.disabled = true;
      try {
        // Keep whatever income sheet was set if this person can't see Finances.
        const income = sheets.length ? state.income : current.income;
        await api.saveSponsorSettings({ ...(config.sponsors || {}), stages: state.stages.map((s) => ({ ...s, label: s.label.trim() })), kinds: state.kinds, income });
        await reloadConfig();
        setFlash('Board settings saved.');
        rerender();
      } catch (err) {
        box.querySelector('#set-errors').innerHTML = errorBox(err);
        btn.disabled = false;
      }
    }
  };
  draw();
}

// ---- One card ------------------------------------------------------------------------------

export async function renderSponsorCard(el, { config, params, rerender }) {
  let card;
  try {
    card = await api.getSponsorCard(params.id);
  } catch (err) {
    el.innerHTML = `<a class="back-link" href="#/sponsors">← Sponsors board</a><div class="empty">${esc(err.message)}</div>`;
    return;
  }
  const { stages, kinds } = sponsorSettings(config);
  const [{ all: people, viewers }, cards] = await Promise.all([boardPeople(), api.listSponsorCards()]);
  const nameOf = (id) => people.find((p) => p.id === id)?.full_name || 'Someone';
  const stageLabel = (k) => stages.find((s) => s.key === k)?.label || k;
  const editable = canEdit();
  const me = auth.user.id;
  const watching = card.watchers.includes(me);
  const renewedFrom = cards.find((c) => c.id === card.renewed_from);
  const renewals = cards.filter((c) => c.renewed_from === card.id);
  // Similar sponsors (other cards with a shared tag or the same type), most in common first.
  const similar = cards
    .filter((c) => c.id !== card.id && c.id !== card.renewed_from && c.renewed_from !== card.id)
    .map((c) => ({ c, score: (c.tags || []).filter((t) => (card.tags || []).includes(t)).length * 2 + (c.kind && c.kind === card.kind ? 1 : 0) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);
  const nextSeason = (() => {
    const y = Number(String(card.season || config.season).split('-')[0]);
    return y ? `${y + 1}-${y + 2}` : '';
  })();

  const field = (label, html, wide = false) => `<div class="field ${wide ? 'span-2' : ''}"><label>${label}</label>${html}</div>`;
  const input = (name, value, attrs = '') => `<input name="${name}" value="${esc(value ?? '')}" ${attrs}>`;
  const read = (v) => `<div class="read-value">${v || '<span class="muted">—</span>'}</div>`;

  el.innerHTML = `
    ${takeFlash()}
    <a class="back-link" href="#/sponsors">← Sponsors board</a>
    <div class="page-header">
      <div>
        <p class="eyebrow">${esc(card.season || '')}${card.kind ? ` · ${esc(card.kind)}` : ''}</p>
        <h1>${esc(card.name)}</h1>
        <p class="subtitle"><span class="badge tone-blue">${esc(stageLabel(card.stage))}</span>
          ${card.amount !== null ? `<strong>${fmtMoney(card.amount)}</strong>` : ''}
          ${renewedFrom ? `<span class="muted small">Renewed from <a href="#/sponsors/${esc(renewedFrom.id)}">${esc(renewedFrom.season)}</a></span>` : ''}
          ${renewals.map((r) => `<span class="muted small">Renewed for <a href="#/sponsors/${esc(r.id)}">${esc(r.season)}</a></span>`).join('')}</p>
      </div>
      <div class="card-actions">
        <button type="button" class="btn" id="watch">${watching ? '👁 Watching · Stop' : '👁 Watch'}</button>
        ${editable && nextSeason && !renewals.some((r) => r.season === nextSeason) ? `<button type="button" class="btn" id="renew">Renew for ${esc(nextSeason)}</button>` : ''}
      </div>
    </div>
    <div id="card-errors"></div>
    <div class="detail-layout">
      <div>
        <form id="card-form" novalidate>
          <section class="card">
            <h2>Details</h2>
            <div class="form-grid">
              ${editable ? field('Name', input('name', card.name, 'maxlength="120" required'), true) : ''}
              ${field('Stage', editable ? `<select name="stage">${stages.map((s) => `<option value="${esc(s.key)}" ${s.key === card.stage ? 'selected' : ''}>${esc(s.label)}</option>`).join('')}</select>` : read(esc(stageLabel(card.stage))))}
              ${field('Type', editable ? `<select name="kind"><option value=""></option>${[...new Set([...kinds, ...(card.kind ? [card.kind] : [])])].map((k) => `<option ${k === card.kind ? 'selected' : ''}>${esc(k)}</option>`).join('')}</select>` : read(esc(card.kind)))}
              ${field('Amount ($)', editable ? input('amount', card.amount ?? '', 'inputmode="decimal" placeholder="e.g. 2500"') : read(card.amount !== null ? fmtMoney(card.amount) : ''))}
              ${field('Season', editable ? input('season', card.season, 'maxlength="9"') : read(esc(card.season)))}
              ${field('Lead', editable ? `<select name="owner_id"><option value="">Nobody yet</option>${people.map((p) => `<option value="${esc(p.id)}" ${p.id === card.owner_id ? 'selected' : ''}>${esc(p.full_name || p.email)}</option>`).join('')}</select>` : read(esc(card.owner_id ? nameOf(card.owner_id) : '')))}
              ${field('Follow up on', editable ? input('follow_up', card.follow_up ?? '', 'type="date"') : read(card.follow_up ? fmtDate(card.follow_up) : ''))}
              ${field('Tags <span class="muted small">(comma-separated, e.g. aerospace, local, alumni)</span>', editable ? input('tags', (card.tags || []).join(', ')) : read((card.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join(' ')), true)}
            </div>
            <h3 class="sub-heading">Contact</h3>
            <div class="form-grid">
              ${field('Name', editable ? input('contact_name', card.contact_name) : read(esc(card.contact_name)))}
              ${field('Email', editable ? input('contact_email', card.contact_email, 'type="email"') : read(card.contact_email ? `<a href="mailto:${esc(card.contact_email)}">${esc(card.contact_email)}</a>` : ''))}
              ${field('Phone', editable ? input('contact_phone', card.contact_phone, 'type="tel"') : read(esc(card.contact_phone)))}
              ${field('Website', editable ? input('website', card.website, 'type="url" placeholder="https://"') : read(/^https?:\/\//.test(card.website) ? `<a href="${esc(card.website)}" target="_blank" rel="noopener">${esc(card.website)}</a>` : esc(card.website)))}
            </div>
          </section>
          <section class="card">
            <h2>About this sponsor</h2>
            ${editable
              ? `<textarea name="description" rows="7" placeholder="Who they are, what they gave or offered, what they asked for in return (logo on the car, social posts, a report…), deadlines and paperwork.">${esc(card.description)}</textarea>`
              : `<div class="rich">${card.description ? renderRichText(card.description) : '<p class="muted">Nothing written yet.</p>'}</div>`}
          </section>
          <section class="card playbook">
            <h2>Tips for next time</h2>
            <p class="muted small">For future teams: how we found them, who to ask, when to ask, what worked and what didn't.</p>
            ${editable
              ? `<textarea name="playbook" rows="6" placeholder="e.g. Ask in August, before their budget closes. Jane in Community Relations decides. They liked the team photo with their logo.">${esc(card.playbook)}</textarea>`
              : `<div class="rich">${card.playbook ? renderRichText(card.playbook) : '<p class="muted">Nothing written yet.</p>'}</div>`}
          </section>
          ${editable ? `<div class="form-actions sticky-actions">
            <span class="muted small" id="card-dirty" hidden>Unsaved changes</span>
            <button type="button" class="btn btn-danger reset-btn" id="delete-card">Delete card</button>
            <button type="submit" class="btn btn-primary" id="save-card" disabled>Save</button>
          </div>` : ''}
        </form>

        <section class="card">
          <h2>Notes &amp; history</h2>
          <form id="comment-form" class="comment-form" novalidate>
            <textarea id="comment" rows="2" placeholder="Add a note: a call, an email, what they said…" aria-label="Add a note"></textarea>
            <button type="submit" class="btn btn-sm">Add note</button>
          </form>
          <ol class="timeline sponsor-timeline">${card.activity
            .map((a) => {
              const what = {
                created: 'Added the card',
                moved: `Moved from <strong>${esc(stageLabel(a.from_stage))}</strong> to <strong>${esc(stageLabel(a.to_stage))}</strong>`,
                edited: esc(a.body),
                comment: '',
                income: esc(a.body),
                renewed: esc(a.body),
              }[a.kind];
              return `<li class="tl-${esc(a.kind)}">
                <div><strong>${esc(a.actor_name || 'Someone')}</strong> ${what}</div>
                ${a.kind === 'comment' ? `<blockquote>${esc(a.body)}</blockquote>` : ''}
                <div class="muted small">${fmtDateTime(a.created_at)}</div>
              </li>`;
            })
            .join('')}</ol>
        </section>
      </div>

      <aside class="detail-side">
        <section class="card">
          <h2>Watchers</h2>
          <p class="muted small">Get an email / Teams message when this card moves or gets a note.</p>
          <ul class="watcher-list">${card.watchers
            .map((id) => `<li><span class="avatar">${esc(initials(nameOf(id)))}</span>${esc(nameOf(id))}${
              editable || id === me ? ` <button type="button" class="icon-btn" data-unwatch="${esc(id)}" aria-label="Remove ${esc(nameOf(id))}">&times;</button>` : ''}</li>`)
            .join('') || '<li class="muted small">Nobody yet.</li>'}</ul>
          ${editable ? `<select id="add-watcher" aria-label="Add a watcher"><option value="">+ Add a watcher…</option>${viewers
            .filter((p) => !card.watchers.includes(p.id))
            .map((p) => `<option value="${esc(p.id)}">${esc(p.full_name || p.email)}</option>`)
            .join('')}</select>` : ''}
        </section>
        ${similar.length ? `<section class="card">
          <h2>Similar sponsors</h2>
          <ul class="similar-list">${similar
            .map(({ c }) => `<li><a href="#/sponsors/${esc(c.id)}">${esc(c.name)}</a> <span class="muted small">${esc(c.season)} · ${esc(stageLabel(c.stage))}${c.amount ? ` · ${fmtMoney(c.amount)}` : ''}</span></li>`)
            .join('')}</ul>
        </section>` : ''}
        <section class="card small muted">Added ${fmtDate(card.created_at)}${card.created_by ? ` by ${esc(nameOf(card.created_by))}` : ''}.</section>
      </aside>
    </div>`;

  const errors = el.querySelector('#card-errors');
  const form = el.querySelector('#card-form');
  let dirty = false;
  const markDirty = () => {
    dirty = true;
    el.querySelector('#save-card').disabled = false;
    el.querySelector('#card-dirty').hidden = false;
  };
  if (editable) {
    form.addEventListener('input', markDirty);
    form.addEventListener('change', markDirty);
    guardLeaving(el, () => dirty);
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!editable) return;
    const data = Object.fromEntries(new FormData(form));
    const fields = {
      ...data,
      amount: String(data.amount || '').replace(/[$,\s]/g, ''),
      tags: String(data.tags || '').split(',').map((t) => t.trim()).filter(Boolean),
    };
    const btn = el.querySelector('#save-card');
    btn.disabled = true;
    try {
      await api.saveSponsorCard(card.id, fields);
      dirty = false;
      releaseGuard();
      setFlash('Saved.');
      rerender();
    } catch (err) {
      errors.innerHTML = errorBox(err);
      errors.scrollIntoView({ behavior: 'smooth' });
      btn.disabled = false;
    }
  });

  el.querySelector('#comment-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const box = el.querySelector('#comment');
    if (!box.value.trim()) return;
    if (dirty && !confirm('You have unsaved changes to the details. Add the note anyway? (Your other changes will be lost.)')) return;
    try {
      await api.addSponsorComment(card.id, box.value);
      dirty = false;
      releaseGuard();
      rerender();
    } catch (err) {
      errors.innerHTML = errorBox(err);
    }
  });

  el.addEventListener('change', async (e) => {
    if (e.target.id !== 'add-watcher' || !e.target.value) return;
    try {
      await api.setSponsorWatch(card.id, e.target.value, true);
      if (!dirty) rerender();
    } catch (err) {
      errors.innerHTML = errorBox(err);
    }
  });

  el.addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    try {
      if (btn.id === 'watch') {
        await api.setSponsorWatch(card.id, me, !watching);
        return rerender();
      }
      if (btn.dataset.unwatch) {
        await api.setSponsorWatch(card.id, btn.dataset.unwatch, false);
        return rerender();
      }
      if (btn.id === 'renew') {
        if (!confirm(`Add ${card.name} to the ${nextSeason} board? Contacts, notes, tips and watchers are copied; it starts at "${stages[0].label}".`)) return;
        const id = await api.renewSponsorCard(card.id, nextSeason);
        setFlash(`Added ${card.name} to ${nextSeason}.`);
        location.hash = `#/sponsors/${id}`;
        return;
      }
      if (btn.id === 'delete-card') {
        if (!confirm(`Delete ${card.name} and its whole history? This can't be undone.\n\nTip: moving it to "${stages.find((s) => s.kind === 'lost')?.label || 'Not this year'}" keeps the history for future teams.`)) return;
        await api.deleteSponsorCard(card.id);
        dirty = false;
        releaseGuard();
        setFlash(`Deleted ${card.name}.`);
        location.hash = '#/sponsors';
      }
    } catch (err) {
      errors.innerHTML = errorBox(err);
    }
  });
}

/** For Home: open cards you lead or watch whose follow-up date has come. */
export async function sponsorFollowUps(config) {
  if (!auth.can('sponsors.view') && !auth.can('sponsors.edit')) return [];
  const { stages } = sponsorSettings(config);
  const me = auth.user.id;
  const cards = await api.listSponsorCards().catch(() => []);
  return cards
    .filter((c) => c.follow_up && c.follow_up <= today() && isOpen(stages, c) && (c.owner_id === me || c.watchers.includes(me)))
    .sort((a, b) => a.follow_up.localeCompare(b.follow_up));
}
