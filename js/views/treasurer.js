/**
 * Treasurer: approved requests to order, and ordered requests awaiting delivery.
 * Both lists are sortable; their columns and default sorts come from Admin → Lists.
 * Budgets (Admin → Workflow) are shown above them.
 */
import { api } from '../api.js';
import { auth } from '../auth.js';
import { STATUS, esc, fmtMoney, requestTable, bindRowLinks, bindSorting, takeFlash, introText } from '../ui.js';
import { budgetSummary, workflowSettings } from '../workflow.js';
import { listColumns, listSort } from '../listColumns.js';
import { rememberedSort } from './listSortState.js';

export async function renderTreasurer(el, { config }) {
  const all = await api.listRequests([STATUS.APPROVED, STATUS.ORDERED]);
  const toOrder = all.filter((r) => r.status === STATUS.APPROVED);
  const inTransit = all.filter((r) => r.status === STATUS.ORDERED);
  const sum = (rows) => fmtMoney(rows.reduce((s, r) => s + r.total, 0));
  const budgets = workflowSettings(config).budgets.field
    ? budgetSummary(config, await api.listRequests(null, { season: config.season }))
    : [];

  el.innerHTML = `
    ${takeFlash()}
    <div class="page-header">
      <div>
        <h1>Treasurer</h1>
        ${introText('treasurer', '') ? `<p class="page-intro">${introText('treasurer', '')}</p>` : ''}
        <p class="subtitle">${toOrder.length} to order (${sum(toOrder)}) · ${inTransit.length} awaiting delivery (${sum(inTransit)})</p>
      </div>
    </div>
    ${auth.can('request.order') ? '' : '<div class="alert alert-info">View only — only the <strong>Treasurer</strong> can mark requests as Ordered or Received.</div>'}

    ${budgets.length ? budgetCard(budgets, config) : ''}

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

/** Budget used / left per cost center (or whatever field Admin → Workflow picked). */
function budgetCard(budgets, config) {
  const rows = budgets
    .map((b) => {
      const pct = b.amount > 0 ? Math.min(100, Math.round((b.used / b.amount) * 100)) : 100;
      return `<tr class="${b.over ? 'is-over' : ''}">
        <td>${esc(b.value)}</td>
        <td class="num">${fmtMoney(b.amount)}</td>
        <td class="num">${fmtMoney(b.used)}</td>
        <td class="num">${fmtMoney(b.remaining)}</td>
        <td class="num muted">${b.pending ? fmtMoney(b.pending) : '—'}</td>
        <td class="budget-bar-cell"><span class="budget-bar"><span style="width:${pct}%"></span></span></td>
      </tr>`;
    })
    .join('');
  return `<section class="card budget-card">
    <h2>Budgets · ${esc(config.season)}</h2>
    <div class="table-wrap flat"><table class="table">
      <thead><tr><th>${esc(budgetLabel(config))}</th><th class="num">Budget</th><th class="num">Used</th><th class="num">Left</th><th class="num">Awaiting approval</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <p class="muted small">Used = approved, ordered and received this season (with shipping).</p>
  </section>`;
}

function budgetLabel(config) {
  const key = workflowSettings(config).budgets.field;
  return (config.requestFields || []).find((f) => f.key === key)?.label || (key === 'subsystem' ? 'Subsystem' : key);
}
