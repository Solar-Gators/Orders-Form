/**
 * Request detail page. Shows the full request, its items and history, plus
 * the one action panel that fits the request's status and the user's permissions:
 *   Draft / Changes Requested -> Edit (the person who created it)
 *   Submitted                 -> Approve / Request Changes / Reject (request.review)
 *   Approved                  -> Mark as Ordered (request.order)
 *   Ordered                   -> Mark as Received (request.order)
 */
import { api } from '../api.js';
import { auth } from '../auth.js';
import {
  STATUS, DECISION_LABELS, esc, fmtMoney, fmtDate, fmtDateTime, todayISO,
  statusBadge, priorityTag, isOverdue, errorBox, setFlash, takeFlash, copyButton, bindCopyButtons,
} from '../ui.js';
import { requestFields, itemFields, shown, getValue, displayValue, MONEY_FIELDS } from '../formFields.js';

/** The Treasurer copies values into purchasing forms, so they get copy buttons. */
const showCopy = () => auth.can('request.order');

/** Plain text to copy for a field value (dollars without "$", URLs as-is). */
function copyText(field, value) {
  if (value === null || value === undefined || value === '') return '';
  if (MONEY_FIELDS.has(field.key)) return Number(value).toFixed(2);
  return String(value);
}
const copyFor = (field, value) => (showCopy() ? copyButton(copyText(field, value), field.label) : '');

/** All items as tab-separated text (with a header row) — pastes into Excel or Sheets as a table. */
function itemsAsTable(r, config) {
  const fields = shown(itemFields(config));
  const clean = (v) => String(v ?? '').replace(/[\t\n\r]+/g, ' ');
  const header = [...fields.map((f) => f.label), 'Line total'];
  const rows = r.items.map((i) => [...fields.map((f) => clean(copyText(f, getValue(i, f)))), (i.item_total + (Number(i.shipping_cost) || 0)).toFixed(2)]);
  return [header, ...rows].map((row) => row.join('\t')).join('\n');
}

function itemsTable(r, config) {
  if (!r.items.length) return '<div class="empty">No items yet.</div>';
  // Item name gets its own column with notes underneath; other shown fields follow in form order.
  const fields = shown(itemFields(config));
  const nameField = fields.find((f) => f.key === 'item_name');
  const notesField = fields.find((f) => f.key === 'notes');
  const cols = fields.filter((f) => f !== nameField && f !== notesField);
  const isNum = (f) => f.type === 'number';
  const rows = r.items
    .map(
      (i, idx) => `<tr>
        <td class="muted hide-mobile">${idx + 1}</td>
        <td class="cell-primary" data-label=""><strong>${esc(i.item_name || '—')}</strong>${nameField ? copyFor(nameField, i.item_name) : ''}${notesField && i.notes ? `<div class="muted small">${esc(i.notes)}</div>` : ''}</td>
        ${cols.map((f) => `<td class="${isNum(f) ? 'num' : ''}" data-label="${esc(f.label)}"><span class="copy-wrap">${displayValue(f, getValue(i, f))}${copyFor(f, getValue(i, f))}</span></td>`).join('')}
        <td class="num" data-label="Total">${fmtMoney(i.item_total)}</td>
      </tr>`
    )
    .join('');
  return `<div class="table-wrap flat"><table class="table detail-items stack-mobile">
    <thead><tr><th>#</th><th>${esc(nameField?.label || 'Item')}</th>${cols
      .map((f) => `<th class="${isNum(f) ? 'num' : ''}">${esc(f.label)}</th>`)
      .join('')}<th class="num">Total</th></tr></thead>
    <tbody>${rows}</tbody>
    <tfoot>
      ${r.shipping ? `<tr class="subtotal"><td colspan="${cols.length + 2}" class="num">Items</td><td class="num">${fmtMoney(r.subtotal)}</td></tr>
      <tr class="subtotal"><td colspan="${cols.length + 2}" class="num">Shipping</td><td class="num">${fmtMoney(r.shipping)}</td></tr>` : ''}
      <tr><td colspan="${cols.length + 2}" class="num"><strong>Request total</strong></td><td class="num"><strong>${fmtMoney(r.total)}</strong></td></tr>
    </tfoot>
  </table></div>`;
}

