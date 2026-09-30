/** Treasurer: approved requests to order, and ordered requests awaiting delivery (both sortable). */
import { api } from '../api.js';
import { auth } from '../auth.js';
import { STATUS, fmtMoney, requestTable, COLUMNS, bindRowLinks, bindSorting, takeFlash } from '../ui.js';

// Each list keeps its own sort order while moving around the app.
const toOrderSort = { key: 'approvedOn', dir: 'asc' };
const inTransitSort = { key: 'orderedOn', dir: 'asc' };
const toOrderColumns = [COLUMNS.requested, COLUMNS.title, COLUMNS.requester, COLUMNS.subsystem, COLUMNS.total, COLUMNS.vendors, COLUMNS.approvedOn];
const inTransitColumns = [COLUMNS.requested, COLUMNS.title, COLUMNS.requester, COLUMNS.total, COLUMNS.vendors, COLUMNS.orderNumber, COLUMNS.orderedOn];

export async function renderTreasurer(el) {
  const all = await api.listRequests([STATUS.APPROVED, STATUS.ORDERED]);
  const toOrder = all.filter((r) => r.status === STATUS.APPROVED);
  const inTransit = all.filter((r) => r.status === STATUS.ORDERED);
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
    <div id="to-order"></div>

    <h2 class="section-title">Awaiting delivery</h2>
    <div id="in-transit"></div>`;

  const lists = [
    [el.querySelector('#to-order'), toOrder, toOrderColumns, toOrderSort, 'No approved requests are waiting to be ordered.'],
    [el.querySelector('#in-transit'), inTransit, inTransitColumns, inTransitSort, 'Nothing is on order right now.'],
  ];
  for (const [box, rows, columns, sort, empty] of lists) {
    const draw = () => (box.innerHTML = requestTable(rows, columns, empty, sort));
    bindSorting(box, sort, columns, draw);
    draw();
  }
  bindRowLinks(el);
}
