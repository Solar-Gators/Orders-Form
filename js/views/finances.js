/**
 * Finances (#/finances): spreadsheet-like sheets the Treasurer shapes himself
 * (migration 014). Typed-in columns save as you leave a cell; calculated columns
 * (budgets, order totals, totals from another sheet, request details, + / − math,
 * running totals) fill themselves in, and clicking one shows what was added up.
 * See js/financeCalc.js (the math) and js/views/financeColumns.js (the column editor).
 *
 * Also: totals row, search, sorting (with "Keep this order"), "Add ordered requests",
 * "Add a row per Cost center", Excel import and download.
 * Viewing needs finances.view; changing, finances.edit.
 */
import { api } from '../api.js';
import { auth } from '../auth.js';
import { esc, fmtMoney, fmtDate, errorBox, setFlash, takeFlash } from '../ui.js';
import { requestFields } from '../formFields.js';
import { workflowSettings } from '../workflow.js';
import { loadExcelJS } from '../excel.js';
import { cellText } from '../sheetImport.js';
import {
  PLAIN_NUMERIC, requestDetails, isNumeric, isMoney, isCalc, toNumber, same, computeRows, runningTotals, explain,
} from '../financeCalc.js';
import { openColumnEditor, newSheetDialog, optionsOf, formFieldOf, newKey } from './financeColumns.js';
import { renderBudgetPanel } from './treasurer.js';

// Kept while moving around the app.
const view = { sheetId: null, q: '', sort: null };

