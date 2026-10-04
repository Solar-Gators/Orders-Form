/**
 * Builds and downloads the .xlsx export in the browser (there is no server on
 * GitHub Pages).
 *
 * Export templates (Admin → Exports) pick columns from a catalog: every request
 * field, every item field, and workflow values (status, approval, order, …).
 * The built-in "Full export" is one row per item with every column, and it
 * follows the form automatically: renaming or adding a field changes it too.
 */
import { STATUS, statusLabel } from './ui.js';
import { requestFields, itemFields, shown, answerable, getValue, MONEY_FIELDS, shippingPerRequest } from './formFields.js';

const EXCELJS_URL = 'https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js';
const CURRENCY = '"$"#,##0.00';
const DATE = 'yyyy-mm-dd';

/** Column width from the field type/label. */
function widthFor(field) {
  if (field.key === 'title' || field.key === 'item_name') return 30;
  if (field.type === 'textarea') return 40;
  if (field.type === 'url') return 36;
  if (field.type === 'date' || field.type === 'number') return Math.max(12, field.label.length + 2);
  return Math.min(30, Math.max(14, field.label.length + 4));
}

/** Export type for a form field: currency | date | link | number | text. */
function typeFor(field) {
  if (MONEY_FIELDS.has(field.key)) return 'currency';
  if (field.type === 'date') return 'date';
  if (field.type === 'url') return 'link';
  if (field.type === 'number') return 'number';
  return 'text';
}

// Workflow values that aren't form fields. `perItem` columns need one row per item.
const COMPUTED = {
  id: { header: 'Request ID', width: 12, get: (r) => r.request_number },
  season: { header: 'Season', width: 11, get: (r) => r.season },
  requested: { header: 'Requested', width: 12, type: 'date', get: (r) => localDate(r.created_at) },
  status: { header: 'Request Status', width: 18, get: (r) => statusLabel(r.status) },
  vendor: { header: 'Vendor', width: 18, get: (r) => r.vendors.join(', ') },
  itemCount: { header: 'Items', width: 8, type: 'number', get: (r) => r.items.length },
  itemTotal: { header: 'Item Total', width: 12, type: 'currency', perItem: true, get: (r, i) => i.item_total },
  subtotal: { header: 'Items Subtotal', width: 14, type: 'currency', get: (r) => r.subtotal },
  shipping: { header: 'Request Shipping', width: 16, type: 'currency', get: (r) => r.shipping },
  total: { header: 'Request Total', width: 14, type: 'currency', get: (r) => r.total },
  approver: { header: 'Approver', width: 18, get: (r, i, x) => x.approval.approver },
  approvalDate: { header: 'Approval Date', width: 14, type: 'date', get: (r, i, x) => localDate(x.approval.created_at) },
  approvalComment: { header: 'Approval Comment', width: 36, get: (r, i, x) => x.approval.comment },
  orderDate: { header: 'Order Date', width: 12, type: 'date', get: (r, i, x) => x.order.order_date },
  ticket: { header: 'Department Order Number', width: 24, get: (r, i, x) => x.order.department_order_number },
  treasurerNotes: { header: 'Treasurer Notes', width: 36, get: (r, i, x) => x.order.treasurer_notes },
  receivedDate: { header: 'Received Date', width: 14, type: 'date', get: (r, i, x) => x.order.received_date },
  receivedNotes: { header: 'Received Notes', width: 30, get: (r, i, x) => x.order.received_notes },
};

/**
 * Every column a template can use, keyed like "request:title", "item:vendor", "status".
 * Each: { key, header, width, type, get(request, item, extra), group, perItem }.
 */
export function exportCatalog(config) {
  const fromField = (field, source) => ({
    key: `${source}:${field.key}`,
    header: field.label,
    width: widthFor(field),
    type: typeFor(field),
    group: source === 'item' ? 'Item fields' : 'Request fields',
    perItem: source === 'item',
    get: (r, item) => getValue(source === 'item' ? item : r, field),
  });
  return [
    ...answerable(shown(requestFields(config))).map((f) => fromField(f, 'request')),
    ...shown(itemFields(config)).map((f) => fromField(f, 'item')),
    ...Object.entries(COMPUTED).map(([key, c]) => ({ ...c, key, group: 'Workflow & totals' })),
  ];
}

