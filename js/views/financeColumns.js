/**
 * Finances: the "Columns & sheet" editor and the new-sheet templates.
 * Calculated columns are set up with menus that read like a sentence
 * ("Add up Amount in Income, where Type is Sponsorship"), never typed formulas.
 * See js/financeCalc.js for what each type does.
 */
import { api } from '../api.js';
import { esc, errorBox, setFlash } from '../ui.js';
import { requestFields, fieldOptions } from '../formFields.js';
import { workflowSettings } from '../workflow.js';
import { ORDER_METRICS, PLAIN_NUMERIC, requestDetails, isNumeric, isCalc, checkColumns } from '../financeCalc.js';

export const COLUMN_TYPES = [
  ['Typed in', [
    ['text', 'Text'], ['money', 'Money ($)'], ['number', 'Number'], ['date', 'Date'], ['select', 'Dropdown'],
    ['checkbox', 'Checkbox'], ['link', 'Link'], ['request', 'Request (SG number)'],
  ]],
  ['Calculated', [
    ['budget', 'Budget (the site\'s budgets)'], ['orders', 'From orders'], ['lookup', 'Total from a sheet'],
    ['reqinfo', 'From the request'], ['math', 'Math (+ / −)'], ['running', 'Running total'],
  ]],
];
export const typeLabel = (t) => COLUMN_TYPES.flatMap((g) => g[1]).find((x) => x[0] === t)?.[1] || t;

export const newKey = () => `f_${Math.random().toString(36).slice(2, 9)}`;

/** Dropdowns on the request form whose list a column can use (e.g. Cost center). */
export const formDropdowns = (config) => requestFields(config).filter((f) => f.type === 'select');

/** A Dropdown column's options: its own list, or a form dropdown's current list. */
export function optionsOf(c, config) {
  if (c.source?.startsWith('form:')) {
    const f = formDropdowns(config).find((x) => x.key === c.source.slice(5));
    return f ? fieldOptions(f, config) : [];
  }
  return c.options || [];
}

/** The form field a column's values come from (a form-linked dropdown), if any. */
export const formFieldOf = (c) => (c?.source?.startsWith('form:') ? c.source.slice(5) : '');

/** Sensible settings when a column becomes a calculated type. */
function defaults(c, columns, sheets, sheetId) {
  const others = columns.filter((x) => x !== c);
  const formCol = others.find((x) => x.type === 'select' && formFieldOf(x));
  const matchCol = formCol || others.find((x) => x.type === 'select' || x.type === 'text');
  if (c.type === 'budget') Object.assign(c, { by: matchCol?.key, sum: true });
  if (c.type === 'orders') Object.assign(c, { metric: 'spent', season: 'current', by: formCol?.key, field: formFieldOf(formCol), sum: true });
  if (c.type === 'lookup') {
    const target = sheets.find((s) => s.id !== sheetId && (s.columns || []).some((x) => x.type === 'money')) || sheets.find((s) => s.id === sheetId);
    const cols = target?.id === sheetId ? columns : target?.columns || [];
    Object.assign(c, { sheet: target?.id, col: cols.find((x) => PLAIN_NUMERIC.has(x.type) && x !== c)?.key, sum: true });
  }
  if (c.type === 'reqinfo') Object.assign(c, { req: others.find((x) => x.type === 'request')?.key, detail: 'total' });
  if (c.type === 'math') Object.assign(c, { terms: others.filter((x) => isNumeric(x) && !['math', 'running'].includes(x.type)).slice(0, 1).map((x) => ({ op: '+', col: x.key })), sum: true });
  if (c.type === 'running') Object.assign(c, { of: others.find((x) => isNumeric(x) && x.type !== 'running')?.key });
}

/** Drop settings that don't belong to the column's type (kept tidy in the database). */
function tidy(c) {
  const keep = {
    select: ['options', 'source'], money: ['sum'], number: ['sum'], budget: ['by', 'sum'],
    orders: ['metric', 'season', 'by', 'field', 'sum'], lookup: ['sheet', 'col', 'match', 'where', 'sum'],
    reqinfo: ['req', 'detail'], math: ['terms', 'sum'], running: ['of'],
  }[c.type] || [];
  const out = { key: c.key, label: c.label.trim(), type: c.type };
  for (const k of keep) if (c[k] !== undefined && c[k] !== '' && c[k] !== false) out[k] = c[k];
  if (c.source && c.type === 'select') delete out.options;
  if (!isCalc(c) && c.fill) out.fill = c.fill;
  return out;
}

