/**
 * The Treasurer's ledger (migration 018), as plain functions (tested in Node:
 * tests/ledger.test.mjs).
 *
 * A ledger line is either a request approved on this site (its description, cost
 * and order # come from the request; the Treasurer adds the department steps, M / E
 * and notes, and can change the budget category it counts toward) or a purchase logged on its own (bought outside the site).
 */

/** The purchasing steps, in order, with the colors of the Treasurer's old spreadsheet legend. */
export const STEPS = [
  { key: 'to_submit', label: 'To submit', tone: 'gray', hint: 'Approved here, not sent to the department yet' },
  { key: 'sent', label: 'Request sent', tone: 'pink', hint: 'Sent to MAE / ECE purchasing' },
  { key: 'dept_approved', label: 'Dept approved', tone: 'lightgreen', hint: 'The department approved it' },
  { key: 'ordered', label: 'Ordered', tone: 'green', hint: 'Ordered by the department' },
  { key: 'received', label: 'Received', tone: 'teal', hint: 'Arrived' },
  { key: 'cancelled', label: 'Cancelled', tone: 'red', hint: "Not happening; doesn't count toward budgets" },
];
export const stepOf = (key) => STEPS.find((s) => s.key === key) || STEPS[0];
export const SPENT = new Set(['ordered', 'received']);
export const COMMITTED = new Set(['to_submit', 'sent', 'dept_approved']);

/** Who places the order (the old sheet's M/E column). */
export const DEPTS = [['M', 'MAE'], ['E', 'ECE'], ['A', 'Other']];

