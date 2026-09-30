/**
 * Archive: past seasons, searchable. Two sources, shown together:
 *   • old order sheets imported from Excel (click a row to see every original column)
 *   • requests made in this app in earlier seasons (click a row to open the request)
 * Imports are managed in Admin → Import; seasons roll over in Admin → Settings.
 */
import { api } from '../api.js';
import { auth } from '../auth.js';
import { esc, fmtMoney, fmtDate, introText } from '../ui.js';

// Filters persist while moving around the app.
const filters = { q: '', season: '', subteam: '', status: '' };
const PAGE = 200;

/** One archive row per item of a past-season request, shaped like an imported sheet row. */
function fromRequests(requests) {
  return requests.flatMap((r) =>
    (r.items.length ? r.items : [{}]).map((i, idx) => ({
      id: `app-${r.id}-${idx}`,
      app: true,
      request_number: r.request_number,
      season: r.season,
      order_date: (r.created_at || '').slice(0, 10),
      requester: r.requester,
      subteam: r.subsystem,
      item: i.item_name || r.title,
      cost: i.item_total ?? null,
      status: r.status,
      ticket: r.order?.department_order_number || '',
      _search: [r.request_number, r.title, r.requester, r.subsystem, r.justification, r.status, r.order?.department_order_number,
        i.item_name, i.vendor, i.part_number, i.product_link, i.notes, ...Object.values(r.data || {}), ...Object.values(i.data || {})]
        .filter(Boolean).join(' ').toLowerCase(),
    }))
  );
}

