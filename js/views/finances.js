/**
 * Finances (#/finances): spreadsheet-like sheets the Treasurer shapes himself
 * (migration 014). Each sheet has its own columns (text, number, money, date,
 * dropdown, checkbox, link, request, running total); cells save as you leave them.
 *
 * Also: a totals row, search, sorting (with "Keep this order"), "Add ordered
 * requests" (fills columns from requests), Excel import (each worksheet becomes a
 * sheet) and Excel download. Viewing needs finances.view; changing, finances.edit.
 */
import { api } from '../api.js';
import { auth } from '../auth.js';
import { esc, fmtMoney, fmtDate, errorBox, setFlash, takeFlash } from '../ui.js';
import { requestFields } from '../formFields.js';
import { loadExcelJS } from '../excel.js';
import { cellText } from '../sheetImport.js';

export const COLUMN_TYPES = [
  ['text', 'Text'],
  ['money', 'Money ($)'],
  ['number', 'Number'],
  ['date', 'Date'],
  ['select', 'Dropdown'],
  ['checkbox', 'Checkbox'],
  ['link', 'Link'],
  ['request', 'Request (SG number)'],
  ['running', 'Running total'],
];
const NUMERIC = new Set(['money', 'number']);

/** What "Add ordered requests" can put in a column. Request fields (e.g. Cost center) are added per form. */
const FILL_BASE = [
  ['request', 'Request ID', (r) => r.request_number],
  ['title', 'Request title', (r) => r.title],
  ['requester', 'Requester', (r) => r.requester],
  ['vendor', 'Vendor', (r) => r.vendors.join(', ')],
  ['total', 'Request total', (r) => Number(r.total || 0).toFixed(2)],
  ['shipping', 'Shipping', (r) => (r.shipping ? Number(r.shipping).toFixed(2) : '')],
  ['ticket', 'Ticket #', (r) => r.order?.department_order_number],
  ['order_date', 'Order date', (r) => String(r.order?.order_date || '').slice(0, 10)],
  ['received_date', 'Received date', (r) => String(r.order?.received_date || '').slice(0, 10)],
  ['status', 'Status', (r) => r.status],
  ['season', 'Season', (r) => r.season],
];
const fillSources = (config) => [
  ...FILL_BASE,
  ...requestFields(config)
    .filter((f) => f.type !== 'section' && !['title', 'requester'].includes(f.key))
    .map((f) => [`field:${f.key}`, f.label, (r) => r[f.key] ?? r.data?.[f.key]]),
];

// Kept while moving around the app.
const view = { sheetId: null, q: '', sort: null };

const newKey = () => `f_${Math.random().toString(36).slice(2, 9)}`;
/** '$1,234.50' → 1234.5; accounting-style '(12.50)' → -12.5; anything else → 0. */
const toNumber = (v) => {
  const s = String(v ?? '').trim();
  const n = Number(s.replace(/[$,\s()]/g, ''));
  return Number.isFinite(n) ? (/^\(.*\)$/.test(s) ? -n : n) : 0;
};