/** Statuses in which the Treasurer can still adjust costs. */
const COST_EDITABLE = [STATUS.APPROVED, STATUS.ORDERED, STATUS.RECEIVED];
const canEditCosts = (r) => auth.can('request.order') && COST_EDITABLE.includes(r.status);

/** Treasurer's "Edit costs" mode: unit price + shipping per item, with a reason. */
function costEditor(r) {
  const money = (v) => (v === null || v === undefined || v === '' ? '' : String(Number(v)));
  return `<form id="cost-form" novalidate>
    <p class="muted small">Change what was actually paid. Every change is recorded in the history with your name and the reason.</p>
    <div class="table-wrap flat"><table class="table cost-table stack-form">
      <thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Unit price</th><th class="num">Shipping</th><th class="num">Line total</th></tr></thead>
      <tbody>${r.items
        .map(
          (i) => `<tr data-id="${esc(i.id)}">
            <td class="w-idx"><strong>${esc(i.item_name || '—')}</strong></td>
            <td class="num" data-label="Quantity">${esc(i.quantity ?? '—')}</td>
            <td class="w-number" data-label="Unit price"><input type="number" min="0" step="0.01" inputmode="decimal" name="unit_price"
              value="${esc(money(i.unit_price))}" data-original="${esc(money(i.unit_price))}" aria-label="Unit price for ${esc(i.item_name)}"></td>
            <td class="w-number" data-label="Shipping"><input type="number" min="0" step="0.01" inputmode="decimal" name="shipping_cost"
              value="${esc(money(i.shipping_cost))}" data-original="${esc(money(i.shipping_cost))}" placeholder="—" aria-label="Shipping for ${esc(i.item_name)}"></td>
            <td class="num w-total" data-label="Line total" data-role="line">${fmtMoney((Number(i.quantity) || 0) * (Number(i.unit_price) || 0) + (Number(i.shipping_cost) || 0))}</td>
          </tr>`
        )
        .join('')}</tbody>
    </table></div>
    <div class="field">
      <label for="cost-reason">Reason <span class="muted">(optional, e.g. "price changed at checkout", "free shipping")</span></label>
      <input id="cost-reason" name="reason" type="text" maxlength="300">
    </div>
    <div id="cost-errors"></div>
    <div class="form-actions">
      <span class="muted small" id="cost-new-total"></span>
      <button type="button" class="btn btn-ghost" id="cost-cancel">Cancel</button>
      <button type="submit" class="btn btn-primary">Save costs</button>
    </div>
  </form>`;
}

/** Cost changes made in one save share a timestamp; show each save as one history entry. */
function costEvents(r) {
  const FIELD = { unit_price: 'unit price', shipping_cost: 'shipping' };
  const fmt = (v) => (v === null || v === undefined ? 'none' : fmtMoney(v));
  const groups = new Map();
  for (const c of r.cost_changes) {
    const key = `${c.created_at}|${c.changed_by_name}|${c.reason}`;
    if (!groups.has(key)) groups.set(key, { when: c.created_at, who: c.changed_by_name, reason: c.reason, lines: [] });
    groups.get(key).lines.push(`${esc(c.item_name)}: ${FIELD[c.field]} ${fmt(c.old_value)} → <strong>${fmt(c.new_value)}</strong>`);
  }
  return [...groups.values()].map((g) => ({
    when: g.when,
    text: `<strong>Costs adjusted</strong> by ${esc(g.who)}<ul class="change-list">${g.lines.map((l) => `<li>${l}</li>`).join('')}</ul>`,
    comment: g.reason,
    kind: 'cost',
  }));
}

