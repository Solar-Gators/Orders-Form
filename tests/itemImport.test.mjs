/**
 * Importing a parts list into a request (js/itemImport.js): pasted cells, CSV,
 * recognising columns, and turning rows into items.   node tests/itemImport.test.mjs
 */
import assert from 'node:assert/strict';
import { parsePasted, parseDelimited, findHeaderRow, guessMapping, toItems, toMoney, byVendor, importableFields, TEMPLATE_EXAMPLE } from '../js/itemImport.js';

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

// The default item fields (shipping is per request by default, so it isn't importable).
const config = {
  itemFields: [
    { key: 'item_name', label: 'Item name', type: 'text', builtin: true, required: true },
    { key: 'vendor', label: 'Vendor', type: 'text', builtin: true, required: true },
    { key: 'product_link', label: 'Product link', type: 'url', builtin: true },
    { key: 'part_number', label: 'Part number', type: 'text', builtin: true },
    { key: 'quantity', label: 'Quantity', type: 'number', builtin: true, required: true },
    { key: 'unit_price', label: 'Unit price', type: 'number', builtin: true, required: true },
    { key: 'shipping_cost', label: 'Shipping', type: 'number', builtin: true },
    { key: 'notes', label: 'Notes', type: 'textarea', builtin: true },
    { key: 'c_grade', label: 'Grade', type: 'select', options: ['A', 'B'] },
  ],
};
const fields = importableFields(config);
const rowsOf = (grid, header) => grid.slice(header + 1).map((cells, i) => ({ n: header + i + 2, cells }));
const pick = (items, key) => items.map((i) => i[key] ?? i.data[key]);

console.log('Importing a parts list');

test('fields: everything on the item form except whole-order shipping', () => {
  assert.deepEqual(fields.map((f) => f.key), ['item_name', 'vendor', 'product_link', 'part_number', 'quantity', 'unit_price', 'notes', 'c_grade']);
});

test('pasted cells from Excel / Google Sheets (tabs), and CSV with quotes', () => {
  assert.deepEqual(parsePasted('Part\tPrice\r\nBolt\t$1.50\r\n\r\n'), [['Part', 'Price'], ['Bolt', '$1.50']]);
  assert.deepEqual(parseDelimited('Part,Price,Notes\n"Bolt, M5","$1,234.50","say ""hi"""\n', ','), [['Part', 'Price', 'Notes'], ['Bolt, M5', '$1,234.50', 'say "hi"']]);
  assert.deepEqual(parsePasted('Part,Price\nNut,0.10'), [['Part', 'Price'], ['Nut', '0.10']]);
  // Excel's CSV with European number settings: semicolons, comma decimals.
  assert.deepEqual(parsePasted('Item;Qty;Price\nCable;2;1.234,50'), [['Item', 'Qty', 'Price'], ['Cable', '2', '1.234,50']]);
});

test('header row: skips a title line above the table; -1 when there are no headers', () => {
  assert.equal(findHeaderRow([['Battery box parts'], [], ['Qty', 'Description', 'Price']]), 2);
  assert.equal(findHeaderRow([['M5 bolt', '2', '1.50'], ['Nut', '4', '0.10']]), -1);
});

test('columns: a McMaster-Carr style cart', () => {
  const m = guessMapping(['Line', 'Quantity', 'Part Number', 'Description', 'Price Each', 'Total'], fields);
  assert.deepEqual(m, { quantity: 1, part_number: 2, item_name: 3, unit_price: 4, _total: 5 });
});

test('columns: a Digi-Key style export and a home-made list', () => {
  assert.deepEqual(
    guessMapping(['Index', 'Quantity', 'Part Number', 'Manufacturer Part Number', 'Description', 'Customer Reference', 'Unit Price', 'Extended Price'], fields),
    { quantity: 1, part_number: 2, item_name: 4, unit_price: 6, _total: 7 }
  );
  assert.deepEqual(guessMapping(['Part', 'Qty', 'Cost', 'Supplier', 'Link', 'Comments'], fields),
    { quantity: 1, unit_price: 2, vendor: 3, product_link: 4, notes: 5, item_name: 0 });
});

