/**
 * Treasurer: approved requests to order, and ordered requests awaiting delivery.
 * Both lists are sortable; their columns and default sorts come from Admin → Lists.
 * Budgets are shown (and set, by the Treasurer) above them.
 */
import { api } from '../api.js';
import { auth } from '../auth.js';
import { STATUS, LATE_DELIVERY_DAYS, esc, fmtMoney, todayISO, requestTable, bindRowLinks, bindSorting, errorBox, setFlash, takeFlash, introText } from '../ui.js';
import { budgetSummary, workflowSettings } from '../workflow.js';
import { requestFields, fieldOptions } from '../formFields.js';
import { listColumns, listSort } from '../listColumns.js';
import { rememberedSort } from './listSortState.js';

export async function renderTreasurer(el, { config, rerender, reloadConfig }) {
  const all = await api.listRequests([STATUS.APPROVED, STATUS.ORDERED]);
  const toOrder = all.filter((r) => r.status === STATUS.APPROVED);
  const inTransit = all.filter((r) => r.status === STATUS.ORDERED);
  const sum = (rows) => fmtMoney(rows.reduce((s, r) => s + r.total, 0));
  const late = inTransit.filter((r) => r.order?.order_date && Date.now() - new Date(`${String(r.order.order_date).slice(0, 10)}T12:00:00`) > LATE_DELIVERY_DAYS * 86400000);
  const budgets = workflowSettings(config).budgets.field
    ? budgetSummary(config, await api.listRequests(null, { season: config.season }))
    : [];

  el.innerHTML = `
    ${takeFlash()}
    <div class="page-header">
      <div>
        <h1>Treasurer</h1>
        ${introText('treasurer', '') ? `<p class="page-intro">${introText('treasurer', '')}</p>` : ''}
        <p class="subtitle"><span>${toOrder.length} to order (${sum(toOrder)}) · ${inTransit.length} awaiting delivery (${sum(inTransit)})${late.length ? ` · <strong class="late-text">${late.length} ordered over ${LATE_DELIVERY_DAYS} days ago</strong>` : ''}</span></p>
      </div>
    </div>
    ${auth.can('request.order') ? '' : '<div class="alert alert-info">View only — only the <strong>Treasurer</strong> can mark requests as Ordered or Received.</div>'}

    ${budgets.length
      ? budgetCard(budgets, config, canSetBudgets())
      : canSetBudgets()
        ? `<section class="card budget-card"><div class="card-head"><h2>Budgets</h2>
             <button type="button" class="btn btn-sm" id="edit-budgets">Set budgets</button></div>
             <p class="muted small">No budgets yet. Set an amount per Cost center (or Subsystem) to track spending this season.</p>
             <div id="budget-editor"></div></section>`
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
  bindBudgetEditor(el, config, reloadConfig, rerender);
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

/** Budget used / left per cost center (or whatever field Admin → Workflow picked). */
function budgetCard(budgets, config, canEdit) {
  const rows = budgets
    .map((b) => {
      const pct = b.amount > 0 ? Math.min(100, Math.round((b.used / b.amount) * 100)) : 100;
      return `<tr class="${b.over ? 'is-over' : ''}">
        <td>${esc(b.value)}</td>
        <td class="num">${fmtMoney(b.amount)}</td>
        <td class="num">${fmtMoney(b.used)}</td>
        <td class="num">${b.remaining >= 0 ? fmtMoney(b.remaining) : `${fmtMoney(-b.remaining)} over`}</td>
        <td class="num muted">${b.pending ? fmtMoney(b.pending) : '—'}</td>
        <td class="budget-bar-cell"><span class="budget-bar"><span style="width:${pct}%"></span></span></td>
      </tr>`;
    })
    .join('');
  return `<section class="card budget-card">
    <div class="card-head"><h2>Budgets · ${esc(config.season)}</h2>
      ${canEdit ? '<button type="button" class="btn btn-sm" id="edit-budgets">Edit budgets</button>' : ''}</div>
    <div id="budget-editor"></div>
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

/** Budgets are the Treasurer's (Order & receive), or anyone who manages the workflow. */
const canSetBudgets = () => auth.can('request.order') || auth.can('workflow.edit');

/** Dropdowns a budget can follow: Cost center, Subsystem… (not Priority or yes/no). */
function budgetFields(config) {
  return requestFields(config).filter((f) => f.type === 'select' && f.key !== 'priority' && !f.hidden && fieldOptions(f, config).length);
}

function bindBudgetEditor(el, config, reloadConfig, rerender) {
  const open = el.querySelector('#edit-budgets');
  const box = el.querySelector('#budget-editor');
  if (!open || !box) return;
  const fields = budgetFields(config);
  const state = structuredClone(workflowSettings(config).budgets);
  if (!state.field && fields.length) state.field = fields.find((f) => /cost\s*cent/i.test(f.label))?.key || fields[0].key;

  const draw = () => {
    const field = fields.find((x) => x.key === state.field);
    box.innerHTML = `<form id="budget-form" class="budget-editor" novalidate>
      <div class="field"><label for="budget-field">Budget by</label>
        <select id="budget-field">${fields.map((x) => `<option value="${esc(x.key)}" ${x.key === state.field ? 'selected' : ''}>${esc(x.label)}</option>`).join('')}</select>
        <div class="hint">Amounts are for the current season (${esc(config.season)}). Leave an option blank for no budget.</div></div>
      ${field ? `<table class="table budget-table"><thead><tr><th>${esc(field.label)}</th><th>Budget ($)</th></tr></thead><tbody>${fieldOptions(field, config)
        .map((o) => `<tr><td>${esc(o)}</td><td><input type="number" min="0" step="0.01" inputmode="decimal" data-budget="${esc(o)}" value="${esc(state.amounts?.[o] ?? '')}" placeholder="No budget" aria-label="Budget for ${esc(o)}"></td></tr>`)
        .join('')}</tbody></table>` : '<p class="muted small">Add a dropdown like Cost center to the form first.</p>'}
      <label class="rule-toggle"><input type="checkbox" id="budget-block" ${state.block ? 'checked' : ''}>
        <span>Approving over budget needs a written reason <span class="hint">The approver has to say why; it's kept in the request's History. Off: approvers just see a warning.</span></span></label>
      <div id="budget-errors"></div>
      <div class="form-actions">
        <button type="button" class="btn btn-ghost" id="budget-cancel">Cancel</button>
        <button type="submit" class="btn btn-primary">Save budgets</button>
      </div>
    </form>`;
  };

  open.addEventListener('click', () => {
    open.hidden = true;
    draw();
  });
  box.addEventListener('change', (e) => {
    if (e.target.id === 'budget-field') {
      state.field = e.target.value;
      state.amounts = {};
      draw();
    } else if (e.target.id === 'budget-block') state.block = e.target.checked;
  });
  box.addEventListener('input', (e) => {
    const option = e.target.dataset.budget;
    if (option === undefined) return;
    state.amounts ||= {};
    if (e.target.value === '') delete state.amounts[option];
    else state.amounts[option] = e.target.value;
  });
  box.addEventListener('click', (e) => {
    if (e.target.id !== 'budget-cancel') return;
    box.innerHTML = '';
    open.hidden = false;
  });
  box.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api.setBudgets(state);
      await reloadConfig();
      setFlash('Budgets saved.');
      await rerender();
    } catch (err) {
      box.querySelector('#budget-errors').innerHTML = errorBox(err);
    }
  });
}
