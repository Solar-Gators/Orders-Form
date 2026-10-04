/**
 * Requests page: this season's requests (or a past season), filterable and sortable.
 * Columns, filters and the default sort come from Admin → Lists (js/listColumns.js).
 * On top: your own requests that need you (from any season), and a welcome for
 * people who haven't made a request yet.
 */
import { api } from '../api.js';
import { auth } from '../auth.js';
import { esc, requestTable, bindRowLinks, bindSorting, sortRows, statusBadge, takeFlash, introText } from '../ui.js';
import { listColumns, listSort, listFilters } from '../listColumns.js';

// Kept while navigating around the app (not across reloads).
// season '' means "the current season"; values holds each filter's choice.
const state = { season: '', q: '', values: {}, sort: null, sortFrom: '' };
const PAGE = 100;

/** Everything a search can match: IDs, names, vendors, items, part numbers, ticket #, custom answers. */
function searchText(r) {
  return [
    r.request_number, r.title, r.requester, ...r.vendors, ...Object.values(r.data || {}),
    r.order?.department_order_number,
    ...r.items.flatMap((i) => [i.item_name, i.part_number, ...Object.values(i.data || {})]),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

export async function renderRequestList(el, { config, rerender }) {
  const season = state.season || config.season;
  const [all, seasons, mine] = await Promise.all([
    api.listRequests(null, { season }),
    api.listSeasons(),
    api.listMyUnfinished(auth.user.id),
  ]);
  const seasonList = [...new Set([config.season, ...seasons])].filter(Boolean).sort().reverse();
  const isCurrent = season === config.season;
  for (const r of all) r._search = searchText(r);

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

  // Your requests that need you: sent back for changes first, then drafts. Any season.
  const needsYou = [...mine].sort((a, b) => (a.status === b.status ? 0 : a.status === 'Changes Requested' ? -1 : 1));
  const needsYouStrip = needsYou.length
    ? `<section class="card needs-you">
        <h2>Needs your action</h2>
        <ul class="needs-list">${needsYou
          .map(
            (r) => `<li>
              <a href="#/requests/${esc(r.request_number)}"><span class="mono small">${esc(r.request_number)}</span> ${esc(r.title || 'Untitled request')}</a>
              ${statusBadge(r.status)}
              <span class="muted small">${r.status === 'Changes Requested' ? `${esc(r.latest_approval?.approver || 'A reviewer')} asked for changes` : 'Not submitted yet'}${r.season && r.season !== config.season ? ` · ${esc(r.season)} season` : ''}</span>
            </li>`
          )
          .join('')}</ul>
      </section>`
    : '';

  // First visit: nothing of yours anywhere yet (checked across the season you're looking at).
  const neverRequested = !mine.length && !all.some((r) => r.created_by === auth.user.id) && isCurrent;
  const welcome = neverRequested && !auth.can('request.review') && !auth.can('request.order')
    ? `<div class="alert alert-info small welcome-hint">First time using the Order Form? <a href="#/home">See how ordering works</a>
        (you can always get back there by clicking the logo).</div>`
    : '';

  el.innerHTML = `
    ${takeFlash()}
    <div class="page-header">
      <div>
        <h1>Requests</h1>
        <p class="subtitle">${isCurrent ? introText('requests', `Purchase requests for the ${esc(season)} season.`) : `Past season: ${esc(season)}.`}</p>
      </div>
      <a class="btn btn-primary" href="#/new">+ New Request</a>
    </div>
    ${welcome}
    ${needsYouStrip}
    ${isCurrent ? '' : `<div class="alert alert-info small">You're looking at <strong>${esc(season)}</strong>. <a href="#" id="back-current">Back to ${esc(config.season)}</a></div>`}
    <div class="toolbar">
      <input type="search" id="q" placeholder="Search ID, title, person, vendor, item, part #, ticket #…" value="${esc(state.q)}" aria-label="Search">
      ${seasonList.length > 1 ? `<select id="season" aria-label="Season">${seasonList.map((s) => `<option value="${esc(s)}" ${s === season ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select>` : ''}
      ${filters.map(select).join('')}
      <span class="muted" id="count"></span>
    </div>
    <div id="results"></div>`;

  let limit = PAGE;
  const apply = () => {
    const words = state.q.toLowerCase().split(/\s+/).filter(Boolean);
    const ctx = { userId: auth.user.id };
    const rows = all.filter(
      (r) => filters.every((f) => !state.values[f.key] || f.match(r, state.values[f.key], ctx)) && words.every((w) => r._search.includes(w))
    );
    el.querySelector('#count').textContent = `${rows.length} of ${all.length}`;
    const results = el.querySelector('#results');
    if (!rows.length && state.values.owner === 'mine' && !all.some((r) => r.created_by === auth.user.id) && !words.length) {
      results.innerHTML = `<div class="empty">You haven't made a request ${isCurrent ? 'this season' : 'in this season'} yet.
        <div><a class="btn btn-primary btn-sm" href="#/new">+ New Request</a></div></div>`;
      return;
    }
    const sorted = sortRows(rows, columns, state.sort);
    results.innerHTML =
      requestTable(
        sorted.slice(0, limit),
        columns,
        all.length ? 'No requests match these filters.' : isCurrent ? 'No requests yet this season. Create one with “New Request”.' : 'No requests in this season.',
        state.sort
      ) + (rows.length > limit ? `<p class="center"><button type="button" class="btn" id="more">Show ${Math.min(PAGE, rows.length - limit)} more</button></p>` : '');
  };

  el.querySelector('#q').addEventListener('input', (e) => {
    state.q = e.target.value;
    limit = PAGE;
    apply();
  });
  el.querySelectorAll('[data-filter]').forEach((s) =>
    s.addEventListener('input', (e) => {
      state.values[e.target.dataset.filter] = e.target.value;
      limit = PAGE;
      apply();
    })
  );
  el.querySelector('#results').addEventListener('click', (e) => {
    if (e.target.id !== 'more') return;
    limit += PAGE;
    apply();
  });
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