export async function renderArchive(el, { config }) {
  const [imports, sheetRows, pastRequests] = await Promise.all([
    api.listArchiveImports(),
    api.listArchive(),
    api.listRequests(null, { notSeason: config.season }),
  ]);
  const columnsByImport = Object.fromEntries(imports.map((i) => [i.id, i.columns]));
  for (const r of sheetRows) r._search = Object.values(r.fields).join(' ').toLowerCase();
  const rows = [...fromRequests(pastRequests), ...sheetRows];
  const seasons = [...new Set(rows.map((r) => r.season))].sort().reverse();

  if (!rows.length) {
    el.innerHTML = `
      <div class="page-header"><div><h1>Archive</h1><p class="subtitle">Past seasons' orders.</p></div></div>
      <div class="empty">Nothing here yet. Past seasons show up once a new season starts, or when old spreadsheets are imported.${
        auth.can('settings.edit') ? ' Add them in <a href="#/admin/import">Admin → Import</a>.' : ''
      }</div>`;
    return;
  }

  const options = (list, selected, all) =>
    `<option value="">${all}</option>` +
    list.map((v) => `<option value="${esc(v)}" ${v === selected ? 'selected' : ''}>${esc(v)}</option>`).join('');
  const distinct = (key) => [...new Set(rows.map((r) => r[key]).filter(Boolean))].sort((a, b) => a.localeCompare(b));

  el.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Archive</h1>
        <p class="subtitle">${introText('archive', `Orders from past seasons (${seasons.map(esc).join(', ')}). Imported spreadsheet rows show every original column; requests made on this site open their full page.`)}</p>
      </div>
    </div>
    <div class="toolbar">
      <input type="search" id="q" placeholder="Search anything: item, vendor, part #, person, ticket…" value="${esc(filters.q)}" aria-label="Search the archive">
      <select id="season" aria-label="Season">${options(seasons, filters.season, 'All seasons')}</select>
      <select id="subteam" aria-label="Subteam">${options(distinct('subteam'), filters.subteam, 'All subteams')}</select>
      <select id="status" aria-label="Order status">${options(distinct('status'), filters.status, 'Any status')}</select>
    </div>
    <p class="muted small" id="summary"></p>
    <div id="results"></div>`;

  let limit = PAGE;

  const detail = (r) => {
    const cols = columnsByImport[r.import_id] || Object.keys(r.fields);
    const cells = cols
      .filter((c) => r.fields[c])
      .map((c) => {
        const v = r.fields[c];
        const url = v.match(/https?:\/\/\S+/)?.[0]?.replace(/[)\]]+$/, '');
        return `<div><dt>${esc(c)}</dt><dd>${esc(v)}${url ? ` <a href="${esc(url)}" target="_blank" rel="noopener noreferrer">↗</a>` : ''}</dd></div>`;
      })
      .join('');
    return `<tr class="archive-detail"><td colspan="8"><dl class="meta-grid">${cells}</dl>
      <p class="muted small">${esc(r.season)} · row ${r.row_number} of the original sheet</p></td></tr>`;
  };

  const apply = () => {
    const words = filters.q.toLowerCase().split(/\s+/).filter(Boolean);
    const hits = rows.filter(
      (r) =>
        (!filters.season || r.season === filters.season) &&
        (!filters.subteam || r.subteam === filters.subteam) &&
        (!filters.status || r.status === filters.status) &&
        words.every((w) => r._search.includes(w))
    );
    const total = hits.reduce((s, r) => s + (Number(r.cost) || 0), 0);
    el.querySelector('#summary').textContent = `${hits.length} of ${rows.length} rows · ${fmtMoney(total)} gross cost`;

    const shown = hits.slice(0, limit);
    el.querySelector('#results').innerHTML = hits.length
      ? `<div class="table-wrap"><table class="table archive-table stack-mobile">
          <thead><tr><th>Season</th><th>Date</th><th>Requester</th><th>Subteam</th><th>Item</th>
            <th class="num">Cost</th><th>Status</th><th>Ticket</th></tr></thead>
          <tbody>${shown
            .map(
              (r) => `<tr class="clickable" data-id="${esc(r.id)}" tabindex="0" aria-expanded="false">
                <td class="nowrap" data-label="Season">${esc(r.season)}</td>
                <td class="nowrap" data-label="Date">${r.order_date ? fmtDate(r.order_date) : esc(r.fields?.Date || '—')}</td>
                <td data-label="Requester">${esc(r.requester || '—')}</td>
                <td data-label="Subteam">${esc(r.subteam || '—')}</td>
                <td class="cell-title cell-primary" data-label="">${esc(r.item || '—')}${r.app ? ` <span class="mono small muted">${esc(r.request_number)}</span>` : ''}</td>
                <td class="num" data-label="Cost">${r.cost === null ? '—' : fmtMoney(r.cost)}</td>
                <td data-label="Status">${esc(r.status || '—')}</td>
                <td data-label="Ticket">${esc(r.ticket || '—')}</td>
              </tr>`
            )
            .join('')}</tbody></table></div>
        ${hits.length > limit ? `<p class="center"><button type="button" class="btn" id="more">Show ${Math.min(PAGE, hits.length - limit)} more</button></p>` : ''}`
      : '<div class="empty">No archived orders match.</div>';
  };

  const toggle = (tr) => {
    const row = rows.find((r) => r.id === tr.dataset.id);
    if (row.app) {
      location.hash = `#/requests/${row.request_number}`; // made on this site: open the full request
      return;
    }
    const open = tr.nextElementSibling?.classList.contains('archive-detail');
    if (open) tr.nextElementSibling.remove();
    else tr.insertAdjacentHTML('afterend', detail(row));
    tr.setAttribute('aria-expanded', String(!open));
  };

  el.addEventListener('click', (e) => {
    if (e.target.id === 'more') {
      limit += PAGE;
      apply();
      return;
    }
    if (e.target.closest('a')) return;
    const tr = e.target.closest('tr[data-id]');
    if (tr) toggle(tr);
  });
  el.addEventListener('keydown', (e) => {
    const tr = e.target.closest?.('tr[data-id]');
    if (tr && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      toggle(tr);
    }
  });
  for (const key of ['q', 'season', 'subteam', 'status']) {
    el.querySelector(`#${key}`).addEventListener('input', (e) => {
      filters[key] = e.target.value;
      limit = PAGE;
      apply();
    });
  }

  apply();
}
