/** Requests page: every request, filterable by status and subsystem. */
import { api } from '../api.js';
import { auth } from '../auth.js';
import { esc, requestTable, COLUMNS, bindRowLinks, takeFlash } from '../ui.js';

// Filters persist while navigating around the app (not across reloads).
const filters = { owner: '', status: '', subsystem: '', q: '' };

export async function renderRequestList(el, { config }) {
  const all = await api.listRequests();
  const options = (list, selected) =>
    list.map((v) => `<option value="${esc(v)}" ${v === selected ? 'selected' : ''}>${esc(v)}</option>`).join('');

  el.innerHTML = `
    ${takeFlash()}
    <div class="page-header">
      <div>
        <h1>Requests</h1>
        <p class="subtitle">All purchase requests for the ${esc(config.season)} season.</p>
      </div>
      <a class="btn btn-primary" href="#/new">+ New Request</a>
    </div>
    <div class="toolbar">
      <input type="search" id="q" placeholder="Search ID, title, requester, vendor…" value="${esc(filters.q)}" aria-label="Search">
      <select id="owner" aria-label="Whose requests"><option value="">Everyone</option><option value="mine" ${filters.owner === 'mine' ? 'selected' : ''}>My requests</option></select>
      <select id="status" aria-label="Status filter"><option value="">All statuses</option>${options(config.statuses, filters.status)}</select>
      <select id="subsystem" aria-label="Subsystem filter"><option value="">All subsystems</option>${options(config.subsystems, filters.subsystem)}</select>
      <span class="muted" id="count"></span>
    </div>
    <div id="results"></div>`;

  const columns = [COLUMNS.id, COLUMNS.title, COLUMNS.requester, COLUMNS.subsystem, COLUMNS.total, COLUMNS.status, COLUMNS.neededBy];

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
      all.length ? 'No requests match these filters.' : 'No requests yet. Create the first one with “New Request”.'
    );
  };

  for (const key of ['q', 'owner', 'status', 'subsystem']) {
    el.querySelector(`#${key}`).addEventListener('input', (e) => {
      filters[key] = e.target.value;
      apply();
    });
  }

  bindRowLinks(el);
  apply();
}
