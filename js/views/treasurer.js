/** Treasurer: approved requests to order, and ordered requests awaiting delivery. */
import { api } from '../api.js';
import { auth } from '../auth.js';
import { STATUS, fmtMoney, requestTable, COLUMNS, bindRowLinks, takeFlash } from '../ui.js';

export async function renderTreasurer(el) {
  const all = await api.listRequests([STATUS.APPROVED, STATUS.ORDERED]);
  const byDate = (key) => (a, b) => (key(a) || '').localeCompare(key(b) || '');
  const toOrder = all.filter((r) => r.status === STATUS.APPROVED).sort(byDate((r) => r.latest_approval?.created_at));
  const inTransit = all.filter((r) => r.status === STATUS.ORDERED).sort(byDate((r) => r.order?.order_date));
  const sum = (rows) => fmtMoney(rows.reduce((s, r) => s + r.total, 0));

  el.innerHTML = `
    ${takeFlash()}
    <div class="page-header">
      <div>
        <h1>Treasurer</h1>
        <p class="subtitle">${toOrder.length} to order (${sum(toOrder)}) · ${inTransit.length} awaiting delivery (${sum(inTransit)})</p>
      </div>
    </div>
    ${auth.can('request.order') ? '' : '<div class="alert alert-info">View only — only the <strong>Treasurer</strong> can mark requests as Ordered or Received.</div>'}

    <h2 class="section-title">To order</h2>
    ${requestTable(
      toOrder,
      [COLUMNS.requested, COLUMNS.title, COLUMNS.requester, COLUMNS.subsystem, COLUMNS.total, COLUMNS.vendors, COLUMNS.approvedOn],
      'No approved requests are waiting to be ordered.'
    )}

    <h2 class="section-title">Awaiting delivery</h2>
    ${requestTable(
      inTransit,
      [COLUMNS.requested, COLUMNS.title, COLUMNS.requester, COLUMNS.total, COLUMNS.vendors, COLUMNS.orderNumber, COLUMNS.orderedOn],
      'Nothing is on order right now.'
    )}`;
  bindRowLinks(el);
}
