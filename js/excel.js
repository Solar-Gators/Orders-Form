/**
 * Builds and downloads the .xlsx export in the browser (there is no server on
 * GitHub Pages). One row per order item; request-level fields repeat on each
 * row so the sheet can be filtered and pivoted in Excel.
 *
 * COLUMNS is the export "template". More templates can be added as more lists.
 */
import { STATUS } from './ui.js';

const EXCELJS_URL = 'https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js';
const CURRENCY = '"$"#,##0.00';
const DATE = 'yyyy-mm-dd';

// type: 'currency' | 'date' | 'link' | undefined (plain text/number)
export const COLUMNS = [
  { header: 'Request ID', key: 'request_number', width: 12 },
  { header: 'Request Title', key: 'title', width: 30 },
  { header: 'Requester', key: 'requester', width: 18 },
  { header: 'Subsystem', key: 'subsystem', width: 14 },
  { header: 'Priority', key: 'priority', width: 10 },
  { header: 'Needed By', key: 'needed_by', width: 12, type: 'date' },
  { header: 'Request Status', key: 'status', width: 18 },
  { header: 'Request Justification', key: 'justification', width: 40 },
  { header: 'Item Name', key: 'item_name', width: 28 },
  { header: 'Vendor', key: 'vendor', width: 18 },
  { header: 'Product Link', key: 'product_link', width: 36, type: 'link' },
  { header: 'Part Number', key: 'part_number', width: 18 },
  { header: 'Quantity', key: 'quantity', width: 10 },
  { header: 'Unit Price', key: 'unit_price', width: 12, type: 'currency' },
  { header: 'Item Total', key: 'item_total', width: 12, type: 'currency' },
  { header: 'Request Total', key: 'request_total', width: 14, type: 'currency' },
  { header: 'Approver', key: 'approver', width: 18 },
  { header: 'Approval Date', key: 'approval_date', width: 14, type: 'date' },
  { header: 'Approval Comment', key: 'approval_comment', width: 36 },
  { header: 'Order Date', key: 'order_date', width: 12, type: 'date' },
  { header: 'Department Order Number', key: 'department_order_number', width: 24 },
  { header: 'Treasurer Notes', key: 'treasurer_notes', width: 36 },
  { header: 'Received Date', key: 'received_date', width: 14, type: 'date' },
  { header: 'Received Notes', key: 'received_notes', width: 30 },
];

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

function toRows(requests) {
  const rows = [];
  for (const r of requests) {
    // Once a request is edited/resubmitted, the earlier decision no longer applies.
    const decisionIsCurrent = ![STATUS.DRAFT, STATUS.SUBMITTED].includes(r.status);
    const approval = (decisionIsCurrent && r.latest_approval) || {};
    const order = r.order || {};
    const base = {
      request_number: r.request_number,
      title: r.title,
      requester: r.requester,
      subsystem: r.subsystem,
      priority: r.priority,
      needed_by: r.needed_by,
      status: r.status,
      justification: r.justification,
      request_total: r.total,
      approver: approval.approver,
      approval_date: localDate(approval.created_at),
      approval_comment: approval.comment,
      order_date: order.order_date,
      department_order_number: order.department_order_number,
      treasurer_notes: order.treasurer_notes,
      received_date: order.received_date,
      received_notes: order.received_notes,
    };
    for (const item of r.items.length ? r.items : [{}]) {
      rows.push({
        ...base,
        item_name: item.item_name,
        vendor: item.vendor,
        product_link: item.product_link,
        part_number: item.part_number,
        quantity: item.quantity,
        unit_price: item.unit_price,
        item_total: item.item_total,
      });
    }
  }
  return rows;
}

function cellValue(col, value) {
  if (value === '' || value === null || value === undefined) return null;
  if (col.type === 'date') return toExcelDate(value);
  if (col.type === 'link' && /^https?:\/\//i.test(value)) return { text: value, hyperlink: value };
  return value;
}

export async function downloadWorkbook(requests, config, columns = COLUMNS) {
  const ExcelJS = await loadExcelJS();
  const wb = new ExcelJS.Workbook();
  wb.creator = `${config.teamName} Orders`;
  wb.created = new Date();

  const ws = wb.addWorksheet('Order Requests', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = columns.map((c) => ({ header: c.header, key: c.key, width: c.width }));

  const sorted = [...requests].sort((a, b) => a.created_at.localeCompare(b.created_at));
  for (const row of toRows(sorted)) {
    ws.addRow(Object.fromEntries(columns.map((c) => [c.key, cellValue(c, row[c.key])])));
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