/**
 * Open the editor in `box`. `sheets` is every sheet (for lookups); `onDone()` closes it.
 */
export function openColumnEditor(box, { sheet, sheets, rowsCount, config, onDone, rerender, setView }) {
  const state = { name: sheet.name, columns: structuredClone(sheet.columns || []) };
  const details = requestDetails(requestFields(config));
  const dropdowns = formDropdowns(config);
  const budgets = workflowSettings(config).budgets;
  const sheetCols = (id) => (id === sheet.id ? state.columns : sheets.find((s) => s.id === id)?.columns || []);
  const opt = (value, label, current) => `<option value="${esc(value)}" ${String(value) === String(current ?? '') ? 'selected' : ''}>${esc(label)}</option>`;
  const colOptions = (list, current, empty) => `${empty ? opt('', empty, current) : ''}${list.map((x) => opt(x.key, x.label || '(no name)', current)).join('')}`;
  const sumBox = (c) => `<label class="inline-check"><input type="checkbox" data-set="sum" ${c.sum ? 'checked' : ''}> Total at the bottom</label>`;

  const settings = (c) => {
    const others = state.columns.filter((x) => x !== c);
    switch (c.type) {
      case 'select':
        return `<span>Options:</span>
          <select data-set="source">${opt('', 'My own list', c.source)}${dropdowns.map((f) => opt(`form:${f.key}`, `The form's ${f.label} list`, c.source)).join('')}</select>
          ${c.source ? `<span class="muted small">${esc(optionsOf(c, config).join(', ') || 'none yet')}</span>`
            : `<textarea data-set="options" rows="2" placeholder="One option per line">${esc((c.options || []).join('\n'))}</textarea>`}`;
      case 'money':
      case 'number':
        return sumBox(c);
      case 'budget':
        return `<span>The site's budget for this row's</span>
          <select data-set="by">${colOptions(others.filter((x) => ['select', 'text'].includes(x.type)), c.by, 'Choose a column')}</select>
          ${sumBox(c)}
          <span class="hint">Same numbers as the Treasurer page${budgets.field ? `, set per ${esc(dropdowns.find((f) => f.key === budgets.field)?.label || budgets.field)}` : ''}. You can type a budget straight into this column.</span>`;
      case 'orders': {
        const perRow = !!c.by;
        return `<span>Add up requests that are</span>
          <select data-set="metric">${ORDER_METRICS.map(([k, l]) => opt(k, l.toLowerCase(), c.metric)).join('')}</select>
          <select data-set="season">${opt('current', 'this season', c.season)}${opt('all', 'in every season', c.season)}</select>
          <span>for</span>
          <select data-set="ordersfor">${opt('team', 'the whole team', perRow ? 'row' : 'team')}${opt('row', "each row's…", perRow ? 'row' : 'team')}</select>
          ${perRow ? `<select data-set="by">${colOptions(others.filter((x) => ['select', 'text'].includes(x.type)), c.by)}</select>
            <span>matched to the request form's</span>
            <select data-set="field">${opt('', 'Choose a field', c.field)}${requestFields(config).filter((f) => f.type !== 'section').map((f) => opt(f.key, f.label, c.field)).join('')}</select>` : ''}
          ${sumBox(c)}`;
      }
      case 'lookup': {
        const theirs = sheetCols(c.sheet);
        const perRow = !!c.match;
        return `<span>Add up</span>
          <select data-set="col">${colOptions(theirs.filter((x) => PLAIN_NUMERIC.has(x.type) && x !== c), c.col, 'Choose a Money column')}</select>
          <span>in</span>
          <select data-set="sheet">${sheets.map((s) => opt(s.id, s.id === sheet.id ? `${state.name} (this sheet)` : s.name, c.sheet)).join('')}</select>
          <span>for</span>
          <select data-set="matchmode">${opt('all', 'every row', perRow ? 'row' : 'all')}${opt('row', 'rows that match', perRow ? 'row' : 'all')}</select>
          ${perRow ? `<span>where its</span><select data-set="match.theirs">${colOptions(theirs, c.match.theirs, 'Choose')}</select>
            <span>is this row's</span><select data-set="match.mine">${colOptions(others, c.match.mine, 'Choose')}</select>` : ''}
          <span>· only where</span>
          <select data-set="where.col">${colOptions(theirs, c.where?.col, '(any row)')}</select>
          ${c.where?.col ? `<span>is</span><input type="text" data-set="where.value" value="${esc(c.where.value || '')}" placeholder="e.g. Sponsorship">` : ''}
          ${sumBox(c)}`;
      }
      case 'reqinfo':
        return `<span>Show the</span>
          <select data-set="detail">${details.map(([k, l]) => opt(k, l, c.detail)).join('')}</select>
          <span>of the request in</span>
          <select data-set="req">${colOptions(others.filter((x) => x.type === 'request'), c.req, 'Add a Request column first')}</select>`;
      case 'math': {
        const usable = others.filter((x) => isNumeric(x) && !['math', 'running'].includes(x.type));
        return `${(c.terms || [])
          .map((t, i) => `<span class="math-term">
              ${i === 0 ? '<span class="muted">=</span>' : `<select data-term-op="${i}" aria-label="Plus or minus">${opt('+', '+', t.op)}${opt('-', '−', t.op)}</select>`}
              <select data-term-col="${i}">${colOptions(usable, t.col, 'Choose')}</select>
              <button type="button" class="icon-btn" data-term-del="${i}" aria-label="Remove">&times;</button></span>`)
          .join('')}
          <button type="button" class="btn btn-sm" data-term-add>+ Column</button>
          ${sumBox(c)}
          ${usable.length ? '' : '<span class="hint">Add Money, Budget, From orders or Total-from-a-sheet columns first.</span>'}`;
      }
      case 'running':
        return `<span>Add up</span>
          <select data-set="of">${colOptions(others.filter((x) => isNumeric(x) && x.type !== 'running'), c.of, 'Choose a column')}</select>
          <span>row by row, in the order shown</span>`;
      default:
        return '';
    }
  };

  const draw = () => {
    box.innerHTML = `<section class="card columns-editor">
      <div class="card-head"><h2>Columns &amp; sheet</h2></div>
      <div class="field sheet-name-field"><label for="sheet-name">Sheet name</label>
        <input id="sheet-name" type="text" maxlength="60" value="${esc(state.name)}"></div>
      <ol class="col-list">${state.columns
        .map(
          (c, i) => `<li data-i="${i}" class="${isCalc(c) ? 'is-calc-col' : ''}">
            <div class="col-main">
              <span class="col-move">
                <button type="button" class="icon-btn" data-col-move="-1" aria-label="Move ${esc(c.label)} left" ${i === 0 ? 'disabled' : ''}>←</button>
                <button type="button" class="icon-btn" data-col-move="1" aria-label="Move ${esc(c.label)} right" ${i === state.columns.length - 1 ? 'disabled' : ''}>→</button>
              </span>
              <input type="text" data-set="label" value="${esc(c.label)}" maxlength="60" aria-label="Column name">
              <select data-set="type" aria-label="Type of ${esc(c.label)}">${COLUMN_TYPES.map(([g, list]) => `<optgroup label="${esc(g)}">${list.map(([k, l]) => opt(k, l, c.type)).join('')}</optgroup>`).join('')}</select>
              ${isCalc(c) ? '' : `<label class="col-fill"><span class="muted small">Fill from request</span>
                <select data-set="fill">${opt('', 'Nothing', c.fill)}${details.map(([k, l]) => opt(k, l, c.fill)).join('')}</select></label>`}
              <button type="button" class="icon-btn col-del" data-col-delete aria-label="Delete column ${esc(c.label)}" title="Delete column">&times;</button>
            </div>
            ${settings(c) ? `<div class="col-settings">${settings(c)}</div>` : ''}
          </li>`
        )
        .join('')}</ol>
      <button type="button" class="btn btn-sm" id="col-add">+ Add column</button>
      <p class="hint"><strong>Calculated</strong> columns fill themselves in, and you can click any of their cells to see what was added up.
        "Fill from request" is what <strong>Add ordered requests</strong> copies into a column. Deleting a column hides its data.</p>
      <div id="col-errors"></div>
      <div class="form-actions">
        <button type="button" class="btn btn-danger reset-btn" id="sheet-delete">Delete this sheet</button>
        <button type="button" class="btn btn-ghost" id="col-cancel">Cancel</button>
        <button type="button" class="btn btn-primary" id="col-save">Save columns</button>
      </div>
    </section>`;
  };

  const colOf = (node) => state.columns[Number(node.closest('li[data-i]')?.dataset.i)];
  const setPath = (c, path, value) => {
    const [a, b] = path.split('.');
    if (b) {
      c[a] = { ...(c[a] || {}) };
      if (value === '') delete c[a][b];
      else c[a][b] = value;
      if (!Object.keys(c[a]).length) delete c[a];
    } else if (value === '' || value === false) delete c[a];
    else c[a] = value;
  };

  box.addEventListener('input', (e) => {
    if (e.target.id === 'sheet-name') state.name = e.target.value;
    const c = colOf(e.target);
    const key = e.target.dataset.set;
    if (!c || !key) return;
    if (key === 'label') c.label = e.target.value;
    if (key === 'options') c.options = e.target.value.split('\n').map((s) => s.trim()).filter(Boolean);
    if (key === 'where.value') setPath(c, key, e.target.value);
  });

  box.addEventListener('change', (e) => {
    const c = colOf(e.target);
    if (!c) return;
    const t = e.target;
    const key = t.dataset.set;
    if (t.dataset.termOp !== undefined) c.terms[Number(t.dataset.termOp)].op = t.value;
    else if (t.dataset.termCol !== undefined) c.terms[Number(t.dataset.termCol)].col = t.value;
    else if (key === 'type') {
      c.type = t.value;
      defaults(c, state.columns, sheets, sheet.id);
    } else if (key === 'ordersfor') {
      if (t.value === 'team') {
        delete c.by;
        delete c.field;
      } else {
        const formCol = state.columns.find((x) => x !== c && x.type === 'select' && formFieldOf(x)) || state.columns.find((x) => x !== c && ['select', 'text'].includes(x.type));
        c.by = formCol?.key;
        c.field = formFieldOf(formCol);
      }
    } else if (key === 'by' && c.type === 'orders') {
      c.by = t.value;
      c.field = formFieldOf(state.columns.find((x) => x.key === t.value)) || c.field;
    } else if (key === 'matchmode') {
      if (t.value === 'all') delete c.match;
      else c.match = { theirs: '', mine: '' };
    } else if (key === 'sheet') {
      c.sheet = t.value;
      c.col = sheetCols(t.value).find((x) => PLAIN_NUMERIC.has(x.type) && x !== c)?.key;
      delete c.match;
      delete c.where;
    } else if (key === 'sum') c.sum = t.checked;
    else if (key === 'source') {
      if (t.value) c.source = t.value;
      else delete c.source;
    } else if (key && !['label', 'options', 'where.value'].includes(key)) setPath(c, key, t.value);
    else return;
    draw();
  });

  box.addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const c = colOf(btn);
    const i = state.columns.indexOf(c);
    if (btn.dataset.colMove) {
      const to = i + Number(btn.dataset.colMove);
      [state.columns[i], state.columns[to]] = [state.columns[to], state.columns[i]];
      draw();
    } else if (btn.hasAttribute('data-col-delete')) {
      const users = state.columns.filter((x) => x !== c && [x.by, x.req, x.of, x.match?.mine, ...(x.terms || []).map((t) => t.col)].includes(c.key));
      if (!confirm(`Delete the column "${c.label}"?${users.length ? ` ${users.map((x) => `"${x.label}"`).join(', ')} use${users.length === 1 ? 's' : ''} it and will need fixing.` : ''}`)) return;
      state.columns.splice(i, 1);
      draw();
    } else if (btn.hasAttribute('data-term-add')) {
      c.terms = [...(c.terms || []), { op: c.terms?.length ? '-' : '+', col: '' }];
      draw();
    } else if (btn.dataset.termDel !== undefined) {
      c.terms.splice(Number(btn.dataset.termDel), 1);
      draw();
    } else if (btn.id === 'col-add') {
      state.columns.push({ key: newKey(), label: 'New column', type: 'text' });
      draw();
      [...box.querySelectorAll('[data-set="label"]')].pop()?.select();
    } else if (btn.id === 'col-cancel') {
      onDone();
    } else if (btn.id === 'sheet-delete') {
      if (!confirm(`Delete the sheet "${sheet.name}" and all ${rowsCount} of its rows? This can't be undone. (Download it first if you might need it.)`)) return;
      try {
        await api.deleteFinanceSheet(sheet.id);
        setView({ sheetId: null });
        setFlash(`Deleted "${sheet.name}".`);
        rerender();
      } catch (err) {
        box.querySelector('#col-errors').innerHTML = errorBox(err);
      }
    } else if (btn.id === 'col-save') {
      const clean = state.columns.map(tidy);
      const all = new Map(sheets.map((s) => [s.id, { sheet: s.id === sheet.id ? { ...s, name: state.name, columns: clean } : s }]));
      const problems = [...(state.name.trim() ? [] : ['Give the sheet a name.']), ...checkColumns(clean, all, budgets)];
      if (problems.length) {
        box.querySelector('#col-errors').innerHTML = errorBox(Object.assign(new Error('Please fix the following:'), { details: problems }));
        return;
      }
      btn.disabled = true;
      try {
        await api.saveFinanceSheet(sheet.id, state.name.trim(), clean);
        setFlash('Columns saved.');
        rerender();
      } catch (err) {
        box.querySelector('#col-errors').innerHTML = errorBox(err);
        btn.disabled = false;
      }
    }
  });

  draw();
}

