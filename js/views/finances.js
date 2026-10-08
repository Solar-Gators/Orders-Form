/**
 * Finances (#/finances), laid out the way the Treasurer works (migration 018):
 *   Purchases  — the ledger: every approved request plus anything bought outside the
 *                site, with the department steps (to submit → request sent → dept
 *                approved → ordered → received, or cancelled), M / E, order #, notes.
 *   Budget     — per category: budget, spent, in the pipeline, left.
 *   Funding    — where the money comes from (expected / received), the Sponsors
 *                board's income, and the rainy-day fund.
 *   Notes      — the Treasurer's planning notes for the season.
 *   Custom sheets — the free-form spreadsheets (js/views/financeSheets.js).
 * The math is in js/ledger.js. Viewing needs finances.view; changing, finances.edit.
 */
import { api } from '../api.js';
import { auth } from '../auth.js';
import { esc, fmtMoney, fmtDate, errorBox, setFlash, takeFlash, renderRichText } from '../ui.js';
import { requestFields, fieldOptions } from '../formFields.js';
import { workflowSettings } from '../workflow.js';
import { loadExcelJS } from '../excel.js';
import { cellText } from '../sheetImport.js';
import { STEPS, stepOf, DEPTS, ledgerLines, budgetTable, fundingTotals, readFinancialsSheet } from '../ledger.js';
import { openAttachmentsDialog } from '../attachments.js';
import { renderSheets } from './financeSheets.js';

const TABS = [['purchases', 'Purchases'], ['budget', 'Budget'], ['funding', 'Funding'], ['notes', 'Notes'], ['sheets', 'Custom sheets']];
const SORTS = [['newest', 'Newest first'], ['oldest', 'Oldest first'], ['status', 'By status'], ['category', 'By category'], ['cost', 'Highest cost']];

// Kept while moving around the app.
const view = { tab: 'purchases', season: '', q: '', status: '', category: '', sort: 'newest' };

