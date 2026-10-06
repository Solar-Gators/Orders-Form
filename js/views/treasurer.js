/**
 * Treasurer: approved requests to order, and ordered requests awaiting delivery.
 * Both lists are sortable; their columns and default sorts come from Admin → Display → Request lists.
 * Budgets live on Finances → Budget; this page only warns when one is over.
 */
import { api } from '../api.js';
import { auth } from '../auth.js';
import { STATUS, LATE_DELIVERY_DAYS, esc, fmtMoney, todayISO, requestTable, bindRowLinks, bindSorting, errorBox, setFlash, takeFlash, introText, pageTabs } from '../ui.js';
import { budgetSummary, workflowSettings } from '../workflow.js';
import { listColumns, listSort } from '../listColumns.js';
import { rememberedSort } from './listSortState.js';

export async function renderTreasurer(el, { config, rerender }) {
  const all = await api.listRequests([STATUS.APPROVED, STATUS.ORDERED]);
  const toOrder = all.filter((r) => r.status === STATUS.APPROVED);
  const inTransit = all.filter((r) => r.status === STATUS.ORDERED);
  const sum = (rows) => fmtMoney(rows.reduce((s, r) => s + r.total, 0));
  const late = inTransit.filter((r) => r.order?.order_date && Date.now() - new Date(`${String(r.order.order_date).slice(0, 10)}T12:00:00`) > LATE_DELIVERY_DAYS * 86400000);
  const budgets = workflowSettings(config).budgets.field
    ? budgetSummary(config, await api.listRequests(null, { season: config.season }), (await api.listPurchases().catch(() => [])) || [])
    : [];

  el.innerHTML = `
    ${takeFlash()}
    ${pageTabs('queue', 'treasurer')}
    <div class="page-header">
      <div>
        <h1>To order &amp; deliveries</h1>
        ${introText('treasurer', '') ? `<p class="page-intro">${introText('treasurer', '')}</p>` : ''}
        <p class="subtitle"><span>${toOrder.length} to order (${sum(toOrder)}) · ${inTransit.length} awaiting delivery (${sum(inTransit)})${late.length ? ` · <strong class="late-text">${late.length} ordered over ${LATE_DELIVERY_DAYS} days ago</strong>` : ''}</span></p>
      </div>
    </div>
    ${auth.can('request.order') ? '' : '<div class="alert alert-info">View only — only the <strong>Treasurer</strong> can mark requests as Ordered or Received.</div>'}

    ${budgets.some((b) => b.over)
      ? `<div class="alert alert-warning small">Over budget: ${budgets
          .filter((b) => b.over)
          .map((b) => `<strong>${esc(b.value)}</strong> by ${fmtMoney(-b.remaining)}`)
          .join(', ')}. <a href="#/finances">See budgets in Finances</a></div>`
      : ''}

    <h2 class="section-title">To order</h2>
    ${auth.can('request.order') && toOrder.length > 1 ? batchCard(toOrder, config) : ''}
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
  bindBatch(el, toOrder, rerender);
}

/**
 * Several approved requests bought in one checkout (often the same vendor):
 * tick them and enter the order date / ticket number once.
 */
function batchCard(toOrder, config) {
  const byVendor = new Map();
  for (const r of toOrder) {
    const v = r.vendors.join(', ') || 'No vendor';
    if (!byVendor.has(v)) byVendor.set(v, []);
    byVendor.get(v).push(r);
  }
  const required = config.requireOrderNumber !== false;
  return `<details class="card batch-order" id="batch">
    <summary><strong>Order several at once</strong> <span class="muted small">Bought a few of these in one checkout? Mark them ordered together.</span></summary>
    <form id="batch-form" novalidate>
      <div class="batch-groups">${[...byVendor.entries()]
        .sort((a, b) => b[1].length - a[1].length)
        .map(([vendor, rows]) => `<fieldset>
          <legend>${esc(vendor)}</legend>
          ${rows.map((r) => `<label class="batch-row"><input type="checkbox" name="pick" value="${esc(r.id)}" data-number="${esc(r.request_number)}">
            <span class="mono small">${esc(r.request_number)}</span> ${esc(r.title || 'Untitled')} <span class="muted small">${fmtMoney(r.total)}</span></label>`).join('')}
        </fieldset>`)
        .join('')}</div>
      <div class="form-grid batch-fields">
        <div class="field"><label for="b-date">Order date</label><input id="b-date" name="order_date" type="date" value="${todayISO()}"></div>
        <div class="field"><label for="b-number">Ticket / Dept. Order #${required ? ' <span class="req">*</span>' : ' <span class="muted">(optional)</span>'}</label>
          <input id="b-number" name="department_order_number" type="text" placeholder="e.g. 6046"></div>
        <div class="field span-2"><label for="b-notes">Treasurer notes <span class="muted">(optional)</span></label><input id="b-notes" name="treasurer_notes" type="text"></div>
      </div>
      <div id="batch-errors"></div>
      <button type="submit" class="btn btn-primary" id="batch-go" disabled>Mark selected as ordered</button>
    </form>
  </details>`;
}

function bindBatch(el, toOrder, rerender) {
  const form = el.querySelector('#batch-form');
  if (!form) return;
  const go = form.querySelector('#batch-go');
  const picked = () => [...form.querySelectorAll('[name=pick]:checked')];
  form.addEventListener('change', () => {
    const n = picked().length;
    go.disabled = !n;
    go.textContent = n ? `Mark ${n} as ordered` : 'Mark selected as ordered';
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errs = form.querySelector('#batch-errors');
    const rows = picked();
    const data = Object.fromEntries(new FormData(form));
    const ticket = form.querySelector('#b-number');
    if (ticket.closest('.field').querySelector('.req') && !data.department_order_number.trim()) {
      errs.innerHTML = errorBox(new Error('Enter the ticket / Dept. order number.'));
      ticket.classList.add('is-invalid');
      ticket.focus();
      return;
    }
    go.disabled = true;
    errs.innerHTML = '';
    const done = [];
    const failed = [];
    for (const box of rows) {
      try {
        await api.markOrdered(box.value, data);
        done.push(box.dataset.number);
      } catch (err) {
        failed.push(`${box.dataset.number}: ${err.message}`);
      }
    }
    if (failed.length) {
      errs.innerHTML = errorBox(Object.assign(new Error(`${done.length} marked as ordered; ${failed.length} couldn't be:`), { details: failed }));
      go.disabled = false;
      return;
    }
    setFlash(`${done.join(', ')} marked as ordered.`);
    await rerender();
  });
}