const num = (v) => {
  const n = Number(String(v ?? '').replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : 0;
};
const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
const answer = (r, key) => String(r?.[key] ?? r?.data?.[key] ?? '').trim();

/**
 * Ledger lines for a season: requests that are Approved / Ordered / Received, plus
 * purchases logged on their own. `field` is the request field budgets go by (e.g.
 * the Cost center), so a request's category is its answer, unless the Treasurer
 * picked another one for its line (migration 020; `answer` keeps the request's own).
 */
export function ledgerLines({ requests = [], purchases = [], field = '', season = '' }) {
  const byRequest = new Map(purchases.filter((p) => p.request_id).map((p) => [p.request_id, p]));
  const lines = [];
  for (const r of requests) {
    if (!['Approved', 'Ordered', 'Received'].includes(r.status)) continue;
    if (season && r.season && r.season !== season) continue;
    const p = byRequest.get(r.id);
    // Ordered / Received come from the request itself; before that, the Treasurer's step.
    const before = p && (COMMITTED.has(p.dept_status) || p.dept_status === 'cancelled') ? p.dept_status : 'to_submit';
    const status = r.status === 'Ordered' ? 'ordered' : r.status === 'Received' ? 'received' : before;
    lines.push({
      key: `r:${r.id}`,
      kind: 'request',
      request: r,
      purchaseId: p?.id || null,
      description: r.title || 'Untitled request',
      number: r.request_number,
      amount: num(r.total),
      category: String(p?.category || '').trim() || (field ? answer(r, field) : ''),
      answer: field ? answer(r, field) : '',
      dept: p?.dept || '',
      status,
      orderNumber: r.order?.department_order_number || '',
      date: String(r.order?.order_date || r.latest_approval?.created_at || r.created_at || '').slice(0, 10),
      sortDate: String(r.order?.order_date || r.latest_approval?.created_at || r.created_at || ''),
      notes: p?.notes || '',
    });
  }
  for (const p of purchases) {
    if (p.request_id) continue;
    if (season && p.season !== season) continue;
    lines.push({
      key: `p:${p.id}`,
      kind: 'own',
      purchaseId: p.id,
      description: p.description || '',
      amount: p.amount === null || p.amount === undefined || p.amount === '' ? null : num(p.amount),
      category: p.category || '',
      dept: p.dept || '',
      status: p.dept_status || 'to_submit',
      orderNumber: p.order_number || '',
      date: String(p.purchased_on || '').slice(0, 10), // blank when not known (e.g. imported)
      sortDate: String(p.purchased_on || p.created_at || ''),
      notes: p.notes || '',
    });
  }
  return lines;
}

/** Money of the lines that count (cancelled ones don't). */
const counts = (l) => l.status !== 'cancelled' && l.amount !== null;

/**
 * The budget table: one row per category (every budgeted one, plus any category a
 * line uses), with budget, spent (ordered + received), in the pipeline (to submit /
 * sent / approved by the department) and left = budget − both. Matching ignores
 * case and spaces. Lines with no category show as "(no category)". `order` is the
 * Treasurer's order of the categories (migration 021).
 */
export function budgetTable(lines, amounts = {}, order = []) {
  const rows = new Map();
  const row = (name) => {
    const k = norm(name);
    if (!rows.has(k)) rows.set(k, { category: name || '(no category)', budget: null, spent: 0, pipeline: 0 });
    return rows.get(k);
  };
  for (const [name, amount] of Object.entries(amounts || {})) {
    if (amount === '' || amount === null || amount === undefined) continue;
    row(name).budget = num(amount);
  }
  for (const l of lines.filter(counts)) {
    const r = row(l.category);
    if (SPENT.has(l.status)) r.spent += l.amount;
    else r.pipeline += l.amount;
  }
  const list = [...rows.values()].map((r) => ({
    ...r,
    spent: round(r.spent),
    pipeline: round(r.pipeline),
    left: r.budget === null ? null : round(r.budget - r.spent - r.pipeline),
  }));
  const total = {
    budget: round(list.reduce((s, r) => s + (r.budget || 0), 0)),
    spent: round(list.reduce((s, r) => s + r.spent, 0)),
    pipeline: round(list.reduce((s, r) => s + r.pipeline, 0)),
  };
  total.left = round(total.budget - total.spent - total.pipeline);
  // The Treasurer's order; then budgeted categories (in the order they were set), then the rest.
  const place = new Map((order || []).map((name, i) => [norm(name), i]));
  const rank = (r) => (place.has(norm(r.category)) ? place.get(norm(r.category)) : r.budget !== null ? 1e6 : 2e6);
  return { rows: list.map((r, i) => [r, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([r]) => r), total };
}

const round = (n) => Math.round(n * 100) / 100;

/** Funding: totals of expected and received, plus what the Sponsors board brought in. */
export function fundingTotals(funds = [], sponsorsReceived = 0) {
  const expected = round(funds.reduce((s, f) => s + num(f.expected), 0) + sponsorsReceived);
  const received = round(funds.reduce((s, f) => s + num(f.received), 0) + sponsorsReceived);
  return { expected, received };
}

// ---- Importing the Treasurer's old spreadsheet -------------------------------------------

/** The old sheet's legend colors (cell fill of the item's row) → steps. */
const FILL_STEPS = {
  FFFFAAA4: 'sent', // Request Sent
  FFC6E0B4: 'dept_approved', // Approved
  FFA9D08E: 'dept_approved', // (a slightly darker "Approved" green)
  FF00B050: 'ordered', // MAE Ordered
  FFFF0000: 'cancelled', // Cancelled
};

/**
 * Read the old "Financials" sheet. `sheet` is { rows, cols, value(r, c), fill(r, c) } with
 * 1-based rows / columns, value as text, fill as an ARGB like "FF00B050" (or '').
 * Finds the header row by its titles ("Item Description", "Cost", …), so moved columns
 * still work. Returns { purchases, budgets, rainyDay, notes }.
 */
export function readFinancialsSheet(sheet) {
  let header = 0;
  const col = {};
  for (let r = 1; r <= Math.min(sheet.rows, 20) && !header; r++) {
    for (let c = 1; c <= sheet.cols; c++) {
      const v = norm(sheet.value(r, c));
      if (/item description|^description$/.test(v)) (col.description = c), (header = r);
    }
  }
  if (!header) throw new Error('Couldn\'t find the "Item Description" column in that sheet.');
  for (let c = 1; c <= sheet.cols; c++) {
    const v = norm(sheet.value(header, c));
    if (v === 'cost' || v === 'amount' || v === 'price') col.amount ??= c;
    else if (/^m\s*\/\s*e$|^dept/.test(v)) col.dept ??= c;
    else if (/subteam|category|subsystem/.test(v)) col.category ??= c;
    else if (/order\s*#|order number|ticket/.test(v)) col.order ??= c;
    else if (v === 'notes' || v === 'note') col.notes ??= c;
    else if (/total budget/.test(v)) col.budgetName = c, col.budget = c + 1;
    else if (/^date/.test(v)) col.date ??= c;
  }

  const purchases = [];
  for (let r = header + 1; r <= sheet.rows; r++) {
    const description = String(sheet.value(r, col.description) ?? '').trim();
    if (!description) continue;
    const amountText = col.amount ? String(sheet.value(r, col.amount) ?? '').trim() : '';
    const notes = col.notes ? String(sheet.value(r, col.notes) ?? '').trim() : '';
    let status = FILL_STEPS[String(sheet.fill(r, col.description) || '').toUpperCase()] || 'to_submit';
    if (/^cancel/i.test(notes)) status = 'cancelled';
    purchases.push({
      description,
      amount: amountText === '' ? '' : String(num(amountText)),
      dept: col.dept ? String(sheet.value(r, col.dept) ?? '').trim() : '',
      category: col.category ? String(sheet.value(r, col.category) ?? '').trim() : '',
      order_number: col.order ? String(sheet.value(r, col.order) ?? '').trim() : '',
      purchased_on: col.date ? String(sheet.value(r, col.date) ?? '').slice(0, 10) : '',
      notes,
      dept_status: status,
    });
  }

  // The budget table beside the ledger: "Total Budget" heading, then name / amount rows.
  const budgets = {};
  if (col.budget) {
    for (let r = header + 1; r <= sheet.rows; r++) {
      const name = String(sheet.value(r, col.budgetName) ?? '').trim();
      const amount = String(sheet.value(r, col.budget) ?? '').trim();
      if (!name || /^notes?$/i.test(name)) break;
      if (amount !== '' && Number.isFinite(num(amount))) budgets[name] = String(num(amount));
    }
  }

  // "Rainy Day … Balance:" and the notes under a "Notes" heading.
  let rainyDay = '';
  const notes = [];
  for (let r = 1; r <= sheet.rows; r++) {
    for (let c = 1; c <= sheet.cols; c++) {
      const v = String(sheet.value(r, c) ?? '').trim();
      if (/rainy day/i.test(v) && !rainyDay) rainyDay = String(num(sheet.value(r, c + 1)));
      if (/^notes$/i.test(v) && c !== col.notes) {
        for (let rr = r + 1; rr <= sheet.rows; rr++) {
          const line = String(sheet.value(rr, c) ?? '').trim();
          if (line) notes.push(line);
        }
      }
    }
  }
  return { purchases, budgets, rainyDay: rainyDay === '0' ? '' : rainyDay, notes: notes.join('\n') };
}