/** The built-in template: one row per item, every column (what the Export page always did). */
export function fullTemplate(config) {
  const keys = (list, source) => list.map((f) => `${source}:${f.key}`);
  return {
    id: 'full',
    name: 'Full export (one row per item)',
    builtIn: true,
    rowPer: 'item',
    columns: [
      'id', 'season',
      ...keys(answerable(shown(requestFields(config))), 'request'),
      'status',
      // Whole-order shipping is the "Request Shipping" column, not a per-item one.
      ...keys(shown(itemFields(config)).filter((f) => !(shippingPerRequest(config) && f.key === 'shipping_cost')), 'item'),
      'itemTotal', 'shipping', 'total',
      'approver', 'approvalDate', 'approvalComment', 'orderDate', 'ticket', 'treasurerNotes', 'receivedDate', 'receivedNotes',
    ],
    statuses: [],
    fileName: '',
  };
}

/** All templates: the built-in one first, then the team's saved ones. */
export function exportTemplates(config) {
  return [fullTemplate(config), ...((config.exports?.templates || []).filter((t) => t && t.id && t.id !== 'full'))];
}

/** A template's columns (skipping any whose field no longer exists). */
export function templateColumns(template, config) {
  const catalog = new Map(exportCatalog(config).map((c) => [c.key, c]));
  return template.columns
    .map((k) => catalog.get(k))
    .filter(Boolean)
    .filter((c) => template.rowPer === 'item' || !c.perItem)
    .map((c) => ({ ...c, header: template.headers?.[c.key] || c.header }));
}

let loading = null;
export function loadExcelJS() {
  if (window.ExcelJS) return Promise.resolve(window.ExcelJS);
  loading ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = EXCELJS_URL;
    s.onload = () => resolve(window.ExcelJS);
    s.onerror = () => {
      loading = null;
      reject(new Error('Could not load the Excel library. Check your internet connection.'));
    };
    document.head.appendChild(s);
  });
  return loading;
}

/** "YYYY-MM-DD" -> Date at UTC midnight (ExcelJS writes dates as UTC). */
function toExcelDate(ymd) {
  const [y, m, d] = ymd.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/** ISO timestamp -> local calendar date "YYYY-MM-DD". */
function localDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function cellValue(col, value) {
  if (value === '' || value === null || value === undefined) return null;
  if (col.type === 'date') return /^\d{4}-\d{2}-\d{2}/.test(value) ? toExcelDate(value) : value;
  if (col.type === 'link' && /^https?:\/\//i.test(value)) return { text: value, hyperlink: value };
  if ((col.type === 'number' || col.type === 'currency') && value !== '' && !Number.isNaN(Number(value))) return Number(value);
  return value;
}

/** Build and download a workbook. `template` defaults to the full export. */
export async function downloadWorkbook(requests, config, template = fullTemplate(config)) {
  const columns = templateColumns(template, config);
  const perItem = template.rowPer !== 'request';
  if (template.statuses?.length) requests = requests.filter((r) => template.statuses.includes(r.status));
  const ExcelJS = await loadExcelJS();
  const wb = new ExcelJS.Workbook();
  wb.creator = `${config.teamName} Orders`;
  wb.created = new Date();

  const ws = wb.addWorksheet('Order Requests', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = columns.map((c, i) => ({ header: c.header, key: `c${i}`, width: c.width }));

  const sorted = [...requests].sort((a, b) => a.created_at.localeCompare(b.created_at));
  for (const r of sorted) {
    // Once a request is edited/resubmitted, the earlier decision no longer applies.
    const decisionIsCurrent = ![STATUS.DRAFT, STATUS.SUBMITTED].includes(r.status);
    const extra = { approval: (decisionIsCurrent && r.latest_approval) || {}, order: r.order || {} };
    for (const item of perItem && r.items.length ? r.items : [{ data: {} }]) {
      ws.addRow(Object.fromEntries(columns.map((c, i) => [`c${i}`, cellValue(c, c.get(r, item, extra))])));
    }
  }

  columns.forEach((col, i) => {
    const column = ws.getColumn(i + 1);
    if (col.type === 'currency') column.numFmt = CURRENCY;
    if (col.type === 'date') column.numFmt = DATE;
    if (col.type === 'link') column.font = { color: { argb: 'FF1D4ED8' }, underline: true };
  });

  const header = ws.getRow(1);
  header.height = 20;
  header.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0B2545' } };
    cell.alignment = { vertical: 'middle' };
    cell.numFmt = '@';
  });
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };

  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const base = (template.fileName || `${config.teamName} Orders ${config.season}`).replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  a.download = `${base || 'Orders'}_${localDate(new Date().toISOString())}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  return requests.length; // how many requests were exported
}
