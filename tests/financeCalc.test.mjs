/**
 * Finances calculated columns (js/financeCalc.js): budgets, order totals, lookups,
 * request details, math and running totals.   node tests/financeCalc.test.mjs
 */
import assert from 'node:assert/strict';
import { computeRows, runningTotals, explain, checkColumns, toNumber, requestDetails } from '../js/financeCalc.js';

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

const req = (n, status, total, cc, season = '2026-2027') => ({ id: n, request_number: n, title: `Req ${n}`, status, total, season, data: { c_cost_center: cc } });
const requests = [
  req('SG-1', 'Ordered', 100, 'Powertrain'),
  req('SG-2', 'Received', 50.25, 'powertrain '), // spelled differently
  req('SG-3', 'Approved', 30, 'Powertrain'),
  req('SG-4', 'Submitted', 999, 'Powertrain'),
  req('SG-5', 'Ordered', 400, 'Electrical'),
  req('SG-6', 'Ordered', 7, 'Powertrain', '2025-2026'), // last season
];

const income = {
  sheet: { id: 'inc', name: 'Income', columns: [
    { key: 'from', label: 'From', type: 'text' }, { key: 'type', label: 'Type', type: 'select' },
    { key: 'cc', label: 'Cost center', type: 'select' }, { key: 'amt', label: 'Amount', type: 'money' },
  ] },
  rows: [
    { id: 'i1', data: { from: 'Acme', type: 'Sponsorship', cc: 'Powertrain', amt: '500' } },
    { id: 'i2', data: { from: 'Jo', type: 'Donation', amt: '$1,000.50' } },
    { id: 'i3', data: { from: 'Bolt Co', type: 'sponsorship', cc: 'Electrical', amt: '(20)' } },
  ],
};

const budgetSheet = [
  { key: 'cc', label: 'Cost center', type: 'select', source: 'form:c_cost_center' },
  { key: 'budget', label: 'Budget', type: 'budget', by: 'cc' },
  { key: 'spent', label: 'Spent', type: 'orders', metric: 'spent', by: 'cc', field: 'c_cost_center' },
  { key: 'wait', label: 'Approved', type: 'orders', metric: 'to_order', by: 'cc', field: 'c_cost_center' },
  { key: 'spons', label: 'Sponsored', type: 'lookup', sheet: 'inc', col: 'amt', match: { theirs: 'cc', mine: 'cc' }, where: { col: 'type', value: 'Sponsorship' } },
  { key: 'left', label: 'Left', type: 'math', terms: [{ op: '+', col: 'budget' }, { op: '-', col: 'spent' }, { op: '-', col: 'wait' }] },
];
const ctx = {
  requests,
  season: '2026-2027',
  budgets: { field: 'c_cost_center', amounts: { Powertrain: '3000', Electrical: '300' } },
  sheets: new Map([['inc', income]]),
};

console.log('Finances: calculated columns');

test('budget, spent, approved, sponsored and left per cost center (this season, forgiving matches)', () => {
  const rows = [{ id: 'a', data: { cc: 'Powertrain' } }, { id: 'b', data: { cc: 'Electrical' } }, { id: 'c', data: {} }];
  const v = computeRows(budgetSheet, rows, ctx);
  assert.deepEqual(
    ['budget', 'spent', 'wait', 'spons', 'left'].map((k) => v.get('a')[k]),
    [3000, 150.25, 30, 500, 2819.75]
  );
  assert.deepEqual(['budget', 'spent', 'spons', 'left'].map((k) => v.get('b')[k]), [300, 400, -20, -100]);
  // A row with no cost center yet shows blanks, not the whole team's totals.
  assert.deepEqual(['budget', 'spent', 'spons', 'left'].map((k) => v.get('c')[k]), ['', '', '', 0]);
});

test('whole-team totals and all seasons', () => {
  const cols = [
    { key: 'in', label: 'Money in', type: 'lookup', sheet: 'inc', col: 'amt' },
    { key: 'out', label: 'Spent', type: 'orders', metric: 'spent' },
    { key: 'ever', label: 'Spent ever', type: 'orders', metric: 'spent', season: 'all' },
    { key: 'pool', label: 'Left in pool', type: 'math', terms: [{ op: '+', col: 'in' }, { op: '-', col: 'out' }] },
  ];
  const v = computeRows(cols, [{ id: 'x', data: {} }], ctx).get('x');
  assert.deepEqual([v.in, v.out, v.ever, v.pool], [1480.5, 550.25, 557.25, 930.25]);
});

