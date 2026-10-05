/**
 * Calculated columns for the Finances sheets. Pure functions (no page, no database),
 * so they're tested in Node (tests/financeCalc.test.mjs).
 *
 * Column types that are calculated (read-only, except Budget):
 *   budget   — the site's budget for this row's value, e.g. its Cost center.
 *              { by: column key in this sheet }
 *   orders   — total of requests in a stage for this row's value, or for the whole team.
 *              { metric: 'spent' | 'to_order' | 'in_review', by?: column key, field: form field key, season: 'current' | 'all' }
 *   lookup   — add up a column of a sheet, optionally where a column matches this row's.
 *              { sheet, col, match?: { theirs, mine }, where?: { col, value } }
 *   reqinfo  — a detail of the request named in this row's Request column. { req: column key, detail }
 *   math     — + and − of other columns in the same row. { terms: [{ op: '+' | '-', col }] }
 *   running  — a balance down the rows, in the order shown. { of: column key }
 *
 * To stay simple and loop-free: Math only uses plain numbers and the budget / orders /
 * lookup / request columns (not other Math or running totals), and Lookup only adds up
 * plain Money / Number columns. So nothing can depend on itself.
 */

export const ORDER_METRICS = [
  ['spent', 'Spent (ordered + received)', ['Ordered', 'Received']],
  ['to_order', 'Approved, not ordered yet', ['Approved']],
  ['in_review', 'Waiting for approval', ['Submitted']],
];

/** What a Request column can show, and what "Add ordered requests" can fill in. */
const REQUEST_DETAILS = [
  ['request', 'Request ID', (r) => r.request_number],
  ['title', 'Request title', (r) => r.title],
  ['requester', 'Requester', (r) => r.requester],
  ['vendor', 'Vendor', (r) => (r.vendors || []).join(', ')],
  ['total', 'Request total', (r) => Number(r.total || 0).toFixed(2), true],
  ['shipping', 'Shipping', (r) => (r.shipping ? Number(r.shipping).toFixed(2) : ''), true],
  ['ticket', 'Ticket #', (r) => r.order?.department_order_number],
  ['order_date', 'Order date', (r) => String(r.order?.order_date || '').slice(0, 10)],
  ['received_date', 'Received date', (r) => String(r.order?.received_date || '').slice(0, 10)],
  ['status', 'Status', (r) => r.status],
  ['season', 'Season', (r) => r.season],
];

/** A request's answer to a form field (built-in column or custom data). */
export const answer = (r, key) => String(r?.[key] ?? r?.data?.[key] ?? '');

/** Request details plus the request form's own fields, as [key, label, get(r), isMoney]. */
export function requestDetails(formFields = []) {
  return [
    ...REQUEST_DETAILS,
    ...formFields
      .filter((f) => f.type !== 'section' && !['title', 'requester'].includes(f.key))
      .map((f) => [`field:${f.key}`, f.label, (r) => answer(r, f.key), false]),
  ];
}

export const PLAIN_NUMERIC = new Set(['money', 'number']);
const CALC_TYPES = new Set(['budget', 'orders', 'lookup', 'reqinfo', 'math', 'running']);
/** Columns Math may use, and Running totals may add up (besides Math). */
const MATH_OPERANDS = new Set(['money', 'number', 'budget', 'orders', 'lookup', 'reqinfo']);

const MONEY_DETAILS = new Set(REQUEST_DETAILS.filter((d) => d[3]).map((d) => d[0]));
/** Does this column hold amounts (shown as $, can be totaled)? */
export function isNumeric(c) {
  if (PLAIN_NUMERIC.has(c.type) || ['budget', 'orders', 'lookup', 'math', 'running'].includes(c.type)) return true;
  return c.type === 'reqinfo' && MONEY_DETAILS.has(c.detail);
}
export const isMoney = (c) => isNumeric(c) && c.type !== 'number';
export const isCalc = (c) => CALC_TYPES.has(c.type);

/** '$1,234.50' → 1234.5; accounting-style '(12.50)' → -12.5; blanks and text → 0. */
export function toNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const s = String(v ?? '').trim();
  const n = Number(s.replace(/[$,\s()]/g, ''));
  return Number.isFinite(n) ? (/^\(.*\)$/.test(s) ? -n : n) : 0;
}