const money = (n) => (n === null || n === undefined || n === '' ? '' : fmtMoney(Number(n)));
const toAmount = (v) => {
  const s = String(v ?? '').trim();
  if (s === '') return '';
  const n = Number(s.replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n.toFixed(2) : null;
};

/** The dropdowns budgets can follow (Cost center, Subsystem…). */
const budgetFields = (config) => requestFields(config).filter((f) => f.type === 'select' && f.key !== 'priority' && !f.hidden);

export async function renderFinances(el, ctx) {
  const { config, rerender, reloadConfig } = ctx;
  const canEdit = auth.can('finances.edit');
  const canBudget = canEdit && (auth.can('request.order') || auth.can('workflow.edit'));
  const purchases = await api.listPurchases();
  if (!view.season) view.season = config.season;
  const season = view.season;

  // Before migration 018 only the custom sheets exist.
  if (purchases === null) {
    el.innerHTML = `${takeFlash()}<div class="page-header"><div><h1>Finances</h1></div></div>
      <div class="alert alert-info">The ledger, budget and funding tabs need database update <code>018_treasurer_ledger.sql</code>.</div>
      <div id="fin-tab"></div>`;
    return renderSheets(el.querySelector('#fin-tab'), ctx);
  }

  const budgets = workflowSettings(config).budgets;
  const [requests, funds, seasonInfo, seasons, purchaseFiles, requestFiles, sponsorsIn] = await Promise.all([
    api.listRequests(['Approved', 'Ordered', 'Received'], { season }),
    api.listFunds(season),
    api.getFinanceSeason(season),
    api.listSeasons(),
    api.attachmentCounts('purchase'),
    api.attachmentCounts('request'),
    sponsorIncome(config, season),
  ]);
  // "+ Add a purchase" saves a blank row right away; one left untouched for an hour was
  // abandoned, so tidy it away instead of showing an empty line forever.
  if (canEdit) {
    const abandoned = purchases.filter(
      (p) => !p.request_id && !String(p.description || '').trim() && (p.amount === null || p.amount === '') && !p.notes && !p.order_number &&
        !p.dept && p.dept_status === 'to_submit' && !purchaseFiles[p.id] && Date.now() - new Date(p.created_at).getTime() > 3600e3
    );
    for (const p of abandoned) {
      purchases.splice(purchases.indexOf(p), 1);
      api.deletePurchase(p.id).catch(() => {});
    }
  }
  const lines = ledgerLines({ requests, purchases, field: budgets.field, season });
  const table = budgetTable(lines, budgets.amounts);
  const funding = fundingTotals(funds, sponsorsIn);
  const seasonList = [...new Set([config.season, ...seasons, ...purchases.map((p) => p.season)])].filter(Boolean).sort().reverse();
  const field = budgetFields(config).find((f) => f.key === budgets.field);
  const categories = [...new Set([
    ...Object.keys(budgets.amounts || {}),
    ...(field ? fieldOptions(field, config) : []),
    ...lines.map((l) => l.category).filter(Boolean),
  ])];
  const fileCount = (l) => (l.kind === 'request' ? requestFiles[l.request.id] : purchaseFiles[l.purchaseId]) || 0;

  el.innerHTML = `
    ${takeFlash()}
    <div class="page-header">
      <div>
        <h1>Finances</h1>
        <p class="subtitle">${seasonList.length > 1
          ? `<select id="fin-season" aria-label="Season" class="inline-select">${seasonList.map((s) => `<option ${s === season ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select>`
          : esc(season)} season${canEdit ? '' : ' · view only'}</p>
      </div>
      <div class="card-actions">
        ${canEdit ? `<label class="btn btn-sm">Import from spreadsheet…<input type="file" id="fin-import" accept=".xlsx" hidden></label>` : ''}
        <button type="button" class="btn btn-sm" id="fin-download">Download .xlsx</button>
      </div>
    </div>

    <div class="fin-tiles">
      ${tile('Budget', fmtMoney(table.total.budget), table.rows.filter((r) => r.budget !== null).length ? `${table.rows.filter((r) => r.budget !== null).length} categories` : 'Not set yet')}
      ${tile('Spent', fmtMoney(table.total.spent), 'Ordered + received')}
      ${tile('In the pipeline', fmtMoney(table.total.pipeline), 'Approved, not ordered yet')}
      ${table.total.budget
        ? tile('Left', fmtMoney(table.total.left), `${Math.round(((table.total.spent + table.total.pipeline) / table.total.budget) * 100)}% used`, table.total.left < 0)
        : tile('Left', '—', 'Set budgets on the Budget tab')}
      ${tile('Funds received', fmtMoney(funding.received), funding.expected ? `of ${fmtMoney(funding.expected)} expected` : 'Add sources in Funding')}
      ${seasonInfo.rainy_day !== null ? tile('Rainy-day fund', fmtMoney(seasonInfo.rainy_day), 'Kept aside') : ''}
    </div>

    <nav class="segmented fin-tabs" aria-label="Finances">${TABS.map(([k, label]) => `<a href="#/finances" data-tab="${k}" ${k === view.tab ? 'aria-current="page"' : ''}>${esc(label)}${
      k === 'purchases' ? ` <span class="muted small">${lines.length}</span>` : ''}</a>`).join('')}</nav>
    <div id="fin-errors"></div>
    <div id="fin-tab"></div>`;

  const errors = el.querySelector('#fin-errors');
  const showError = (err) => (errors.innerHTML = errorBox(err));
  const box = el.querySelector('#fin-tab');

  el.querySelector('.fin-tabs').addEventListener('click', (e) => {
    const a = e.target.closest('[data-tab]');
    if (!a) return;
    e.preventDefault();
    view.tab = a.dataset.tab;
    rerender();
  });
  el.querySelector('#fin-season')?.addEventListener('change', (e) => {
    view.season = e.target.value;
    rerender();
  });
  el.querySelector('#fin-download').addEventListener('click', () => download({ season, lines, table, funds, funding, sponsorsIn, seasonInfo }).catch(showError));
  el.querySelector('#fin-import')?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) importSpreadsheet(file, { config, season, requests, purchases, budgets, canBudget, reloadConfig, rerender }).catch(showError);
  });

  const shared = { ...ctx, canEdit, canBudget, season, lines, table, funds, funding, sponsorsIn, seasonInfo, categories, budgets, fileCount, showError };
  if (view.tab === 'purchases') drawPurchases(box, shared);
  else if (view.tab === 'budget') drawBudget(box, shared);
  else if (view.tab === 'funding') drawFunding(box, shared);
  else if (view.tab === 'notes') drawNotes(box, shared);
  else await renderSheets(box, ctx);
}

const tile = (label, value, note, bad = false) => `<div class="fin-tile ${bad ? 'is-bad' : ''}">
  <span class="fin-tile-label">${esc(label)}</span><strong>${value}</strong>${note ? `<span class="muted small">${esc(note)}</span>` : ''}</div>`;

/** Money the Sponsors board brought in this season (cards in a "received" or "done" stage). */
async function sponsorIncome(config, season) {
  if (!auth.can('sponsors.view') && !auth.can('sponsors.edit')) return 0;
  const stages = Array.isArray(config.sponsors?.stages) ? config.sponsors.stages : [];
  const paid = new Set(stages.filter((s) => ['received', 'done'].includes(s.kind)).map((s) => s.key));
  if (!paid.size) return 0;
  const cards = await api.listSponsorCards().catch(() => []);
  return cards.filter((c) => c.season === season && paid.has(c.stage)).reduce((s, c) => s + (Number(c.amount) || 0), 0);
}

const stepChip = (key) => `<span class="step-chip step-${esc(stepOf(key).tone)}" title="${esc(stepOf(key).hint)}">${esc(stepOf(key).label)}</span>`;

// ---- Purchases ---------------------------------------------------------------------------

function drawPurchases(box, s) {
  const { canEdit, categories, rerender, showError } = s;
  const lines = s.lines;
  const order = STEPS.map((x) => x.key);

  const shown = () => {
    const words = view.q.toLowerCase().split(/\s+/).filter(Boolean);
    let list = lines.filter(
      (l) =>
        (!view.status || l.status === view.status) &&
        (!view.category || l.category.toLowerCase() === view.category.toLowerCase()) &&
        words.every((w) => [l.description, l.number, l.category, l.dept, l.orderNumber, l.notes].join(' ').toLowerCase().includes(w))
    );
    const by = {
      newest: (a, b) => b.sortDate.localeCompare(a.sortDate),
      oldest: (a, b) => a.sortDate.localeCompare(b.sortDate),
      status: (a, b) => order.indexOf(a.status) - order.indexOf(b.status) || b.sortDate.localeCompare(a.sortDate),
      category: (a, b) => a.category.localeCompare(b.category) || b.sortDate.localeCompare(a.sortDate),
      cost: (a, b) => (b.amount || 0) - (a.amount || 0),
    }[view.sort];
    return [...list].sort(by);
  };

  const statusCell = (l) => {
    if (!canEdit) return stepChip(l.status);
    // Ordered / Received are marked on the request (date, ticket #, tells the requester).
    if (l.kind === 'request' && ['ordered', 'received'].includes(l.status)) {
      return `<a href="#/requests/${esc(l.number)}" class="step-chip step-${esc(stepOf(l.status).tone)} step-link" title="Set on the request itself (it records the date and ticket number). Open ${esc(l.number)} to change it.">${esc(stepOf(l.status).label)} ↗</a>`;
    }
    const options = l.kind === 'request' ? STEPS.filter((x) => !['ordered', 'received'].includes(x.key)) : STEPS;
    return `<select data-f="dept_status" class="step-select step-${esc(stepOf(l.status).tone)}" aria-label="Status">${options
      .map((x) => `<option value="${x.key}" ${x.key === l.status ? 'selected' : ''}>${esc(x.label)}</option>`)
      .join('')}${l.kind === 'request' ? '<option value="goto">Ordered… (on the request)</option>' : ''}</select>`;
  };
  const input = (l, f, value, attrs = '') => `<input data-f="${f}" value="${esc(value ?? '')}" ${attrs}>`;
  // Requests count toward their answer to the budgets dropdown; the Treasurer can move one
  // to another category (e.g. after switching budgets from Subsystem to Cost center).
  const recategorize = canEdit && Number(s.config.schemaVersion) >= 20;
  const categoryCell = (l) => {
    if (l.kind === 'own' ? !canEdit : !recategorize) return esc(l.category || '—');
    if (l.kind === 'own') return input(l, 'category', l.category, 'list="fin-categories" aria-label="Category"');
    const moved = l.category !== l.answer;
    return input(l, 'category', l.category, `list="fin-categories" placeholder="${esc(l.answer || 'Category')}" aria-label="Category" ${moved ? 'class="is-moved"' : ''}
      title="${esc(moved ? `Moved here by the Treasurer. The request says ${l.answer ? `"${l.answer}"` : 'nothing'}; clear this box to go back to it.` : 'From the request. Type another category to count it there instead.')}"`);
  };
  const row = (l) => {
    const own = l.kind === 'own';
    const files = s.fileCount(l);
    return `<tr data-line="${esc(l.key)}" class="step-row-${esc(stepOf(l.status).tone)} ${l.status === 'cancelled' ? 'is-cancelled' : ''}">
      <td class="ledger-status" data-label="Status">${statusCell(l)}</td>
      <td class="ledger-desc cell-primary" data-label="">${own && canEdit
        ? input(l, 'description', l.description, 'placeholder="What was bought" aria-label="Description"')
        : own ? esc(l.description) : `<a href="#/requests/${esc(l.number)}"><span class="mono small">${esc(l.number)}</span> ${esc(l.description)}</a>`}</td>
      <td class="num ledger-cost" data-label="Cost">${own && canEdit ? input(l, 'amount', l.amount === null ? '' : fmtMoney(l.amount), 'inputmode="decimal" placeholder="$" aria-label="Cost"') : money(l.amount)}</td>
      <td class="ledger-dept" data-label="M/E">${canEdit ? input(l, 'dept', l.dept, 'list="fin-depts" maxlength="20" aria-label="M/E"') : esc(l.dept)}</td>
      <td class="ledger-cat" data-label="Category">${categoryCell(l)}</td>
      <td class="ledger-order" data-label="Order #">${own && canEdit ? input(l, 'order_number', l.orderNumber, 'aria-label="Order #"') : esc(l.orderNumber || '—')}</td>
      <td class="nowrap ledger-date" data-label="Date">${own && canEdit ? input(l, 'purchased_on', l.date, 'type="date" class="date-quiet" required aria-label="Date"') : l.date ? fmtDate(l.date) : '—'}</td>
      <td class="ledger-notes" data-label="Notes">${canEdit ? input(l, 'notes', l.notes, 'aria-label="Notes"') : esc(l.notes)}</td>
      <td class="ledger-actions" data-label="">
        <button type="button" class="row-files ${files ? 'has-files' : ''}" data-files title="${files ? `${files} file(s)` : 'Attach a receipt or file'}" aria-label="Files">📎${files ? `<span>${files}</span>` : ''}</button>
        ${own && canEdit ? '<button type="button" class="icon-btn" data-delete title="Delete" aria-label="Delete purchase">&times;</button>' : ''}
      </td>
    </tr>`;
  };

  const draw = () => {
    const list = shown();
    const total = list.filter((l) => l.status !== 'cancelled').reduce((sum, l) => sum + (l.amount || 0), 0);
    box.querySelector('#ledger-body').innerHTML = list.length
      ? list.map(row).join('')
      : `<tr><td colspan="9" class="muted sheet-empty">${lines.length ? 'Nothing matches.' : 'No purchases yet this season. Approved requests show up here on their own.'}</td></tr>`;
    box.querySelector('#ledger-count').textContent = `${list.length} of ${lines.length} · ${fmtMoney(total)} (not counting cancelled)`;
  };

  const counts = Object.fromEntries(STEPS.map((x) => [x.key, lines.filter((l) => l.status === x.key).length]));
  box.innerHTML = `
    <div class="step-strip">${STEPS.map((x) => `<button type="button" class="step-pill step-${esc(x.tone)} ${view.status === x.key ? 'is-on' : ''}" data-step="${x.key}" title="${esc(x.hint)}">
      ${esc(x.label)} <strong>${counts[x.key]}</strong></button>`).join('')}</div>
    <div class="toolbar">
      <input type="search" id="ledger-q" placeholder="Search description, order #, notes…" value="${esc(view.q)}" aria-label="Search purchases">
      <select id="ledger-category" aria-label="Category"><option value="">All categories</option>${categories.map((c) => `<option ${c === view.category ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
      <select id="ledger-sort" aria-label="Sort">${SORTS.map(([k, l]) => `<option value="${k}" ${k === view.sort ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
      <span class="muted small" id="ledger-count"></span>
      ${canEdit ? '<button type="button" class="btn btn-sm btn-primary toolbar-end" id="ledger-add">+ Add a purchase</button>' : ''}
    </div>
    <div class="table-wrap sheet-wrap">
      <table class="table ledger-table stack-mobile" data-fit>
        <thead><tr><th>Status</th><th>Description</th><th class="num">Cost</th><th>M/E</th><th>Category</th><th>Order #</th><th>Date</th><th>Notes</th><th></th></tr></thead>
        <tbody id="ledger-body"></tbody>
      </table>
    </div>
    <p class="hint">Requests show up here once they're approved. Add a purchase for anything bought outside the site (a PayPal invoice, a quote over the phone).
      ${s.canEdit && Number(s.config.schemaVersion) >= 20 ? "Change a request's Category to count it toward another budget; clear it to go back to what the request says." : ''}
      M/E is who orders it: <strong>M</strong> MAE, <strong>E</strong> ECE, <strong>A</strong> other.</p>
    <datalist id="fin-depts">${DEPTS.map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('')}</datalist>
    <datalist id="fin-categories">${categories.map((c) => `<option value="${esc(c)}">`).join('')}</datalist>`;

  const lineOf = (node) => lines.find((l) => l.key === node.closest('tr[data-line]')?.dataset.line);
  const save = async (l, fields) => {
    try {
      if (l.purchaseId) await api.savePurchase(l.purchaseId, fields);
      else l.purchaseId = await api.savePurchase(null, { ...fields, request_id: l.request.id });
      document.querySelector('#fin-errors').innerHTML = '';
      return true;
    } catch (err) {
      showError(err);
      return false;
    }
  };

  box.addEventListener('change', async (e) => {
    const t = e.target;
    if (t.id === 'ledger-category') return (view.category = t.value), draw();
    if (t.id === 'ledger-sort') return (view.sort = t.value), draw();
    const f = t.dataset.f;
    const l = f && lineOf(t);
    if (!l) return;
    if (f === 'dept_status' && t.value === 'goto') {
      location.hash = `#/requests/${l.number}`;
      return;
    }
    let value = t.value.trim();
    // Typing the request's own answer again (or nothing) goes back to following it.
    if (f === 'category' && l.kind === 'request' && value.toLowerCase() === l.answer.toLowerCase()) value = '';
    if (f === 'amount') {
      value = toAmount(value);
      if (value === null) return showError(new Error(`"${t.value}" isn't a number.`));
      t.value = value;
    }
    if (await save(l, { [f]: value })) {
      if (f === 'dept_status') return rerender(); // totals and tiles change
      if (f === 'amount' || f === 'category') return rerender();
      l[{ dept: 'dept', notes: 'notes', description: 'description', order_number: 'orderNumber', purchased_on: 'date' }[f]] = value;
    }
  });
  box.addEventListener('input', (e) => {
    if (e.target.id === 'ledger-q') {
      view.q = e.target.value;
      draw();
    }
  });
  box.addEventListener('click', async (e) => {
    const step = e.target.closest('[data-step]');
    if (step) {
      view.status = view.status === step.dataset.step ? '' : step.dataset.step;
      box.querySelectorAll('[data-step]').forEach((b) => b.classList.toggle('is-on', b.dataset.step === view.status));
      return draw();
    }
    const btn = e.target.closest('button');
    if (!btn) return;
    if (btn.id === 'ledger-add') {
      try {
        await api.savePurchase(null, { season: s.season, purchased_on: new Date().toISOString().slice(0, 10), category: view.category || '' });
        view.sort = 'newest';
        view.status = '';
        await rerender();
        document.querySelector('.ledger-table [data-f="description"]')?.focus();
      } catch (err) {
        showError(err);
      }
      return;
    }
    const l = lineOf(btn);
    if (!l) return;
    if (btn.hasAttribute('data-files')) {
      if (l.kind === 'own' && !l.purchaseId) return;
      openAttachmentsDialog({
        title: `Files · ${l.number || l.description || 'Purchase'}`,
        kind: l.kind === 'request' ? 'request' : 'purchase',
        ownerId: l.kind === 'request' ? l.request.id : l.purchaseId,
        canEdit: l.kind === 'request' ? auth.can('request.order') || auth.can('request.review') : canEdit,
        onChange: () => {},
      });
    } else if (btn.hasAttribute('data-delete')) {
      if (!confirm(`Delete "${l.description || 'this purchase'}"? This can't be undone.`)) return;
      try {
        await api.deletePurchase(l.purchaseId);
        await rerender();
      } catch (err) {
        showError(err);
      }
    }
  });
  draw();
}

// ---- Budget --------------------------------------------------------------------------------

function drawBudget(box, s) {
  const { table, canBudget, config, budgets, reloadConfig, rerender, showError } = s;
  const fields = budgetFields(config);
  const bar = (r) => {
    if (r.budget === null || r.budget <= 0) return '';
    const spent = Math.min(100, (r.spent / r.budget) * 100);
    const pipe = Math.min(100 - spent, (r.pipeline / r.budget) * 100);
    return `<span class="budget-bar two-part" title="${Math.round(((r.spent + r.pipeline) / r.budget) * 100)}% used"><span class="bar-spent" style="width:${spent}%"></span><span class="bar-pipe" style="width:${pipe}%"></span></span>`;
  };
  box.innerHTML = `
    <div class="table-wrap">
      <table class="table stack-mobile budget-ledger">
        <thead><tr><th>Category</th><th class="num">Budget</th><th class="num">Spent</th><th class="num">In the pipeline</th><th class="num">Left</th><th></th></tr></thead>
        <tbody>${table.rows
          .map(
            (r) => `<tr class="${r.left !== null && r.left < 0 ? 'is-over' : ''}">
              <td class="cell-primary" data-label=""><a href="#/finances" data-category="${esc(r.category)}" title="See its purchases">${esc(r.category)}</a></td>
              <td class="num" data-label="Budget">${canBudget && r.category !== '(no category)'
                ? `<input class="budget-input" data-budget="${esc(r.category)}" value="${r.budget === null ? '' : r.budget.toFixed(2)}" inputmode="decimal" placeholder="Set" aria-label="Budget for ${esc(r.category)}">`
                : money(r.budget) || '—'}</td>
              <td class="num" data-label="Spent">${fmtMoney(r.spent)}</td>
              <td class="num" data-label="In the pipeline">${fmtMoney(r.pipeline)}</td>
              <td class="num" data-label="Left"><strong>${r.left === null ? '—' : r.left < 0 ? `${fmtMoney(-r.left)} over` : fmtMoney(r.left)}</strong></td>
              <td class="budget-bar-cell" data-label=""><div class="budget-bar-row">${bar(r)}${canBudget && r.category !== '(no category)'
                ? `<button type="button" class="icon-btn" data-delete-category="${esc(r.category)}" title="Delete this category" aria-label="Delete ${esc(r.category)}">&times;</button>` : ''}</div></td>
            </tr>`
          )
          .join('') || '<tr><td colspan="6" class="muted sheet-empty">No budgets yet.</td></tr>'}</tbody>
        <tfoot><tr><td><strong>Total</strong></td><td class="num"><strong>${fmtMoney(table.total.budget)}</strong></td><td class="num"><strong>${fmtMoney(table.total.spent)}</strong></td>
          <td class="num"><strong>${fmtMoney(table.total.pipeline)}</strong></td><td class="num"><strong>${!table.rows.some((r) => r.budget !== null) ? '—' : table.total.left < 0 ? `${fmtMoney(-table.total.left)} over` : fmtMoney(table.total.left)}</strong></td><td></td></tr></tfoot>
      </table>
    </div>
    ${canBudget ? `<form class="budget-add" id="budget-add" novalidate>
        <input id="new-category" list="fin-categories" placeholder="Add a category, e.g. Competition" aria-label="New category">
        <input id="new-amount" inputmode="decimal" placeholder="Budget ($)" aria-label="Budget">
        <button type="submit" class="btn btn-sm">Add</button>
      </form>
      <datalist id="fin-categories">${s.categories.map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
      <details class="about"><summary>Budget settings</summary><div>
        <div class="field"><label for="budget-field">Requests count toward the budget of their</label>
          <select id="budget-field"><option value="">(choose a dropdown)</option>${fields.map((f) => `<option value="${esc(f.key)}" ${f.key === budgets.field ? 'selected' : ''}>${esc(f.label)}</option>`).join('')}</select></div>
        <label class="rule-toggle"><input type="checkbox" id="budget-block" ${budgets.block ? 'checked' : ''}>
          <span>Approving over budget needs a written reason <span class="hint">The approver has to say why; it's kept in the request's History.</span></span></label>
      </div></details>` : ''}
    <p class="hint">Spent = ordered + received. In the pipeline = approved but not ordered yet (to submit, sent, or approved by the department).
      Purchases added by hand count too; cancelled ones don't. The same budgets warn approvers before a request goes over.</p>`;

  const saveBudgets = async (next) => {
    try {
      await api.setBudgets({ ...budgets, ...next });
      await reloadConfig();
      await rerender();
    } catch (err) {
      showError(err);
    }
  };
  box.addEventListener('change', (e) => {
    const t = e.target;
    if (t.dataset.budget !== undefined) {
      const value = toAmount(t.value);
      if (value === null) return showError(new Error(`"${t.value}" isn't a number.`));
      const amounts = { ...(budgets.amounts || {}) };
      if (value === '') delete amounts[t.dataset.budget];
      else amounts[t.dataset.budget] = value;
      return saveBudgets({ amounts });
    }
    if (t.id === 'budget-field') return saveBudgets({ field: t.value });
    if (t.id === 'budget-block') return saveBudgets({ block: t.checked });
  });
  box.querySelector('#budget-add')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = box.querySelector('#new-category').value.trim();
    const value = toAmount(box.querySelector('#new-amount').value);
    if (!name || !value) return showError(new Error('Enter a category and its budget.'));
    saveBudgets({ amounts: { ...(budgets.amounts || {}), [name]: value } });
  });
  box.addEventListener('click', (e) => {
    const del = e.target.closest('[data-delete-category]');
    if (del) return deleteCategory(del.dataset.deleteCategory, s);
    const a = e.target.closest('[data-category]');
    if (!a) return;
    e.preventDefault();
    view.tab = 'purchases';
    view.category = a.dataset.category === '(no category)' ? '' : a.dataset.category;
    rerender();
  });
}

// ---- Funding -------------------------------------------------------------------------------

const FUND_KINDS = ['University allocation', 'Donations', 'Department', 'Sponsorship', 'Grant', 'Fundraiser', 'Other'];

function drawFunding(box, s) {
  const { funds, funding, sponsorsIn, table, canEdit, seasonInfo, season, rerender, showError } = s;
  const gap = funding.expected - table.total.budget;
  const cell = (f, key, attrs = '') => (canEdit ? `<input data-fund="${esc(f.id)}" data-k="${key}" value="${esc(key === 'expected' || key === 'received' ? (f[key] === null ? '' : Number(f[key]).toFixed(2)) : f[key] || '')}" ${attrs}>` : esc(key === 'expected' || key === 'received' ? money(f[key]) : f[key] || ''));
  box.innerHTML = `
    <div class="table-wrap">
      <table class="table stack-mobile funds-table">
        <thead><tr><th>Source</th><th>Type</th><th class="num">Expected</th><th class="num">Received</th><th>Notes</th><th></th></tr></thead>
        <tbody>${funds
          .map(
            (f) => `<tr>
              <td class="cell-primary" data-label="">${cell(f, 'name', 'aria-label="Source"')}</td>
              <td data-label="Type">${cell(f, 'kind', 'list="fund-kinds" aria-label="Type"')}</td>
              <td class="num" data-label="Expected">${cell(f, 'expected', 'inputmode="decimal" placeholder="$" aria-label="Expected"')}</td>
              <td class="num" data-label="Received">${cell(f, 'received', 'inputmode="decimal" placeholder="$" aria-label="Received"')}</td>
              <td data-label="Notes">${cell(f, 'notes', 'aria-label="Notes"')}</td>
              <td data-label="">${canEdit ? `<button type="button" class="icon-btn" data-delete-fund="${esc(f.id)}" aria-label="Delete source">&times;</button>` : ''}</td>
            </tr>`
          )
          .join('')}
          ${sponsorsIn ? `<tr class="is-auto"><td class="cell-primary" data-label=""><a href="#/sponsors">Sponsors board</a> <span class="muted small">(cards received this season)</span></td><td data-label="Type">Sponsorship</td>
            <td class="num" data-label="Expected">${fmtMoney(sponsorsIn)}</td><td class="num" data-label="Received">${fmtMoney(sponsorsIn)}</td><td data-label="Notes" class="muted small">Adds itself up</td><td></td></tr>` : ''}
          ${!funds.length && !sponsorsIn ? '<tr><td colspan="6" class="muted sheet-empty">No funding sources yet, e.g. the university allocation, donations, or money from ECE.</td></tr>' : ''}
        </tbody>
        <tfoot><tr><td><strong>Total</strong></td><td></td><td class="num"><strong>${fmtMoney(funding.expected)}</strong></td><td class="num"><strong>${fmtMoney(funding.received)}</strong></td><td></td><td></td></tr></tfoot>
      </table>
    </div>
    ${canEdit ? '<button type="button" class="btn btn-sm" id="fund-add">+ Add a source</button>' : ''}
    <datalist id="fund-kinds">${FUND_KINDS.map((k) => `<option value="${esc(k)}">`).join('')}</datalist>
    <div class="fund-compare card">
      <div><span class="muted small">Expected funds</span><strong>${fmtMoney(funding.expected)}</strong></div>
      <div><span class="muted small">Total budget</span><strong>${fmtMoney(table.total.budget)}</strong></div>
      ${table.total.budget
        ? `<div class="${gap < 0 ? 'is-bad' : ''}"><span class="muted small">${gap < 0 ? 'Short by' : 'To spare'}</span><strong>${fmtMoney(Math.abs(gap))}</strong></div>`
        : '<div><span class="muted small">To spare</span><strong>—</strong></div>'}
      <div><span class="muted small">Rainy-day fund</span>${canEdit
        ? `<input id="rainy-day" inputmode="decimal" value="${seasonInfo.rainy_day === null ? '' : Number(seasonInfo.rainy_day).toFixed(2)}" placeholder="$" aria-label="Rainy-day fund balance">`
        : `<strong>${money(seasonInfo.rainy_day) || '—'}</strong>`}</div>
    </div>`;

  box.addEventListener('change', async (e) => {
    const t = e.target;
    try {
      if (t.dataset.fund) {
        let value = t.value.trim();
        if (['expected', 'received'].includes(t.dataset.k)) {
          value = toAmount(value);
          if (value === null) return showError(new Error(`"${t.value}" isn't a number.`));
        }
        await api.saveFund(t.dataset.fund, { [t.dataset.k]: value });
        if (['expected', 'received'].includes(t.dataset.k)) await rerender();
      } else if (t.id === 'rainy-day') {
        const value = toAmount(t.value);
        if (value === null) return showError(new Error(`"${t.value}" isn't a number.`));
        await api.saveFinanceSeason(season, { rainy_day: value });
        await rerender();
      }
    } catch (err) {
      showError(err);
    }
  });
  box.addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    try {
      if (btn.id === 'fund-add') {
        await api.saveFund(null, { season, name: 'New source' });
        await rerender();
        [...document.querySelectorAll('.funds-table [data-k="name"]')].pop()?.select();
      } else if (btn.dataset.deleteFund) {
        if (!confirm('Delete this funding source?')) return;
        await api.deleteFund(btn.dataset.deleteFund);
        await rerender();
      }
    } catch (err) {
      showError(err);
    }
  });
}

