/**
 * Treasurer: approved requests to order, and ordered requests awaiting delivery.
 * Both lists are sortable; their columns and default sorts come from Admin → Lists.
 */
import { api } from '../api.js';
import { auth } from '../auth.js';
import { STATUS, fmtMoney, requestTable, bindRowLinks, bindSorting, takeFlash } from '../ui.js';
import { listColumns, listSort } from '../listColumns.js';
import { rememberedSort } from './listSortState.js';

export async function renderTreasurer(el, { config }) {
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
    ['treasurerToOrder', el.querySelector('#to-order'), toOrder, 'No approved requests are waiting to be ordered.'],
    ['treasurerOrdered', el.querySelector('#in-transit'), inTransit, 'Nothing is on order right now.'],
  ];
  for (const [name, box, rows, empty] of lists) {
    const columns = listColumns(name, config);
    const sort = rememberedSort(name, listSort(name, config), columns);
    const draw = () => (box.innerHTML = requestTable(rows, columns, empty, sort));
    bindSorting(box, sort, columns, draw);
    draw();
  }
  bindRowLinks(el);
}
