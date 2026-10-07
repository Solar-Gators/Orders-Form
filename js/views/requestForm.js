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
import { requestFields, itemFields, shown, getValue, setValue, renderInput, isVisible, shippingPerRequest } from '../formFields.js';
import { guardLeaving, releaseGuard } from '../leaveGuard.js';

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
  const shared = new Set(); // keys of item fields filled in once for every item (below)
  // New rows start with the defaults, and with any "same for every item" values.
  const blankItem = () => {
    const item = withDefaults({ data: {} }, iFields);
    for (const f of iFields) if (shared.has(f.key)) setValue(item, f, getValue(items[0], f));
    return item;
  };
  const items = existing?.items.length ? existing.items.map((i) => ({ ...i, data: { ...i.data } })) : [blankItem()];

  // One vendor per request (Settings, on by default): the vendor is entered once,
  // above the items, instead of in every row. The database enforces the same rule.
  const vendorField = iFields.find((f) => f.key === 'vendor');
  const oneVendor = config.oneVendorPerRequest !== false && !!vendorField;
  // Shipping for the whole order (Settings, on by default): one box under the
  // items instead of a column. Saved on the first item, so totals add up the same.
  const shipField = iFields.find((f) => f.key === 'shipping_cost');
  const oneShipping = shippingPerRequest(config) && !!shipField;
  const shipNumbers = items.map((i) => i.shipping_cost).filter((v) => v !== null && v !== undefined && String(v).trim() !== '');
  let orderShipping = shipNumbers.length ? String(round2(shipNumbers.reduce((s, v) => s + (Number(v) || 0), 0))) : '';
  const inTable = (f) => !(oneVendor && f === vendorField) && !(oneShipping && f === shipField);
  // "Same for every item": any required item field (plus the link, e.g. one
  // shared Digi-Key / McMaster cart) can be filled in once instead of per row.
  // Every item keeps a copy of the value, so totals, rules and saving work as usual.
  const sharable = iFields.filter(
    (f) => f.type !== 'section' && f.key !== 'item_name' && inTable(f) && (f.required || f.key === 'product_link')
  );
  const sameEverywhere = (f) => {
    const values = items.map((i) => String(getValue(i, f) ?? '').trim());
    return items.length > 1 && values[0] !== '' && values.every((v) => v === values[0]);
  };
  for (const f of sharable.filter(sameEverywhere)) shared.add(f.key); // reopening a draft keeps them
  const tableFields = () => iFields.filter((f) => inTable(f) && !shared.has(f.key));
  const fillAll = (f, value) => items.forEach((i) => setValue(i, f, value));
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
        <h2>Items</h2>
        ${vendorBox}
        ${sharable.length ? '<div id="shared-box" class="shared-fields"></div>' : ''}
        <div class="table-wrap flat">
          <table class="table items-table stack-form" data-fit>
            <thead id="items-head"></thead>
            <tbody id="items-body"></tbody>
            <tfoot>
              ${
                oneShipping
                  ? `<tr class="shipping-row">
                      <td id="ship-label" class="num"><label for="f-shipping"><strong>${esc(shipField.label)}${star(shipField)}</strong>
                        <span class="muted small">for the whole order, as the vendor charges it</span></label></td>
                      <td class="num ship-input"><input id="f-shipping" type="number" min="0" step="0.01" inputmode="decimal" value="${esc(orderShipping)}" placeholder="0.00"></td>
                      <td></td>
                    </tr>`
                  : ''
              }
              <tr>
                <td id="total-label" class="num"><strong>Request total</strong> <span class="muted small">(incl. shipping)</span></td>
                <td class="num"><strong id="grand-total">$0.00</strong></td>
                <td></td>
              </tr>
            </tfoot>
          </table>
        </div>
        <div class="add-row">
          <button type="button" class="btn btn-sm" data-action="add-item">+ Add another item</button>
          <span class="hint hide-touch">Tip: pressing Enter moves to the next box, and adds a new item from the last one.</span>
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
  const itemForRules = (item) => (oneVendor ? { ...item, vendor: form.querySelector('#f-vendor').value } : item);

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
    const shipping = oneShipping ? Number(orderShipping) || 0 : items.reduce((s, i) => s + (Number(i.shipping_cost) || 0), 0);
    grandTotal.textContent = fmtMoney(round2(items.reduce((s, i) => s + itemTotal(i), 0) + shipping));
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
    if (oneShipping) el.querySelector('#ship-label').colSpan = cols.length + 1;
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

  el.querySelector('#f-shipping')?.addEventListener('input', (e) => {
    orderShipping = e.target.value;
    updateTotals();
  });

  // ---- "Same for every item" ----
  const sharedBox = el.querySelector('#shared-box');
  const drawShared = () => {
    if (!sharedBox) return;
    const on = sharable.filter((f) => shared.has(f.key));
    sharedBox.innerHTML = `
      <div class="shared-toggles">
        <span class="small"><strong>Same for every item:</strong></span>
        ${sharable
          .map((f) => `<label class="role-chip ${shared.has(f.key) ? 'on' : ''}"><input type="checkbox" data-share="${esc(f.key)}" ${shared.has(f.key) ? 'checked' : ''}>${esc(f.label)}</label>`)
          .join('')}
      </div>
      ${
        on.length
          ? `<div class="form-grid shared-inputs">${on
              .map(
                (f) => `<div class="field w-${esc(f.type)}">
                  <label for="s-${esc(f.key)}">${esc(f.label)}${star(f)} <span class="muted small">(every item)</span></label>
                  ${renderInput({ ...f, placeholder: f.key === 'product_link' ? 'e.g. a shared Digi-Key or McMaster-Carr cart link' : f.placeholder }, getValue(items[0], f), config, `id="s-${esc(f.key)}" data-shared="${esc(f.key)}"`)}
                </div>`
              )
              .join('')}</div>`
          : ''
      }
      <p class="hint">${on.length ? '' : 'Tick one to type it once for all items, e.g. a single cart link. '}Every item still needs its own row below.</p>`;
  };
  sharedBox?.addEventListener('change', (e) => {
    const key = e.target.dataset.share;
    if (!key) return;
    const f = iFields.find((x) => x.key === key);
    if (e.target.checked) {
      // Start from the first value already typed in a row.
      shared.add(key);
      fillAll(f, items.map((i) => getValue(i, f)).find((v) => String(v ?? '').trim() !== '') ?? '');
    } else {
      shared.delete(key); // every row keeps the shared value, ready to edit
    }
    drawShared();
    renderRows();
    if (e.target.checked) sharedBox.querySelector(`#s-${CSS.escape(key)}`)?.focus();
  });
  const onSharedInput = (e) => {
    const key = e.target.dataset.shared;
    if (!key) return;
    fillAll(iFields.find((x) => x.key === key), e.target.value);
    if (['quantity', 'unit_price', 'shipping_cost'].includes(key)) renderRows(); // row totals (focus stays up here)
  };
  sharedBox?.addEventListener('input', onSharedInput);
  sharedBox?.addEventListener('change', onSharedInput); // selects

  el.addEventListener('click', (e) => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (action === 'add-item') {
      items.push(blankItem());
      dirty = true;
      renderRows();
      tbody.querySelector('tr:last-child input, tr:last-child select')?.focus();
    } else if (action === 'remove-item' && items.length > 1) {
      items.splice(Number(e.target.closest('tr').dataset.index), 1);
      dirty = true;
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
      items: items.map((i, idx) => {
        const out = { data: {} };
        for (const f of iFields) setValue(out, f, getValue(i, f));
        if (oneVendor) out.vendor = form.querySelector('#f-vendor').value.trim(); // same vendor for every item
        // Whole-order shipping goes on the first item (0 on the rest if Shipping is required).
        if (oneShipping) out.shipping_cost = idx === 0 ? orderShipping.trim() : shipField.required ? '0' : '';
        for (const f of iFields) if (!isVisible(f, request, out)) setValue(out, f, '');
        return out;
      }),
    };

    const buttons = form.querySelectorAll('button');
    buttons.forEach((b) => (b.disabled = true));
    errorsEl.innerHTML = '';
    clearMarks();
    try {
      const number = await api.saveRequest(existing?.id, payload);
      setFlash(action === 'submit' ? `${number} submitted for approval.` : `${number} saved as a draft.`);
      releaseGuard(); // saved: leaving is fine now
      location.hash = `#/requests/${number}`;
    } catch (err) {
      buttons.forEach((b) => (b.disabled = false));
      renderRows(); // restore "remove" disabled state (before marking item fields)
      showErrors(err);
    }
  });

  // ---- Errors: in the form's order, said plainly, and marked on the fields ----
  const fieldStarting = (fields, text) =>
    [...fields].filter((f) => f.type !== 'section' && text.startsWith(f.label)).sort((a, b) => b.label.length - a.label.length)[0];
  function explain(lines) {
    const out = [];
    let vendorSaid = false;
    for (const line of lines) {
      const m = line.match(/^Item (\d+): (.*)$/);
      if (m) {
        const n = Number(m[1]);
        const f = fieldStarting(iFields, m[2]);
        // The single vendor / shipping box: say it once, about that box.
        if (oneVendor && f === vendorField) {
          if (!vendorSaid) out.push({ order: 900, text: m[2], el: form.querySelector('#f-vendor') });
          vendorSaid = true;
          continue;
        }
        if (oneShipping && f === shipField) {
          out.push({ order: 90000, text: m[2], el: form.querySelector('#f-shipping') });
          continue;
        }
        const el = f && shared.has(f.key)
          ? sharedBox?.querySelector(`[data-shared="${f.key}"]`)
          : tbody.querySelectorAll('tr[data-index]')[n - 1]?.querySelector(`[data-ifield="${f?.key}"]`);
        out.push({ order: 1000 + n * 100 + (f ? iFields.indexOf(f) : 99), text: line, el });
        continue;
      }
      if (/^Add at least one item/.test(line)) {
        out.push({ order: 950, text: 'Fill in item 1: its name, quantity and unit price.', el: tbody.querySelector('[data-ifield="item_name"]') });
        continue;
      }
      const f = fieldStarting(rFields, line);
      out.push({ order: f ? rFields.indexOf(f) : 899, text: line, el: f ? form.querySelector(`[data-rfield="${f.key}"]`) : null });
    }
    return out.sort((a, b) => a.order - b.order);
  }
  function clearMarks() {
    form.querySelectorAll('.is-invalid').forEach((x) => {
      x.classList.remove('is-invalid');
      x.removeAttribute('aria-invalid');
    });
  }
  function showErrors(err) {
    const problems = err.details?.length ? explain(err.details) : [];
    if (problems.length) err.details = [...new Set(problems.map((p) => p.text))];
    errorsEl.innerHTML = errorBox(err);
    for (const p of problems) {
      if (!p.el) continue;
      p.el.classList.add('is-invalid');
      p.el.setAttribute('aria-invalid', 'true');
    }
    const first = problems.find((p) => p.el)?.el;
    if (first) {
      first.scrollIntoView({ behavior: 'smooth', block: 'center' });
      first.focus({ preventScroll: true });
    } else {
      errorsEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }
  form.addEventListener('input', (e) => {
    if (e.target.classList.contains('is-invalid')) {
      e.target.classList.remove('is-invalid');
      e.target.removeAttribute('aria-invalid');
    }
  });

  // ---- Enter moves to the next box (and adds a row from the last one); it never submits ----
  form.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing || !e.target.matches('input, select')) return;
    e.preventDefault();
    const row = e.target.closest('#items-body tr');
    const rowFields = row ? [...row.querySelectorAll('input, select, textarea')].filter((x) => !x.disabled) : [];
    if (row && row === tbody.lastElementChild && rowFields.at(-1) === e.target) {
      items.push(blankItem());
      dirty = true;
      renderRows();
      tbody.querySelector('tr:last-child input, tr:last-child select')?.focus();
      return;
    }
    const all = [...form.querySelectorAll('input, select, textarea')].filter((x) => !x.disabled && x.type !== 'checkbox' && x.offsetParent !== null);
    all[all.indexOf(e.target) + 1]?.focus();
  });

  // ---- Unsaved changes: switching pages or closing the tab asks first ----
  let dirty = false;
  form.addEventListener('input', () => (dirty = true));
  form.addEventListener('change', () => (dirty = true));
  guardLeaving(el, () => dirty);

  drawShared();
  renderRows();
}