// ---- Notes ----------------------------------------------------------------------------------

function drawNotes(box, s) {
  const { canEdit, seasonInfo, season, showError } = s;
  box.innerHTML = canEdit
    ? `<textarea id="fin-notes" rows="14" placeholder="Plans and reminders for this season, e.g. $13,970 minimum for competition; could get $5,400 from ECE…">${esc(seasonInfo.notes || '')}</textarea>
       <p class="muted small" id="notes-status">Saves when you click away.</p>`
    : `<section class="card rich">${seasonInfo.notes ? renderRichText(seasonInfo.notes) : '<p class="muted">No notes yet.</p>'}</section>`;
  box.querySelector('#fin-notes')?.addEventListener('change', async (e) => {
    try {
      await api.saveFinanceSeason(season, { notes: e.target.value });
      box.querySelector('#notes-status').textContent = 'Saved.';
    } catch (err) {
      showError(err);
    }
  });
}

// ---- Download: one workbook with the ledger (in the old legend colors), budget and funding ----

const FILLS = { gray: 'FFEEF1F4', pink: 'FFFFAAA4', lightgreen: 'FFC6E0B4', green: 'FF00B050', teal: 'FFB3E2E8', red: 'FFFF8A80' };

async function download({ season, lines, table, funds, funding, sponsorsIn, seasonInfo }) {
  const ExcelJS = await loadExcelJS();
  const wb = new ExcelJS.Workbook();
  const head = (ws) => {
    ws.getRow(1).eachCell((c) => {
      c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0B2545' } };
    });
    ws.views = [{ state: 'frozen', ySplit: 1 }];
  };
  const money = '"$"#,##0.00';

  const ws = wb.addWorksheet('Purchases');
  ws.columns = [
    { header: 'Status', key: 'status', width: 16 }, { header: 'Item Description', key: 'description', width: 48 },
    { header: 'Cost', key: 'amount', width: 12 }, { header: 'M/E', key: 'dept', width: 6 }, { header: 'Category', key: 'category', width: 18 },
    { header: 'Order #', key: 'order', width: 12 }, { header: 'Request', key: 'number', width: 10 }, { header: 'Date', key: 'date', width: 12 },
    { header: 'Notes', key: 'notes', width: 48 },
  ];
  for (const l of [...lines].sort((a, b) => String(a.date).localeCompare(String(b.date)))) {
    const row = ws.addRow({
      status: stepOf(l.status).label, description: l.description, amount: l.amount, dept: l.dept, category: l.category,
      order: l.orderNumber, number: l.number || '', date: l.date ? new Date(`${l.date}T00:00:00Z`) : null, notes: l.notes,
    });
    row.getCell('status').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: FILLS[stepOf(l.status).tone] } };
  }
  ws.getColumn('amount').numFmt = money;
  ws.getColumn('date').numFmt = 'mm/dd/yyyy';
  ws.autoFilter = { from: 'A1', to: 'I1' };
  head(ws);

  const wsB = wb.addWorksheet('Budget');
  wsB.columns = [{ header: 'Category', key: 'c', width: 22 }, { header: 'Budget', key: 'b', width: 14 }, { header: 'Spent', key: 's', width: 14 },
    { header: 'In the pipeline', key: 'p', width: 16 }, { header: 'Left', key: 'l', width: 14 }];
  for (const r of table.rows) wsB.addRow({ c: r.category, b: r.budget, s: r.spent, p: r.pipeline, l: r.left });
  const t = wsB.addRow({ c: 'Total', ...{ b: table.total.budget, s: table.total.spent, p: table.total.pipeline, l: table.total.left } });
  t.font = { bold: true };
  ['b', 's', 'p', 'l'].forEach((k) => (wsB.getColumn(k).numFmt = money));
  head(wsB);

  const wsF = wb.addWorksheet('Funding');
  wsF.columns = [{ header: 'Source', key: 'n', width: 28 }, { header: 'Type', key: 'k', width: 20 }, { header: 'Expected', key: 'e', width: 14 },
    { header: 'Received', key: 'r', width: 14 }, { header: 'Notes', key: 'x', width: 40 }];
  for (const f of funds) wsF.addRow({ n: f.name, k: f.kind, e: f.expected === null ? null : Number(f.expected), r: f.received === null ? null : Number(f.received), x: f.notes });
  if (sponsorsIn) wsF.addRow({ n: 'Sponsors board', k: 'Sponsorship', e: sponsorsIn, r: sponsorsIn });
  wsF.addRow({ n: 'Total', e: funding.expected, r: funding.received }).font = { bold: true };
  if (seasonInfo.rainy_day !== null) wsF.addRow({ n: 'Rainy-day fund', e: Number(seasonInfo.rainy_day) });
  ['e', 'r'].forEach((k) => (wsF.getColumn(k).numFmt = money));
  head(wsF);
  if (seasonInfo.notes) {
    const wsN = wb.addWorksheet('Notes');
    wsN.getColumn(1).width = 100;
    for (const line of seasonInfo.notes.split('\n')) wsN.addRow([line]);
  }

  const blob = new Blob([await wb.xlsx.writeBuffer()], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `Solar_Gators_${season}_Financials.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/**
 * Delete a category: drop its budget and move every purchase in it (requests too) to
 * another category, so the row really goes away.
 */
function deleteCategory(name, { lines, categories, budgets, season, reloadConfig, rerender, showError }) {
  const key = (c) => String(c || '').trim().toLowerCase();
  const using = lines.filter((l) => key(l.category) === key(name));
  const amounts = Object.fromEntries(Object.entries(budgets.amounts || {}).filter(([k]) => key(k) !== key(name)));
  const others = categories.filter((c) => key(c) !== key(name));
  if (!using.length) {
    if (!confirm(`Delete the "${name}" category and its budget?`)) return;
    return api.setBudgets({ ...budgets, amounts }).then(reloadConfig).then(rerender).catch(showError);
  }
  const dialog = document.createElement('dialog');
  dialog.className = 'card sheet-dialog';
  dialog.innerHTML = `<form method="dialog" novalidate>
    <h2>Delete "${esc(name)}"</h2>
    <p>${using.length} purchase${using.length === 1 ? '' : 's'} in ${esc(season)} ${using.length === 1 ? 'is' : 'are'} in this category. Move ${using.length === 1 ? 'it' : 'them'} to:</p>
    <div class="field"><input id="move-to" list="move-categories" placeholder="e.g. Cost center 1" aria-label="Move to category" required>
      <datalist id="move-categories">${others.map((c) => `<option value="${esc(c)}">`).join('')}</datalist></div>
    <p class="hint">Requests keep their own answer; only the category they count toward on Finances changes. Its budget is removed too.</p>
    <div id="delete-errors"></div>
    <div class="form-actions"><button type="button" class="btn btn-ghost" id="delete-cancel">Cancel</button><button type="submit" class="btn btn-danger">Move and delete</button></div>
  </form>`;
  document.body.appendChild(dialog);
  const close = () => (dialog.close(), dialog.remove());
  dialog.querySelector('#delete-cancel').addEventListener('click', close);
  dialog.addEventListener('cancel', close);
  dialog.querySelector('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const to = dialog.querySelector('#move-to').value.trim();
    const errors = dialog.querySelector('#delete-errors');
    if (!to || key(to) === key(name)) return (errors.innerHTML = errorBox(new Error('Pick another category to move them to.')));
    const btn = dialog.querySelector('[type="submit"]');
    btn.disabled = true;
    try {
      for (const [i, l] of using.entries()) {
        btn.textContent = `Moving ${i + 1} of ${using.length}…`;
        // Moving a request back to its own answer means following the request again.
        const category = l.kind === 'request' && key(to) === key(l.answer) ? '' : to;
        if (l.purchaseId) await api.savePurchase(l.purchaseId, { category });
        else await api.savePurchase(null, { request_id: l.request.id, category });
      }
      await api.setBudgets({ ...budgets, amounts });
      close();
      setFlash(`Deleted "${name}"; moved ${using.length} purchase${using.length === 1 ? '' : 's'} to "${to}".`);
      await reloadConfig();
      rerender();
    } catch (err) {
      errors.innerHTML = errorBox(err);
      btn.disabled = false;
      btn.textContent = 'Move and delete';
    }
  });
  dialog.showModal();
  dialog.querySelector('#move-to').focus();
}

// ---- Import: the Treasurer's old Financials spreadsheet --------------------------------------

async function importSpreadsheet(file, { config, season, requests, purchases, budgets, canBudget, reloadConfig, rerender }) {
  const ExcelJS = await loadExcelJS();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await file.arrayBuffer());
  const ws = wb.worksheets.find((w) => w.state !== 'hidden') || wb.worksheets[0];
  const data = readFinancialsSheet({
    rows: ws.rowCount,
    cols: ws.columnCount,
    value: (r, c) => cellText(ws.getRow(r).getCell(c).value),
    fill: (r, c) => ws.getRow(r).getCell(c).fill?.fgColor?.argb || '',
  });

  // Lines already here: requests with the same order #, or a purchase with the same description, cost and order #.
  const byTicket = new Map(requests.filter((r) => r.order?.department_order_number).map((r) => [String(r.order.department_order_number).trim(), r]));
  const own = purchases.filter((p) => !p.request_id && p.season === season);
  const key = (p) => `${String(p.description).trim().toLowerCase()}|${Number(p.amount || 0).toFixed(2)}|${String(p.order_number || '').trim()}`;
  const have = new Set(own.map(key));
  const toLink = [];
  const toAdd = [];
  let skipped = 0;
  for (const p of data.purchases) {
    const match = p.order_number && byTicket.get(p.order_number);
    if (match) toLink.push({ p, r: match });
    else if (have.has(key(p))) skipped++;
    else toAdd.push(p);
  }
  const total = toAdd.reduce((s, p) => s + (p.dept_status === 'cancelled' ? 0 : Number(p.amount) || 0), 0);
  const budgetNames = Object.keys(data.budgets);
  const current = await api.getFinanceSeason(season);
  const notesThere = !!data.notes && String(current.notes || '').includes(data.notes);

  const dialog = document.createElement('dialog');
  dialog.className = 'card sheet-dialog';
  dialog.innerHTML = `<form method="dialog" novalidate>
    <h2>Import ${esc(file.name)}</h2>
    <p class="muted small">Into the ${esc(season)} season. Nothing is saved until you click Import.</p>
    <label class="rule-toggle"><input type="checkbox" name="purchases" ${toAdd.length ? 'checked' : 'disabled'}>
      <span><strong>${toAdd.length ? `${toAdd.length} new purchase${toAdd.length === 1 ? '' : 's'}` : 'No new purchases'}</strong>${toAdd.length ? ` (${fmtMoney(total)}, not counting cancelled)` : ''}
        <span class="hint">${toAdd.length ? `${STEPS.map((x) => [x.label, toAdd.filter((p) => p.dept_status === x.key).length]).filter(([, n]) => n).map(([l, n]) => `${n} ${l.toLowerCase()}`).join(', ')}. Status comes from each row's color.` : ''}${toLink.length ? ` ${toLink.length} match a request already on the site by order # and add their M/E and notes to it instead.` : ''}${skipped ? ` ${skipped} were imported before and are skipped.` : ''}</span></span></label>
    ${budgetNames.length ? `<label class="rule-toggle"><input type="checkbox" name="budgets" ${canBudget ? 'checked' : 'disabled'}>
      <span><strong>Budgets for ${budgetNames.length} categories</strong> (${fmtMoney(Object.values(data.budgets).reduce((s, v) => s + Number(v), 0))})
        <span class="hint">${esc(budgetNames.join(', '))}. Replaces these categories' budgets.${canBudget ? '' : ' Only the Treasurer can set budgets.'}</span></span></label>` : ''}
    ${data.rainyDay ? `<label class="rule-toggle"><input type="checkbox" name="rainy" checked><span><strong>Rainy-day fund:</strong> ${fmtMoney(Number(data.rainyDay))}</span></label>` : ''}
    ${data.notes ? `<label class="rule-toggle"><input type="checkbox" name="notes" ${notesThere ? '' : 'checked'}><span><strong>Notes</strong> (${data.notes.split('\n').length} lines), ${notesThere ? 'already in the season\'s notes' : 'added to the season\'s notes'}</span></label>` : ''}
    <div id="import-errors"></div>
    <div class="form-actions"><button type="button" class="btn btn-ghost" id="import-cancel">Cancel</button><button type="submit" class="btn btn-primary">Import</button></div>
  </form>`;
  document.body.appendChild(dialog);
  const close = () => (dialog.close(), dialog.remove());
  dialog.querySelector('#import-cancel').addEventListener('click', close);
  dialog.addEventListener('cancel', close);
  dialog.querySelector('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const pick = (n) => dialog.querySelector(`[name="${n}"]`)?.checked;
    const btn = dialog.querySelector('[type="submit"]');
    btn.disabled = true;
    try {
      if (pick('purchases')) {
        for (const [i, p] of toAdd.entries()) {
          btn.textContent = `Importing ${i + 1} of ${toAdd.length}…`;
          await api.savePurchase(null, { ...p, season });
        }
        for (const { p, r } of toLink) {
          await api.savePurchase(null, { request_id: r.id, dept: p.dept, notes: p.notes, ...(['sent', 'dept_approved', 'cancelled'].includes(p.dept_status) && r.status === 'Approved' ? { dept_status: p.dept_status } : {}) });
        }
      }
      if (pick('budgets')) {
        let field = budgets.field;
        if (!field) field = budgetFields(config).find((f) => /cost\s*cent|subteam|subsystem/i.test(f.label))?.key || '';
        await api.setBudgets({ ...budgets, field, amounts: { ...(budgets.amounts || {}), ...data.budgets } });
        await reloadConfig();
      }
      if (pick('rainy') || pick('notes')) {
        await api.saveFinanceSeason(season, {
          ...(pick('rainy') ? { rainy_day: data.rainyDay } : {}),
          ...(pick('notes') ? { notes: [current.notes, data.notes].filter(Boolean).join('\n\n') } : {}),
        });
      }
      close();
      setFlash(`Imported ${file.name}.`);
      view.tab = 'purchases';
      rerender();
    } catch (err) {
      dialog.querySelector('#import-errors').innerHTML = errorBox(err);
      btn.disabled = false;
      btn.textContent = 'Import';
    }
  });
  dialog.showModal();
}
