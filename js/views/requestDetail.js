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
  statusBadge, priorityTag, isOverdue, errorBox, setFlash, takeFlash,
} from '../ui.js';
import { requestFields, itemFields, shown, getValue, displayValue } from '../formFields.js';

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
        <td class="muted">${idx + 1}</td>
        <td><strong>${esc(i.item_name || '—')}</strong>${notesField && i.notes ? `<div class="muted small">${esc(i.notes)}</div>` : ''}</td>
        ${cols.map((f) => `<td class="${isNum(f) ? 'num' : ''}">${displayValue(f, getValue(i, f))}</td>`).join('')}
        <td class="num">${fmtMoney(i.item_total)}</td>
      </tr>`
    )
    .join('');
  return `<div class="table-wrap flat"><table class="table detail-items">
    <thead><tr><th>#</th><th>${esc(nameField?.label || 'Item')}</th>${cols
      .map((f) => `<th class="${isNum(f) ? 'num' : ''}">${esc(f.label)}</th>`)
      .join('')}<th class="num">Total</th></tr></thead>
    <tbody>${rows}</tbody>
    <tfoot><tr><td colspan="${cols.length + 2}" class="num"><strong>Request total</strong></td><td class="num"><strong>${fmtMoney(r.total)}</strong></td></tr></tfoot>
  </table></div>`;
}

/** Request fields except the title/priority (shown in the header). Long text goes full width. */
function detailsGrid(r, config) {
  const fields = shown(requestFields(config)).filter((f) => f.key !== 'title' && f.key !== 'priority');
  const cell = (f) => {
    const value = getValue(r, f);
    const cls = f.key === 'needed_by' && isOverdue(r) ? 'overdue' : f.type === 'textarea' ? 'prewrap' : '';
    return `<div class="${f.type === 'textarea' ? 'span-full' : ''}"><dt>${esc(f.label)}</dt><dd class="${cls}">${displayValue(f, value)}</dd></div>`;
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
        <div class="eyebrow mono">${esc(r.request_number)}</div>
        <h1>${esc(r.title || 'Untitled request')}</h1>
        <p class="subtitle">${statusBadge(r.status)} ${priorityTag(r.priority)}</p>
      </div>
      <div class="big-total"><span class="muted small">Request total</span>${fmtMoney(r.total)}</div>
    </div>

    <div class="detail-layout">
      <div class="detail-main">
        <section class="card">
          <h2>Details</h2>
          ${detailsGrid(r, config)}
        </section>
        <section class="card">
          <h2>Items (${r.items.length})</h2>
          ${itemsTable(r, config)}
        </section>
      </div>
      <aside class="detail-side">
        ${actionPanel(r, config)}
        ${historyCard(r)}
      </aside>
    </div>`;

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
}