export async function renderFinances(el, { config, rerender, reloadConfig }) {
  const canEdit = auth.can('finances.edit');
  const canBudget = canEdit && (auth.can('request.order') || auth.can('workflow.edit'));
  let sheets;
  try {
    sheets = await api.listFinanceSheets();
  } catch {
    el.innerHTML = `<div class="page-header"><div><h1>Finances</h1></div></div>
      <div class="alert alert-info">The Finances tab needs database update <code>014_finances.sql</code>.</div>`;
    return;
  }

  const startNew = async () => {
    const id = await newSheetDialog({ config, sheets });
    if (id) {
      view.sheetId = id;
      view.sort = null;
      setFlash('Sheet created. Use "Columns & sheet" to change it.');
      rerender();
    }
  };

  if (!sheets.length) {
    el.innerHTML = `${takeFlash()}<div class="page-header"><div><h1>Finances</h1></div></div>
      <div class="empty"><p>No sheets yet.</p>${canEdit ? '<button type="button" class="btn btn-primary" id="first-sheet">+ New sheet</button>' : ''}</div>`;
    el.querySelector('#first-sheet')?.addEventListener('click', startNew);
    return;
  }
  if (!sheets.some((s) => s.id === view.sheetId)) view.sheetId = sheets[0].id;
  const sheet = sheets.find((s) => s.id === view.sheetId);
  const columns = sheet.columns || [];
  const rows = await api.listFinanceRows(sheet.id);
  if (view.sort && !columns.some((c) => c.key === view.sort.key)) view.sort = null;

  // What calculated columns need: requests, other sheets' rows, the site's budgets.
  const needsRequests = columns.some((c) => ['request', 'orders', 'reqinfo'].includes(c.type));
  const requests = needsRequests ? await api.listRequests(null).catch(() => []) : [];
  const byNumber = new Map(requests.map((r) => [r.request_number.toLowerCase(), r]));
  const sheetData = new Map([[sheet.id, { sheet, rows }]]);
  for (const id of new Set(columns.filter((c) => c.type === 'lookup' && c.sheet && c.sheet !== sheet.id).map((c) => c.sheet))) {
    const other = sheets.find((s) => s.id === id);
    if (other) sheetData.set(id, { sheet: other, rows: await api.listFinanceRows(id) });
  }
  const ctx = {
    requests, season: config.season, budgets: workflowSettings(config).budgets, sheets: sheetData,
    details: requestDetails(requestFields(config)), columns,
  };
  const hasFill = columns.some((c) => c.fill);
  const perOption = columns.find((c) => c.type === 'select' && formFieldOf(c));

  el.innerHTML = `
    ${takeFlash()}
    <div class="page-header">
      <div>
        <h1>Finances</h1>
        <p class="subtitle">${canEdit
          ? 'Your own sheets. Typed cells save as you go; shaded cells are calculated (click one to see how).'
          : 'View only. Shaded cells are calculated; click one to see how.'}</p>
      </div>
      <div class="card-actions">
        ${canEdit && hasFill ? '<button type="button" class="btn" id="add-ordered">Add ordered requests</button>' : ''}
        <button type="button" class="btn" id="download">Download .xlsx</button>
      </div>
    </div>

    <div id="budget-panel"></div>

    <div class="sheet-tabs" role="tablist" aria-label="Sheets">
      ${sheets.map((s) => `<button type="button" role="tab" data-sheet="${esc(s.id)}" aria-selected="${s.id === sheet.id}">${esc(s.name)}</button>`).join('')}
      ${canEdit ? `<button type="button" class="sheet-add" id="new-sheet">+ New sheet</button>
        <label class="btn btn-sm btn-ghost sheet-import">Import Excel…<input type="file" id="import-file" accept=".xlsx" hidden></label>` : ''}
    </div>

    <div id="fin-errors"></div>
    <div id="columns-editor"></div>

    <div class="toolbar sheet-toolbar">
      <input type="search" id="fin-q" placeholder="Search this sheet" value="${esc(view.q)}" aria-label="Search this sheet">
      <span class="muted small" id="fin-count"></span>
      <span class="muted small" id="fin-status" aria-live="polite"></span>
      <span class="toolbar-right">
        <span id="keep-order-box"></span>
        <span id="per-option-box"></span>
        ${canEdit ? '<button type="button" class="btn btn-sm" id="edit-columns">Columns &amp; sheet</button>' : ''}
      </span>
    </div>

    <div class="table-wrap sheet-wrap">
      <table class="table sheet-table">
        <thead><tr>
          <th class="sheet-idx">#</th>
          ${columns.map((c) => `<th class="${isNumeric(c) ? 'num' : ''} ${isCalc(c) ? 'is-calc-head' : ''}" ${isCalc(c) ? 'title="Calculated"' : ''}>
            <button type="button" class="sort-btn" data-sort="${esc(c.key)}">${esc(c.label)}<span class="sort-ind" aria-hidden="true">${
              view.sort?.key === c.key ? (view.sort.dir === 'desc' ? '▼' : '▲') : '↕'}</span></button></th>`).join('')}
          ${canEdit ? '<th class="sheet-del"></th>' : ''}
        </tr></thead>
        <tbody id="sheet-body"></tbody>
        <tfoot id="sheet-foot"></tfoot>
      </table>
    </div>
    ${canEdit ? '<div class="add-row"><button type="button" class="btn btn-sm" id="add-row">+ Add row</button><span class="hint hide-touch">Enter moves down a row; Tab moves right.</span></div>' : ''}
    ${columns.some((c) => c.type === 'request') ? `<datalist id="request-numbers">${requests.map((r) => `<option value="${esc(r.request_number)}">${esc(r.title || '')}</option>`).join('')}</datalist>` : ''}`;

  renderBudgetPanel(el.querySelector('#budget-panel'), { config, reloadConfig, rerender }).catch(() => {});

  const errors = el.querySelector('#fin-errors');
  const status = el.querySelector('#fin-status');
  const showError = (err) => {
    errors.innerHTML = errorBox(err);
    status.textContent = '';
  };

  // ---- values: typed + calculated --------------------------------------------------------
  let values = computeRows(columns, rows, ctx);
  let running = new Map();
  const recalc = () => {
    values = computeRows(columns, rows, ctx);
  };

  const textOf = (row) => Object.values(values.get(row.id) || row.data || {}).join(' ').toLowerCase();
  const shownRows = () => {
    const words = view.q.toLowerCase().split(/\s+/).filter(Boolean);
    let list = rows.filter((r) => words.every((w) => textOf(r).includes(w)));
    if (view.sort) {
      const col = columns.find((c) => c.key === view.sort.key);
      const dir = view.sort.dir === 'desc' ? -1 : 1;
      const raw = (r) => values.get(r.id)?.[col.key] ?? '';
      list = [...list].sort((a, b) => {
        const [x, y] = [raw(a), raw(b)];
        if (x === '' || y === '') return x === y ? 0 : x === '' ? 1 : -1; // blanks last
        if (isNumeric(col)) return (toNumber(x) - toNumber(y)) * dir;
        return String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: 'base' }) * dir;
      });
    }
    return list;
  };

  const show = (c, v) => {
    if (v === '' || v === undefined || v === null) return '';
    if (isMoney(c)) return fmtMoney(toNumber(v));
    if (isNumeric(c)) return String(Number(toNumber(v).toFixed(6)));
    return esc(v);
  };
  const negative = (c, v) => isNumeric(c) && v !== '' && toNumber(v) < 0;

  const cell = (row, c) => {
    const v = row.data?.[c.key] ?? '';
    const attrs = `data-row="${esc(row.id)}" data-key="${esc(c.key)}" aria-label="${esc(c.label)}"`;
    if (c.type === 'budget' && canBudget) {
      const bv = values.get(row.id)?.[c.key] ?? '';
      return `<td class="num t-money is-budget" title="The site's budget (same as the Budgets card)"><input type="text" inputmode="decimal" data-budget-row="${esc(row.id)}" data-key="${esc(c.key)}" aria-label="${esc(c.label)}" value="${bv === '' ? '' : toNumber(bv).toFixed(2)}" placeholder="—"></td>`;
    }
    if (isCalc(c)) return `<td class="${isNumeric(c) ? 'num ' : ''}is-calc" data-calc="${esc(c.key)}" data-row-id="${esc(row.id)}" tabindex="0" title="Calculated: click to see how"></td>`;
    if (!canEdit) {
      const req = c.type === 'request' && v ? byNumber.get(String(v).toLowerCase()) : null;
      const shown =
        c.type === 'money' ? show(c, v)
        : c.type === 'date' ? (v ? fmtDate(v) : '')
        : c.type === 'checkbox' ? (v ? '✓' : '')
        : c.type === 'link' && v ? `<a href="${esc(v)}" target="_blank" rel="noopener">${esc(v)}</a>`
        : req ? `<a href="#/requests/${esc(req.request_number)}" title="${esc(req.title || '')}">${esc(v)}</a>`
        : esc(v);
      return `<td class="${PLAIN_NUMERIC.has(c.type) ? 'num' : ''} ${negative(c, v) ? 'is-negative' : ''}">${shown}</td>`;
    }
    let input;
    if (c.type === 'checkbox') input = `<input type="checkbox" ${attrs} ${v ? 'checked' : ''}>`;
    else if (c.type === 'select') {
      const opts = [...new Set([...optionsOf(c, config), ...(v ? [v] : [])])];
      input = `<select ${attrs}><option value=""></option>${opts.map((o) => `<option ${o === v ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
    } else if (c.type === 'date') input = `<input type="date" ${attrs} value="${esc(v)}">`;
    else if (PLAIN_NUMERIC.has(c.type)) input = `<input type="text" inputmode="decimal" ${attrs} value="${esc(c.type === 'money' && v !== '' ? toNumber(v).toFixed(2) : v)}" ${c.type === 'money' ? 'placeholder="$"' : ''}>`;
    else if (c.type === 'request') {
      const r = byNumber.get(String(v).toLowerCase());
      input = `<span class="cell-with-link"><input type="text" list="request-numbers" ${attrs} value="${esc(v)}" placeholder="SG-…">${
        r ? `<a href="#/requests/${esc(r.request_number)}" title="${esc(r.title || '')}" aria-label="Open ${esc(v)}">↗</a>` : ''}</span>`;
    } else if (c.type === 'link') {
      input = `<span class="cell-with-link"><input type="url" ${attrs} value="${esc(v)}">${
        /^https?:\/\//i.test(v) ? `<a href="${esc(v)}" target="_blank" rel="noopener" aria-label="Open link">↗</a>` : ''}</span>`;
    } else input = `<input type="text" ${attrs} value="${esc(v)}">`;
    return `<td class="${PLAIN_NUMERIC.has(c.type) ? 'num' : ''} t-${esc(c.type)} ${negative(c, v) ? 'is-negative' : ''}">${input}</td>`;
  };

  const draw = () => {
    const list = shownRows();
    el.querySelector('#sheet-body').innerHTML = list.length
      ? list
          .map(
            (row, i) => `<tr data-row-id="${esc(row.id)}">
              <td class="sheet-idx muted">${i + 1}</td>
              ${columns.map((c) => cell(row, c)).join('')}
              ${canEdit ? `<td class="sheet-del"><button type="button" class="icon-btn" data-delete-row="${esc(row.id)}" title="Delete row" aria-label="Delete row ${i + 1}">&times;</button></td>` : ''}
            </tr>`
          )
          .join('')
      : `<tr><td colspan="${columns.length + 2}" class="muted sheet-empty">${rows.length ? 'No rows match your search.' : canEdit ? 'No rows yet. Click "+ Add row".' : 'No rows yet.'}</td></tr>`;
    el.querySelector('#fin-count').textContent = list.length === rows.length ? `${rows.length} row${rows.length === 1 ? '' : 's'}` : `${list.length} of ${rows.length} rows`;
    el.querySelector('#keep-order-box').innerHTML = canEdit && view.sort && !view.q
      ? '<button type="button" class="btn btn-sm btn-ghost" id="keep-order" title="Save the rows in this order">Keep this order</button>'
      : '';
    const missing = perOption && canEdit ? optionsOf(perOption, config).filter((o) => !rows.some((r) => same(r.data?.[perOption.key], o))) : [];
    el.querySelector('#per-option-box').innerHTML = missing.length
      ? `<button type="button" class="btn btn-sm" id="per-option" title="${esc(missing.join(', '))}">Add a row per ${esc(perOption.label)} (${missing.length})</button>`
      : '';
    fillCalculated(list);
  };

  /** Calculated cells, running totals and the totals row (over the rows shown, in the order shown). */
  const fillCalculated = (list = shownRows()) => {
    running = runningTotals(columns, list, values);
    for (const td of el.querySelectorAll('#sheet-body [data-calc]')) {
      const c = columns.find((x) => x.key === td.dataset.calc);
      const v = c.type === 'running' ? running.get(td.dataset.rowId)?.[c.key] : values.get(td.dataset.rowId)?.[c.key];
      td.innerHTML = show(c, v ?? '');
      td.classList.toggle('is-negative', negative(c, v ?? ''));
    }
    const any = columns.some((c) => (c.sum && isNumeric(c)) || c.type === 'running');
    el.querySelector('#sheet-foot').innerHTML = any
      ? `<tr><td class="sheet-idx" title="Totals of the rows shown"><strong>Σ</strong></td>${columns
          .map((c) => {
            let total;
            if (c.type === 'running') total = list.length ? running.get(list[list.length - 1].id)?.[c.key] ?? 0 : 0;
            else if (c.sum && isNumeric(c)) total = list.reduce((s, r) => s + toNumber(values.get(r.id)?.[c.key]), 0);
            else return '<td></td>';
            return `<td class="num ${total < 0 ? 'is-negative' : ''}"><strong>${isMoney(c) ? fmtMoney(total) : Number(total.toFixed(6))}</strong></td>`;
          })
          .join('')}${canEdit ? '<td></td>' : ''}</tr>`
      : '';
  };

  // ---- "Click to see why" ----------------------------------------------------------
  const why = (td) => {
    const c = columns.find((x) => x.key === td.dataset.calc);
    const row = rows.find((r) => r.id === td.dataset.rowId);
    if (!c || !row) return;
    let info;
    if (c.type === 'running') {
      const of = columns.find((x) => x.key === c.of);
      const list = shownRows();
      const upTo = list.slice(0, list.indexOf(row) + 1);
      info = { text: `${of?.label || '?'} added up row by row, in the order shown (row 1 to this row).`, items: upTo.map((r, i) => ({ label: `Row ${i + 1}`, amount: toNumber(values.get(r.id)?.[c.of]) })) };
    } else info = explain(c, row, values.get(row.id) || {}, ctx);
    const total = c.type === 'running' ? running.get(row.id)?.[c.key] : values.get(row.id)?.[c.key];
    const dialog = document.createElement('dialog');
    dialog.className = 'card calc-dialog';
    dialog.innerHTML = `<h2>${esc(c.label)}</h2>
      <p>${esc(info.text)}</p>
      ${info.items.length
        ? `<ul class="calc-items">${info.items
            .slice(0, 200)
            .map((i) => `<li>${i.href ? `<a href="${esc(i.href)}">${esc(i.label)}</a>` : `<span>${esc(i.label)}</span>`}${i.amount !== undefined ? `<span class="num">${fmtMoney(i.amount)}</span>` : ''}</li>`)
            .join('')}</ul>${info.items.length > 200 ? `<p class="muted small">…and ${info.items.length - 200} more.</p>` : ''}`
        : '<p class="muted small">Nothing to add up yet.</p>'}
      ${isNumeric(c) ? `<p class="calc-total"><span>Total</span><strong>${show(c, total ?? 0) || fmtMoney(0)}</strong></p>` : ''}
      <div class="form-actions"><button type="button" class="btn" id="calc-close">Close</button></div>`;
    document.body.appendChild(dialog);
    const close = () => {
      dialog.close();
      dialog.remove();
    };
    dialog.querySelector('#calc-close').addEventListener('click', close);
    dialog.addEventListener('click', (e) => (e.target === dialog || e.target.closest('a')) && close());
    dialog.addEventListener('cancel', close);
    dialog.showModal();
  };

  // ---- saving cells ---------------------------------------------------------------
  let pending = 0;
  const parseAmount = (input, value) => {
    // Accepts 1234.5, $1,234.50, -5 and accounting-style (12.50).
    const n = /^-?\(?-?\$?\s?[\d,]*\.?\d+\)?$/.test(value) ? toNumber(value) : NaN;
    if (!Number.isFinite(n)) {
      input.classList.add('is-invalid');
      status.textContent = `"${value}" isn't a number.`;
      return null;
    }
    input.classList.remove('is-invalid');
    return n;
  };

  const save = async (input) => {
    const row = rows.find((r) => r.id === input.dataset.row);
    const col = columns.find((c) => c.key === input.dataset.key);
    if (!row || !col) return;
    let value = input.type === 'checkbox' ? (input.checked ? 'Yes' : '') : input.value.trim();
    if (PLAIN_NUMERIC.has(col.type) && value !== '') {
      const n = parseAmount(input, value);
      if (n === null) return;
      value = col.type === 'money' ? n.toFixed(2) : String(n);
      input.value = value;
    }
    input.classList.remove('is-invalid');
    if ((row.data[col.key] ?? '') === value) return;
    const before = row.data[col.key];
    if (value === '') delete row.data[col.key];
    else row.data[col.key] = value;
    input.closest('td')?.classList.toggle('is-negative', negative(col, value));
    recalc();
    fillCalculated();
    pending++;
    status.textContent = 'Saving…';
    try {
      await api.setFinanceCell(row.id, col.key, value);
      if (!--pending) status.textContent = 'All changes saved';
      errors.innerHTML = '';
    } catch (err) {
      pending--;
      if (before === undefined) delete row.data[col.key];
      else row.data[col.key] = before;
      recalc();
      fillCalculated();
      showError(err);
    }
    // A request number or link that changed gets its ↗.
    if (col.type === 'request' || col.type === 'link') {
      const td = input.closest('td');
      const tr = input.closest('tr');
      const focusKey = document.activeElement?.dataset?.key;
      td.outerHTML = cell(row, col);
      if (focusKey && focusKey !== col.key) tr.querySelector(`[data-key="${CSS.escape(focusKey)}"]`)?.focus();
    }
  };

  /** Budget cells change the site's budgets (the Budgets card uses the same numbers). */
  const saveBudget = async (input) => {
    const row = rows.find((r) => r.id === input.dataset.budgetRow);
    const col = columns.find((c) => c.key === input.dataset.key);
    const name = String(row?.data?.[col.by] ?? '').trim();
    const value = input.value.trim();
    if (!name) {
      input.value = '';
      showError(new Error(`Pick a ${columns.find((c) => c.key === col.by)?.label || 'value'} in this row first.`));
      return;
    }
    const n = value === '' ? '' : parseAmount(input, value);
    if (n === null) return;
    const budgets = structuredClone(workflowSettings(config).budgets);
    const field = formFieldOf(columns.find((c) => c.key === col.by));
    if (!budgets.field) budgets.field = field;
    if (field && budgets.field !== field) {
      showError(new Error('The site\'s budgets are set per another field. Change "Budget by" in the Budgets card first.'));
      return;
    }
    const existing = Object.keys(budgets.amounts || {}).find((k) => same(k, name));
    budgets.amounts = { ...(budgets.amounts || {}) };
    if (existing !== undefined) delete budgets.amounts[existing];
    if (n !== '') budgets.amounts[existing ?? name] = String(n);
    status.textContent = 'Saving budget…';
    try {
      await api.setBudgets(budgets);
      await reloadConfig();
      ctx.budgets = workflowSettings(config).budgets;
      input.value = n === '' ? '' : n.toFixed(2);
      recalc();
      fillCalculated();
      status.textContent = 'Budget saved';
      errors.innerHTML = '';
    } catch (err) {
      showError(err);
    }
  };

  el.addEventListener('change', (e) => {
    if (e.target.matches('[data-budget-row]')) saveBudget(e.target);
    else if (e.target.matches('[data-row][data-key]')) save(e.target);
  });

  // Enter: down to the same column in the next row (adds a row at the bottom).
  el.addEventListener('keydown', async (e) => {
    const input = e.target;
    if (e.key === 'Enter' && input.matches?.('td[data-calc]')) return why(input);
    if (e.key !== 'Enter' || !input.matches?.('input[data-row][data-key], input[data-budget-row]')) return;
    e.preventDefault();
    input.blur(); // saves
    const tr = input.closest('tr');
    let next = tr.nextElementSibling;
    if (!next && canEdit && !input.dataset.budgetRow) {
      await addRows([{ data: {} }]);
      next = el.querySelector('#sheet-body tr:last-child');
    }
    next?.querySelector(`[data-key="${CSS.escape(input.dataset.key)}"]`)?.focus();
  });

  const addRows = async (list) => {
    try {
      const added = await api.addFinanceRows(sheet.id, list);
      rows.push(...added);
      view.sort = null; // new rows go at the bottom, where you can see them
      recalc();
      draw();
      return added;
    } catch (err) {
      showError(err);
      return [];
    }
  };

  // ---- clicks ---------------------------------------------------------------------
  el.addEventListener('click', async (e) => {
    const calc = e.target.closest('td[data-calc]');
    if (calc && !e.target.closest('a')) return why(calc);
    const btn = e.target.closest('button');
    if (!btn) return;
    if (btn.dataset.sheet) {
      view.sheetId = btn.dataset.sheet;
      view.sort = null;
      return rerender();
    }
    if (btn.dataset.sort) {
      const key = btn.dataset.sort;
      view.sort = view.sort?.key !== key ? { key, dir: 'asc' } : view.sort.dir === 'asc' ? { key, dir: 'desc' } : null;
      el.querySelectorAll('[data-sort]').forEach((b) => {
        b.querySelector('.sort-ind').textContent = view.sort?.key === b.dataset.sort ? (view.sort.dir === 'desc' ? '▼' : '▲') : '↕';
      });
      return draw();
    }
    if (btn.id === 'add-row') {
      const [row] = await addRows([{ data: {} }]);
      const first = columns.find((c) => !isCalc(c));
      if (row && first) el.querySelector(`[data-row="${CSS.escape(row.id)}"][data-key="${CSS.escape(first.key)}"]`)?.focus();
      return;
    }
    if (btn.id === 'per-option') {
      const missing = optionsOf(perOption, config).filter((o) => !rows.some((r) => same(r.data?.[perOption.key], o)));
      await addRows(missing.map((o) => ({ data: { [perOption.key]: o } })));
      status.textContent = `Added ${missing.length} row${missing.length === 1 ? '' : 's'}.`;
      return;
    }
    if (btn.dataset.deleteRow) {
      if (!confirm('Delete this row? This can\'t be undone.')) return;
      try {
        await api.deleteFinanceRows([btn.dataset.deleteRow]);
        rows.splice(rows.findIndex((r) => r.id === btn.dataset.deleteRow), 1);
        recalc();
        draw();
      } catch (err) {
        showError(err);
      }
      return;
    }
    if (btn.id === 'keep-order') {
      const list = shownRows();
      btn.disabled = true;
      status.textContent = 'Saving order…';
      try {
        for (const [i, row] of list.entries()) {
          if (row.position !== i + 1) {
            await api.moveFinanceRow(row.id, i + 1);
            row.position = i + 1;
          }
        }
        view.sort = null;
        setFlash('Row order saved.');
        return rerender();
      } catch (err) {
        showError(err);
        btn.disabled = false;
      }
      return;
    }
    if (btn.id === 'new-sheet') return startNew();
    if (btn.id === 'edit-columns') {
      btn.hidden = true;
      const box = el.querySelector('#columns-editor');
      openColumnEditor(box, {
        sheet, sheets, rowsCount: rows.length, config, rerender,
        setView: (v) => Object.assign(view, v),
        onDone: () => {
          box.innerHTML = '';
          btn.hidden = false;
        },
      });
      box.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    if (btn.id === 'download') return download(sheet, columns, shownRows(), values, running).catch(showError);
    if (btn.id === 'add-ordered') return addOrdered();
  });

  el.querySelector('#fin-q').addEventListener('input', (e) => {
    view.q = e.target.value;
    draw();
  });

  el.querySelector('#import-file')?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    status.textContent = 'Reading the file…';
    try {
      const made = await importWorkbook(file, sheets.length);
      if (!made.length) throw new Error('No sheets with data were found in that file.');
      view.sheetId = made[0];
      setFlash(`Imported ${made.length} sheet${made.length === 1 ? '' : 's'} from ${file.name}.`);
      rerender();
    } catch (err) {
      showError(err);
    }
    e.target.value = '';
  });

  // ---- "Add ordered requests" -------------------------------------------------------
  async function addOrdered() {
    const sources = new Map(ctx.details.map(([k, , get]) => [k, get]));
    const linked = new Set(rows.map((r) => r.request_id).filter(Boolean));
    const ordered = (await api.listRequests(['Ordered', 'Received']))
      .filter((r) => !linked.has(r.id))
      .sort((a, b) => String(a.order?.order_date || a.created_at).localeCompare(String(b.order?.order_date || b.created_at)));
    if (!ordered.length) return alert('Every ordered request is already in this sheet.');
    if (!confirm(`Add ${ordered.length} ordered request${ordered.length === 1 ? '' : 's'} not yet in "${sheet.name}"?`)) return;
    const list = ordered.map((r) => ({
      request_id: r.id,
      data: Object.fromEntries(
        columns
          .filter((c) => c.fill && sources.has(c.fill))
          .map((c) => [c.key, String(sources.get(c.fill)(r) ?? '').trim()])
          .filter(([, v]) => v !== '')
      ),
    }));
    const added = await addRows(list);
    if (added.length) status.textContent = `Added ${added.length} row${added.length === 1 ? '' : 's'}.`;
  }

  draw();
}

