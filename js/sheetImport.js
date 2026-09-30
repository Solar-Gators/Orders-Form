/**
 * Reading the team's old Excel order sheets (in the browser).
 *
 *   readWorkbook(file)            → sheets with headers + rows (every column kept)
 *   toArchiveRows(sheet)          → rows for the Archive (past seasons)
 *   toRequests(sheet, options)    → requests for this season (grouped rows → requests)
 *
 * Column names changed a little between years ("Requestor"/"Requester",
 * "Gross Cost (cost before shipping)" …), so columns are recognised by pattern.
 */
import { loadExcelJS } from './excel.js';
import { makeKey } from './formFields.js';

const colLetter = (n) => {
  let s = '';
  for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

const pad = (n) => String(n).padStart(2, '0');

/** Plain text for any ExcelJS cell value (dates → YYYY-MM-DD, formulas → result, links → URL). */
export function cellText(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return `${v.getUTCFullYear()}-${pad(v.getUTCMonth() + 1)}-${pad(v.getUTCDate())}`;
  if (typeof v === 'number') return String(Number(v.toFixed(6)));
  if (typeof v === 'object') {
    if (v.richText) return v.richText.map((t) => t.text).join('').trim();
    if ('result' in v || 'formula' in v || 'sharedFormula' in v) return cellText(v.result);
    if (v.hyperlink) {
      const text = cellText(v.text);
      if (!text || text === v.hyperlink || /^https?:\/\//i.test(text)) return v.hyperlink;
      return `${text} (${v.hyperlink})`;
    }
    if ('text' in v) return cellText(v.text);
    return '';
  }
  return String(v).trim();
}

const clean = (s) => s.replace(/\s+/g, ' ').trim();

/** Find the header row: the first row (in the top 15) that looks like column titles. */
function findHeaderRow(ws) {
  for (let r = 1; r <= Math.min(15, ws.rowCount); r++) {
    const vals = ws.getRow(r).values.slice(1).map(cellText).filter(Boolean);
    if (vals.length >= 3 && vals.some((v) => /request|item/i.test(v))) return r;
  }
  return 1;
}

/** One sheet → { name, headerRow, columns: [header…], rows: [{ row_number, values: {header: text} }] } */
function readSheet(ws) {
  const headerRow = findHeaderRow(ws);
  const width = ws.columnCount;
  const raw = [];
  ws.eachRow((row, n) => {
    if (n <= headerRow) return;
    const cells = [];
    for (let c = 1; c <= width; c++) cells.push(cellText(row.getCell(c).value));
    const filled = cells.filter(Boolean);
    if (filled.length < 2 || /^totals?:?$/i.test(filled[0])) return; // blank, notes, or a totals line
    raw.push({ row_number: n, cells });
  });

  // Keep every column that has a header or any data. Unlabeled ones become "Column S" etc.
  const columns = [];
  const index = [];
  const seen = new Map();
  for (let c = 1; c <= width; c++) {
    let header = clean(cellText(ws.getRow(headerRow).getCell(c).value));
    if (!header && !raw.some((r) => r.cells[c - 1])) continue;
    header ||= `Column ${colLetter(c)}`;
    const count = (seen.get(header) || 0) + 1;
    seen.set(header, count);
    columns.push(count > 1 ? `${header} (${count})` : header);
    index.push(c - 1);
  }

  const rows = raw.map(({ row_number, cells }) => {
    const values = {};
    columns.forEach((h, i) => {
      if (cells[index[i]]) values[h] = cells[index[i]];
    });
    return { row_number, values };
  });
  return { name: ws.name, headerRow, columns, rows };
}

/** Read all visible sheets of an .xlsx File. */
export async function readWorkbook(file) {
  const ExcelJS = await loadExcelJS();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await file.arrayBuffer());
  const sheets = [];
  wb.eachSheet((ws) => {
    if (ws.state === 'visible' || !ws.state) sheets.push(readSheet(ws));
  });
  return sheets;
}

/** Best sheet to start with: the one with the most order-like rows. */
export const pickSheet = (sheets) => [...sheets].sort((a, b) => b.rows.length - a.rows.length)[0];

/** "24-25 Budget.xlsx" → "2024-2025", "Order Page_2025-2026.xlsx" → "2025-2026". */
export function guessSeason(filename) {
  const m = filename.match(/(?:20)?(\d{2})\s*[-_–]\s*(?:20)?(\d{2})/);
  return m ? `20${m[1]}-20${m[2]}` : '';
}

// ---- recognising columns ----------------------------------------------------------

const find = (cols, ...patterns) => patterns.map((p) => cols.find((c) => p.test(c))).find(Boolean);

export function detectColumns(columns) {
  return {
    requester: find(columns, /request(o|e)r/i),
    date: find(columns, /^date$/i, /^date(?!.*receiv)/i),
    subteam: find(columns, /sub ?team|subsystem/i),
    item: find(columns, /item/i),
    quantity: find(columns, /^quantity/i),
    vendor: find(columns, /vendor/i),
    description: find(columns, /description|why you need/i),
    cost: find(columns, /gross cost/i, /^cost/i),
    // Not "Gross Cost (Before Shipping)" — only a column that is about shipping itself.
    shipping: find(columns, /^shipping/i, /shipping cost/i),
    info: find(columns, /additional info/i),
    priority: find(columns, /priority/i),
    approver: find(columns, /ce approval/i, /approv/i),
    status: find(columns, /order status|status of order/i),
    ticket: find(columns, /ticket/i),
  };
}

const toNumber = (text) => {
  const t = String(text ?? '').replace(/[$,\s]/g, '');
  return /^-?\d*\.?\d+$/.test(t) ? Number(t) : null;
};
const isDate = (t) => /^\d{4}-\d{2}-\d{2}$/.test(t || '');

/** Archive rows: all original values plus a few common columns for search/filter. */
export function toArchiveRows(sheet) {
  const m = detectColumns(sheet.columns);
  const get = (r, col) => (col ? r.values[col] || '' : '');
  return sheet.rows.map((r) => ({
    row_number: r.row_number,
    fields: r.values,
    order_date: isDate(get(r, m.date)) ? get(r, m.date) : null,
    requester: get(r, m.requester),
    subteam: get(r, m.subteam),
    item: get(r, m.item),
    status: get(r, m.status),
    approver: get(r, m.approver),
    ticket: get(r, m.ticket),
    cost: toNumber(get(r, m.cost)),
  }));
}

// ---- this season's sheet → requests -------------------------------------------------

/** Suggest a configured subsystem for an old subteam name ("Batt Pack" → "Battery"). */
export function guessSubsystem(value, subsystems) {
  const v = value.toLowerCase();
  const exact = subsystems.find((s) => s.toLowerCase() === v);
  if (exact) return exact;
  const word = v.split(/[^a-z]+/).find(Boolean) || '';
  return (
    subsystems.find((s) => v.includes(s.toLowerCase())) ||
    (word.length >= 3 && subsystems.find((s) => s.toLowerCase().startsWith(word.slice(0, 4)))) ||
    ''
  );
}

function mapStatus(statusText, approverText) {
  const s = statusText.toLowerCase();
  const a = approverText.toLowerCase();
  if (/cancel/.test(s) || /do not/.test(a)) return 'Rejected';
  if (/receiv/.test(s)) return 'Received';
  if (/order/.test(s)) return 'Ordered';
  return approverText ? 'Approved' : 'Submitted';
}

const SHORT_LINKS = { 'a.co': 'amazon.com', 'amzn.to': 'amazon.com', 'amzn.com': 'amazon.com' };
const hostOf = (text) => {
  try {
    const host = new URL(text).hostname.replace(/^www\./, '');
    return SHORT_LINKS[host] || host;
  } catch {
    return '';
  }
};

/**
 * Group rows into requests (same requester, date, subteam, ticket, status and approver).
 * Columns without a built-in home become custom item fields so nothing is lost.
 * Returns { requests, newItemFields, subteams }.
 */
export function toRequests(sheet, { config, itemFields, subsystemMap = {} }) {
  const m = detectColumns(sheet.columns);
  const mapped = new Set(Object.values(m).filter(Boolean));
  const get = (r, col) => (col ? r.values[col] || '' : '');

  // Extra columns → custom item fields (reusing any with the same label).
  const keys = new Set(itemFields.map((f) => f.key));
  const newItemFields = [];
  const extra = sheet.columns
    .filter((c) => !mapped.has(c) && sheet.rows.some((r) => r.values[c]))
    .map((header) => {
      const label = header.length > 60 ? header.slice(0, 57) + '…' : header;
      let field = itemFields.find((f) => !f.builtin && f.label.toLowerCase() === label.toLowerCase());
      if (!field) {
        field = { key: makeKey(label, keys), label, type: 'text', required: false };
        keys.add(field.key);
        newItemFields.push(field);
      }
      return { header, key: field.key };
    });

  const priorityFor = (text) =>
    config.priorities.find((p) => p.toLowerCase() === text.toLowerCase()) || config.defaultPriority || '';

  const groups = new Map();
  for (const r of sheet.rows) {
    const g = [m.requester, m.date, m.subteam, m.ticket, m.status, m.approver].map((c) => get(r, c).toLowerCase()).join('|');
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(r);
  }

  const subteams = new Set();
  const requests = [...groups.values()].map((rows) => {
    const first = rows[0];
    const subteam = get(first, m.subteam);
    if (subteam) subteams.add(subteam);
    const statusText = get(first, m.status);
    const approver = get(first, m.approver);
    const status = mapStatus(statusText, approver);

    const items = rows.map((r) => {
      const qtyText = get(r, m.quantity);
      const qm = qtyText.match(/^\s*(\d*\.?\d+)\s*(.*)$/);
      const qty = qm ? Number(qm[1]) : 1;
      const gross = toNumber(get(r, m.cost)); // the sheets record the line total
      const vendorText = get(r, m.vendor);
      const shipText = get(r, m.shipping);
      const ship = toNumber(shipText);
      const shipNote = ship === null && shipText && !/^(n\/?a|none|-|0)$/i.test(shipText) ? `Shipping: ${shipText}` : '';
      const data = {};
      for (const x of extra) if (r.values[x.header]) data[x.key] = r.values[x.header];
      return {
        item_name: get(r, m.item),
        vendor: hostOf(vendorText.match(/https?:\/\/\S+/)?.[0] || ''),
        product_link: vendorText,
        part_number: '',
        quantity: String(qty),
        unit_price: gross === null ? '' : String(Math.round((gross / (qty || 1)) * 10000) / 10000),
        shipping_cost: ship === null ? '' : String(ship),
        notes: [get(r, m.info), qtyText && qtyText !== String(qty) ? `Qty: ${qtyText}` : '', gross === null && get(r, m.cost) ? `Cost: ${get(r, m.cost)}` : '', shipNote]
          .filter(Boolean)
          .join(' · '),
        data,
      };
    });

    const descriptions = [...new Set(rows.map((r) => get(r, m.description)).filter(Boolean))];
    const firstItem = items[0].item_name || 'Imported request';
    return {
      title: (firstItem.length > 80 ? firstItem.slice(0, 77) + '…' : firstItem) + (items.length > 1 ? ` (+${items.length - 1} more)` : ''),
      requester: get(first, m.requester),
      subteam,
      subsystem: subsystemMap[subteam] ?? subteam,
      priority: priorityFor(get(first, m.priority)),
      justification: descriptions.join('\n'),
      date: isDate(get(first, m.date)) ? get(first, m.date) : null,
      status,
      approver: /do not/i.test(approver) ? '' : approver,
      ticket: get(first, m.ticket),
      received_notes: status === 'Received' ? statusText : '',
      items,
      total: items.reduce((s, i) => s + (Number(i.unit_price) || 0) * (Number(i.quantity) || 0) + (Number(i.shipping_cost) || 0), 0),
    };
  });

  return { requests, newItemFields, subteams: [...subteams], columns: m, extra };
}