/** Text compared the forgiving way: "Powertrain " matches "powertrain". */
export const same = (a, b) => String(a ?? '').trim().toLowerCase().replace(/\s+/g, ' ') === String(b ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

const round = (n) => Math.round(n * 100) / 100;

/**
 * Values for every row (except running totals, which depend on the order shown).
 * ctx: { requests, season, budgets: { field, amounts }, sheets: Map(id → { sheet, rows }), details }
 * Returns Map(rowId → { [key]: value }) where calculated values are numbers (or text for
 * non-money request details), and plain columns keep their text.
 */
export function computeRows(columns, rows, ctx) {
  ctx = { ...ctx, columns };
  const out = new Map();
  for (const row of rows) {
    const v = { ...(row.data || {}) };
    for (const c of columns) if (isCalc(c) && c.type !== 'math' && c.type !== 'running') v[c.key] = explain(c, row, v, ctx).value;
    for (const c of columns) if (c.type === 'math') v[c.key] = explain(c, row, v, ctx).value;
    out.set(row.id, v);
  }
  return out;
}

/** Running totals for rows in the order shown: Map(rowId → { [key]: balance }). */
export function runningTotals(columns, orderedRows, values) {
  const out = new Map(orderedRows.map((r) => [r.id, {}]));
  for (const c of columns.filter((x) => x.type === 'running')) {
    let sum = 0;
    for (const r of orderedRows) {
      sum = round(sum + toNumber(values.get(r.id)?.[c.of]));
      out.get(r.id)[c.key] = sum;
    }
  }
  return out;
}

/**
 * One calculated cell: { value, text, items }. `text` says where it came from and
 * `items` lists what was added up ({ label, amount, href }), for "click to see why".
 */
export function explain(c, row, values, ctx) {
  const mine = (key) => row.data?.[key] ?? '';
  const columnsByKey = ctx.columns ? new Map(ctx.columns.map((x) => [x.key, x])) : new Map();
  if (c.type === 'budget') {
    const key = mine(c.by);
    const amounts = ctx.budgets?.amounts || {};
    const name = Object.keys(amounts).find((k) => same(k, key));
    const amount = name !== undefined && amounts[name] !== '' ? toNumber(amounts[name]) : '';
    return { value: amount, text: key ? `The site's budget for ${key}${amount === '' ? ' (none set yet)' : ''}.` : 'Pick a value in this row to see its budget.', items: [] };
  }
  if (c.type === 'orders') {
    const metric = ORDER_METRICS.find((m) => m[0] === c.metric) || ORDER_METRICS[0];
    const key = c.by ? mine(c.by) : null;
    const list = (ctx.requests || []).filter(
      (r) => metric[2].includes(r.status) && (c.season === 'all' || !ctx.season || r.season === ctx.season) && (key === null || (key !== '' && same(answer(r, c.field), key)))
    );
    const total = round(list.reduce((s, r) => s + toNumber(r.total), 0));
    return {
      value: key === '' ? '' : total,
      text: `${metric[1]}: ${c.season === 'all' ? 'all seasons' : `the ${ctx.season || 'current'} season`}${key === null ? ', whole team' : key ? `, ${key}` : ''}.`,
      items: list.map((r) => ({ label: `${r.request_number} · ${r.title || 'Untitled'} (${r.status})`, amount: toNumber(r.total), href: `#/requests/${r.request_number}` })),
    };
  }
  if (c.type === 'lookup') {
    const target = ctx.sheets?.get(c.sheet);
    if (!target) return { value: '', text: 'The sheet this column adds up was deleted. Choose another in Columns & sheet.', items: [] };
    const theirCols = target.sheet.columns || [];
    const colLabel = (k) => theirCols.find((x) => x.key === k)?.label || '?';
    const key = c.match?.theirs ? mine(c.match.mine) : null;
    const hits = target.rows.filter(
      (t) => (key === null || (key !== '' && same(t.data?.[c.match.theirs], key))) && (!c.where?.col || same(t.data?.[c.where.col], c.where.value))
    );
    const first = theirCols.find((x) => x.type === 'text' || x.type === 'select' || x.type === 'date');
    return {
      value: key === '' ? '' : round(hits.reduce((s, t) => s + toNumber(t.data?.[c.col]), 0)),
      text: `${colLabel(c.col)} in "${target.sheet.name}"${key === null ? '' : `, where ${colLabel(c.match.theirs)} is ${key || '(blank)'}`}${c.where?.col ? `, only where ${colLabel(c.where.col)} is ${c.where.value}` : ''}.`,
      items: hits.map((t) => ({ label: first ? String(t.data?.[first.key] ?? '') || '(blank)' : 'Row', amount: toNumber(t.data?.[c.col]) })),
    };
  }
  if (c.type === 'reqinfo') {
    const number = mine(c.req);
    const r = (ctx.requests || []).find((x) => same(x.request_number, number));
    const detail = (ctx.details || REQUEST_DETAILS).find((d) => d[0] === c.detail);
    if (!number) return { value: '', text: 'No request in this row.', items: [] };
    if (!r || !detail) return { value: '', text: `There is no request ${number}.`, items: [] };
    const raw = detail[2](r) ?? '';
    return { value: detail[3] ? toNumber(raw) : String(raw), text: `${detail[1]} of ${r.request_number}.`, items: [{ label: `${r.request_number} · ${r.title || 'Untitled'}`, href: `#/requests/${r.request_number}` }] };
  }
  if (c.type === 'math') {
    let sum = 0;
    const parts = [];
    for (const [i, t] of (c.terms || []).entries()) {
      const n = toNumber(values[t.col]);
      sum += t.op === '-' ? -n : n;
      parts.push(`${i === 0 ? (t.op === '-' ? '−' : '') : t.op === '-' ? ' − ' : ' + '}${columnsByKey.get(t.col)?.label || '?'}`);
    }
    return { value: round(sum), text: `${parts.join('')}.`, items: (c.terms || []).map((t) => ({ label: `${t.op === '-' ? '−' : '+'} ${columnsByKey.get(t.col)?.label || '?'}`, amount: toNumber(values[t.col]) })) };
  }
  return { value: row.data?.[c.key] ?? '', text: '', items: [] };
}

/**
 * Problems with a sheet's columns, in plain words (empty = fine). `sheets` is a
 * Map(id → { sheet }) of every sheet, for lookups.
 */
export function checkColumns(columns, sheets = new Map(), budgets = {}) {
  const problems = [];
  const byKey = new Map(columns.map((c) => [c.key, c]));
  for (const c of columns) {
    const name = `"${c.label || 'A column'}"`;
    if (!c.label?.trim()) problems.push('Every column needs a name.');
    if (c.type === 'budget') {
      if (!byKey.has(c.by)) problems.push(`${name}: choose which column holds the Cost center (or whatever budgets are set by).`);
    }
    if (c.type === 'orders') {
      if (c.by && !byKey.has(c.by)) problems.push(`${name}: the column it matches on was deleted.`);
      if (c.by && !c.field) problems.push(`${name}: choose which form field it matches.`);
    }
    if (c.type === 'lookup') {
      const target = sheets.get(c.sheet);
      const theirs = new Map((target?.sheet.columns || []).map((x) => [x.key, x]));
      if (!target) problems.push(`${name}: choose a sheet to add up.`);
      else if (!PLAIN_NUMERIC.has(theirs.get(c.col)?.type)) problems.push(`${name}: choose a Money or Number column of "${target.sheet.name}" to add up.`);
      if (c.match?.theirs && (!theirs.has(c.match.theirs) || !byKey.has(c.match.mine))) problems.push(`${name}: choose both columns to match.`);
      if (c.where?.col && !theirs.has(c.where.col)) problems.push(`${name}: the "only where" column was deleted.`);
    }
    if (c.type === 'reqinfo' && byKey.get(c.req)?.type !== 'request') problems.push(`${name}: choose a Request column in this sheet.`);
    if (c.type === 'math') {
      if (!(c.terms || []).length) problems.push(`${name}: add at least one column to the calculation.`);
      for (const t of c.terms || []) {
        const x = byKey.get(t.col);
        if (!x || !MATH_OPERANDS.has(x.type) || !isNumeric(x)) problems.push(`${name}: it can only use money, number, budget, order, lookup or request-total columns.`);
      }
    }
    if (c.type === 'running') {
      const x = byKey.get(c.of);
      if (!x || x.type === 'running' || !isNumeric(x)) problems.push(`${name}: choose which amount column it adds up.`);
    }
  }
  if (budgets?.field) {
    // Budget columns use the site's budgets, which are set per one form field.
    for (const c of columns.filter((x) => x.type === 'budget')) {
      const by = byKey.get(c.by);
      if (by?.source && by.source !== `form:${budgets.field}`) problems.push(`"${c.label}": the site's budgets are set per another field. Match it on a column that uses that field's list.`);
    }
  }
  return [...new Set(problems)];
}
