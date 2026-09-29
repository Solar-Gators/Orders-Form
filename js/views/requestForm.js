/**
 * New Request / Edit Request page.
 * Items live in a local array; typing updates the array and totals in place
 * (no re-render) so inputs keep focus. Adding/removing rows re-renders the rows.
 */
import { api } from '../api.js';
import { auth } from '../auth.js';
import { esc, fmtMoney, itemTotal, round2, statusBadge, errorBox, setFlash } from '../ui.js';

const ITEM_FIELDS = [
  { key: 'item_name', label: 'Item name', type: 'text', placeholder: 'e.g. M5 socket head screw', cls: 'w-name' },
  { key: 'vendor', label: 'Vendor', type: 'text', placeholder: 'McMaster-Carr', cls: 'w-vendor' },
  { key: 'product_link', label: 'Product link', type: 'url', placeholder: 'https://…', cls: 'w-link' },
  { key: 'part_number', label: 'Part #', type: 'text', placeholder: '91292A113', cls: 'w-part' },
  { key: 'quantity', label: 'Qty', type: 'number', placeholder: '1', cls: 'w-qty', attrs: 'min="0" step="any" inputmode="decimal"' },
  { key: 'unit_price', label: 'Unit price', type: 'number', placeholder: '0.00', cls: 'w-price', attrs: 'min="0" step="0.01" inputmode="decimal"' },
  { key: 'notes', label: 'Notes', type: 'text', placeholder: 'Pack size, shipping, special instructions', cls: 'w-notes' },
];

const blankItem = () => ({ item_name: '', vendor: '', product_link: '', part_number: '', quantity: '', unit_price: '', notes: '' });

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

  const req = existing || {
    title: '',
    requester: auth.user.full_name,
    subsystem: '',
    priority: config.defaultPriority,
    needed_by: '',
    justification: '',
  };
  const items = existing?.items.length
    ? existing.items.map((i) => ({ ...blankItem(), ...i, quantity: i.quantity ?? '', unit_price: i.unit_price ?? '' }))
    : [blankItem()];

  const options = (list, selected) =>
    list.map((v) => `<option value="${esc(v)}" ${v === selected ? 'selected' : ''}>${esc(v)}</option>`).join('');

  const latest = existing?.latest_approval;
  const changesNote =
    existing?.status === 'Changes Requested' && latest
      ? `<div class="alert alert-warning"><strong>Changes requested by ${esc(latest.approver)}:</strong> ${esc(latest.comment)}</div>`
      : '';

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
          <div class="field span-2">
            <label for="f-title">Request title <span class="req">*</span></label>
            <input id="f-title" name="title" type="text" maxlength="120" value="${esc(req.title)}" placeholder="e.g. Steering assembly fasteners">
          </div>
          <div class="field">
            <label for="f-requester">Requester name <span class="req">*</span></label>
            <input id="f-requester" name="requester" type="text" value="${esc(req.requester)}">
          </div>
          <div class="field">
            <label for="f-subsystem">Subsystem <span class="req">*</span></label>
            <select id="f-subsystem" name="subsystem">
              <option value="">Select…</option>
              ${options(config.subsystems, req.subsystem)}
            </select>
          </div>
          <div class="field">
            <label for="f-priority">Priority</label>
            <select id="f-priority" name="priority">${options(config.priorities, req.priority)}</select>
          </div>
          <div class="field">
            <label for="f-needed">Needed by <span class="req">*</span></label>
            <input id="f-needed" name="needed_by" type="date" value="${esc(req.needed_by)}">
          </div>
          <div class="field span-full">
            <label for="f-just">Justification <span class="req">*</span></label>
            <textarea id="f-just" name="justification" rows="3" placeholder="Why do you need these items? Be as descriptive as possible — it makes approval easier.">${esc(req.justification)}</textarea>
          </div>
        </div>
      </section>

      <section class="card">
        <div class="card-head">
          <h2>Items</h2>
          <button type="button" class="btn btn-sm" data-action="add-item">+ Add item</button>
        </div>
        <div class="table-wrap flat">
          <table class="table items-table">
            <thead>
              <tr>
                <th class="w-idx">#</th>
                ${ITEM_FIELDS.map((f) => `<th class="${f.cls}">${esc(f.label)}</th>`).join('')}
                <th class="num w-total">Total</th>
                <th class="w-remove"><span class="sr-only">Remove</span></th>
              </tr>
            </thead>
            <tbody id="items-body"></tbody>
            <tfoot>
              <tr>
                <td colspan="${ITEM_FIELDS.length + 1}" class="num"><strong>Request total</strong></td>
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
    grandTotal.textContent = fmtMoney(round2(items.reduce((s, i) => s + itemTotal(i), 0)));
  };

  const renderRows = () => {
    tbody.innerHTML = items
      .map(
        (item, idx) => `
        <tr data-index="${idx}">
          <td class="w-idx muted">${idx + 1}</td>
          ${ITEM_FIELDS.map(
            (f) => `<td class="${f.cls}"><input type="${f.type}" data-field="${f.key}" value="${esc(item[f.key])}"
                      placeholder="${esc(f.placeholder)}" aria-label="${esc(f.label)} (item ${idx + 1})" ${f.attrs || ''}></td>`
          ).join('')}
          <td class="num w-total" data-role="row-total">${fmtMoney(itemTotal(item))}</td>
          <td class="w-remove">
            <button type="button" class="icon-btn" data-action="remove-item" title="Remove item" aria-label="Remove item ${idx + 1}"
              ${items.length === 1 ? 'disabled' : ''}>&times;</button>
          </td>
        </tr>`
      )
      .join('');
    updateTotals();
  };

  tbody.addEventListener('input', (e) => {
    const field = e.target.dataset.field;
    if (!field) return;
    const row = e.target.closest('tr');
    const item = items[Number(row.dataset.index)];
    item[field] = e.target.value;
    if (field === 'quantity' || field === 'unit_price') {
      row.querySelector('[data-role="row-total"]').textContent = fmtMoney(itemTotal(item));
      updateTotals();
    }
  });

  el.addEventListener('click', (e) => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (action === 'add-item') {
      items.push(blankItem());
      renderRows();
      tbody.querySelector('tr:last-child input')?.focus();
    } else if (action === 'remove-item' && items.length > 1) {
      items.splice(Number(e.target.closest('tr').dataset.index), 1);
      renderRows();
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const action = e.submitter?.dataset.submit || 'draft';
    const data = Object.fromEntries(new FormData(form));
    const payload = {
      action,
      request: {
        title: data.title,
        requester: data.requester,
        subsystem: data.subsystem,
        priority: data.priority,
        needed_by: data.needed_by,
        justification: data.justification,
      },
      items,
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
