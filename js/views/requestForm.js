/**
 * New Request / Edit Request page. The fields come from the form settings
 * (Admin → Form fields) — see js/formFields.js.
 *
 * Items live in a local array; typing updates the array and totals in place
 * (no re-render) so inputs keep focus. Adding/removing rows re-renders the rows.
 */
import { api } from '../api.js';
import { auth } from '../auth.js';
import { esc, fmtMoney, itemTotal, round2, statusBadge, errorBox, setFlash } from '../ui.js';
import { requestFields, itemFields, shown, getValue, setValue, renderInput } from '../formFields.js';

// Example placeholders for built-in item columns (custom fields use their help text).
const ITEM_PLACEHOLDERS = {
  item_name: 'e.g. M5 socket head screw',
  vendor: 'McMaster-Carr',
  part_number: '91292A113',
  quantity: '1',
  unit_price: '0.00',
};

export async function renderRequestForm(el, { config, params }) {
  let existing = null;
  if (params.id) {
    existing = await api.getRequest(params.id);
    if (existing.created_by !== auth.user.id) {
      el.innerHTML = `
        <div class="alert alert-info">Only the person who created ${esc(existing.request_number)} can edit it.</div>
        <a class="btn" href="#/requests/${esc(existing.request_number)}">Back to request</a>`;
      return;
    }
    if (!config.editableStatuses.includes(existing.status)) {
      el.innerHTML = `
        <div class="alert alert-info">${esc(existing.request_number)} is ${statusBadge(existing.status)} and can no longer be edited.</div>
        <a class="btn" href="#/requests/${esc(existing.request_number)}">Back to request</a>`;
      return;
    }
  }

  const rFields = shown(requestFields(config));
  const iFields = shown(itemFields(config)).map((f) => ({
    ...f,
    placeholder: f.help || ITEM_PLACEHOLDERS[f.key] || '',
  }));

  const req = existing
    ? { ...existing, data: { ...existing.data } }
    : { requester: auth.user.full_name, priority: config.defaultPriority, data: {} };
  const blankItem = () => ({ data: {} });
  const items = existing?.items.length ? existing.items.map((i) => ({ ...i, data: { ...i.data } })) : [blankItem()];

  const latest = existing?.latest_approval;
  const changesNote =
    existing?.status === 'Changes Requested' && latest
      ? `<div class="alert alert-warning"><strong>Changes requested by ${esc(latest.approver)}:</strong> ${esc(latest.comment)}</div>`
      : '';

  const star = (f) => (f.required ? ' <span class="req">*</span>' : '');
  const span = (f) => (f.type === 'textarea' ? 'span-full' : f.key === 'title' ? 'span-2' : '');

  el.innerHTML = `
    <div class="page-header">
      <div>
        <h1>${existing ? `Edit ${esc(existing.request_number)}` : 'New Purchase Request'}</h1>
        <p class="subtitle">${existing ? statusBadge(existing.status) : 'Fill in the request, add one row per item, then submit for Chief Engineer approval.'}</p>
      </div>
    </div>
    ${changesNote}
    <div id="form-errors"></div>

    <form id="request-form" novalidate>
      <section class="card">
        <h2>Request details</h2>
        <div class="form-grid">
          ${rFields
            .map(
              (f) => `<div class="field ${span(f)}">
                <label for="f-${esc(f.key)}">${esc(f.label)}${star(f)}</label>
                ${renderInput({ ...f, placeholder: f.type === 'textarea' ? f.help : '' }, getValue(req, f), config, `id="f-${esc(f.key)}" data-rfield="${esc(f.key)}"`)}
                ${f.help && f.type !== 'textarea' ? `<div class="hint">${esc(f.help)}</div>` : ''}
              </div>`
            )
            .join('')}
        </div>
      </section>

      <section class="card">
        <div class="card-head">
          <h2>Items</h2>
          <button type="button" class="btn btn-sm" data-action="add-item">+ Add item</button>
        </div>
        <div class="table-wrap flat">
          <table class="table items-table stack-form">
            <thead>
              <tr>
                <th class="w-idx">#</th>
                ${iFields.map((f) => `<th class="w-${esc(f.type)} k-${esc(f.key)}">${esc(f.label)}${star(f)}</th>`).join('')}
                <th class="num w-total">Total</th>
                <th class="w-remove"><span class="sr-only">Remove</span></th>
              </tr>
            </thead>
            <tbody id="items-body"></tbody>
            <tfoot>
              <tr>
                <td colspan="${iFields.length + 1}" class="num"><strong>Request total</strong> <span class="muted small">(incl. shipping)</span></td>
                <td class="num"><strong id="grand-total">$0.00</strong></td>
                <td></td>
              </tr>
            </tfoot>
          </table>
        </div>
      </section>

      <div class="form-actions">
        <a class="btn btn-ghost" href="${existing ? `#/requests/${esc(existing.request_number)}` : '#/requests'}">Cancel</a>
        <button type="submit" class="btn" data-submit="draft">Save Draft</button>
        <button type="submit" class="btn btn-primary" data-submit="submit">Submit Request</button>
      </div>
    </form>`;

  const form = el.querySelector('#request-form');
  const tbody = el.querySelector('#items-body');
  const grandTotal = el.querySelector('#grand-total');
  const errorsEl = el.querySelector('#form-errors');

  const updateTotals = () => {
    // Request total = items (quantity × unit price) + shipping.
    grandTotal.textContent = fmtMoney(round2(items.reduce((s, i) => s + itemTotal(i) + (Number(i.shipping_cost) || 0), 0)));
  };

  const renderRows = () => {
    tbody.innerHTML = items
      .map(
        (item, idx) => `
        <tr data-index="${idx}">
          <td class="w-idx muted"><span class="only-mobile">Item </span>${idx + 1}</td>
          ${iFields
            .map(
              (f) => `<td class="w-${esc(f.type)} k-${esc(f.key)}" data-label="${esc(f.label)}${f.required ? ' *' : ''}">${renderInput(
                f,
                getValue(item, f),
                config,
                `data-ifield="${esc(f.key)}" aria-label="${esc(f.label)} (item ${idx + 1})"`
              )}</td>`
            )
            .join('')}
          <td class="num w-total" data-label="Item total" data-role="row-total">${fmtMoney(itemTotal(item))}</td>
          <td class="w-remove">
            <button type="button" class="icon-btn" data-action="remove-item" title="Remove item" aria-label="Remove item ${idx + 1}"
              ${items.length === 1 ? 'disabled' : ''}>&times;</button>
          </td>
        </tr>`
      )
      .join('');
    updateTotals();
  };

  const onItemInput = (e) => {
    const key = e.target.dataset.ifield;
    if (!key) return;
    const row = e.target.closest('tr');
    const item = items[Number(row.dataset.index)];
    setValue(item, iFields.find((f) => f.key === key), e.target.value);
    if (key === 'quantity' || key === 'unit_price') row.querySelector('[data-role="row-total"]').textContent = fmtMoney(itemTotal(item));
    if (key === 'quantity' || key === 'unit_price' || key === 'shipping_cost') updateTotals();
  };
  tbody.addEventListener('input', onItemInput);
  tbody.addEventListener('change', onItemInput); // selects

  el.addEventListener('click', (e) => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (action === 'add-item') {
      items.push(blankItem());
      renderRows();
      tbody.querySelector('tr:last-child input, tr:last-child select')?.focus();
    } else if (action === 'remove-item' && items.length > 1) {
      items.splice(Number(e.target.closest('tr').dataset.index), 1);
      renderRows();
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const action = e.submitter?.dataset.submit || 'draft';

    // Built-in fields go at the top level, custom fields in `data`.
    const request = { data: {} };
    for (const f of rFields) setValue(request, f, form.querySelector(`[data-rfield="${f.key}"]`).value);
    const payload = {
      action,
      request,
      items: items.map((i) => {
        const out = { data: {} };
        for (const f of iFields) setValue(out, f, getValue(i, f));
        return out;
      }),
    };

    const buttons = form.querySelectorAll('button');
    buttons.forEach((b) => (b.disabled = true));
    errorsEl.innerHTML = '';
    try {
      const number = await api.saveRequest(existing?.id, payload);
      setFlash(action === 'submit' ? `${number} submitted for approval.` : `${number} saved as a draft.`);
      location.hash = `#/requests/${number}`;
    } catch (err) {
      errorsEl.innerHTML = errorBox(err);
      errorsEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
      buttons.forEach((b) => (b.disabled = false));
      renderRows(); // restore "remove" disabled state
    }
  });

  renderRows();
}
