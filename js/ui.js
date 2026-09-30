/** Shared formatting and small UI helpers used by every view. */

// Workflow statuses. The database enforces the transitions (supabase/schema.sql);
// keep this list in sync with the `status` check constraint there.
export const STATUS = Object.freeze({
  DRAFT: 'Draft',
  SUBMITTED: 'Submitted',
  CHANGES_REQUESTED: 'Changes Requested',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  ORDERED: 'Ordered',
  RECEIVED: 'Received',
});
export const STATUSES = Object.values(STATUS);
export const EDITABLE_STATUSES = [STATUS.DRAFT, STATUS.CHANGES_REQUESTED];

export const DECISION_LABELS = {
  approve: 'Approved',
  request_changes: 'Changes requested',
  reject: 'Rejected',
};

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
export const fmtMoney = (n) => money.format(Number(n) || 0);

export const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
export const itemTotal = (item) => round2((Number(item.quantity) || 0) * (Number(item.unit_price) || 0));

/** Format "YYYY-MM-DD" (a calendar date) or an ISO timestamp for display. */
export function fmtDate(value) {
  if (!value) return '—';
  const opts = { month: 'short', day: 'numeric', year: 'numeric' };
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('en-US', opts);
  }
  return new Date(value).toLocaleDateString('en-US', opts);
}

export function fmtDateTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-');

export const statusBadge = (status) => `<span class="badge badge-${slug(status)}">${esc(status)}</span>`;

export const priorityTag = (priority) =>
  priority ? `<span class="priority priority-${slug(priority)}">${esc(priority)}</span>` : '';

/** Is `needed_by` today or earlier (and still in an open status)? */
export function isOverdue(r) {
  return r.needed_by && r.needed_by <= todayISO() && ![STATUS.ORDERED, STATUS.RECEIVED, STATUS.REJECTED].includes(r.status);
}

/**
 * Render a table of requests. Each column: { label, cell(r) => html, className }.
 * Rows link to the request detail page.
 */