test('"click to see why" lists exactly what was added up', () => {
  const e = explain(budgetSheet[2], { id: 'a', data: { cc: 'Powertrain' } }, {}, ctx);
  assert.deepEqual(e.items.map((i) => i.label.split(' ')[0]), ['SG-1', 'SG-2']);
  assert.match(e.text, /Spent .*2026-2027 season, Powertrain/);
  const s = explain(budgetSheet[4], { id: 'a', data: { cc: 'Powertrain' } }, {}, ctx);
  assert.deepEqual(s.items, [{ label: 'Acme', amount: 500 }]);
});

test('request details and running totals (in the order shown)', () => {
  const cols = [
    { key: 'req', label: 'Request', type: 'request' },
    { key: 'tot', label: 'Total', type: 'reqinfo', req: 'req', detail: 'total' },
    { key: 'cc', label: 'Cost center', type: 'reqinfo', req: 'req', detail: 'field:c_cost_center' },
    { key: 'bal', label: 'Balance', type: 'running', of: 'tot' },
  ];
  const rows = [{ id: 'r1', data: { req: 'SG-5' } }, { id: 'r2', data: { req: 'sg-1' } }, { id: 'r3', data: { req: 'SG-404' } }];
  const ctx2 = { ...ctx, details: requestDetails([{ key: 'c_cost_center', label: 'Cost center', type: 'select' }]) };
  const v = computeRows(cols, rows, ctx2);
  assert.deepEqual([v.get('r1').tot, v.get('r1').cc, v.get('r2').tot, v.get('r3').tot], [400, 'Electrical', 100, '']);
  const run = runningTotals(cols, [rows[1], rows[0], rows[2]], v);
  assert.deepEqual([run.get('r2').bal, run.get('r1').bal, run.get('r3').bal], [100, 500, 500]);
});

test('setups that would break are explained before saving', () => {
  const sheets = new Map([['inc', income]]);
  assert.deepEqual(checkColumns(budgetSheet, sheets, ctx.budgets), []);
  const bad = checkColumns([
    { key: 'm', label: 'Loop', type: 'math', terms: [{ op: '+', col: 'm2' }] },
    { key: 'm2', label: 'Other math', type: 'math', terms: [{ op: '+', col: 'm' }] },
    { key: 'l', label: 'Lookup', type: 'lookup', sheet: 'inc', col: 'from' },
    { key: 'g', label: 'Gone', type: 'lookup', sheet: 'deleted', col: 'amt' },
    { key: 'r', label: 'Run', type: 'running', of: 'r' },
    { key: 'b', label: 'Budget', type: 'budget', by: 'nope' },
    { key: 'q', label: 'Info', type: 'reqinfo', req: 'm' },
  ], sheets);
  assert.ok(bad.some((p) => /Loop.*can only use/.test(p)), 'math cannot use math');
  assert.ok(bad.some((p) => /Lookup.*Money or Number/.test(p)));
  assert.ok(bad.some((p) => /Gone.*choose a sheet/.test(p)));
  assert.ok(bad.some((p) => /Run.*amount column/.test(p)));
  assert.ok(bad.some((p) => /Budget.*Cost center/.test(p)));
  assert.ok(bad.some((p) => /Info.*Request column/.test(p)));
  const wrongField = checkColumns([{ key: 's', label: 'Sub', type: 'select', source: 'form:subsystem' }, { key: 'b', label: 'Budget', type: 'budget', by: 's' }], sheets, ctx.budgets);
  assert.ok(wrongField.some((p) => /budgets are set per another field/.test(p)));
});

test('amounts: $, commas, accounting negatives, blanks', () => {
  assert.deepEqual(['$1,234.50', '(12.50)', '-3', '', 'abc', 7].map(toNumber), [1234.5, -12.5, -3, 0, 0, 7]);
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
