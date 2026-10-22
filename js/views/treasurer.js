/**
 * Treasurer: approved requests to order, and ordered requests awaiting delivery.
 * Both lists are sortable; their columns and default sorts come from Admin → Display → Request lists.
 * Budgets live on Finances → Budget; this page only warns when one is over.
 * The Treasurer's working columns (025) always show for them: the purchasing step (a dropdown
 * in To order), how many items arrived, and their own notes (editable right in the list).
 */
import { api } from '../api.js';
import { auth } from '../auth.js';
import { STATUS, LATE_DELIVERY_DAYS, esc, fmtMoney, fmtDateTime, todayISO, requestTable, bindRowLinks, bindSorting, errorBox, setFlash, takeFlash, introText, pageTabs } from '../ui.js';
import { stepOf } from '../ledger.js';
import { budgetSummary, workflowSettings } from '../workflow.js';
import { listColumns, listSort } from '../listColumns.js';
import { rememberedSort } from './listSortState.js';

export async function renderTreasurer(el, { config, rerender }) {
  const all = await api.listRequests([STATUS.APPROVED, STATUS.ORDERED]);
  const toOrder = all.filter((r) => r.status === STATUS.APPROVED);
  const inTransit = all.filter((r) => r.status === STATUS.ORDERED);
  const sum = (rows) => fmtMoney(rows.reduce((s, r) => s + r.total, 0));
  const late = inTransit.filter((r) => r.order?.order_date && Date.now() - new Date(`${String(r.order.order_date).slice(0, 10)}T12:00:00`) > LATE_DELIVERY_DAYS * 86400000);
  const ledgerOn = (auth.can('finances.view') || auth.can('finances.edit')) && Number(config.schemaVersion) >= 18;
  const [purchases, deleted] = await Promise.all([
    ledgerOn || workflowSettings(config).budgets.field ? api.listPurchases().catch(() => null) : null,
    auth.can('request.order') && Number(config.schemaVersion) >= 25 ? api.listDeletedRequests() : null,
  ]);
  const budgets = workflowSettings(config).budgets.field
    ? budgetSummary(config, await api.listRequests(null, { season: config.season }), purchases || [])
    : [];
  // Each request's line on Finances (its step and the Treasurer's note).
  const editable = Number(config.schemaVersion) >= 25 && auth.can('request.order') && ledgerOn;
  if (ledgerOn && purchases) {
    const byRequest = new Map(purchases.filter((p) => p.request_id).map((p) => [p.request_id, p]));
    for (const r of all) Object.assign(r, { purchase: byRequest.get(r.id) || null, editable });
  }

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
    <div id="in-transit"></div>
    ${deleted?.length ? deletedCard(deleted) : ''}`;

  const lists = [
    ['treasurerToOrder', el.querySelector('#to-order'), toOrder, 'No approved requests are waiting to be ordered.'],
    ['treasurerOrdered', el.querySelector('#in-transit'), inTransit, 'Nothing is on order right now.'],
  ];
  // The Treasurer's working columns show even if the list's saved columns predate them.
  const always = { treasurerToOrder: ['step', 'treasurerNote'], treasurerOrdered: ['arrived', 'treasurerNote'] };
  for (const [name, box, rows, empty] of lists) {
    const columns = listColumns(name, config);
    if (editable) {
      const all = new Map(listColumns(name, { ...config, lists: {} }).map((c) => [c.key, c]));
      for (const key of always[name]) if (!columns.some((c) => c.key === key) && all.get(key)) columns.push(all.get(key));
    }
    const sort = rememberedSort(name, listSort(name, config), columns);
    const draw = () => (box.innerHTML = requestTable(rows, columns, empty, sort));
    bindSorting(box, sort, columns, draw);
    draw();
  }
  bindRowLinks(el);
  bindBatch(el, toOrder, rerender);
  if (editable) bindLedgerEdits(el, all);
}

/** Step dropdowns and note editing right in the lists; both save to the request's Finances line. */
function bindLedgerEdits(el, rows) {
  const save = async (r, fields, node) => {
    try {
      const id = await api.savePurchase(r.purchase?.id || null, r.purchase?.id ? fields : { ...fields, request_id: r.id });
      r.purchase = { ...(r.purchase || { id }), ...fields };
      return true;
    } catch (err) {
      node.closest('td').insertAdjacentHTML('beforeend', errorBox(err));
      return false;
    }
  };
  el.addEventListener('change', async (e) => {
    const sel = e.target.closest('[data-step-for]');
    if (!sel) return;
    const r = rows.find((x) => x.id === sel.dataset.stepFor);
    sel.className = `step-select step-${stepOf(sel.value).tone}`;
    await save(r, { dept_status: sel.value }, sel);
  });
  el.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-note-for]');
    if (!btn) return;
    const r = rows.find((x) => x.id === btn.dataset.noteFor);
    const cell = btn.closest('td');
    cell.innerHTML = `<textarea class="note-input" rows="2" maxlength="2000" aria-label="Treasurer note for ${esc(r.request_number)}"
      placeholder="Quote #, who you emailed, what's left…">${esc(r.purchase?.notes || '')}</textarea>`;
    const box = cell.querySelector('textarea');
    box.focus();
    let saving = false;
    const done = async () => {
      if (saving) return;
      saving = true;
      box.disabled = true;
      if (box.value !== (r.purchase?.notes || '') && !(await save(r, { notes: box.value }, box))) return (box.disabled = false), (saving = false);
      cell.innerHTML = `<span class="note-text">${esc(r.purchase?.notes || '')}</span><button type="button" class="icon-btn note-edit" data-note-for="${esc(r.id)}" title="Edit note" aria-label="Edit note">✎</button>`;
    };
    box.addEventListener('blur', done);
    box.addEventListener('change', done);
    box.addEventListener('keydown', (k) => {
      if (k.key === 'Enter' && !k.shiftKey) {
        k.preventDefault();
        box.blur();
      }
    });
  });
}

/** Requests the Treasurer deleted entirely (duplicates, mistakes), with why. A copy of each is kept. */
function deletedCard(rows) {
  return `<details class="card deleted-requests">
    <summary><strong>Deleted requests</strong> <span class="muted small">${rows.length} · removed entirely, e.g. duplicates. A copy of each is kept in the database.</span></summary>
    <div class="table-wrap flat"><table class="table stack-mobile">
      <thead><tr><th>Request</th><th>Status</th><th class="num">Total</th><th>Deleted</th><th>Why</th></tr></thead>
      <tbody>${rows.map((d) => `<tr>
        <td class="cell-primary" data-label=""><span class="mono small">${esc(d.request_number)}</span> ${esc(d.title || 'Untitled')}</td>
        <td data-label="Status">${esc(d.status)}</td>
        <td class="num" data-label="Total">${fmtMoney(d.total)}</td>
        <td data-label="Deleted">${fmtDateTime(d.deleted_at)}<div class="muted small">${esc(d.deleted_by_name || '')}</div></td>
        <td data-label="Why">${esc(d.reason)}</td></tr>`).join('')}</tbody>
    </table></div>
  </details>`;
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