export function requestTable(rows, columns, emptyMessage = 'Nothing here yet.', sort = null) {
  if (!rows.length) return `<div class="empty">${esc(emptyMessage)}</div>`;
  if (sort) rows = sortRows(rows, columns, sort);
  const head = columns
    .map((c) => {
      if (!sort || !c.sort) return `<th class="${c.className || ''}">${esc(c.label)}</th>`;
      const active = sort.key === c.key;
      const aria = active ? (sort.dir === 'desc' ? 'descending' : 'ascending') : 'none';
      return `<th class="${c.className || ''} sortable${active ? ' sorted' : ''}" aria-sort="${aria}">
        <button type="button" class="sort-btn" data-sort="${esc(c.key)}" title="Sort by ${esc(c.label)}">${esc(c.label)}<span class="sort-ind" aria-hidden="true">${
          active ? (sort.dir === 'desc' ? '▼' : '▲') : '↕'
        }</span></button></th>`;
    })
    .join('');
  // Phones hide the header row (card layout), so offer a "Sort by" menu instead.
  const sortBar = sort
    ? `<div class="sort-bar"><label>Sort by
        <select data-sort-select aria-label="Sort by">${columns
          .filter((c) => c.sort)
          .flatMap((c) =>
            [c.defaultDir || 'asc', c.defaultDir === 'desc' ? 'asc' : 'desc'].map(
              (dir) => `<option value="${esc(c.key)}:${dir}" ${sort.key === c.key && sort.dir === dir ? 'selected' : ''}>${esc(c.label)} (${esc(
                (c.dirLabels || DIR_LABELS)[dir]
              )})</option>`
            )
          )
          .join('')}</select></label></div>`
    : '';
  const body = rows
    .map(
      (r) => `<tr class="clickable" data-href="#/requests/${esc(r.request_number)}">
        ${columns.map((c) => `<td class="${c.className || ''}${c.primary ? ' cell-primary' : ''}" data-label="${c.primary ? '' : esc(c.label)}">${c.cell(r)}</td>`).join('')}
      </tr>`
    )
    .join('');
  return `${sortBar}<div class="table-wrap"><table class="table stack-mobile"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

// ---- Sorting ----------------------------------------------------------------

const DIR_LABELS = { asc: 'A → Z', desc: 'Z → A' };
const DATE_LABELS = { desc: 'newest first', asc: 'oldest first' };
const NUM_LABELS = { desc: 'highest first', asc: 'lowest first' };

const isBlank = (v) => v === null || v === undefined || v === '';

/** Sort rows by the column `sort.key` (`sort.dir` 'asc' | 'desc'). Blanks always go last. */
export function sortRows(rows, columns, sort) {
  const col = columns.find((c) => c.key === sort?.key);
  if (!col?.sort) return rows;
  const dir = sort.dir === 'desc' ? -1 : 1;
  return [...rows].sort((a, b) => {
    const x = col.sort(a);
    const y = col.sort(b);
    if (isBlank(x) || isBlank(y)) return isBlank(x) === isBlank(y) ? 0 : isBlank(x) ? 1 : -1;
    if (typeof x === 'number' && typeof y === 'number') return (x - y) * dir;
    return String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: 'base' }) * dir;
  });
}

/**
 * Make the tables rendered inside `container` sortable. `state` ({ key, dir }) is
 * updated in place; `redraw()` re-renders. Clicking the active column flips the
 * direction; a new column starts in its natural direction (e.g. newest first).
 */
export function bindSorting(container, state, columns, redraw) {
  container.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-sort]');
    if (!btn) return;
    const col = columns.find((c) => c.key === btn.dataset.sort);
    if (state.key === col.key) state.dir = state.dir === 'asc' ? 'desc' : 'asc';
    else Object.assign(state, { key: col.key, dir: col.defaultDir || 'asc' });
    redraw();
  });
  container.addEventListener('change', (e) => {
    if (!e.target.matches('[data-sort-select]')) return;
    const [key, dir] = e.target.value.split(':');
    Object.assign(state, { key, dir });
    redraw();
  });
}

// Requests from an earlier season (still waiting on someone) are labelled with it.
let currentSeason = '';
export const setCurrentSeason = (s) => (currentSeason = s || '');
export const seasonTag = (r) =>
  r.season && currentSeason && r.season !== currentSeason ? ` <span class="season-tag" title="From an earlier season">${esc(r.season)}</span>` : '';

/** Common column definitions, reused across the list pages. */
export const COLUMNS = {
  id: { label: 'Request ID', primary: true, cell: (r) => `<a class="mono" href="#/requests/${esc(r.request_number)}">${esc(r.request_number)}</a>` },
  /** When it was requested — more useful in lists than the SG number. */
  requested: {
    label: 'Requested',
    className: 'nowrap',
    cell: (r) => `<time datetime="${esc((r.created_at || '').slice(0, 10))}">${fmtDate(r.created_at)}</time>`,
    sort: (r) => r.created_at,
    defaultDir: 'desc',
    dirLabels: DATE_LABELS,
  },
  title: {
    label: 'Title',
    primary: true,
    cell: (r) =>
      `<a class="cell-title title-link" href="#/requests/${esc(r.request_number)}">${esc(r.title || 'Untitled request')}</a> ${priorityTag(r.priority !== 'Normal' ? r.priority : '')}${seasonTag(r)}`,
    sort: (r) => r.title,
  },
  requester: { label: 'Requester', cell: (r) => esc(r.requester || '—'), sort: (r) => r.requester },
  subsystem: { label: 'Subsystem', cell: (r) => esc(r.subsystem || '—'), sort: (r) => r.subsystem },
  total: {
    label: 'Total',
    className: 'num',
    cell: (r) => fmtMoney(r.total),
    sort: (r) => Number(r.total) || 0,
    defaultDir: 'desc',
    dirLabels: NUM_LABELS,
  },
  status: {
    label: 'Status',
    cell: (r) => statusBadge(r.status),
    sort: (r) => STATUSES.indexOf(r.status), // workflow order, not alphabetical
    dirLabels: { asc: 'Draft → Received', desc: 'Received → Draft' },
  },
  neededBy: {
    label: 'Needed By',
    cell: (r) => `<span class="${isOverdue(r) ? 'overdue' : ''}">${fmtDate(r.needed_by)}</span>`,
    sort: (r) => r.needed_by,
    dirLabels: { asc: 'soonest first', desc: 'latest first' },
  },
  vendors: { label: 'Vendor', cell: (r) => esc(r.vendors.join(', ') || '—'), sort: (r) => r.vendors[0] },
  approvedOn: {
    label: 'Approved',
    cell: (r) => fmtDate(r.latest_approval?.created_at),
    sort: (r) => r.latest_approval?.created_at,
    dirLabels: { asc: 'oldest first', desc: 'newest first' },
  },
  orderedOn: {
    label: 'Ordered',
    cell: (r) => fmtDate(r.order?.order_date),
    sort: (r) => r.order?.order_date,
    dirLabels: { asc: 'oldest first', desc: 'newest first' },
  },
  orderNumber: { label: 'Ticket #', cell: (r) => esc(r.order?.department_order_number || '—'), sort: (r) => r.order?.department_order_number },
};
for (const [key, col] of Object.entries(COLUMNS)) col.key = key;

/** Make clickable table rows navigate (event delegation, once per view). */
export function bindRowLinks(el) {
  el.addEventListener('click', (e) => {
    if (e.target.closest('a, button, input, select, textarea')) return;
    const row = e.target.closest('tr[data-href]');
    if (row) location.hash = row.dataset.href;
  });
}

export function errorBox(err) {
  err = err instanceof Error || err?.message ? err : new Error(String(err));
  const details = err.details?.length ? `<ul>${err.details.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>` : '';
  return `<div class="alert alert-error" role="alert"><strong>${esc(err.message)}</strong>${details}</div>`;
}

// ---- One-shot flash message shown on the next page render ----------------

let flash = null;
export function setFlash(message, type = 'success') {
  flash = { message, type };
}
export function takeFlash() {
  const f = flash;
  flash = null;
  return f ? `<div class="alert alert-${f.type}" role="status">${esc(f.message)}</div>` : '';
}

// ---- Copy to clipboard (Treasurer: paste into purchasing forms) ------------

/** A small copy button for `value`. Nothing is rendered for empty values. */
export function copyButton(value, label = 'value') {
  if (value === null || value === undefined || String(value).trim() === '') return '';
  return `<button type="button" class="copy-btn" data-copy="${esc(value)}" title="Copy ${esc(label)}" aria-label="Copy ${esc(label)}">
    <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5" y="5" width="9" height="9" rx="1.5"/><path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5"/></svg>
  </button>`;
}

async function writeClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Older browsers / non-secure contexts
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

/** Wire up every [data-copy] button inside `el` (once per view). */
export function bindCopyButtons(el) {
  el.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-copy]');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    await writeClipboard(btn.dataset.copy);
    btn.classList.add('copied');
    const label = btn.dataset.copiedLabel;
    if (label) btn.dataset.text ??= btn.textContent, (btn.textContent = label);
    setTimeout(() => {
      btn.classList.remove('copied');
      if (label) btn.textContent = btn.dataset.text;
    }, 1200);
  });
}