// ---- New sheet: blank or from a template ---------------------------------------------------

export const TEMPLATES = [
  ['blank', 'Blank sheet', 'Two columns to start (Item and Amount). Add your own.'],
  ['budget', 'Budget by cost center', 'One row per cost center: budget, spent, approved but not ordered, and what\'s left. Fills itself in from the orders.'],
  ['income', 'Income (sponsorships & donations)', 'Log money coming in: date, from, type, amount.'],
  ['overview', 'Funds overview', 'The general pool: money in (from your Income sheet) minus what the team has spent and approved.'],
];

/** The new sheets a template makes: [{ name, columns, rows }] (an Overview may also need an Income sheet). */
export function templateSheets(kind, name, { config, sheets }) {
  const k = newKey;
  if (kind === 'blank') return [{ name, columns: [{ key: k(), label: 'Item', type: 'text' }, { key: k(), label: 'Amount', type: 'money', sum: true }], rows: [] }];
  if (kind === 'income') return [incomeSheet(name)];
  if (kind === 'budget') {
    const dropdowns = formDropdowns(config);
    const field = dropdowns.find((f) => f.key === workflowSettings(config).budgets.field) || dropdowns.find((f) => /cost\s*cent/i.test(f.label)) || dropdowns.find((f) => f.key !== 'priority');
    if (!field) throw new Error('Add a dropdown like Cost center to the request form first (Admin → Request form → Fields).');
    const cc = { key: k(), label: field.label, type: 'select', source: `form:${field.key}` };
    const budget = { key: k(), label: 'Budget', type: 'budget', by: cc.key, sum: true };
    const spent = { key: k(), label: 'Spent', type: 'orders', metric: 'spent', season: 'current', by: cc.key, field: field.key, sum: true };
    const waiting = { key: k(), label: 'Approved, not ordered', type: 'orders', metric: 'to_order', season: 'current', by: cc.key, field: field.key, sum: true };
    const left = { key: k(), label: 'Left', type: 'math', sum: true, terms: [{ op: '+', col: budget.key }, { op: '-', col: spent.key }, { op: '-', col: waiting.key }] };
    return [{ name, columns: [cc, budget, spent, waiting, left], rows: fieldOptions(field, config).map((o) => ({ data: { [cc.key]: o } })) }];
  }
  if (kind === 'overview') {
    const out = [];
    let income = sheets.find((s) => /income|sponsor|donat/i.test(s.name) && (s.columns || []).some((c) => c.type === 'money'));
    if (!income) {
      income = incomeSheet('Income');
      out.push(income);
    }
    const amount = (income.columns || []).find((c) => c.type === 'money');
    const moneyIn = { key: k(), label: `Money in (${income.name})`, type: 'lookup', sheet: income.id || '@income', col: amount.key, sum: true };
    const spent = { key: k(), label: 'Spent on orders', type: 'orders', metric: 'spent', season: 'current', sum: true };
    const waiting = { key: k(), label: 'Approved, not ordered', type: 'orders', metric: 'to_order', season: 'current', sum: true };
    const left = { key: k(), label: 'Left in the pool', type: 'math', sum: true, terms: [{ op: '+', col: moneyIn.key }, { op: '-', col: spent.key }, { op: '-', col: waiting.key }] };
    const season = { key: k(), label: 'Season', type: 'text' };
    out.push({ name, columns: [season, moneyIn, spent, waiting, left], rows: [{ data: { [season.key]: config.season } }] });
    return out;
  }
  return [];
}