export async function renderFinances(el, { config, rerender }) {
  const canEdit = auth.can('finances.edit');
  let sheets;
  try {
    sheets = await api.listFinanceSheets();
  } catch {
    el.innerHTML = `<div class="page-header"><div><h1>Finances</h1></div></div>
      <div class="alert alert-info">The Finances tab needs database update <code>014_finances.sql</code>.</div>`;
    return;
  }

  if (!sheets.length) {
    el.innerHTML = `${takeFlash()}<div class="page-header"><div><h1>Finances</h1></div></div>
      <div class="empty"><p>No sheets yet.</p>${canEdit ? '<button type="button" class="btn btn-primary" id="first-sheet">+ New sheet</button>' : ''}</div>`;
    el.querySelector('#first-sheet')?.addEventListener('click', () => newSheet(sheets, rerender));
    return;
  }
  if (!sheets.some((s) => s.id === view.sheetId)) view.sheetId = sheets[0].id;
  const sheet = sheets.find((s) => s.id === view.sheetId);
  const columns = sheet.columns || [];
  let rows = await api.listFinanceRows(sheet.id);
  if (view.sort && !columns.some((c) => c.key === view.sort.key)) view.sort = null;

  // Requests, for the Request column (titles, links, suggestions).
  const needsRequests = columns.some((c) => c.type === 'request');
  const requests = needsRequests ? await api.listRequests(null).catch(() => []) : [];
  const byNumber = new Map(requests.map((r) => [r.request_number, r]));
  const hasFill = columns.some((c) => c.fill);

  el.innerHTML = `
    ${takeFlash()}
    <div class="page-header">
      <div>
        <h1>Finances</h1>
        <p class="subtitle">${canEdit
          ? 'Your own sheets: add columns and rows, and changes save as you go.'
          : 'View only. The Treasurer keeps these sheets.'}</p>
      </div>
      <div class="card-actions">
        ${canEdit && hasFill ? '<button type="button" class="btn" id="add-ordered">Add ordered requests</button>' : ''}
        <button type="button" class="btn" id="download">Download .xlsx</button>
      </div>
    </div>

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
        ${canEdit ? '<button type="button" class="btn btn-sm" id="edit-columns">Columns &amp; sheet</button>' : ''}
      </span>
    </div>

    <div class="table-wrap sheet-wrap">
      <table class="table sheet-table">
        <thead><tr>
          <th class="sheet-idx">#</th>
          ${columns.map((c) => `<th class="${NUMERIC.has(c.type) || c.type === 'running' ? 'num' : ''} t-${esc(c.type)}">
            <button type="button" class="sort-btn" data-sort="${esc(c.key)}">${esc(c.label)}<span class="sort-ind" aria-hidden="true">${
              view.sort?.key === c.key ? (view.sort.dir === 'desc' ? '▼' : '▲') : '↕'}</span></button></th>`).join('')}
          ${canEdit ? '<th class="sheet-del"></th>' : ''}
        </tr></thead>
        <tbody id="sheet-body"></tbody>
        <tfoot id="sheet-foot"></tfoot>
      </table>
    </div>
    ${canEdit ? '<div class="add-row"><button type="button" class="btn btn-sm" id="add-row">+ Add row</button><span class="hint hide-touch">Enter moves down a row; Tab moves right.</span></div>' : ''}
    ${needsRequests ? `<datalist id="request-numbers">${requests.map((r) => `<option value="${esc(r.request_number)}">${esc(r.title || '')}</option>`).join('')}</datalist>` : ''}`;

  const errors = el.querySelector('#fin-errors');
  const status = el.querySelector('#fin-status');
  const showError = (err) => {
    errors.innerHTML = errorBox(err);
    status.textContent = '';
  };

  // ---- rows: filter, sort, draw -----------------------------------------------------
  const textOf = (row) => Object.values(row.data || {}).join(' ').toLowerCase();
  const shownRows = () => {
    const words = view.q.toLowerCase().split(/\s+/).filter(Boolean);
    let list = rows.filter((r) => words.every((w) => textOf(r).includes(w)));
    if (view.sort) {
      const col = columns.find((c) => c.key === view.sort.key);
      const dir = view.sort.dir === 'desc' ? -1 : 1;
      const val = (r) => (NUMERIC.has(col.type) ? toNumber(r.data[col.key]) : String(r.data[col.key] ?? ''));
      list = [...list].sort((a, b) => {
        const x = a.data[col.key] ?? '';
        const y = b.data[col.key] ?? '';
        if (x === '' || y === '') return x === y ? 0 : x === '' ? 1 : -1; // blanks last
        const [p, q] = [val(a), val(b)];
        return (typeof p === 'number' ? p - q : p.localeCompare(q, undefined, { numeric: true, sensitivity: 'base' })) * dir;
      });
    }
    return list;
  };

  const cell = (row, c) => {
    const v = row.data?.[c.key] ?? '';
    const attrs = `data-row="${esc(row.id)}" data-key="${esc(c.key)}" aria-label="${esc(c.label)}"`;
    if (c.type === 'running') return `<td class="num" data-running="${esc(c.key)}" data-row-id="${esc(row.id)}"></td>`;
    if (!canEdit) {
      const shown =
        c.type === 'money' ? (v === '' ? '' : fmtMoney(toNumber(v)))
        : c.type === 'date' ? (v ? fmtDate(v) : '')
        : c.type === 'checkbox' ? (v ? '✓' : '')
        : c.type === 'link' && v ? `<a href="${esc(v)}" target="_blank" rel="noopener">${esc(v)}</a>`
        : c.type === 'request' && v ? `<a href="#/requests/${esc(v)}" title="${esc(byNumber.get(v)?.title || '')}">${esc(v)}</a>`
        : esc(v);
      return `<td class="${NUMERIC.has(c.type) ? 'num' : ''}">${shown}</td>`;
    }
    let input;
    if (c.type === 'checkbox') input = `<input type="checkbox" ${attrs} ${v ? 'checked' : ''}>`;
    else if (c.type === 'select') {
      const opts = [...new Set([...(c.options || []), ...(v ? [v] : [])])];
      input = `<select ${attrs}><option value=""></option>${opts.map((o) => `<option ${o === v ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
    } else if (c.type === 'date') input = `<input type="date" ${attrs} value="${esc(v)}">`;
    else if (NUMERIC.has(c.type)) input = `<input type="text" inputmode="decimal" ${attrs} value="${esc(c.type === 'money' && v !== '' ? toNumber(v).toFixed(2) : v)}" ${c.type === 'money' ? 'placeholder="$"' : ''}>`;
    else if (c.type === 'request') {
      const r = byNumber.get(v);
      input = `<span class="cell-with-link"><input type="text" list="request-numbers" ${attrs} value="${esc(v)}" placeholder="SG-…">${
        r ? `<a href="#/requests/${esc(v)}" title="${esc(r.title || '')}" aria-label="Open ${esc(v)}">↗</a>` : ''}</span>`;
    } else if (c.type === 'link') {
      input = `<span class="cell-with-link"><input type="url" ${attrs} value="${esc(v)}">${
        /^https?:\/\//i.test(v) ? `<a href="${esc(v)}" target="_blank" rel="noopener" aria-label="Open link">↗</a>` : ''}</span>`;
    } else input = `<input type="text" ${attrs} value="${esc(v)}">`;
    return `<td class="${NUMERIC.has(c.type) ? 'num' : ''} t-${esc(c.type)}">${input}</td>`;
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
    computed(list);
  };

  /** Running totals and the totals row (over the rows shown, in the order shown). */
  const computed = (list = shownRows()) => {
    for (const c of columns.filter((x) => x.type === 'running')) {
      let sum = 0;
      for (const row of list) {
        sum += toNumber(row.data[c.of]);
        const td = el.querySelector(`[data-running="${CSS.escape(c.key)}"][data-row-id="${CSS.escape(row.id)}"]`);
        if (td) td.textContent = fmtMoney(sum);
      }
    }
    const any = columns.some((c) => c.sum || c.type === 'running');
    el.querySelector('#sheet-foot').innerHTML = any
      ? `<tr><td class="sheet-idx"><strong>Σ</strong></td>${columns
          .map((c) => {
            if (c.type === 'running') return `<td class="num"><strong>${fmtMoney(list.reduce((s, r) => s + toNumber(r.data[c.of]), 0))}</strong></td>`;
            if (!c.sum) return '<td></td>';
            const total = list.reduce((s, r) => s + toNumber(r.data[c.key]), 0);
            return `<td class="num"><strong>${c.type === 'money' ? fmtMoney(total) : Number(total.toFixed(6))}</strong></td>`;
          })
          .join('')}${canEdit ? '<td></td>' : ''}</tr>`
      : '';
  };

  // ---- saving cells ---------------------------------------------------------------
  let pending = 0;
  const save = async (input) => {
    const row = rows.find((r) => r.id === input.dataset.row);
    const col = columns.find((c) => c.key === input.dataset.key);
    if (!row || !col) return;
    let value = input.type === 'checkbox' ? (input.checked ? 'Yes' : '') : input.value.trim();
    if (NUMERIC.has(col.type) && value !== '') {
      // Accepts 1234.5, $1,234.50, -5 and accounting-style (12.50).
      const n = /^-?\(?-?\$?\s?[\d,]*\.?\d+\)?$/.test(value) ? toNumber(value) : NaN;
      if (!Number.isFinite(n)) {
        input.classList.add('is-invalid');
        status.textContent = `"${value}" isn't a number.`;
        return;
      }
      value = col.type === 'money' ? n.toFixed(2) : String(n);
      input.value = value;
    }
    input.classList.remove('is-invalid');
    if ((row.data[col.key] ?? '') === value) return;
    const before = row.data[col.key];
    if (value === '') delete row.data[col.key];
    else row.data[col.key] = value;
    computed();
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
      showError(err);
    }
    // A request number that changed gets its ↗ link.
    if (col.type === 'request' || col.type === 'link') {
      const td = input.closest('td');
      const tr = input.closest('tr');
      const focusKey = document.activeElement?.dataset?.key;
      td.outerHTML = cell(row, col);
      if (focusKey && focusKey !== col.key) tr.querySelector(`[data-key="${CSS.escape(focusKey)}"]`)?.focus();
    }
  };

  el.addEventListener('change', (e) => {
    if (e.target.matches('[data-row][data-key]')) save(e.target);
  });

  // Enter: down to the same column in the next row (adds a row at the bottom).
  el.addEventListener('keydown', async (e) => {
    const input = e.target;
    if (e.key !== 'Enter' || !input.matches?.('input[data-row][data-key]')) return;
    e.preventDefault();
    input.blur(); // saves
    const tr = input.closest('tr');
    let next = tr.nextElementSibling;
    if (!next && canEdit) {
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
      draw();
      return added;
    } catch (err) {
      showError(err);
      return [];
    }
  };

  // ---- clicks ---------------------------------------------------------------------
  el.addEventListener('click', async (e) => {
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
      const first = columns.find((c) => c.type !== 'running');
      if (row && first) el.querySelector(`[data-row="${CSS.escape(row.id)}"][data-key="${CSS.escape(first.key)}"]`)?.focus();
      return;
    }
    if (btn.dataset.deleteRow) {
      if (!confirm('Delete this row? This can\'t be undone.')) return;
      try {
        await api.deleteFinanceRows([btn.dataset.deleteRow]);
        rows = rows.filter((r) => r.id !== btn.dataset.deleteRow);
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
        rows.sort((a, b) => a.position - b.position);
        view.sort = null;
        setFlash('Row order saved.');
        return rerender();
      } catch (err) {
        showError(err);
        btn.disabled = false;
      }
      return;
    }
    if (btn.id === 'new-sheet') return newSheet(sheets, rerender);
    if (btn.id === 'edit-columns') return openColumns();
    if (btn.id === 'download') return download(sheet, columns, shownRows(), byNumber).catch(showError);
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
    const sources = new Map(fillSources(config).map(([k, , get]) => [k, get]));
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

  // ---- Columns & sheet editor ---------------------------------------------------------
  function openColumns() {
    const box = el.querySelector('#columns-editor');
    const state = { name: sheet.name, columns: structuredClone(columns) };
    const sources = fillSources(config);
    const numericCols = () => state.columns.filter((c) => NUMERIC.has(c.type));
    const drawEditor = () => {
      box.innerHTML = `<section class="card columns-editor">
        <div class="card-head"><h2>Columns &amp; sheet</h2></div>
        <div class="field"><label for="sheet-name">Sheet name</label>
          <input id="sheet-name" type="text" maxlength="60" value="${esc(state.name)}"></div>
        <div class="table-wrap flat"><table class="table stack-mobile col-table">
          <thead><tr><th>Order</th><th>Name</th><th>Type</th><th>Settings</th><th>Fill from request</th><th></th></tr></thead>
          <tbody>${state.columns
            .map(
              (c, i) => `<tr data-i="${i}">
                <td class="move" data-label="Order">
                  <button type="button" class="icon-btn" data-col-move="-1" aria-label="Move ${esc(c.label)} left" ${i === 0 ? 'disabled' : ''}>←</button>
                  <button type="button" class="icon-btn" data-col-move="1" aria-label="Move ${esc(c.label)} right" ${i === state.columns.length - 1 ? 'disabled' : ''}>→</button></td>
                <td class="cell-primary" data-label=""><input type="text" data-col="label" value="${esc(c.label)}" maxlength="60" aria-label="Column name"></td>
                <td data-label="Type"><select data-col="type" aria-label="Type of ${esc(c.label)}">${COLUMN_TYPES.map(([k, l]) => `<option value="${k}" ${k === c.type ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></td>
                <td data-label="Settings">${
                  c.type === 'select'
                    ? `<textarea data-col="options" rows="2" placeholder="One option per line" aria-label="Options for ${esc(c.label)}">${esc((c.options || []).join('\n'))}</textarea>`
                    : NUMERIC.has(c.type)
                      ? `<label class="inline-check"><input type="checkbox" data-col="sum" ${c.sum ? 'checked' : ''}> Total at the bottom</label>`
                      : c.type === 'running'
                        ? `<select data-col="of" aria-label="Running total of">${numericCols().length ? '' : '<option value="">Add a Money column first</option>'}${numericCols()
                            .map((x) => `<option value="${esc(x.key)}" ${x.key === c.of ? 'selected' : ''}>of ${esc(x.label)}</option>`)
                            .join('')}</select>`
                        : '<span class="muted small">—</span>'
                }</td>
                <td data-label="Fill from request">${
                  c.type === 'running'
                    ? '<span class="muted small">—</span>'
                    : `<select data-col="fill" aria-label="Fill ${esc(c.label)} from"><option value="">Nothing</option>${sources
                        .map(([k, l]) => `<option value="${esc(k)}" ${k === c.fill ? 'selected' : ''}>${esc(l)}</option>`)
                        .join('')}</select>`
                }</td>
                <td data-label=""><button type="button" class="icon-btn" data-col-delete aria-label="Delete column ${esc(c.label)}" title="Delete column">&times;</button></td>
              </tr>`
            )
            .join('')}</tbody>
        </table></div>
        <button type="button" class="btn btn-sm" id="col-add">+ Add column</button>
        <p class="hint">"Fill from request" is what <strong>Add ordered requests</strong> puts in that column. Deleting a column hides its data; it isn't shown or exported anymore.</p>
        <div id="col-errors"></div>
        <div class="form-actions">
          <button type="button" class="btn btn-danger reset-btn" id="sheet-delete">Delete this sheet</button>
          <button type="button" class="btn btn-ghost" id="col-cancel">Cancel</button>
          <button type="button" class="btn btn-primary" id="col-save">Save columns</button>
        </div>
      </section>`;
    };
    drawEditor();
    el.querySelector('#edit-columns').hidden = true;
    box.scrollIntoView({ behavior: 'smooth', block: 'start' });

    const colOf = (node) => state.columns[Number(node.closest('tr[data-i]')?.dataset.i)];
    box.addEventListener('input', (e) => {
      if (e.target.id === 'sheet-name') state.name = e.target.value;
      const c = colOf(e.target);
      if (!c) return;
      if (e.target.dataset.col === 'label') c.label = e.target.value;
      if (e.target.dataset.col === 'options') c.options = e.target.value.split('\n').map((s) => s.trim()).filter(Boolean);
    });
    box.addEventListener('change', (e) => {
      const c = colOf(e.target);
      if (!c) return;
      const prop = e.target.dataset.col;
      if (prop === 'type') {
        c.type = e.target.value;
        if (c.type === 'running') {
          c.of = numericCols().find((x) => x !== c)?.key;
          delete c.fill;
        }
        drawEditor();
      } else if (prop === 'sum') c.sum = e.target.checked;
      else if (prop === 'of') c.of = e.target.value;
      else if (prop === 'fill') {
        if (e.target.value) c.fill = e.target.value;
        else delete c.fill;
      }
    });
    box.addEventListener('click', async (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      const tr = btn.closest('tr[data-i]');
      const i = tr ? Number(tr.dataset.i) : -1;
      if (btn.dataset.colMove) {
        const to = i + Number(btn.dataset.colMove);
        [state.columns[i], state.columns[to]] = [state.columns[to], state.columns[i]];
        drawEditor();
      } else if (btn.hasAttribute('data-col-delete')) {
        if (!confirm(`Delete the column "${state.columns[i].label}"?`)) return;
        state.columns.splice(i, 1);
        drawEditor();
      } else if (btn.id === 'col-add') {
        state.columns.push({ key: newKey(), label: 'New column', type: 'text' });
        drawEditor();
        const inputs = box.querySelectorAll('[data-col="label"]');
        inputs[inputs.length - 1]?.select();
      } else if (btn.id === 'col-cancel') {
        box.innerHTML = '';
        el.querySelector('#edit-columns').hidden = false;
      } else if (btn.id === 'sheet-delete') {
        if (!confirm(`Delete the sheet "${sheet.name}" and all ${rows.length} of its rows? This can't be undone. (Download it first if you might need it.)`)) return;
        try {
          await api.deleteFinanceSheet(sheet.id);
          view.sheetId = null;
          setFlash(`Deleted "${sheet.name}".`);
          rerender();
        } catch (err) {
          box.querySelector('#col-errors').innerHTML = errorBox(err);
        }
      } else if (btn.id === 'col-save') {
        const problems = [];
        if (!state.name.trim()) problems.push('Give the sheet a name.');
        state.columns.forEach((c) => {
          c.label = (c.label || '').trim();
          if (!c.label) problems.push('Every column needs a name.');
          if (c.type === 'running' && !c.of) problems.push(`"${c.label}": choose which Money or Number column it adds up.`);
          if (c.type !== 'select') delete c.options;
          if (!NUMERIC.has(c.type)) delete c.sum;
          if (c.type !== 'running') delete c.of;
        });
        if (problems.length) {
          box.querySelector('#col-errors').innerHTML = errorBox(Object.assign(new Error('Please fix the following:'), { details: [...new Set(problems)] }));
          return;
        }
        btn.disabled = true;
        try {
          await api.saveFinanceSheet(sheet.id, state.name.trim(), state.columns);
          setFlash('Columns saved.');
          rerender();
        } catch (err) {
          box.querySelector('#col-errors').innerHTML = errorBox(err);
          btn.disabled = false;
        }
      }
    });
  }

  draw();
}

