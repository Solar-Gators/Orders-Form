/** Export page: status summary + in-browser .xlsx download. */
import { api } from '../api.js';
import { downloadWorkbook } from '../excel.js';
import { esc, fmtMoney, statusBadge, errorBox } from '../ui.js';

// '' = current season, 'all' = every season, otherwise a season like 2026-2027.
let pick = '';

export async function renderExport(el, { config, rerender }) {
  const seasons = [...new Set([config.season, ...(await api.listSeasons())])].filter(Boolean).sort().reverse();
  const season = pick === 'all' ? null : pick || config.season;
  const load = () => api.listRequests(null, season ? { season } : {});
  const all = await load();
  const itemCount = all.reduce((s, r) => s + Math.max(r.items.length, 1), 0);

  const rows = config.statuses
    .map((status) => {
      const group = all.filter((r) => r.status === status);
      return `<tr>
        <td>${statusBadge(status)}</td>
        <td class="num">${group.length}</td>
        <td class="num">${fmtMoney(group.reduce((s, r) => s + r.total, 0))}</td>
      </tr>`;
    })
    .join('');

  el.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Export</h1>
        <p class="subtitle">Download requests and items as an Excel workbook.</p>
      </div>
      <div class="field export-season">
        <label for="export-season">Season</label>
        <select id="export-season">
          ${seasons.map((s) => `<option value="${esc(s)}" ${s === season ? 'selected' : ''}>${esc(s)}${s === config.season ? ' (current)' : ''}</option>`).join('')}
          <option value="all" ${season ? '' : 'selected'}>All seasons</option>
        </select>
      </div>
    </div>

    <div class="export-layout">
      <section class="card">
        <h2>Excel export</h2>
        <p>The workbook has <strong>one row per item</strong> (${itemCount} row${itemCount === 1 ? '' : 's'} from ${all.length} request${all.length === 1 ? '' : 's'}).
           Request details, approval, order, and delivery information are repeated on each row so you can filter and pivot freely.</p>
        <p class="muted">Includes bold headers, filters, a frozen header row, and currency/date formatting.</p>
        <div id="export-errors"></div>
        <button type="button" class="btn btn-primary btn-lg" id="download">Download .xlsx</button>
      </section>

      <section class="card">
        <h2>Summary</h2>
        <div class="table-wrap flat">
          <table class="table">
            <thead><tr><th>Status</th><th class="num">Requests</th><th class="num">Total</th></tr></thead>
            <tbody>${rows}</tbody>
            <tfoot><tr><td><strong>All</strong></td><td class="num"><strong>${all.length}</strong></td>
              <td class="num"><strong>${fmtMoney(all.reduce((s, r) => s + r.total, 0))}</strong></td></tr></tfoot>
          </table>
        </div>
      </section>
    </div>`;

  el.querySelector('#export-season').addEventListener('change', (e) => {
    pick = e.target.value === config.season ? '' : e.target.value;
    rerender();
  });

  const button = el.querySelector('#download');
  button.addEventListener('click', async () => {
    button.disabled = true;
    button.textContent = 'Preparing…';
    try {
      await downloadWorkbook(await load(), { ...config, season: season || 'All-seasons' }); // re-fetch so the file is current
    } catch (err) {
      el.querySelector('#export-errors').innerHTML = errorBox(err);
    } finally {
      button.disabled = false;
      button.textContent = 'Download .xlsx';
    }
  });
}