test('columns: the downloaded template matches by label exactly', () => {
  const m = guessMapping(fields.map((f) => f.label), fields);
  assert.deepEqual(m, Object.fromEntries(fields.map((f, i) => [f.key, i])));
});

test('columns: the team\'s old sheets ("Vendor Website" is the link), and linked cells keep their address', () => {
  const headers = ['Requester', 'Item Name', 'Quantity', 'Vendor Website', 'Gross Cost (Before Shipping)', 'Additional Info'];
  const m = guessMapping(headers, fields);
  assert.equal(m.product_link, 3);
  assert.equal(m.vendor, undefined);
  const { items } = toItems([{ n: 2, cells: ['Sam', 'Fuse', '2', 'digikey (https://www.digikey.com/p/1)', '$3', ''] }], m, fields, config);
  assert.equal(items[0].product_link, 'https://www.digikey.com/p/1');
});

test('items: prices with $ and commas, quantity 1 when blank, price from a line total', () => {
  const grid = [
    ['Part', 'Qty', 'Price', 'Total', 'Supplier', 'Link', 'Grade'],
    ['Carbon sheet', '', '$1,234.50', '', 'Rock West', 'www.rockwestcomposites.com/1', 'a'],
    ['Rivets', '3', '', '$4.50', 'McMaster', 'https://mcmaster.com/x', 'C'],
    ['', '', '', '', '', '', ''],
    ['Subtotal', '', '', '$1,239.00'],
    ['Shipping', '', '25'],
    ['Mystery part', '2', 'TBD'],
    ['', '1', '5'],
    ['Glue', 'two', '3'],
  ];
  const { items, skipped } = toItems(rowsOf(grid, 0), guessMapping(grid[0], fields), fields, config);
  assert.deepEqual(pick(items, 'item_name'), ['Carbon sheet', 'Rivets']);
  assert.deepEqual(pick(items, 'quantity'), ['1', '3']);
  assert.deepEqual(pick(items, 'unit_price'), ['1234.5', '1.5']);
  assert.deepEqual(pick(items, 'product_link'), ['https://www.rockwestcomposites.com/1', 'https://mcmaster.com/x']);
  assert.deepEqual(pick(items, 'c_grade'), ['A', undefined]); // dropdowns: only their options
  assert.deepEqual(skipped.map((s) => s.row), [5, 6, 7, 8, 9]); // spreadsheet row numbers
  assert.match(skipped[2].reason, /Mystery part: no price/);
  assert.match(skipped[3].reason, /No part name/);
  assert.match(skipped[4].reason, /quantity "two"/);
});

test('the template: its headers match exactly, and its example row is left out', () => {
  const headers = fields.map((f) => f.label);
  const example = fields.map((f) => String(TEMPLATE_EXAMPLE[f.key] ?? ''));
  const { items, skipped } = toItems([{ n: 2, cells: example }, { n: 3, cells: ['Real part', '', '', '', '1', '4'] }], guessMapping(headers, fields), fields, config);
  assert.deepEqual(pick(items, 'item_name'), ['Real part']);
  assert.match(skipped[0].reason, /example row/);
});

test('money: $, commas, accounting negatives', () => {
  assert.deepEqual([toMoney('$1,234.50'), toMoney(' 3 '), toMoney('(5.00)'), toMoney('free'), toMoney('')], [1234.5, 3, -5, null, null]);
  assert.deepEqual(
    [toMoney('US$24.90'), toMoney('24.90 USD'), toMoney('$ 9.95 '), toMoney('12,50'), toMoney('1.234,50'), toMoney('1,234')],
    [24.9, 24.9, 9.95, 12.5, 1234.5, 1234]
  );
});

test('vendors: grouped ignoring case, in order of first appearance', () => {
  const groups = byVendor([{ vendor: 'McMaster' }, { vendor: 'Digi-Key' }, { vendor: 'mcmaster ' }, { vendor: '' }]);
  assert.deepEqual(groups.map((g) => [g.vendor, g.items.length]), [['McMaster', 2], ['Digi-Key', 1], ['', 1]]);
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
