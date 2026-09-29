/**
 * Builds and downloads the .xlsx export in the browser (there is no server on
 * GitHub Pages). One row per order item; request-level fields repeat on each
 * row so the sheet can be filtered and pivoted in Excel.
 *
 * Columns follow the form settings (Admin → Form fields): every shown request
 * field, then every shown item field, then the workflow columns. Renaming or
 * adding a field changes the export automatically.
 */
import { STATUS } from './ui.js';
import { requestFields, itemFields, shown, getValue } from './formFields.js';

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
  if (field.key === 'unit_price') return 'currency';
  if (field.type === 'date') return 'date';
  if (field.type === 'url') return 'link';
  if (field.type === 'number') return 'number';
  return 'text';
}

/**
 * Each column: { header, width, type, get(request, item, extra) }.
 * `extra` holds per-request workflow values (approval, order).
 */
export function buildColumns(config) {
  const fromField = (field, source) => ({
    header: field.label,
    width: widthFor(field),
    type: typeFor(field),
    get: (r, item) => getValue(source === 'item' ? item : r, field),
  });
  return [
    { header: 'Request ID', width: 12, get: (r) => r.request_number },
    ...shown(requestFields(config)).map((f) => fromField(f, 'request')),
    { header: 'Request Status', width: 18, get: (r) => r.status },
    ...shown(itemFields(config)).map((f) => fromField(f, 'item')),
    { header: 'Item Total', width: 12, type: 'currency', get: (r, i) => i.item_total },
    { header: 'Request Total', width: 14, type: 'currency', get: (r) => r.total },
    { header: 'Approver', width: 18, get: (r, i, x) => x.approval.approver },
    { header: 'Approval Date', width: 14, type: 'date', get: (r, i, x) => localDate(x.approval.created_at) },
    { header: 'Approval Comment', width: 36, get: (r, i, x) => x.approval.comment },
    { header: 'Order Date', width: 12, type: 'date', get: (r, i, x) => x.order.order_date },
    { header: 'Department Order Number', width: 24, get: (r, i, x) => x.order.department_order_number },
    { header: 'Treasurer Notes', width: 36, get: (r, i, x) => x.order.treasurer_notes },
    { header: 'Received Date', width: 14, type: 'date', get: (r, i, x) => x.order.received_date },
    { header: 'Received Notes', width: 30, get: (r, i, x) => x.order.received_notes },
  ];
}

let loading = null;
function loadExcelJS() {
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

export async function downloadWorkbook(requests, config, columns = buildColumns(config)) {
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
    for (const item of r.items.length ? r.items : [{ data: {} }]) {
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
  a.download = `${config.teamName.replace(/[^A-Za-z0-9]+/g, '')}_Orders_${config.season}_${localDate(new Date().toISOString())}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