/** Request fields except the title/priority (shown in the header). Long text goes full width. */
function detailsGrid(r, config) {
  const fields = shown(requestFields(config)).filter((f) => f.key !== 'title' && f.key !== 'priority');
  const cell = (f) => {
    const value = getValue(r, f);
    const cls = f.key === 'needed_by' && isOverdue(r) ? 'overdue' : f.type === 'textarea' ? 'prewrap' : '';
    return `<div class="${f.type === 'textarea' ? 'span-full' : ''}"><dt>${esc(f.label)}</dt><dd class="${cls}"><span class="copy-wrap">${displayValue(f, value)}${copyFor(f, value)}</span></dd></div>`;
  };
  const short = fields.filter((f) => f.type !== 'textarea').map(cell).join('');
  const long = fields.filter((f) => f.type === 'textarea').map(cell).join('');
  return `<dl class="meta-grid">${short}<div><dt>Vendors</dt><dd>${esc(r.vendors.join(', ') || '—')}</dd></div>${long}</dl>`;
}

function historyCard(r) {
  const events = [{ when: r.created_at, text: `Created by ${esc(r.requester || 'unknown')}` }];
  for (const a of r.approvals) {
    events.push({
      when: a.created_at,
      text: `<strong>${esc(DECISION_LABELS[a.decision] || a.decision)}</strong> by ${esc(a.approver)}`,
      comment: a.comment,
      kind: a.decision,
    });
  }
  if (r.order) {
    events.push({
      when: r.order.order_date,
      dateOnly: true,
      text: `<strong>Ordered</strong>${r.order.department_order_number ? ` · Ticket # ${esc(r.order.department_order_number)}` : ''}`,
      comment: r.order.treasurer_notes,
      kind: 'ordered',
    });
    if (r.order.received_date || r.status === STATUS.RECEIVED) {
      events.push({
        when: r.order.received_date,
        dateOnly: true,
        text: `<strong>Received</strong>${r.order.received_date ? '' : ' <span class="muted small">(date not recorded)</span>'}`,
        comment: r.order.received_notes,
        kind: 'received',
      });
    }
  }
  events.push(...costEvents(r));
  // Cost changes happen at a time; order dates are just dates — sort by day, keeping same-day order stable.
  const day = (e) => String(e.when || '9999').slice(0, 10);
  events.sort((a, b) => day(a).localeCompare(day(b)));
  return `<section class="card">
    <h2>History</h2>
    <ol class="timeline">
      ${events
        .map(
          (e) => `<li class="tl-${esc(e.kind || 'created')}">
            <div>${e.text}</div>
            <div class="muted small">${e.dateOnly ? fmtDate(e.when) : fmtDateTime(e.when)}</div>
            ${e.comment ? `<blockquote>${esc(e.comment)}</blockquote>` : ''}
          </li>`
        )
        .join('')}
    </ol>
  </section>`;
}

/** CE or Treasurer: sees every queue, so explain which role can act. */
const isLead = () => auth.can('request.review') || auth.can('request.order');

const waitingCard = (title, text) => `<section class="card action-card"><h2>${title}</h2><p class="muted">${text}</p></section>`;

