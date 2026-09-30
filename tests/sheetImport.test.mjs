/**
 * Column recognition for the team's old order sheets. The headers below are
 * copied from the real 2024-25, 2025-26 and 2026-27 sheets (no order data).
 *
 *   npm run test:import
 */
import assert from 'node:assert/strict';
import { detectColumns, toRequests, guessSeason, guessSubsystem } from '../js/sheetImport.js';

const SHEETS = {
  '2024-2025': ['Column A', 'Requestor', 'Date', 'Subteam', 'Item Name & Quantity', 'Vendor Website',
    'Description of why you need this these item(s). (Please be as descriptive as possible, makes it easier for to approval)',
    'Gross Cost (cost before shipping)', 'Shipping Cost', 'From China?', 'Additional Info (Special Ordering/Delivery Instructions)',
    'Priority (High, Med, Low)', 'Potential Scholarship Funding?', 'CE Approval (ONLY CEs)', 'Order Status (ONLY TREASURER)',
    'Ticket Number', 'Date Received', 'Column S'],
  '2025-2026': ['Requester', 'Date', 'Subteam', 'Item Name', 'Quantity', 'Vendor Website',
    'Description of why you need this these item(s). (Please be as descriptive as possible, makes it easier for approval)',
    'Gross Cost (Before Shipping)', 'Shipping Costs', 'From China', 'Additional Info (Special Ordering/Delivery Instructions)',
    'Potential Scholarship Funding', 'Priority Level', 'CE Approval (ONLY CEs)', 'Order Status (ONLY TREASURER)', 'Ticket Number',
    'Column R', 'Column S', 'Column T'],
  '2026-2027': ['Requester', 'Date', 'Subteam', 'Item Name', 'Quantity', 'Vendor Website',
    'Description of why you need this item(s). (Please be as descriptive as possible, makes it easier for approval)',
    'Gross Cost (Before Shipping)', 'Shipping Costs', 'From China', 'Additional Info (Special Ordering/Delivery Instructions)',
    'Potential Scholarship Funding', 'Priority Level', 'CE Approval (ONLY CEs)', 'Order Status (ONLY TREASURER)', 'Ticket Number'],
};

let passed = 0;
const test = (name, fn) => {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message}`);
    process.exitCode = 1;
  }
};

for (const [season, columns] of Object.entries(SHEETS)) {
  test(`${season}: every key column is recognised correctly`, () => {
    const m = detectColumns(columns);
    assert.match(m.requester, /^Request(o|e)r$/);
    assert.equal(m.date, 'Date'); // not "Date Received"
    assert.equal(m.subteam, 'Subteam');
    assert.match(m.item, /^Item Name/);
    assert.match(m.cost, /^Gross Cost/);
    assert.match(m.shipping, /^Shipping Costs?$/); // not "Gross Cost (Before Shipping)"
    assert.match(m.approver, /^CE Approval/);
    assert.match(m.status, /^Order Status/);
    assert.equal(m.ticket, 'Ticket Number');
  });
}

test('this season: shipping goes into Shipping, price stays in Unit price', () => {
  const columns = SHEETS['2026-2027'];
  const row = (values) => ({ row_number: 2, values: Object.fromEntries(columns.map((c, i) => [c, values[i] ?? '']).filter(([, v]) => v)) });
  const sheet = {
    columns,
    rows: [
      row(['Anneliese', '2026-08-25', 'Structures', 'Primer kit', '1', 'https://www.fibreglast.com/x', 'Plug', '153.78', '36.03', 'no', '', '', 'High', 'Griffin', 'Ordered', '5986']),
      row(['Griffin', '2026-08-25', 'Mech', 'Laser level', '1', 'https://a.co/d/x', 'Datum', '32.49', 'N/A (Prime)', 'No', '', '', 'HIGH', 'Griffin', 'Received', '5987']),
    ],
  };
  const config = { subsystems: ['Battery'], priorities: ['Normal', 'High', 'Urgent'], defaultPriority: 'Normal' };
  const { requests, newItemFields } = toRequests(sheet, { config, itemFields: [] });
  const [primer, laser] = requests.map((r) => r.items[0]);
  assert.deepEqual([primer.unit_price, primer.shipping_cost], ['153.78', '36.03']);
  assert.deepEqual([laser.unit_price, laser.shipping_cost, laser.vendor], ['32.49', '', 'amazon.com']);
  assert.match(laser.notes, /Shipping: N\/A \(Prime\)/);
  assert.ok(!newItemFields.some((f) => /shipping/i.test(f.label)), 'shipping must not become a custom field');
  assert.equal(requests[0].total, 153.78 + 36.03);
  assert.equal(requests[1].priority, 'High');
});

test('season is guessed from the file name', () => {
  assert.equal(guessSeason('24-25 Budget (1).xlsx'), '2024-2025');
  assert.equal(guessSeason('Solar Gators Order Page_2025-2026.xlsx'), '2025-2026');
});

test('old subteam names map to current subsystems', () => {
  const subs = ['Battery', 'Aero', 'Electrical'];
  assert.equal(guessSubsystem('Batt Pack', subs), 'Battery');
  assert.equal(guessSubsystem('Aero/Structures', subs), 'Aero');
  assert.equal(guessSubsystem('Electrical - Telem', subs), 'Electrical');
  assert.equal(guessSubsystem('Mech', subs), '');
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