// ---- Excel: download and import --------------------------------------------------------

async function download(sheet, columns, rows, values, running) {
  const ExcelJS = await loadExcelJS();
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheet.name.slice(0, 31).replace(/[\\/*?:[\]]/g, ' '), { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = columns.map((c) => ({ header: c.label, key: c.key, width: c.type === 'text' ? 28 : c.type === 'request' ? 14 : 16 }));
  for (const row of rows) {
    ws.addRow(
      Object.fromEntries(
        columns.map((c) => {
          const v = c.type === 'running' ? running.get(row.id)?.[c.key] : values.get(row.id)?.[c.key] ?? '';
          if (isNumeric(c)) return [c.key, v === '' || v === undefined ? null : toNumber(v)];
          if (c.type === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return [c.key, new Date(`${v}T00:00:00Z`)];
          return [c.key, v ?? ''];
        })
      )
    );
  }
  columns.forEach((c, i) => {
    const col = ws.getColumn(i + 1);
    if (isMoney(c)) col.numFmt = '"$"#,##0.00';
    if (c.type === 'date') col.numFmt = 'mm/dd/yyyy';
  });
  ws.getRow(1).eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0B2545' } };
  });
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: Math.max(1, columns.length) } };
  const blob = new Blob([await wb.xlsx.writeBuffer()], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${sheet.name.replace(/[^A-Za-z0-9_-]+/g, '_') || 'Finances'}_${new Date().toISOString().slice(0, 10)}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Each worksheet with data becomes a new sheet: first row with 2+ filled cells is the header. Returns the new ids. */
async function importWorkbook(file, startPosition) {
  const ExcelJS = await loadExcelJS();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await file.arrayBuffer());
  const made = [];
  const worksheets = [];
  wb.eachSheet((ws) => (ws.state === 'visible' || !ws.state) && worksheets.push(ws));
  for (const ws of worksheets) {
    const width = ws.columnCount;
    const read = (r) => Array.from({ length: width }, (_, c) => cellText(ws.getRow(r).getCell(c + 1).value));
    let headerRow = 0;
    for (let r = 1; r <= Math.min(15, ws.rowCount); r++) {
      if (read(r).filter(Boolean).length >= 2) {
        headerRow = r;
        break;
      }
    }
    if (!headerRow) continue;
    const headers = read(headerRow);
    const body = [];
    for (let r = headerRow + 1; r <= ws.rowCount; r++) {
      const cells = read(r);
      if (cells.some(Boolean)) body.push(cells);
    }
    const used = headers.map((h, i) => (h || body.some((b) => b[i]) ? i : -1)).filter((i) => i >= 0);
    if (!used.length) continue;
    const seen = new Map();
    const columns = used.map((i) => {
      let label = (headers[i] || `Column ${i + 1}`).replace(/\s+/g, ' ').trim().slice(0, 60);
      const n = (seen.get(label) || 0) + 1;
      seen.set(label, n);
      if (n > 1) label = `${label} (${n})`;
      const values = body.map((b) => b[i]).filter(Boolean);
      return { key: newKey(), label, type: guessType(label, values), _i: i };
    });
    for (const c of columns) if (c.type === 'money') c.sum = true;
    const clean = columns.map(({ _i, ...c }) => c);
    const id = await api.saveFinanceSheet(null, (ws.name || 'Imported').slice(0, 60), clean, startPosition + made.length);
    const rows = body.map((cells) => ({
      data: Object.fromEntries(
        columns
          .map((c) => {
            let v = cells[c._i] || '';
            if (PLAIN_NUMERIC.has(c.type) && v) v = c.type === 'money' ? toNumber(v).toFixed(2) : String(toNumber(v));
            if (c.type === 'checkbox') v = /^(yes|y|true|x|✓|1)$/i.test(v) ? 'Yes' : '';
            return [c.key, v];
          })
          .filter(([, v]) => v !== '')
      ),
    }));
    for (let i = 0; i < rows.length; i += 1000) await api.addFinanceRows(id, rows.slice(i, i + 1000));
    made.push(id);
  }
  return made;
}

/** A column's type from its name and values. */
function guessType(label, values) {
  if (!values.length) return 'text';
  const all = (re) => values.every((v) => re.test(String(v).trim()));
  if (all(/^\d{4}-\d{2}-\d{2}$/)) return 'date';
  if (all(/^(yes|no|y|n|true|false|x|✓)$/i)) return 'checkbox';
  if (all(/^-?\(?\$?\s?-?[\d,]*\.?\d+\)?$/)) {
    return /amount|cost|price|total|balance|paid|debit|credit|charge|budget|spent|deposit|refund|\$/i.test(label) || values.some((v) => /\$/.test(v)) ? 'money' : 'number';
  }
  if (all(/^https?:\/\//i)) return 'link';
  return 'text';
}