function actionPanel(r, config) {
  const isOwner = r.created_by === auth.user.id;

  if (config.editableStatuses.includes(r.status)) {
    const heading = r.status === STATUS.DRAFT ? 'Draft' : 'Changes requested';
    if (!isOwner) return waitingCard(heading, `Waiting on ${esc(r.requester || 'the requester')} to finish and submit.`);
    return `<section class="card action-card">
      <h2>${heading}</h2>
      <p class="muted">${r.status === STATUS.DRAFT ? 'This request has not been submitted yet.' : 'Update the request and resubmit it for approval.'}</p>
      <a class="btn btn-primary" href="#/requests/${esc(r.request_number)}/edit">Edit request</a>
    </section>`;
  }

  if (r.status === STATUS.SUBMITTED) {
    if (!auth.can('request.review')) return waitingCard('Awaiting approval', isLead() ? 'View only — only a <strong>Chief Engineer</strong> can approve, reject, or request changes.' : 'A Chief Engineer will review this request.');
    return `<section class="card action-card">
      <h2>Review</h2>
      <form id="review-form" novalidate>
        <p class="muted small">Signing as <strong>${esc(auth.displayName)}</strong></p>
        <div class="field">
          <label for="r-comment">Comment <span class="muted">(required for changes / reject)</span></label>
          <textarea id="r-comment" name="comment" rows="3"></textarea>
        </div>
        <div id="action-errors"></div>
        <div class="stack-buttons">
          <button type="submit" class="btn btn-success" data-decision="approve">Approve</button>
          <button type="submit" class="btn btn-warning" data-decision="request_changes">Request Changes</button>
          <button type="submit" class="btn btn-danger" data-decision="reject">Reject</button>
        </div>
      </form>
    </section>`;
  }

  if (r.status === STATUS.APPROVED) {
    if (!auth.can('request.order')) return waitingCard('Ready to order', isLead() ? 'View only — only the <strong>Treasurer</strong> can mark this as Ordered.' : 'The Treasurer will place this order.');
    return `<section class="card action-card">
      <h2>Place order</h2>
      <form id="order-form" novalidate>
        <div class="field">
          <label for="o-date">Order date</label>
          <input id="o-date" name="order_date" type="date" value="${todayISO()}">
        </div>
        <div class="field">
          <label for="o-number">Ticket / Dept. Order # <span class="muted">(optional)</span></label>
          <input id="o-number" name="department_order_number" type="text" placeholder="e.g. 6046">
        </div>
        <div class="field">
          <label for="o-notes">Treasurer notes <span class="muted">(optional)</span></label>
          <textarea id="o-notes" name="treasurer_notes" rows="3"></textarea>
        </div>
        <div id="action-errors"></div>
        <button type="submit" class="btn btn-primary btn-block">Mark as Ordered</button>
      </form>
    </section>`;
  }

  if (r.status === STATUS.ORDERED) {
    if (!auth.can('request.order')) return waitingCard('Ordered', isLead() ? 'View only — only the <strong>Treasurer</strong> can mark this as Received.' : 'Waiting for delivery.');
    return `<section class="card action-card">
      <h2>Delivery</h2>
      <form id="receive-form" novalidate>
        <div class="field">
          <label for="d-date">Received date</label>
          <input id="d-date" name="received_date" type="date" value="${todayISO()}">
        </div>
        <div class="field">
          <label for="d-notes">Notes <span class="muted">(optional, e.g. "in office")</span></label>
          <textarea id="d-notes" name="received_notes" rows="2"></textarea>
        </div>
        <div id="action-errors"></div>
        <button type="submit" class="btn btn-primary btn-block">Mark as Received</button>
      </form>
    </section>`;
  }

  return ''; // Rejected / Received: nothing left to do
}

