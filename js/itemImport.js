/**
 * Importing a parts list into a request (New Request → "Import items…"): an Excel
 * or CSV file, or cells pasted from a spreadsheet. Only the part name and price are
 * needed; everything else can be filled in by hand afterwards.
 *
 *   readItemFile(file)            → [{ name, grid }]  (one per sheet with something in it)
 *   parsePasted(text)             → grid               (tab- or comma-separated)
 *   findHeaderRow(grid)           → index of the row with the column titles (or -1)
 *   guessMapping(headers, fields) → { fieldKey | '_total': column index }
 *   toItems(rows, mapping, fields, config) → { items, skipped }
 *   downloadItemTemplate(config)  → an .xlsx with the right headers
 *
 * The pure parts are tested in tests/itemImport.test.mjs.
 */
import { loadExcelJS } from './excel.js';
import { cellText } from './sheetImport.js';
import { itemFields, shown, fieldOptions, shippingPerRequest } from './formFields.js';

/** Item fields a parts list can fill (not section headings, and not whole-order shipping). */
export function importableFields(config) {
  return shown(itemFields(config)).filter((f) => f.type !== 'section' && !(f.key === 'shipping_cost' && shippingPerRequest(config)));
}

// ---- Reading -------------------------------------------------------------------------

/** Rows of text, trailing empty cells and rows dropped. */
const tidy = (grid) => {
  const rows = grid.map((r) => {
    const out = r.map((c) => String(c ?? '').trim());
    while (out.length && out.at(-1) === '') out.pop();
    return out;
  });
  while (rows.length && !rows.at(-1).length) rows.pop();
  return rows;
};

/** CSV / TSV text → rows (quotes and "" inside quotes handled). */
export function parseDelimited(text, delimiter) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const s = String(text ?? '').replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') (cell += '"'), i++;
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === delimiter) row.push(cell), (cell = '');
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(cell), rows.push(row), (row = []), (cell = '');
    } else cell += ch;
  }
  if (cell !== '' || row.length) row.push(cell), rows.push(row);
  return tidy(rows);
}

/** Cells copied from Excel / Google Sheets arrive tab-separated; a CSV pasted as text has commas. */
export function parsePasted(text) {
  const t = String(text ?? '');
  return parseDelimited(t, t.includes('\t') ? '\t' : t.includes(';') && !t.includes(',') ? ';' : ',');
}

/** An .xlsx or .csv file → the sheets that have something in them. */
export async function readItemFile(file) {
  const name = file.name || 'file';
  if (/\.(csv|tsv|txt)$/i.test(name) || /^text\//.test(file.type)) {
    const text = await file.text();
    return [{ name, grid: parseDelimited(text, /\.tsv$/i.test(name) || (text.includes('\t') && !text.includes(',')) ? '\t' : ',') }];
  }
  if (/\.xls$/i.test(name)) throw new Error('That\'s an old .xls file. Open it in Excel and save it as .xlsx (or .csv), then import that.');
  if (!/\.xlsx$/i.test(name)) throw new Error('Choose an Excel (.xlsx) or CSV file.');
  const ExcelJS = await loadExcelJS();
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(await file.arrayBuffer());
  } catch {
    throw new Error('Couldn\'t read that file. Is it a real .xlsx? Try saving it again from Excel, or paste the cells instead.');
  }
  return wb.worksheets
    .filter((ws) => ws.state !== 'hidden')
    .map((ws) => {
      const grid = [];
      ws.eachRow({ includeEmpty: true }, (row, n) => {
        const cells = [];
        for (let c = 1; c <= ws.columnCount; c++) cells.push(cellText(row.getCell(c).value));
        grid[n - 1] = cells;
      });
      return { name: ws.name, grid: tidy(Array.from(grid, (r) => r || [])) };
    })
    .filter((s) => s.grid.length);
}

// ---- Recognising columns -------------------------------------------------------------

const isNumberish = (t) => /^[-$€£\s]*[\d,]*\.?\d+\s*$/.test(t || '');

/** The row with the column titles: the first of the top 10 with 2+ cells that are mostly words. */
export function findHeaderRow(grid) {
  for (let r = 0; r < Math.min(10, grid.length); r++) {
    const cells = grid[r].filter(Boolean);
    if (cells.length >= 2 && cells.filter((c) => !isNumberish(c) && !/^https?:/i.test(c)).length >= Math.ceil(cells.length * 0.7)) {
      // A title row above the table ("Parts for the battery box") has only one cell, so it's skipped.
      if (PATTERNS.some(([, ...ps]) => cells.some((c) => ps.some((p) => p.test(c))))) return r;
    }
  }
  return -1;
}