function incomeSheet(name) {
  const k = newKey;
  return {
    name,
    columns: [
      { key: k(), label: 'Date', type: 'date' },
      { key: k(), label: 'From', type: 'text' },
      { key: k(), label: 'Type', type: 'select', options: ['Sponsorship', 'Donation', 'University', 'Fundraiser', 'Other'] },
      { key: k(), label: 'Amount', type: 'money', sum: true },
      { key: k(), label: 'Received', type: 'checkbox' },
      { key: k(), label: 'Notes', type: 'text' },
    ],
    rows: [],
  };
}

/** Ask which template, then create it. Returns the new sheet's id (or null). */
export function newSheetDialog({ config, sheets }) {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'card sheet-dialog';
    dialog.innerHTML = `<form method="dialog" novalidate>
      <h2>New sheet</h2>
      <div class="template-list">${TEMPLATES.map(([k, l, d], i) => `<label class="template-choice">
        <input type="radio" name="template" value="${k}" ${i === 0 ? 'checked' : ''}>
        <span><strong>${esc(l)}</strong><span class="muted small">${esc(d)}</span></span></label>`).join('')}</div>
      <div class="field"><label for="new-sheet-name">Name</label><input id="new-sheet-name" type="text" maxlength="60" value="Sheet ${sheets.length + 1}"></div>
      <div id="new-sheet-errors"></div>
      <div class="form-actions"><button type="button" class="btn btn-ghost" value="cancel" id="ns-cancel">Cancel</button><button type="submit" class="btn btn-primary">Create sheet</button></div>
    </form>`;
    document.body.appendChild(dialog);
    const nameBox = dialog.querySelector('#new-sheet-name');
    let touched = false;
    nameBox.addEventListener('input', () => (touched = true));
    dialog.addEventListener('change', (e) => {
      if (e.target.name === 'template' && !touched) nameBox.value = TEMPLATES.find((t) => t[0] === e.target.value)[1].replace(/ \(.*/, '');
    });
    const close = (id) => {
      dialog.close();
      dialog.remove();
      resolve(id);
    };
    dialog.querySelector('#ns-cancel').addEventListener('click', () => close(null));
    dialog.addEventListener('cancel', () => close(null));
    dialog.querySelector('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const kind = dialog.querySelector('[name="template"]:checked').value;
      const name = nameBox.value.trim() || 'Sheet';
      try {
        const made = templateSheets(kind, name.slice(0, 60), { config, sheets });
        let lastId = null;
        let incomeId = null;
        for (const [i, s] of made.entries()) {
          const columns = s.columns.map((c) => (c.sheet === '@income' ? { ...c, sheet: incomeId } : c));
          lastId = await api.saveFinanceSheet(null, s.name, columns, sheets.length + i);
          if (s.rows.length) await api.addFinanceRows(lastId, s.rows);
          if (/income/i.test(s.name) && kind === 'overview' && i < made.length - 1) incomeId = lastId;
        }
        close(lastId);
      } catch (err) {
        dialog.querySelector('#new-sheet-errors').innerHTML = errorBox(err);
      }
    });
    dialog.showModal();
  });
}
