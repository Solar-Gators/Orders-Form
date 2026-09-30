/**
 * Chief Engineer queue: every Submitted request (sortable).
 * Columns and the default sort come from Admin → Lists.
 */
import { api } from '../api.js';
import { auth } from '../auth.js';
import { STATUS, fmtMoney, requestTable, bindRowLinks, bindSorting, takeFlash, introText } from '../ui.js';
import { listColumns, listSort } from '../listColumns.js';
import { rememberedSort } from './listSortState.js';

export async function renderApprovals(el, { config }) {
  const rows = await api.listRequests(STATUS.SUBMITTED);
  const total = rows.reduce((s, r) => s + r.total, 0);
  const columns = listColumns('approvals', config);
  const sort = rememberedSort('approvals', listSort('approvals', config), columns);

  el.innerHTML = `
    ${takeFlash()}
    <div class="page-header">
      <div>
        <h1>Approvals</h1>
        ${introText('approvals', '') ? `<p class="page-intro">${introText('approvals', '')}</p>` : ''}
        <p class="subtitle">${rows.length} request${rows.length === 1 ? '' : 's'} awaiting review · ${fmtMoney(total)} total.</p>
      </div>
    </div>
    ${auth.can('request.review') ? '' : '<div class="alert alert-info">View only — only a <strong>Chief Engineer</strong> can approve, reject, or request changes.</div>'}
    <div id="queue"></div>`;

  const queue = el.querySelector('#queue');
  const draw = () => (queue.innerHTML = requestTable(rows, columns, 'No requests are waiting for approval.', sort));
  bindSorting(queue, sort, columns, draw);
  bindRowLinks(el);
  draw();
}