// Header patterns per field, most specific first. '_total' is a line-total column.
const NOT_TOTAL = /total|extended|subtotal|sum|amount|ext\b/i;
const PATTERNS = [
  ['part_number', /part\s*(#|no\.?|num(ber)?)|mfr\.?\s*(#|part)|manufacturer\s*part|\bsku\b|catalog|cat\.?\s*#|item\s*(#|no\.?|num)|product\s*(#|code|id)|\bmpn\b/i],
  ['quantity', /^\s*(qty|quan|quantity|count|#\s*needed|how many|amount needed)\b/i, /\bqty\b|quantity/i],
  ['_total', /^(line\s*)?total|extended|ext\.?\s*price|subtotal|line\s*(cost|price|amount)|total\s*(cost|price)/i],
  ['unit_price', /unit\s*(price|cost)|price\s*(each|per|\/)|cost\s*(each|per|\/)|\beach\b|^\s*(price|cost)\s*$/i, /price|cost/i],
  ['vendor', /vendor|supplier|seller|\bstore\b|distributor|where to buy|company/i],
  ['product_link', /link|url|website|web\s*page/i],
  ['notes', /note|comment|remark|spec|detail/i],
  ['item_name', /^\s*(part|item|product|component)\s*(name)?\s*$/i, /name|title/i, /desc(ription)?/i, /part|item|product|component|what/i],
];

/**
 * Which column holds each field. Exact label matches first (a downloaded template),
 * then the patterns above. Each column is used once.
 */
export function guessMapping(headers, fields) {
  const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/\s*\*$/, '');
  const used = new Set();
  const map = {};
  const take = (key, i) => {
    if (i < 0 || used.has(i) || key in map) return;
    map[key] = i;
    used.add(i);
  };
  for (const f of fields) take(f.key, headers.findIndex((h, i) => !used.has(i) && norm(h) === norm(f.label)));
  const has = new Set(fields.map((f) => f.key));
  for (const [key, ...patterns] of PATTERNS) {
    if (key !== '_total' && !has.has(key)) continue;
    for (const p of patterns) {
      const i = headers.findIndex(
        (h, n) =>
          !used.has(n) && p.test(h || '') &&
          !(key === 'unit_price' && NOT_TOTAL.test(h)) &&
          !(key === 'item_name' && /#|no\.|num/i.test(h)) &&
          !(key === 'vendor' && /link|url|web\s*site|site/i.test(h)) // "Vendor Website" holds links
      );
      if (i >= 0) {
        take(key, i);
        break;
      }
    }
  }
  return map;
}

// ---- Rows → items ----------------------------------------------------------------------

/** "$1,234.50" → 1234.5; "" or words → null. */
export function toMoney(text) {
  const t = String(text ?? '').replace(/[$€£,\s]/g, '').replace(/^\((.*)\)$/, '-$1');
  return /^-?\d*\.?\d+$/.test(t) ? Number(t) : null;
}
const toQty = (text) => {
  const m = String(text ?? '').replace(/,/g, '').match(/-?\d*\.?\d+/);
  return m ? Number(m[0]) : null;
};
const round = (n, places) => Number(n.toFixed(places));
const SUMMARY_ROW = /^\s*(sub\s*-?\s*total|grand\s*total|total|shipping|tax|sales tax|discount|handling)\b/i;

/**
 * Rows → items for the form: { data, item_name, unit_price, … } with text values,
 * plus the rows skipped and why. A row needs a name and a price (or a line total).
 */
export function toItems(rows, mapping, fields, config = {}) {
  const items = [];
  const skipped = [];
  const cell = (row, key) => (mapping[key] === undefined || mapping[key] < 0 ? '' : String(row.cells[mapping[key]] ?? '').trim());
  for (const row of rows) {
    if (!row.cells.some((c) => String(c ?? '').trim())) continue; // blank
    const name = cell(row, 'item_name');
    const qtyText = cell(row, 'quantity');
    let qty = qtyText === '' ? 1 : toQty(qtyText);
    let price = toMoney(cell(row, 'unit_price'));
    const total = toMoney(cell(row, '_total'));
    if (!name && SUMMARY_ROW.test(row.cells.filter(Boolean).join(' '))) {
      skipped.push({ row: row.n, reason: 'Looks like a total or shipping line' });
      continue;
    }
    if (SUMMARY_ROW.test(name) && !qtyText) {
      skipped.push({ row: row.n, reason: `"${name}" looks like a total or shipping line` });
      continue;
    }
    if (!name) {
      skipped.push({ row: row.n, reason: 'No part name' });
      continue;
    }
    if (name === TEMPLATE_EXAMPLE.item_name) {
      skipped.push({ row: row.n, reason: 'The template\'s example row' });
      continue;
    }
    if (qty === null || qty <= 0) {
      skipped.push({ row: row.n, reason: `${name}: the quantity "${qtyText}" isn't a number above 0` });
      continue;
    }
    if (price === null && total !== null) price = total / qty;
    if (price === null || price < 0) {
      skipped.push({ row: row.n, reason: `${name}: no price` });
      continue;
    }
    const item = { data: {} };
    for (const f of fields) {
      let v;
      if (f.key === 'quantity') v = String(round(qty, 4));
      else if (f.key === 'unit_price') v = String(round(price, 4));
      else v = cell(row, f.key);
      if (v && f.type === 'select') {
        // Dropdown answers must be one of its options (matched ignoring case).
        v = fieldOptions(f, config).find((o) => o.toLowerCase() === v.toLowerCase()) || '';
      } else if (v && f.type === 'yesno') {
        v = /^(y|yes|true|1|x)$/i.test(v) ? 'Yes' : /^(n|no|false|0)$/i.test(v) ? 'No' : '';
      } else if (v && f.type === 'number' && !['quantity', 'unit_price'].includes(f.key)) {
        const n = toMoney(v);
        v = n === null ? '' : String(n);
      } else if (f.type === 'url' && v) {
        // A linked cell reads "digikey (https://…)": keep the address.
        const url = v.match(/https?:\/\/[^\s)]+/i)?.[0];
        v = url || (/^www\.|^[\w-]+(\.[\w-]+)+\//i.test(v) ? `https://${v}` : '');
      }
      if (f.maxLength && v.length > Number(f.maxLength)) v = v.slice(0, Number(f.maxLength));
      if (v === '') continue;
      if (f.builtin) item[f.key] = v;
      else item.data[f.key] = v;
    }
    items.push(item);
  }
  return { items, skipped };
}

/** Items grouped by vendor (case-insensitive), in the order they first appear. '' = no vendor. */
export function byVendor(items) {
  const groups = new Map();
  for (const item of items) {
    const v = String(item.vendor || '').trim();
    const k = v.toLowerCase();
    if (!groups.has(k)) groups.set(k, { vendor: v, items: [] });
    groups.get(k).items.push(item);
  }
  return [...groups.values()];
}

// ---- Template --------------------------------------------------------------------------

/** The template's example row (left out if someone forgets to delete it). */
export const TEMPLATE_EXAMPLE = {
  item_name: 'M5 x 12 socket head screw (pack of 50)', vendor: 'McMaster-Carr', part_number: '91292A126',
  quantity: 2, unit_price: 9.87, product_link: 'https://www.mcmaster.com/91292A126', notes: 'Stainless',
};

/** An .xlsx whose headers match this team's item fields, with one example row. */
export async function downloadItemTemplate(config) {
  const fields = importableFields(config);
  const ExcelJS = await loadExcelJS();
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Parts', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = fields.map((f) => ({
    header: f.label,
    key: f.key,
    width: f.key === 'item_name' ? 34 : f.type === 'url' ? 40 : f.key === 'notes' ? 30 : Math.max(12, f.label.length + 4),
  }));
  ws.addRow(Object.fromEntries(fields.map((f) => [f.key, TEMPLATE_EXAMPLE[f.key] ?? null])));
  const price = fields.findIndex((f) => f.key === 'unit_price');
  if (price >= 0) ws.getColumn(price + 1).numFmt = '"$"#,##0.00';
  ws.getRow(1).eachCell((c, n) => {
    const f = fields[n - 1];
    c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: f && ['item_name', 'unit_price'].includes(f.key) ? 'FFF26B1D' : 'FF0B2545' } };
  });
  ws.getRow(2).font = { italic: true, color: { argb: 'FF5D6D7E' } };
  const notes = wb.addWorksheet('How to use');
  notes.getColumn(1).width = 100;
  [
    'One row per part. Only the orange columns are needed: the part name and its price (each).',
    'Quantity is 1 when left blank. A "Total" column works too: the price each is worked out from it.',
    "Replace the grey example row with your parts (it's left out if you forget). Extra columns are fine; you pick which is which when importing.",
    'Then: New Request → Import items… → choose this file. Fill in anything else on the form afterwards.',
  ].forEach((t) => notes.addRow([t]));
  const buffer = await wb.xlsx.writeBuffer();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  a.download = `${String(config.teamName || 'Solar Gators').replace(/[^A-Za-z0-9]+/g, '_')}_parts_list_template.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