async function newSheet(sheets, rerender) {
  const name = prompt('Name of the new sheet (e.g. Reimbursements, Sponsorships):', '')?.trim();
  if (!name) return;
  try {
    view.sheetId = await api.saveFinanceSheet(null, name.slice(0, 60), [
      { key: newKey(), label: 'Date', type: 'date' },
      { key: newKey(), label: 'Description', type: 'text' },
      { key: newKey(), label: 'Amount', type: 'money', sum: true },
      { key: newKey(), label: 'Notes', type: 'text' },
    ], sheets.length);
    setFlash(`Added "${name}". Use "Columns & sheet" to change its columns.`);
    rerender();
  } catch (err) {
    alert(err.message);
  }
}

// ---- Excel: download and import --------------------------------------------------------

async function download(sheet, columns, rows, byNumber) {
  const ExcelJS = await loadExcelJS();
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheet.name.slice(0, 31).replace(/[\\/*?:[\]]/g, ' '), { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = columns.map((c) => ({ header: c.label, key: c.key, width: c.type === 'text' ? 28 : c.type === 'request' ? 14 : 16 }));
  const running = Object.fromEntries(columns.filter((c) => c.type === 'running').map((c) => [c.key, 0]));
  for (const row of rows) {
    ws.addRow(
      Object.fromEntries(
        columns.map((c) => {
          const v = row.data[c.key] ?? '';
          if (c.type === 'running') return [c.key, (running[c.key] += toNumber(row.data[c.of]))];
          if (NUMERIC.has(c.type)) return [c.key, v === '' ? null : toNumber(v)];
          if (c.type === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return [c.key, new Date(`${v}T00:00:00Z`)];
          if (c.type === 'request' && v && byNumber.get(v)) return [c.key, v];
          return [c.key, v];
        })
      )
    );
  }
  columns.forEach((c, i) => {
    const col = ws.getColumn(i + 1);
    if (c.type === 'money' || c.type === 'running') col.numFmt = '"$"#,##0.00';
    if (c.type === 'date') col.numFmt = 'mm/dd/yyyy';
  });
  const header = ws.getRow(1);
  header.eachCell((cell) => {
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
            if (NUMERIC.has(c.type) && v) v = c.type === 'money' ? toNumber(v).toFixed(2) : String(toNumber(v));
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
export function guessType(label, values) {
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
