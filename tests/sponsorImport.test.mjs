/**
 * Reading old sponsor spreadsheets (js/sponsorImport.js).   node tests/sponsorImport.test.mjs
 * The rows are made up, shaped like the team's real sheets.
 */
import assert from 'node:assert/strict';
import { findSponsorHeader, guessSponsorColumns, readSponsorRows, toSponsorCard, guessCar, stageFor } from '../js/sponsorImport.js';

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

const stages = [
  { key: 'prospect', label: 'Prospect', kind: 'open' },
  { key: 'contacted', label: 'Contacted', kind: 'open' },
  { key: 'talks', label: 'In talks', kind: 'open' },
  { key: 'committed', label: 'Committed', kind: 'open' },
  { key: 'received', label: 'Received', kind: 'received' },
  { key: 'thanked', label: 'Thanked', kind: 'done' },
  { key: 'declined', label: 'Not this year', kind: 'lost' },
];
const kinds = ['Sponsorship', 'Donation', 'In-kind (parts or services)', 'Discount', 'Grant'];

// A car's sponsor list: one header row at the top.
const carSheet = [
  ['Sponsor Name', 'Money Donated', 'Sponsor Level', 'Logo', 'Helped How?', 'Sponsor Contact Name', 'Contact Method #1 (Phone)', 'Contact Method #2 (Email)', 'Contact Method #3', 'Address', 'Responsible Team Member', 'System', 'Notes'],
  ['Acme Composites', '256', 'Bronze', '', 'five rolls of carbon fiber', 'Pat Doe', '555 010 0000', 'pat@acme.example', '', '1 Main St\nGainesville, FL', 'Riley', 'Aerobody/Mechanical', 'Ask in August'],
  ['Widget Co', '', 'Silver', '', 'Discount on connectors', '', '', 'a@widget.example, b@widget.example', 'through Sam', '', '', 'Electrical', ''],
  ['Family Fund', '$1,000', 'Donation', '', '', '', '', 'Customer service email', '', '', '', '', ''],
  ['6x6'],
  [],
  ['Total in Aggregate Value', '36572.08'],
  ['Mitsuba?'],
];

// This year's outreach tracker: title rows above the table, a status and outcome per row.
const tracker = [
  ['Solar Gators Sponsorship Outreach Tracker'],
  ['Before emailing: put your name in Assigned To'],
  [],
  ['TOTAL TARGETS', '', '', 'ASSIGNED'],
  ['7', '', '', '5'],
  [],
  ['Priority', 'Request Category', 'Company', 'Requested Support / What They Can Offer', 'Why It Matters to Solar Gators', 'Contact Name', 'Contact Email', 'Company Website / Sponsorship Page', 'Assigned To', 'Outreach Status', 'Date Contacted', 'Follow-Up Date', 'Outcome', 'Notes'],
  ['1', 'PCB Sponsor', 'Board House', 'Blank PCBs', 'We order PCBs every month', '', 'support@boards.example', 'https://boards.example/', 'Sam', 'Email Sent', '2026-09-24', '2026-10-08', 'Pending', 'Top priority'],
  ['', 'Core Material', 'Core Supply', 'Nomex honeycomb', '', '', '', '', '', 'Drafting Email', '', '', 'Pending', ''],
  ['', 'Parts', 'Said No Inc', '', '', '', '', '', '', 'Email Sent', '', '', 'Declined', ''],
];

test('finds the title row, under a sheet title and summary', () => {
  assert.equal(findSponsorHeader(carSheet), 0);
  assert.equal(findSponsorHeader(tracker), 6);
  assert.equal(findSponsorHeader([['Parts list'], ['Part', 'Qty']]), -1);
  // A blank first column, as in one of the sheets.
  assert.equal(findSponsorHeader([[], ['', 'Sponsor Name', 'Monley Donated', 'Donated?']]), 1);
});

