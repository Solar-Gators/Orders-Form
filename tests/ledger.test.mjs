/**
 * The Treasurer's ledger (js/ledger.js): lines from requests + purchases, the budget
 * table, funding totals, and reading the old Financials spreadsheet.   node tests/ledger.test.mjs
 */
import assert from 'node:assert/strict';
import { ledgerLines, budgetTable, fundingTotals, readFinancialsSheet } from '../js/ledger.js';

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message}`);
    process.exitCode = 1;
  }
}

const req = (id, status, total, cc, extra = {}) => ({ id, request_number: `SG-${id}`, title: `Req ${id}`, status, total, season: '2026-2027', data: { c_cc: cc }, ...extra });
const requests = [
  req(1, 'Approved', 100, 'Aero'),
  req(2, 'Ordered', 200, 'aero ', { order: { department_order_number: '6046', order_date: '2026-09-01' } }),
  req(3, 'Received', 50, 'Powertrain'),
  req(4, 'Submitted', 999, 'Aero'), // not approved yet: not in the ledger
  req(5, 'Approved', 70, 'Aero'),
  req(6, 'Approved', 10, 'Aero', { season: '2025-2026' }), // another season
];
const purchases = [
  { id: 'a', request_id: 1, dept: 'M', dept_status: 'sent', notes: 'PO# 27' },
  { id: 'b', request_id: 5, dept_status: 'cancelled' },
  { id: 'c', season: '2026-2027', description: 'CNC machining', amount: '3440', category: 'Extraneous', dept_status: 'sent', order_number: '6369' },
  { id: 'd', season: '2026-2027', description: 'Polycarb sheet', amount: null, category: 'Aero', dept_status: 'cancelled' },
  { id: 'e', season: '2025-2026', description: 'Old', amount: '5', dept_status: 'ordered' },
];

console.log("Treasurer's ledger");

test('lines: approved / ordered / received requests plus purchases on their own, for one season', () => {
  const lines = ledgerLines({ requests, purchases, field: 'c_cc', season: '2026-2027' });
  assert.deepEqual(lines.map((l) => `${l.key}:${l.status}`), ['r:1:sent', 'r:2:ordered', 'r:3:received', 'r:5:cancelled', 'p:c:sent', 'p:d:cancelled']);
  const one = lines.find((l) => l.key === 'r:1');
  assert.deepEqual([one.dept, one.notes, one.category, one.amount], ['M', 'PO# 27', 'Aero', 100]);
  assert.equal(lines.find((l) => l.key === 'r:2').orderNumber, '6046');
});

test('lines: the Treasurer can move a request to another category; blank follows the request', () => {
  const moved = [{ id: 'm', request_id: 3, category: 'Competition' }, { id: 'n', request_id: 1, category: '' }];
  const lines = ledgerLines({ requests, purchases: moved, field: 'c_cc', season: '2026-2027' });
  const three = lines.find((l) => l.key === 'r:3');
  assert.deepEqual([three.category, three.answer], ['Competition', 'Powertrain']);
  assert.equal(lines.find((l) => l.key === 'r:1').category, 'Aero');
  assert.equal(budgetTable(lines, { Competition: '500' }).rows.find((r) => r.category === 'Competition').spent, 50);
});

test("budget table: the Treasurer's order first, then budgeted, then the rest", () => {
  const lines = ledgerLines({ requests, purchases, field: 'c_cc', season: '2026-2027' });
  const { rows } = budgetTable(lines, { Aero: '1000', Powertrain: '40' }, ['extraneous', 'Powertrain']);
  assert.deepEqual(rows.map((r) => r.category), ['Extraneous', 'Powertrain', 'Aero']);
});

test('budget table: Paid counts as spent', () => {
  const lines = ledgerLines({ purchases: [{ id: 'x', season: '2026-2027', description: 'Debt', amount: '200', category: 'Aero', dept_status: 'paid' }], season: '2026-2027' });
  const aero = budgetTable(lines, { Aero: '500' }).rows[0];
  assert.deepEqual([aero.spent, aero.pipeline, aero.left], [200, 0, 300]);
});

test('budget table: spent, in the pipeline, left; cancelled lines and other seasons don\'t count', () => {
  const lines = ledgerLines({ requests, purchases, field: 'c_cc', season: '2026-2027' });
  const { rows, total } = budgetTable(lines, { Aero: '1000', Powertrain: '40', Competition: '14000' });
  const by = Object.fromEntries(rows.map((r) => [r.category, r]));
  assert.deepEqual([by.Aero.spent, by.Aero.pipeline, by.Aero.left], [200, 100, 700]); // "aero " matches Aero
  assert.equal(by.Powertrain.left, -10); // over budget
  assert.deepEqual([by.Competition.spent, by.Competition.left], [0, 14000]);
  assert.deepEqual([by.Extraneous.budget, by.Extraneous.pipeline, by.Extraneous.left], [null, 3440, null]); // no budget set
  assert.deepEqual(rows.map((r) => r.category), ['Aero', 'Powertrain', 'Competition', 'Extraneous']); // budgeted first
  assert.deepEqual(total, { budget: 15040, spent: 250, pipeline: 3540, left: 11250 });
});

test('funding totals include what the Sponsors board brought in', () => {
  assert.deepEqual(fundingTotals([{ expected: '31000', received: '31000' }, { expected: '8000', received: '' }], 2500), { expected: 41500, received: 33500 });
});

test("reading the old Financials sheet: ledger with status colors, budgets, rainy day, notes", () => {
  // A small copy of the real layout: title row, totals row, header row 3, ledger in B..I, budget table in J..M.
  const cells = {
    'J1': 'Rainy Day Funds Balance:', 'K1': '2128.75',
    'B3': 'Legend', 'D3': 'Item Description', 'E3': 'Cost', 'F3': 'M/E', 'G3': 'Subteam', 'H3': 'Order #', 'I3': 'Notes',
    'J3': 'Total Budget (as of 1st Budget Meeting)', 'K3': '60917', 'L3': '55154.44', 'M3': '5762.56',
    'B4': 'Request Sent', 'D4': 'Wheel Stud Replacement', 'E4': '39.53', 'F4': 'M', 'I4': 'First order', 'J4': 'Competition', 'K4': '14000',
    'D5': 'Flex Conduit', 'F5': 'M', 'I5': 'Cancelled, was $27.99', 'J5': 'Aero', 'K5': '15000',
    'D6': 'CNC Machining', 'E6': '3440', 'F6': 'M', 'G6': 'Extraneous', 'H6': '6369', 'I6': 'Submitted PayPal link', 'J6': 'Extraneous', 'K6': '11300',
    'D7': 'Spray guns', 'E7': '79.98', 'G7': 'Aero', 'H7': '6356',
    'J9': 'Notes', 'J10': '$13,970 minimum for competition', 'J11': 'could get $5400 from ECE',
  };
  const fills = { D4: 'FF00B050', D5: 'FFFF0000', D6: 'FFA9D08E', D7: 'FFFFAAA4' };
  const letter = (c) => String.fromCharCode(64 + c);
  const sheet = { rows: 12, cols: 13, value: (r, c) => cells[`${letter(c)}${r}`] ?? '', fill: (r, c) => fills[`${letter(c)}${r}`] ?? '' };
  const out = readFinancialsSheet(sheet);
  assert.deepEqual(out.purchases.map((p) => `${p.description}|${p.amount}|${p.dept_status}|${p.category}|${p.order_number}`), [
    'Wheel Stud Replacement|39.53|ordered||',
    'Flex Conduit||cancelled||',
    'CNC Machining|3440|dept_approved|Extraneous|6369',
    'Spray guns|79.98|sent|Aero|6356',
  ]);
  assert.deepEqual(out.budgets, { Competition: '14000', Aero: '15000', Extraneous: '11300' });
  assert.equal(out.rainyDay, '2128.75');
  assert.equal(out.notes, '$13,970 minimum for competition\ncould get $5400 from ECE');
  assert.throws(() => readFinancialsSheet({ rows: 3, cols: 3, value: () => 'x', fill: () => '' }), /Item Description/);
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
