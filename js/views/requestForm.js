/**
 * New Request / Edit Request page. The fields come from the form settings
 * (Admin → Form fields) — see js/formFields.js.
 *
 * Items live in a local array; typing updates the array and totals in place
 * (no re-render) so inputs keep focus. Adding/removing rows re-renders the rows.
 */
import { api } from '../api.js';
import { auth } from '../auth.js';
import { esc, fmtMoney, itemTotal, round2, statusBadge, errorBox, setFlash, introText } from '../ui.js';
import { requestFields, itemFields, shown, getValue, setValue, renderInput, isVisible } from '../formFields.js';

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

  // Default values (Admin → Form fields) pre-fill new requests and new item rows.
  const withDefaults = (record, fields) => {
    for (const f of fields) {
      if (f.default !== undefined && f.default !== '' && f.type !== 'section' && getValue(record, f) === '') setValue(record, f, f.default);
    }
    return record;
  };
  const req = existing
    ? { ...existing, data: { ...existing.data } }
    : withDefaults({ requester: auth.user.full_name, priority: config.defaultPriority, data: {} }, rFields);
  const blankItem = () => withDefaults({ data: {} }, iFields);
  const items = existing?.items.length ? existing.items.map((i) => ({ ...i, data: { ...i.data } })) : [blankItem()];

  // One vendor per request (Settings, on by default): the vendor is entered once,
  // above the items, instead of in every row. The database enforces the same rule.
  const vendorField = iFields.find((f) => f.key === 'vendor');
  const oneVendor = config.oneVendorPerRequest !== false && !!vendorField;
  // "All items use the same link" (e.g. one shared Digi-Key / McMaster cart):
  // one link box above the items instead of a Link column; it's saved on every item.
  const linkField = iFields.find((f) => f.key === 'product_link');
  const itemLinks = items.map((i) => (i.product_link || '').trim());
  let sameLink = !!linkField && items.length > 1 && !!itemLinks[0] && itemLinks.every((l) => l === itemLinks[0]);
  const tableFields = () => iFields.filter((f) => !(oneVendor && f === vendorField) && !(sameLink && f === linkField));
  const linkBox = linkField
    ? `<div class="field same-link-field">
        <label class="rule-toggle"><input type="checkbox" id="same-link" ${sameLink ? 'checked' : ''}>
          <span>All items use the same ${esc(linkField.label.toLowerCase())} <span class="hint">e.g. a shared Digi-Key or McMaster-Carr cart</span></span></label>
        <input id="f-link" type="url" value="${esc(sameLink ? itemLinks[0] : '')}" placeholder="https://…" aria-label="${esc(linkField.label)} for every item" ${sameLink ? '' : 'hidden'}>
      </div>`
    : '';
  const existingVendors = [...new Set(items.map((i) => (i.vendor || '').trim()).filter(Boolean))];
  const vendorBox = oneVendor
    ? `<div class="field vendor-field">
        <label for="f-vendor">${esc(vendorField.label)}${vendorField.required ? ' <span class="req">*</span>' : ''}</label>
        <input id="f-vendor" type="text" value="${esc(existingVendors[0] || '')}" placeholder="e.g. McMaster-Carr" autocomplete="off">
        <div class="hint">Every item in this request comes from this ${esc(vendorField.label.toLowerCase())}. Buying from another one? Submit a separate request for it.</div>
        ${existingVendors.length > 1 ? `<div class="alert alert-warning small">This request has items from ${existingVendors.map(esc).join(', ')}. Keep one ${esc(vendorField.label.toLowerCase())} here and move the other items into a new request.</div>` : ''}
      </div>`
    : '';

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
        <p class="subtitle">${existing ? statusBadge(existing.status) : introText('new', 'Fill in the request, add one row per item, then submit for Chief Engineer approval.')}</p>
      </div>
    </div>
    ${changesNote}
    <div id="form-errors"></div>

    <form id="request-form" novalidate>
      <section class="card">
        <h2>Request details</h2>
        <div class="form-grid">
          ${rFields
            .map((f) =>
              f.type === 'section'
                ? `<div class="form-section span-full" data-wrap="${esc(f.key)}">
                    <h3>${esc(f.label)}</h3>${f.help ? `<p class="muted small">${esc(f.help)}</p>` : ''}
                  </div>`
                : `<div class="field ${span(f)}" data-wrap="${esc(f.key)}">
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
        ${vendorBox}
        ${linkBox}
        <div class="table-wrap flat">
          <table class="table items-table stack-form">
            <thead id="items-head"></thead>
            <tbody id="items-body"></tbody>
            <tfoot>
              <tr>
                <td id="total-label" class="num"><strong>Request total</strong> <span class="muted small">(incl. shipping)</span></td>
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

  // ---- "Show only when…" conditions (the database applies the same rules) ----
  const answerFields = rFields.filter((f) => f.type !== 'section');
  /** The request as currently typed (built-in at the top level, custom in data). */
  const currentRequest = () => {
    const r = { data: {} };
    for (const f of answerFields) setValue(r, f, form.querySelector(`[data-rfield="${f.key}"]`)?.value ?? '');
    return r;
  };
  /** Item as the conditions see it: the single vendor box counts as each item's vendor. */
  const itemForRules = (item) => ({
    ...item,
    ...(oneVendor ? { vendor: form.querySelector('#f-vendor').value } : {}),
    ...(sameLink ? { product_link: form.querySelector('#f-link').value } : {}),
  });

  const applyConditions = () => {
    const r = currentRequest();
    for (const f of rFields) {
      if (!f.showIf) continue;
      const wrap = form.querySelector(`[data-wrap="${f.key}"]`);
      if (wrap) wrap.hidden = !isVisible(f, r);
    }
    tbody.querySelectorAll('tr[data-index]').forEach((tr) => {
      const item = itemForRules(items[Number(tr.dataset.index)]);
      for (const f of tableFields()) {
        if (!f.showIf) continue;
        const td = tr.querySelector(`td.k-${f.key}`);
        const on = isVisible(f, r, item);
        td.classList.toggle('cond-off', !on); // keeps the table's columns lined up
        td.querySelector('input, select, textarea').disabled = !on;
      }
    });
  };
  form.addEventListener('input', applyConditions);
  form.addEventListener('change', applyConditions);

  const updateTotals = () => {
    // Request total = items (quantity × unit price) + shipping.
    grandTotal.textContent = fmtMoney(round2(items.reduce((s, i) => s + itemTotal(i) + (Number(i.shipping_cost) || 0), 0)));
  };

  const renderRows = () => {
    const cols = tableFields();
    el.querySelector('#items-head').innerHTML = `<tr>
      <th class="w-idx">#</th>
      ${cols.map((f) => `<th class="w-${esc(f.type)} k-${esc(f.key)}">${esc(f.label)}${star(f)}</th>`).join('')}
      <th class="num w-total">Total</th>
      <th class="w-remove"><span class="sr-only">Remove</span></th>
    </tr>`;
    el.querySelector('#total-label').colSpan = cols.length + 1;
    tbody.innerHTML = items
      .map(
        (item, idx) => `
        <tr data-index="${idx}">
          <td class="w-idx muted"><span class="only-mobile">Item </span>${idx + 1}</td>
          ${cols
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
    applyConditions();
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

  el.querySelector('#same-link')?.addEventListener('change', (e) => {
    const box = el.querySelector('#f-link');
    sameLink = e.target.checked;
    if (sameLink) {
      box.value ||= items.map((i) => (i.product_link || '').trim()).find(Boolean) || ''; // start from the first link typed
      box.hidden = false;
      box.focus();
    } else {
      // Back to one link per item: every row keeps the shared link, ready to edit.
      for (const i of items) i.product_link = box.value.trim();
      box.hidden = true;
    }
    renderRows();
  });

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
    // Fields hidden by a "show only when…" condition are sent empty.
    const request = currentRequest();
    for (const f of answerFields) if (!isVisible(f, request)) setValue(request, f, '');
    const payload = {
      action,
      request,
      items: items.map((i) => {
        const out = { data: {} };
        for (const f of iFields) setValue(out, f, getValue(i, f));
        if (oneVendor) out.vendor = form.querySelector('#f-vendor').value.trim(); // same vendor for every item
        if (sameLink) out.product_link = form.querySelector('#f-link').value.trim(); // same link for every item
        for (const f of iFields) if (!isVisible(f, request, out)) setValue(out, f, '');
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
