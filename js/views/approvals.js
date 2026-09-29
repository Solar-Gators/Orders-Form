/** Chief Engineer queue: every Submitted request, most urgent first. */
import { api } from '../api.js';
import { STATUS, fmtMoney, requestTable, COLUMNS, bindRowLinks, takeFlash } from '../ui.js';

export async function renderApprovals(el) {
  const rows = await api.listRequests(STATUS.SUBMITTED);
  rows.sort((a, b) => (a.needed_by || '9999').localeCompare(b.needed_by || '9999'));
  const total = rows.reduce((s, r) => s + r.total, 0);

  el.innerHTML = `
    ${takeFlash()}
    <div class="page-header">
      <div>
        <h1>Approvals</h1>
        <p class="subtitle">${rows.length} request${rows.length === 1 ? '' : 's'} awaiting review · ${fmtMoney(total)} total. Sorted by needed-by date.</p>
      </div>
    </div>
    ${requestTable(
      rows,
      [COLUMNS.id, COLUMNS.title, COLUMNS.requester, COLUMNS.subsystem, COLUMNS.total, COLUMNS.neededBy],
      'No requests are waiting for approval.'
    )}`;
  bindRowLinks(el);
}
