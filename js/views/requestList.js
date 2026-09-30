/**
 * Requests page: this season's requests (or a past season), filterable and sortable.
 * Columns, filters and the default sort come from Admin → Lists (js/listColumns.js).
 */
import { api } from '../api.js';
import { auth } from '../auth.js';
import { esc, requestTable, bindRowLinks, bindSorting, takeFlash } from '../ui.js';
import { listColumns, listSort, listFilters } from '../listColumns.js';

// Kept while navigating around the app (not across reloads).
// season '' means "the current season"; values holds each filter's choice.
const state = { season: '', q: '', values: {}, sort: null, sortFrom: '' };

export async function renderRequestList(el, { config, rerender }) {
  const season = state.season || config.season;
  const [all, seasons] = await Promise.all([api.listRequests(null, { season }), api.listSeasons()]);
  const seasonList = [...new Set([config.season, ...seasons])].filter(Boolean).sort().reverse();
  const isCurrent = season === config.season;

  const columns = listColumns('requests', config);
  const filters = listFilters(config);
  // Start from the configured default sort; re-apply it if an admin changes the default.
  const defaultSort = listSort('requests', config);
  const defaultKey = `${defaultSort.key}:${defaultSort.dir}`;
  if (!state.sort || state.sortFrom !== defaultKey || !columns.some((c) => c.key === state.sort.key)) {
    state.sort = { ...defaultSort };
    state.sortFrom = defaultKey;
  }

  const select = (f) => `
    <select data-filter="${esc(f.key)}" aria-label="${esc(f.label)}">
      <option value="">${esc(f.all)}</option>
      ${f.options.map(([v, label]) => `<option value="${esc(v)}" ${state.values[f.key] === v ? 'selected' : ''}>${esc(label)}</option>`).join('')}
    </select>`;

  el.innerHTML = `
    ${takeFlash()}
    <div class="page-header">
      <div>
        <h1>Requests</h1>
        <p class="subtitle">${isCurrent ? `Purchase requests for the ${esc(season)} season.` : `Past season: ${esc(season)}.`}</p>
      </div>
      <a class="btn btn-primary" href="#/new">+ New Request</a>
    </div>
    ${isCurrent ? '' : `<div class="alert alert-info small">You're looking at <strong>${esc(season)}</strong>. <a href="#" id="back-current">Back to ${esc(config.season)}</a></div>`}
    <div class="toolbar">
      <input type="search" id="q" placeholder="Search title, requester, vendor, ID…" value="${esc(state.q)}" aria-label="Search">
      ${seasonList.length > 1 ? `<select id="season" aria-label="Season">${seasonList.map((s) => `<option value="${esc(s)}" ${s === season ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select>` : ''}
      ${filters.map(select).join('')}
      <span class="muted" id="count"></span>
    </div>
    <div id="results"></div>`;

  const apply = () => {
    const q = state.q.toLowerCase();
    const ctx = { userId: auth.user.id };
    const rows = all.filter(
      (r) =>
        filters.every((f) => !state.values[f.key] || f.match(r, state.values[f.key], ctx)) &&
        (!q || [r.request_number, r.title, r.requester, ...r.vendors, ...Object.values(r.data || {})].join(' ').toLowerCase().includes(q))
    );
    el.querySelector('#count').textContent = `${rows.length} of ${all.length}`;
    el.querySelector('#results').innerHTML = requestTable(
      rows,
      columns,
      all.length ? 'No requests match these filters.' : isCurrent ? 'No requests yet this season. Create one with “New Request”.' : 'No requests in this season.',
      state.sort
    );
  };

  el.querySelector('#q').addEventListener('input', (e) => {
    state.q = e.target.value;
    apply();
  });
  el.querySelectorAll('[data-filter]').forEach((s) =>
    s.addEventListener('input', (e) => {
      state.values[e.target.dataset.filter] = e.target.value;
      apply();
    })
  );
  // Changing season loads that season's requests.
  el.querySelector('#season')?.addEventListener('change', (e) => {
    state.season = e.target.value === config.season ? '' : e.target.value;
    rerender();
  });
  el.querySelector('#back-current')?.addEventListener('click', (e) => {
    e.preventDefault();
    state.season = '';
    rerender();
  });

  bindSorting(el.querySelector('#results'), state.sort, columns, apply);
  bindRowLinks(el);
  apply();
}
