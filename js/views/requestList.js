/** Requests page: this season's requests (or a past season), filterable. */
import { api } from '../api.js';
import { auth } from '../auth.js';
import { esc, requestTable, COLUMNS, bindRowLinks, bindSorting, takeFlash } from '../ui.js';

// Filters persist while navigating around the app (not across reloads).
// season '' means "the current season".
const filters = { season: '', owner: '', status: '', subsystem: '', q: '' };
const sort = { key: 'requested', dir: 'desc' }; // newest first until a header is clicked

export async function renderRequestList(el, { config, rerender }) {
  const season = filters.season || config.season;
  const [all, seasons] = await Promise.all([api.listRequests(null, { season }), api.listSeasons()]);
  const seasonList = [...new Set([config.season, ...seasons])].filter(Boolean).sort().reverse();
  const isCurrent = season === config.season;
  const options = (list, selected) =>
    list.map((v) => `<option value="${esc(v)}" ${v === selected ? 'selected' : ''}>${esc(v)}</option>`).join('');

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
      <input type="search" id="q" placeholder="Search ID, title, requester, vendor…" value="${esc(filters.q)}" aria-label="Search">
      ${seasonList.length > 1 ? `<select id="season" aria-label="Season">${options(seasonList, season)}</select>` : ''}
      <select id="owner" aria-label="Whose requests"><option value="">Everyone</option><option value="mine" ${filters.owner === 'mine' ? 'selected' : ''}>My requests</option></select>
      <select id="status" aria-label="Status filter"><option value="">All statuses</option>${options(config.statuses, filters.status)}</select>
      <select id="subsystem" aria-label="Subsystem filter"><option value="">All subsystems</option>${options(config.subsystems, filters.subsystem)}</select>
      <span class="muted" id="count"></span>
    </div>
    <div id="results"></div>`;

  const columns = [COLUMNS.requested, COLUMNS.title, COLUMNS.requester, COLUMNS.subsystem, COLUMNS.total, COLUMNS.status, COLUMNS.neededBy];

  const apply = () => {
    const q = filters.q.toLowerCase();
    const rows = all.filter(
      (r) =>
        (!filters.owner || r.created_by === auth.user.id) &&
        (!filters.status || r.status === filters.status) &&
        (!filters.subsystem || r.subsystem === filters.subsystem) &&
        (!q || [r.request_number, r.title, r.requester, ...r.vendors].join(' ').toLowerCase().includes(q))
    );
    el.querySelector('#count').textContent = `${rows.length} of ${all.length}`;
    el.querySelector('#results').innerHTML = requestTable(
      rows,
      columns,
      all.length ? 'No requests match these filters.' : isCurrent ? 'No requests yet this season. Create one with “New Request”.' : 'No requests in this season.',
      sort
    );
  };

  for (const key of ['q', 'owner', 'status', 'subsystem']) {
    el.querySelector(`#${key}`).addEventListener('input', (e) => {
      filters[key] = e.target.value;
      apply();
    });
  }
  // Changing season loads that season's requests.
  el.querySelector('#season')?.addEventListener('change', (e) => {
    filters.season = e.target.value === config.season ? '' : e.target.value;
    rerender();
  });
  el.querySelector('#back-current')?.addEventListener('click', (e) => {
    e.preventDefault();
    filters.season = '';
    rerender();
  });

  bindSorting(el.querySelector('#results'), sort, columns, apply);
  bindRowLinks(el);
  apply();
}
