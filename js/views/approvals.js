/** Chief Engineer queue: every Submitted request, most urgent first (sortable). */
import { api } from '../api.js';
import { auth } from '../auth.js';
import { STATUS, fmtMoney, requestTable, COLUMNS, bindRowLinks, bindSorting, takeFlash } from '../ui.js';

// Sort order persists while moving around the app.
const sort = { key: 'neededBy', dir: 'asc' };
const columns = [COLUMNS.requested, COLUMNS.title, COLUMNS.requester, COLUMNS.subsystem, COLUMNS.total, COLUMNS.neededBy];

export async function renderApprovals(el) {
  const rows = await api.listRequests(STATUS.SUBMITTED);
  const total = rows.reduce((s, r) => s + r.total, 0);

  el.innerHTML = `
    ${takeFlash()}
    <div class="page-header">
      <div>
        <h1>Approvals</h1>
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