test('recognises the columns of each sheet', () => {
  const car = guessSponsorColumns(carSheet[0]);
  assert.deepEqual([car[0], car[1], car[2], car[4], car[5], car[6], car[7], car[8], car[9], car[10], car[11], car[12]],
    ['name', 'amount', 'level', 'gave', 'contact_name', 'contact_phone', 'contact_email', 'other_contact', 'address', 'lead', 'system', 'notes']);
  assert.equal(car[3], undefined); // Logo: not a field (kept in the description if it has anything)
  const t = guessSponsorColumns(tracker[6]);
  assert.deepEqual(Object.values(t).sort(), ['category', 'contact_email', 'contact_name', 'contacted', 'follow_up', 'gave', 'lead', 'name', 'notes', 'outcome', 'priority', 'status', 'website', 'why'].sort());
  const flare = guessSponsorColumns(['', 'Sponsor Name', 'Monley Donated', 'Sponsor Level', 'Donated?', 'Contact Name', 'Contact Number', 'Contact Email', 'Team Member Responsible', 'Subsystem', 'Notes']);
  assert.deepEqual(Object.values(flare), ['name', 'amount', 'level', 'gave', 'contact_name', 'contact_phone', 'contact_email', 'lead', 'system', 'notes']);
});

test('reads rows and marks totals, questions and name-only rows', () => {
  const rows = readSponsorRows(carSheet);
  assert.deepEqual(rows.map((r) => [r.name, r.junk || '']), [
    ['Acme Composites', ''], ['Widget Co', ''], ['Family Fund', ''], ['6x6', 'Only a name'],
    ['Total in Aggregate Value', 'Looks like a total'], ['Mitsuba?', 'Ends with a question mark'],
  ]);
  assert.equal(rows[0].row, 2); // spreadsheet row number
});

test('a past car\'s row becomes a finished card with tags, contacts and notes', () => {
  const [acme, widget, family] = readSponsorRows(carSheet).map((r) => toSponsorCard(r, { car: 'Sunrider', season: '', stage: 'thanked', stages, kinds }));
  assert.deepEqual(
    [acme.name, acme.car, acme.stage, acme.kind, acme.amount, acme.contact_email, acme.playbook, acme.lead],
    ['Acme Composites', 'Sunrider', 'thanked', 'In-kind (parts or services)', '256', 'pat@acme.example', 'Ask in August', 'Riley']);
  assert.deepEqual(acme.tags, ['bronze', 'aerobody', 'mechanical']);
  assert.match(acme.description, /\*\*What they gave:\*\* five rolls of carbon fiber/);
  assert.match(acme.description, /\*\*Address:\*\* 1 Main St, Gainesville, FL/);
  assert.match(acme.description, /\*\*Team member:\*\* Riley/);
  assert.deepEqual([widget.kind, widget.amount, widget.contact_email], ['Discount', '', 'a@widget.example']);
  assert.match(widget.description, /Other emails:\*\* b@widget.example/);
  assert.match(widget.description, /Other contact:\*\* through Sam/);
  assert.deepEqual([family.kind, family.amount, family.contact_email], ['Donation', '1000', '']);
  assert.match(family.description, /Contact email:\*\* Customer service email/);
});

test('the outreach tracker\'s status and outcome pick the stage', () => {
  const rows = readSponsorRows(tracker, { sheet: 'Electrical Sponsors' });
  const cards = rows.map((r) => toSponsorCard(r, { car: 'Blaze', season: '2026-2027', stage: 'prospect', stages, kinds }));
  assert.deepEqual(cards.map((c) => c.stage), ['contacted', 'prospect', 'declined']);
  assert.deepEqual(cards[0].tags, ['electrical']);
  assert.deepEqual([cards[0].priority, cards[0].category, cards[0].contacted_on], ['1', 'PCB Sponsor', '2026-09-24']);
  assert.deepEqual([cards[0].website, cards[0].follow_up, cards[0].season, cards[0].playbook], ['https://boards.example/', '2026-10-08', '2026-2027', 'Top priority']);
  assert.match(cards[0].description, /Why it matters:\*\* We order PCBs/);
  assert.doesNotMatch(cards[0].description, /Date contacted|Priority/);
  assert.equal(stageFor({ outcome: 'Secured!' }, stages), 'committed');
  assert.equal(stageFor({ outcome: 'Pending' }, stages), null);
});

test('guesses the car from the file name', () => {
  assert.equal(guessCar('Flare Sponsors.xlsx'), 'Flare');
  assert.equal(guessCar('Car 3 Sponsors.xlsx'), 'Car 3');
  assert.equal(guessCar('Solar_Gators_Sponsorship_Outreach_Tracker (1).xlsx'), '');
});

console.log(`${passed} sponsor import tests passed`);
