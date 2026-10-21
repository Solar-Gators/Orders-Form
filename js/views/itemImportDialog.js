/**
 * New Request → "Import items…": pick an Excel / CSV file or paste cells, check which
 * column is which, then add the rows to the form as items (js/itemImport.js does the
 * reading). With one vendor per request, a list from several vendors can be split
 * into one request per vendor.
 *
 * openItemImport({ config, oneVendor, hasItems, currentVendor, onImport }) — onImport
 * receives { items, mode: 'add' | 'replace', vendor, others: [{ vendor, items }], file }.
 * Items for another vendor than the form's can be saved as their own drafts (`others`).
 */
import { esc, fmtMoney, fmtPrice, errorBox } from '../ui.js';
import { importableFields, readItemFile, parsePasted, findHeaderRow, guessMapping, toItems, byVendor, toMoney, downloadItemTemplate } from '../itemImport.js';

const colName = (n) => {
  let s = '';
  for (n += 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

export function openItemImport({ config, oneVendor, hasItems, currentVendor = '', onImport }) {
  const fields = importableFields(config);
  const byKey = Object.fromEntries(fields.map((f) => [f.key, f]));
  // The columns to match, the two that matter first. '_total' is an alternative to the price each.
  const targets = [
    byKey.item_name && { key: 'item_name', label: byKey.item_name.label, need: true },
    byKey.unit_price && { key: 'unit_price', label: `${byKey.unit_price.label} (each)`, need: true },
    { key: '_total', label: 'Line total', hint: 'instead of the price each: it\'s divided by the quantity' },
    byKey.quantity && { key: 'quantity', label: byKey.quantity.label, hint: '1 when blank' },
    ...fields.filter((f) => !['item_name', 'unit_price', 'quantity'].includes(f.key)).map((f) => ({ key: f.key, label: f.label })),
  ].filter(Boolean);

  let sheets = []; // [{ name, grid }]
  let sheetIndex = 0;
  let headerRow = -1;
  let mapping = {};
  let file = null;
  let result = { items: [], skipped: [] };
  let vendorChoice = 'split';
  let onlyVendor = '';
  let mode = hasItems ? 'add' : 'replace';

  const dialog = document.createElement('dialog');
  dialog.className = 'card sheet-dialog import-dialog';
  document.body.appendChild(dialog);
  const close = () => (dialog.close(), dialog.remove());
  dialog.addEventListener('cancel', close);

  const grid = () => sheets[sheetIndex]?.grid || [];
  const headers = () => {
    const width = Math.max(0, ...grid().map((r) => r.length));
    return Array.from({ length: width }, (_, i) => (headerRow >= 0 ? grid()[headerRow][i] || '' : ''));
  };
  const rows = () => grid().slice(headerRow + 1).map((cells, i) => ({ n: headerRow + i + 2, cells }));
  const recompute = () => (result = toItems(rows(), mapping, fields, config));
  const groups = () => byVendor(result.items).filter((g) => g.vendor);
  const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

  /**
   * What importing does with vendors (one vendor per request): the form keeps one
   * vendor's items (the form's own vendor when adding to it, else the list's first),
   * and the rest go to their own drafts, or are left out. Rows with no vendor stay here.
   */
  const plan = () => {
    const g = groups();
    const formVendor = oneVendor && hasItems && mode === 'add' ? currentVendor.trim() : '';
    if (!oneVendor || !g.length) return { items: result.items, vendor: '', others: [], choice: false, g, formVendor };
    const mainVendor = formVendor || g[0].vendor;
    const differs = g.filter((x) => !same(x.vendor, mainVendor));
    const forVendor = (v) => result.items.filter((i) => !i.vendor || same(i.vendor, v));
    if (!differs.length) return { items: result.items, vendor: mainVendor, others: [], choice: false, g, formVendor };
    if (!onlyVendor || (!g.some((x) => same(x.vendor, onlyVendor)) && !same(onlyVendor, formVendor))) onlyVendor = mainVendor;
    if (vendorChoice === 'split') return { items: forVendor(mainVendor), vendor: mainVendor, others: differs, choice: true, g, formVendor, mainVendor, differs };
    return { items: forVendor(onlyVendor), vendor: onlyVendor, others: [], choice: true, g, formVendor, mainVendor, differs };
  };

  // ---- Step 1: a file or pasted cells ----
  const drawSource = (error = null) => {
    dialog.innerHTML = `<form method="dialog" novalidate>
      <h2>Import items</h2>
      <p class="muted small">From a parts list: only a part name and a price are needed. You can fill in everything else on the form afterwards.</p>
      <label class="attach-drop import-drop">
        <input type="file" accept=".xlsx,.csv,text/csv" id="imp-file">
        <span><strong>Choose an Excel or CSV file</strong> or drop it here <span class="muted small">(.xlsx or .csv)</span></span>
      </label>
      <div class="field"><label for="imp-paste">…or paste cells from a spreadsheet</label>
        <textarea id="imp-paste" rows="5" placeholder="In Excel or Google Sheets, select the rows (with the header row), copy, and paste here."></textarea></div>
      <p class="hint"><button type="button" class="link-btn" id="imp-template">Download a template</button> with the right columns.</p>
      ${error ? errorBox(error) : ''}
      <div class="form-actions"><button type="button" class="btn btn-ghost" data-close>Cancel</button>
        <button type="button" class="btn btn-primary" id="imp-next">Next</button></div>
    </form>`;
    const drop = dialog.querySelector('.import-drop');
    drop.addEventListener('dragover', (e) => (e.preventDefault(), drop.classList.add('is-over')));
    drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      drop.classList.remove('is-over');
      if (e.dataTransfer.files[0]) useFile(e.dataTransfer.files[0]);
    });
  };

  const useFile = async (f) => {
    try {
      const read = await readItemFile(f);
      if (!read.length) throw new Error(`${f.name} is empty.`);
      file = f;
      start(read);
    } catch (err) {
      drawSource(err);
    }
  };
  const start = (read) => {
    sheets = read;
    // The sheet with the most rows that look like parts.
    // The sheet that looks like a parts list (column titles we recognise), then the longest.
    const score = (s) => (findHeaderRow(s.grid) >= 0 ? 1e6 : 0) + s.grid.length;
    sheetIndex = sheets.map((s, i) => [i, score(s)]).sort((a, b) => b[1] - a[1])[0][0];
    pickSheet(sheetIndex);
  };
  const pickSheet = (i) => {
    sheetIndex = i;
    headerRow = findHeaderRow(grid());
    mapping = headerRow >= 0 ? guessMapping(headers(), fields) : guessByContent();
    drawMap();
  };
  /** No header row: guess from the first row's values (text = name, money = price, small whole number = quantity). */
  const guessByContent = () => {
    const first = grid()[0] || [];
    const map = {};
    first.forEach((v, i) => {
      if (!('item_name' in map) && v && toMoney(v) === null && !/^https?:/i.test(v)) map.item_name = i;
      else if (!('quantity' in map) && /^\d{1,4}$/.test(v)) map.quantity = i;
      else if (!('unit_price' in map) && toMoney(v) !== null) map.unit_price = i;
      else if (!('product_link' in map) && /^https?:/i.test(v) && byKey.product_link) map.product_link = i;
    });
    return map;
  };

  // ---- Step 2: which column is which, a preview, vendors, add or replace ----
  // The columns that matter most are always shown; the rest fold away.
  const main = (t) => ['item_name', 'unit_price', '_total', 'quantity', 'vendor'].includes(t.key);
  let moreOpen = false;
  const mapRow = (t) => {
    const cols = headers();
    const sample = (i) => rows().find((r) => r.cells[i])?.cells[i] || '';
    const option = (i) => `${colName(i)}${cols[i] ? `: ${cols[i]}` : sample(i) ? ` (e.g. ${sample(i).slice(0, 30)})` : ''}`;
    return `<label class="import-map-row"><span>${esc(t.label)}${t.need ? ' <span class="req">*</span>' : ''}${t.hint ? ` <span class="muted small">${esc(t.hint)}</span>` : ''}</span>
      <select data-map="${t.key}"><option value="">${t.need ? '(choose a column)' : '(not in the list)'}</option>${cols
        .map((_, i) => `<option value="${i}" ${mapping[t.key] === i ? 'selected' : ''}>${esc(option(i))}</option>`)
        .join('')}</select></label>`;
  };
  const drawMap = () => {
    recompute();
    const p = plan();
    const { g } = p;
    const nameOk = mapping.item_name !== undefined;
    const priceOk = mapping.unit_price !== undefined || mapping._total !== undefined;
    const importing = p.items;
    const others = p.others;
    const vendorList = [...new Set([p.formVendor, ...g.map((x) => x.vendor)].filter(Boolean))];
    // "this item is from X", "these items are from X", "3 of these items are from X (2), Y (1)"
    const otherItemsText = ({ differs }) => {
      const n = differs.reduce((s, x) => s + x.items.length, 0);
      const who = differs.length > 1 ? differs.map((x) => `${esc(x.vendor)} (${x.items.length})`).join(', ') : esc(differs[0].vendor);
      if (n === result.items.length) return `${n === 1 ? 'this item is' : 'these items are'} from ${who}`;
      return `${n} of these items ${n === 1 ? 'is' : 'are'} from ${who}`;
    };
    const draftsText = (list) =>
      list.length === 1 ? `The ${esc(list[0].vendor)} items are saved as a separate draft` : `The other ${list.length} vendors are each saved as a separate draft`;

    dialog.innerHTML = `<form method="dialog" novalidate>
      <h2>Import items${file ? ` <span class="muted small">from ${esc(file.name)}</span>` : ''}</h2>
      ${sheets.length > 1 ? `<div class="field"><label for="imp-sheet">Sheet</label>
        <select id="imp-sheet">${sheets.map((s, i) => `<option value="${i}" ${i === sheetIndex ? 'selected' : ''}>${esc(s.name)} (${s.grid.length} rows)</option>`).join('')}</select></div>` : ''}
      <label class="rule-toggle"><input type="checkbox" id="imp-header" ${headerRow >= 0 ? 'checked' : ''}>
        <span>The first row has the column titles${headerRow > 0 ? ` <span class="muted small">(row ${headerRow + 1})</span>` : ''}</span></label>
      <h3 class="import-sub">Which column is which?</h3>
      <div class="import-map">${targets.filter(main).map(mapRow).join('')}</div>
      <details class="import-more" ${moreOpen ? 'open' : ''}><summary class="small">More columns <span class="muted">(${targets.filter((t) => !main(t) && mapping[t.key] !== undefined).length} matched)</span></summary>
        <div class="import-map">${targets.filter((t) => !main(t)).map(mapRow).join('')}</div></details>
      ${!nameOk || !priceOk ? `<div class="alert alert-warning small">Pick the column with the ${!nameOk ? 'part name' : ''}${!nameOk && !priceOk ? ' and the one with the ' : ''}${!priceOk ? 'price (each, or a line total)' : ''}.</div>` : ''}

      <h3 class="import-sub">${result.items.length} item${result.items.length === 1 ? '' : 's'} ready${result.skipped.length ? `, ${result.skipped.length} row${result.skipped.length === 1 ? '' : 's'} left out` : ''}</h3>
      ${result.skipped.length ? `<details class="import-skipped"><summary class="small">Rows left out</summary>
        <ul class="small">${result.skipped.map((s) => `<li>Row ${s.row}: ${esc(s.reason)}</li>`).join('')}</ul></details>` : ''}
      ${result.items.length ? `<div class="table-wrap flat import-preview"><table class="table">
        <thead><tr><th>${esc(byKey.item_name?.label || 'Item')}</th><th class="num">Qty</th><th class="num">Each</th><th class="num">Total</th>${mapping.vendor !== undefined ? '<th>Vendor</th>' : ''}</tr></thead>
        <tbody>${result.items.slice(0, 6).map((i) => `<tr><td>${esc(i.item_name)}</td><td class="num">${esc(i.quantity)}</td><td class="num">${fmtPrice(Number(i.unit_price))}</td>
          <td class="num">${fmtMoney(Number(i.unit_price) * Number(i.quantity))}</td>${mapping.vendor !== undefined ? `<td>${esc(i.vendor || '')}</td>` : ''}</tr>`).join('')}
          ${result.items.length > 6 ? `<tr><td colspan="5" class="muted small">…and ${result.items.length - 6} more</td></tr>` : ''}</tbody>
        <tfoot><tr><td colspan="3"><strong>Total</strong> <span class="muted small">(before shipping)</span></td><td class="num"><strong>${fmtMoney(result.items.reduce((s, i) => s + Number(i.unit_price) * Number(i.quantity), 0))}</strong></td>${mapping.vendor !== undefined ? '<td></td>' : ''}</tr></tfoot>
      </table></div>` : ''}

      ${hasItems ? `<div class="import-mode">
        <label class="rule-toggle"><input type="radio" name="imp-mode" value="add" ${mode === 'add' ? 'checked' : ''}><span>Add them after the items already on the form</span></label>
        <label class="rule-toggle"><input type="radio" name="imp-mode" value="replace" ${mode === 'replace' ? 'checked' : ''}><span>Replace the items on the form</span></label>
      </div>` : ''}

      ${p.choice ? `<div class="import-vendors">
        <p class="small">${p.formVendor
          ? `<strong>This request is for ${esc(p.formVendor)}</strong>, and ${otherItemsText(p)}. Each request is for one vendor.`
          : `<strong>This list has ${g.length} vendors</strong> (${g.map((x) => `${esc(x.vendor)}: ${x.items.length}`).join(', ')}), and each request is for one vendor.`}</p>
        <label class="rule-toggle"><input type="radio" name="imp-vendors" value="split" ${vendorChoice === 'split' ? 'checked' : ''}>
          <span>${p.formVendor ? 'Save them as their own request' : 'Split it: one request per vendor'} <span class="hint">${p.items.length ? `This form gets the ${esc(p.mainVendor)} items. ` : ''}${draftsText(p.differs)} with the same details, for you to finish.</span></span></label>
        <label class="rule-toggle"><input type="radio" name="imp-vendors" value="one" ${vendorChoice === 'one' ? 'checked' : ''}>
          <span>Only import one vendor's items:
            <select id="imp-only" ${vendorChoice === 'one' ? '' : 'disabled'}>${vendorList.map((v) => `<option ${same(v, onlyVendor) ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></span></label>
        ${result.items.some((i) => !i.vendor) ? '<p class="hint">Rows with no vendor stay on this form.</p>' : ''}
      </div>` : ''}
      <div id="imp-errors"></div>
      <div class="form-actions"><button type="button" class="btn btn-ghost" id="imp-back">Back</button>
        <button type="button" class="btn btn-primary" id="imp-go" ${(importing.length || others.length) && nameOk && priceOk ? '' : 'disabled'}>${[
          importing.length || !others.length ? `Import ${importing.length} item${importing.length === 1 ? '' : 's'}` : '',
          others.length ? `${importing.length ? '+' : 'Save'} ${others.length} draft${others.length === 1 ? '' : 's'}` : '',
        ].filter(Boolean).join(' ')}</button></div>
    </form>`;
  };

  dialog.addEventListener('change', (e) => {
    const t = e.target;
    if (t.id === 'imp-file' && t.files[0]) return useFile(t.files[0]);
    if (t.id === 'imp-sheet') return pickSheet(Number(t.value));
    if (t.id === 'imp-header') {
      headerRow = t.checked ? Math.max(0, findHeaderRow(grid())) : -1;
      mapping = headerRow >= 0 ? guessMapping(headers(), fields) : guessByContent();
      return drawMap();
    }
    if (t.dataset.map) {
      const key = t.dataset.map;
      moreOpen = !!t.closest('.import-more');
      if (t.value === '') delete mapping[key];
      else {
        const col = Number(t.value);
        for (const k of Object.keys(mapping)) if (mapping[k] === col) delete mapping[k]; // a column means one thing
        mapping[key] = col;
      }
      return drawMap();
    }
    if (t.name === 'imp-mode') {
      mode = t.value;
      return drawMap();
    }
    if (t.name === 'imp-vendors') {
      vendorChoice = t.value;
      return drawMap();
    }
    if (t.id === 'imp-only') {
      onlyVendor = t.value;
      return drawMap();
    }
  });
  dialog.addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    if (btn.hasAttribute('data-close')) return close();
    if (btn.id === 'imp-template') {
      btn.disabled = true;
      await downloadItemTemplate(config).catch((err) => drawSource(err));
      btn.disabled = false;
    } else if (btn.id === 'imp-next') {
      const text = dialog.querySelector('#imp-paste').value;
      if (!text.trim()) return drawSource(new Error('Choose a file, or paste some cells first.'));
      file = null;
      start([{ name: 'Pasted cells', grid: parsePasted(text) }]);
    } else if (btn.id === 'imp-back') {
      drawSource();
    } else if (btn.id === 'imp-go') {
      const { items, vendor, others } = plan();
      btn.disabled = true;
      btn.textContent = others.length ? 'Importing and saving drafts…' : 'Importing…';
      try {
        await onImport({ items, mode, vendor, others, file });
        close();
      } catch (err) {
        dialog.querySelector('#imp-errors').innerHTML = errorBox(err);
        btn.disabled = false;
        btn.textContent = 'Try again';
      }
    }
  });

  drawSource();
  dialog.showModal();
}