export async function renderRequestDetail(el, { config, params, rerender }) {
  const r = await api.getRequest(params.id);

  el.innerHTML = `
    ${takeFlash()}
    <a class="back-link" href="#/requests">← All requests</a>
    <div class="page-header">
      <div>
        <div class="eyebrow mono"><span class="copy-wrap">${esc(r.request_number)}${showCopy() ? copyButton(r.request_number, 'request ID') : ''}</span></div>
        <h1>${esc(r.title || 'Untitled request')}</h1>
        <p class="subtitle">${statusBadge(r.status)} ${priorityTag(r.priority)}</p>
      </div>
      <div class="big-total"><span class="muted small">Request total</span><span class="copy-wrap">${fmtMoney(r.total)}${showCopy() ? copyButton(r.total.toFixed(2), 'request total') : ''}</span></div>
    </div>

    <div class="detail-layout">
      <div class="detail-main">
        <section class="card">
          <h2>Details</h2>
          ${detailsGrid(r, config)}
        </section>
        <section class="card" id="items-card">
          <div class="card-head">
            <h2>Items (${r.items.length})${r.cost_changes.length ? ' <span class="field-tag" title="See History">Costs adjusted</span>' : ''}</h2>
            <div class="card-actions">
              ${showCopy() && r.items.length ? `<button type="button" class="btn btn-sm" data-copy="${esc(itemsAsTable(r, config))}" data-copied-label="Copied ✓"
                title="Copies every item as a table — paste into Excel, Sheets, or a form">Copy all items</button>` : ''}
              ${canEditCosts(r) && r.items.length ? '<button type="button" class="btn btn-sm" id="edit-costs">Edit costs</button>' : ''}
            </div>
          </div>
          <div id="items-body">${itemsTable(r, config)}</div>
        </section>
      </div>
      <aside class="detail-side">
        ${actionPanel(r, config)}
        ${historyCard(r)}
      </aside>
    </div>`;

  bindCopyButtons(el);

  const errors = el.querySelector('#action-errors');
  const run = async (form, fn, message) => {
    form.querySelectorAll('button').forEach((b) => (b.disabled = true));
    errors.innerHTML = '';
    try {
      await fn();
      setFlash(message);
      await rerender();
      window.scrollTo({ top: 0, behavior: 'smooth' }); // bring the confirmation into view
    } catch (err) {
      errors.innerHTML = errorBox(err);
      form.querySelectorAll('button').forEach((b) => (b.disabled = false));
    }
  };

  el.querySelector('#review-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const decision = e.submitter?.dataset.decision;
    const comment = e.target.comment.value.trim();
    if (decision !== 'approve' && !comment) {
      errors.innerHTML = errorBox(new Error('Please add a comment explaining what needs to change.'));
      return;
    }
    run(e.target, () => api.review(r.id, decision, comment), `${r.request_number} ${DECISION_LABELS[decision].toLowerCase()}.`);
  });

  el.querySelector('#order-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    run(e.target, () => api.markOrdered(r.id, Object.fromEntries(new FormData(e.target))), `${r.request_number} marked as ordered.`);
  });

  el.querySelector('#receive-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    run(e.target, () => api.markReceived(r.id, Object.fromEntries(new FormData(e.target))), `${r.request_number} marked as received.`);
  });

  // ---- Treasurer: edit costs ------------------------------------------------------
  el.querySelector('#edit-costs')?.addEventListener('click', (e) => {
    e.target.hidden = true;
    const body = el.querySelector('#items-body');
    body.innerHTML = costEditor(r);
    const form = body.querySelector('#cost-form');
    const newTotal = body.querySelector('#cost-new-total');

    const recalc = () => {
      let total = 0;
      form.querySelectorAll('tr[data-id]').forEach((tr) => {
        const item = r.items.find((i) => i.id === tr.dataset.id);
        const line = (Number(item.quantity) || 0) * (Number(tr.querySelector('[name=unit_price]').value) || 0) +
          (Number(tr.querySelector('[name=shipping_cost]').value) || 0);
        tr.querySelector('[data-role=line]').textContent = fmtMoney(line);
        total += line;
      });
      newTotal.innerHTML = Math.abs(total - r.total) > 0.004
        ? `New total <strong>${fmtMoney(total)}</strong> (was ${fmtMoney(r.total)})`
        : '';
    };
    form.addEventListener('input', recalc);
    form.querySelector('input[name=unit_price]')?.focus();

    body.querySelector('#cost-cancel').addEventListener('click', () => rerender());

    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const errs = body.querySelector('#cost-errors');
      errs.innerHTML = '';
      // Only send values that actually changed.
      const changes = [];
      for (const tr of form.querySelectorAll('tr[data-id]')) {
        const change = { id: tr.dataset.id };
        for (const input of tr.querySelectorAll('input')) {
          if (input.value.trim() !== input.dataset.original) change[input.name] = input.value.trim();
        }
        if (Object.keys(change).length > 1) changes.push(change);
      }
      if (!changes.length) return rerender();
      const bad = changes.find((c) => c.unit_price !== undefined && c.unit_price === '');
      if (bad) {
        errs.innerHTML = errorBox(new Error('Unit price can’t be blank — enter 0 if the item was free.'));
        return;
      }
      const buttons = form.querySelectorAll('button');
      buttons.forEach((b) => (b.disabled = true));
      try {
        const n = await api.updateItemCosts(r.id, changes, form.reason.value.trim());
        setFlash(`Costs updated for ${r.request_number} (${n} change${n === 1 ? '' : 's'}).`);
        await rerender();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } catch (err) {
        errs.innerHTML = errorBox(err);
        buttons.forEach((b) => (b.disabled = false));
      }
    });
  });
}
