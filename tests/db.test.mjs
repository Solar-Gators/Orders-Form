/**
 * Database tests: loads every file in supabase/migrations/ (in order) into PGlite (real Postgres running
 * in Node) with a small stand-in for Supabase's `auth` schema, then exercises
 * the workflow and security rules as different users.
 *
 *   npm install
 *   npm run test:db
 */
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import assert from 'node:assert/strict';

const SUPABASE_STUB = `
  create role anon nologin;
  create role authenticated nologin;
  create schema auth;
  create table auth.users (id uuid primary key, email text not null, raw_user_meta_data jsonb default '{}');
  create function auth.uid() returns uuid language sql stable
    as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth to anon, authenticated;
  grant usage on schema public to anon, authenticated;
`;

const db = new PGlite();
await db.exec(SUPABASE_STUB);
const MIGRATIONS = new URL('../supabase/migrations/', import.meta.url);
for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
  // Before 004: data as it looks after importing an old sheet with a "Shipping Costs"
  // column (a custom item field). 004 should fold it into the built-in Shipping field.
  if (file.startsWith('004')) await seedImportedShipping();
  await db.exec(readFileSync(new URL(file, MIGRATIONS), 'utf8'));
}

async function seedImportedShipping() {
  await db.exec(`
    update app_settings set value = jsonb_set(value, '{itemFields}', value -> 'itemFields' ||
      '[{"key": "c_shipping_costs", "label": "Shipping Costs", "type": "text", "required": false}]')
    where key = 'form';
    insert into requests (id, request_number, title, status)
      values ('00000000-0000-0000-0000-00000000f01d', 'FOLD-1', 'Imported', 'Received');
    insert into request_items (request_id, position, item_name, quantity, unit_price, notes, data) values
      ('00000000-0000-0000-0000-00000000f01d', 0, 'Paid shipping', 1, 10, '', '{"c_shipping_costs": "$9.15"}'),
      ('00000000-0000-0000-0000-00000000f01d', 1, 'Prime', 1, 10, 'Keep dry', '{"c_shipping_costs": "N/A (Prime)"}'),
      ('00000000-0000-0000-0000-00000000f01d', 2, 'No shipping', 1, 10, '', '{"c_shipping_costs": "n/a"}');
  `);
}

// ---- helpers ------------------------------------------------------------------

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message}`);
    process.exitCode = 1;
  }
}

/** Run queries as a signed-in user (uid) or as anon (null), like the website would. */
async function as(uid, fn) {
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [uid || '']);
  await db.exec(uid ? 'set role authenticated' : 'set role anon');
  try {
    return await fn();
  } finally {
    await db.exec('reset role');
  }
}

async function rejects(promise, pattern) {
  try {
    await promise;
  } catch (err) {
    if (pattern) assert.match(`${err.message} ${err.detail || ''}`, pattern);
    return err;
  }
  throw new Error(`expected an error matching ${pattern}`);
}

let n = 0;
async function signUp(email, name) {
  const id = `00000000-0000-0000-0000-${String(++n).padStart(12, '0')}`;
  await db.query(`insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)`, [id, email, { full_name: name }]);
  return id;
}

const setRole = (uid, role) => db.query(`update profiles set role = $2 where id = $1`, [uid, role]);
const rpc = (fn, args) => db.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) as result`, args);
const statusOf = async (number) => (await db.query(`select status from requests where request_number = $1`, [number])).rows[0].status;

const completeRequest = {
  title: 'Steering hardware', requester: 'Austin Stang', subsystem: 'Suspension', priority: 'Urgent',
  needed_by: '2026-10-05', justification: 'Steering cam assembly',
};
const completeItems = [
  { item_name: 'M3 SHCS', vendor: 'McMaster-Carr', quantity: '2', unit_price: '7.11' },
  { item_name: '', vendor: '', quantity: '', unit_price: '' }, // blank row is dropped
  { item_name: 'Control cable', vendor: 'Aircraft Spruce', quantity: 15, unit_price: '$2.38' },
];

// ---- tests ----------------------------------------------------------------------

console.log('Accounts');

await test('sign-up outside @ufl.edu is rejected', async () => {
  await rejects(signUp('someone@gmail.com', 'Nope'), /limited to @ufl.edu/);
});

const member = await signUp('member@ufl.edu', 'Mia Member');
const other = await signUp('other@cise.ufl.edu', 'Otto Other');
const ce = await signUp('ce@ufl.edu', 'Griffin York');
const treasurer = await signUp('treasurer@ufl.edu', 'Tess Treasurer');
await setRole(ce, 'ce');
await setRole(treasurer, 'treasurer');

await test('sign-up creates a Member profile (subdomains allowed)', async () => {
  const { rows } = await db.query(`select email, full_name, role from profiles where id in ($1, $2) order by email`, [member, other]);
  assert.deepEqual(rows.map((r) => [r.full_name, r.role]), [['Mia Member', 'member'], ['Otto Other', 'member']]);
});

await test('anon can read general settings but not requests or profiles', async () => {
  await as(null, async () => {
    const { rows } = await db.query(`select key from app_settings`);
    assert.deepEqual(rows.map((r) => r.key), ['general']);
    await rejects(db.query(`select * from requests`), /permission denied/);
    await rejects(db.query(`select * from profiles`), /permission denied/);
  });
});

await test('anon cannot call actions', async () => {
  await as(null, () => rejects(rpc('save_request', [null, completeRequest, completeItems, 'submit']), /permission denied/));
});

await test('users cannot write tables directly', async () => {
  await as(member, async () => {
    await rejects(db.query(`insert into requests (title) values ('x')`), /permission denied/);
    await rejects(db.query(`update profiles set role = 'treasurer' where id = $1`, [member]), /permission denied/);
    await rejects(db.query(`insert into approvals (request_id, approver, decision) values (gen_random_uuid(), 'me', 'approve')`), /permission denied/);
  });
});

await test('users can update their own name', async () => {
  await as(member, () => rpc('update_my_profile', ['Mia M.']));
  const { rows } = await db.query(`select full_name from profiles where id = $1`, [member]);
  assert.equal(rows[0].full_name, 'Mia M.');
});

console.log('Requests');

let draftNumber;
await test('member saves a draft with only a title → SG-001', async () => {
  const { rows } = await as(member, () => rpc('save_request', [null, { title: 'Draft only' }, [], 'draft']));
  draftNumber = rows[0].result;
  assert.equal(draftNumber, 'SG-001');
  assert.equal(await statusOf(draftNumber), 'Draft');
});

await test('submitting an incomplete request lists every problem', async () => {
  const err = await as(member, () =>
    rejects(rpc('save_request', [null, { title: 'x' }, [{ item_name: 'Nut', quantity: '-1' }], 'submit']), /fix the following/)
  );
  assert.match(err.detail, /Subsystem is required/);
  assert.match(err.detail, /Item 1: Quantity must be a positive number/);
  assert.doesNotMatch(err.detail, /Quantity is required/);
  assert.match(err.detail, /Item 1: Vendor is required/);
});

await test('unknown subsystem is rejected', async () => {
  await as(member, () => rejects(rpc('save_request', [null, { ...completeRequest, subsystem: 'Warp Drive' }, completeItems, 'submit']), /Unknown subsystem "Warp Drive"/));
});

let number;
await test('member submits a complete multi-item request', async () => {
  const { rows } = await as(member, () => rpc('save_request', [null, completeRequest, completeItems, 'submit']));
  number = rows[0].result;
  assert.equal(await statusOf(number), 'Submitted');
  const items = await db.query(
    `select item_name, quantity::float, unit_price::float from request_items i join requests r on r.id = i.request_id
     where r.request_number = $1 order by position`, [number]);
  assert.deepEqual(items.rows.map((r) => [r.item_name, r.quantity, r.unit_price]), [['M3 SHCS', 2, 7.11], ['Control cable', 15, 2.38]]);
});

const idOf = async (num) => (await db.query(`select id from requests where request_number = $1`, [num])).rows[0].id;

await test('another user cannot edit your draft', async () => {
  await as(other, async () => rejects(rpc('save_request', [await idOf(draftNumber), { title: 'hijack' }, [], 'draft']), /Only the person/));
});

await test('submitted requests cannot be edited', async () => {
  await as(member, async () => rejects(rpc('save_request', [await idOf(number), completeRequest, completeItems, 'draft']), /can no longer be edited/));
});

console.log('Approvals');

await test('members cannot review', async () => {
  await as(member, async () => rejects(rpc('review_request', [await idOf(number), 'approve', '']), /does not allow/));
});

await test('reject / request changes need a comment', async () => {
  await as(ce, async () => rejects(rpc('review_request', [await idOf(number), 'reject', '  ']), /comment is required/));
});

await test('request changes → owner edits and resubmits', async () => {
  const id = await idOf(number);
  await as(ce, () => rpc('review_request', [id, 'request_changes', 'Add links please']));
  assert.equal(await statusOf(number), 'Changes Requested');
  await as(member, () => rpc('save_request', [id, completeRequest, completeItems, 'submit']));
  assert.equal(await statusOf(number), 'Submitted');
});

await test('CE approves; approver name and id are recorded', async () => {
  await as(ce, async () => rpc('review_request', [await idOf(number), 'approve', '']));
  assert.equal(await statusOf(number), 'Approved');
  const { rows } = await db.query(`select approver, approver_id, decision from approvals order by created_at desc, decision limit 1`);
  assert.equal(rows[0].approver, 'Griffin York');
  assert.equal(rows[0].approver_id, ce);
});

await test('cannot review a request that is not Submitted', async () => {
  await as(ce, async () => rejects(rpc('review_request', [await idOf(number), 'approve', '']), /not Submitted/));
});

console.log('Ordering');

await test('CE cannot mark ordered', async () => {
  await as(ce, async () => rejects(rpc('mark_ordered', [await idOf(number), null, '6048', '']), /does not allow/));
});

await test('cannot mark received before ordered', async () => {
  await as(treasurer, async () => rejects(rpc('mark_received', [await idOf(number), null, '']), /not Ordered/));
});

await test('treasurer marks ordered, then received', async () => {
  const id = await idOf(number);
  await as(treasurer, () => rpc('mark_ordered', [id, '2026-09-30', '6048', 'Expedited']));
  assert.equal(await statusOf(number), 'Ordered');
  await as(treasurer, () => rpc('mark_received', [id, null, 'In office']));
  assert.equal(await statusOf(number), 'Received');
  const { rows } = await db.query(`select department_order_number, received_notes, ordered_by, received_by from order_information where request_id = $1`, [id]);
  assert.deepEqual(rows[0], { department_order_number: '6048', received_notes: 'In office', ordered_by: treasurer, received_by: treasurer });
});

await test('treasurer cannot approve (only Chief Engineers review)', async () => {
  const { rows } = await as(member, () => rpc('save_request', [null, completeRequest, completeItems, 'submit']));
  await as(treasurer, async () => rejects(rpc('review_request', [await idOf(rows[0].result), 'approve', '']), /does not allow/));
  assert.equal(await statusOf(rows[0].result), 'Submitted');
});

console.log('Users & settings');

await test('members cannot change roles', async () => {
  await as(member, () => rejects(rpc('set_user_role', [other, 'ce']), /does not allow/));
});

await test('CE can promote a member, but not change their own role', async () => {
  await as(ce, () => rpc('set_user_role', [other, 'treasurer']));
  assert.equal((await db.query(`select role from profiles where id = $1`, [other])).rows[0].role, 'treasurer');
  await as(ce, () => rejects(rpc('set_user_role', [ce, 'member']), /own role/));
});

const currentForm = async () => (await db.query(`select value from app_settings where key = 'form'`)).rows[0].value;

await test('members cannot edit settings; CE can', async () => {
  const form = { ...(await currentForm()), subsystems: ['Battery', 'Structures'], priorities: ['Normal', 'Urgent'], defaultPriority: 'Normal' };
  await as(member, () => rejects(rpc('update_settings', ['form', form]), /does not allow/));
  await as(ce, () => rpc('update_settings', ['form', form]));
  const { rows } = await db.query(`select value from app_settings where key = 'form'`);
  assert.deepEqual(rows[0].value.subsystems, ['Battery', 'Structures']);
});

await test('settings require at least one subsystem', async () => {
  await as(ce, () => rejects(rpc('update_settings', ['form', { subsystems: [], priorities: ['Normal'] }]), /subsystem/));
});

await test('new request numbers use the configured prefix', async () => {
  const general = (await db.query(`select value from app_settings where key = 'general'`)).rows[0].value;
  await as(ce, () => rpc('update_settings', ['general', { ...general, requestIdPrefix: 'SG27' }]));
  const { rows } = await as(member, () => rpc('save_request', [null, { title: 'x' }, [], 'draft']));
  assert.match(rows[0].result, /^SG27-\d{3}$/);
});

await test('the website cannot change the schema version', async () => {
  const general = (await db.query(`select value from app_settings where key = 'general'`)).rows[0].value;
  await as(ce, () => rpc('update_settings', ['general', { ...general, schemaVersion: 99 }]));
  const after = (await db.query(`select value from app_settings where key = 'general'`)).rows[0].value;
  assert.equal(after.schemaVersion, 4);
});

console.log('Form fields');

const withFields = async (edit) => {
  const form = await currentForm();
  const next = { ...form, requestFields: structuredClone(form.requestFields), itemFields: structuredClone(form.itemFields) };
  edit(next);
  return next;
};
const field = (list, key) => list.find((f) => f.key === key);

await test('migration 002 adds default fields', async () => {
  const form = await currentForm();
  assert.deepEqual(form.requestFields.map((f) => f.key), ['title', 'requester', 'subsystem', 'priority', 'needed_by', 'justification']);
  assert.equal(field(form.itemFields, 'vendor').required, true);
});

await test('field lists that would break the app are rejected', async () => {
  const bad = [
    [(f) => (f.requestFields = f.requestFields.filter((x) => x.key !== 'requester')), /can't be removed/],
    [(f) => (field(f.requestFields, 'title').required = false), /must stay required/],
    [(f) => (field(f.itemFields, 'unit_price').hidden = true), /must stay required/],
    [(f) => f.requestFields.push({ key: 'Bad Key', label: 'x', type: 'text' }), /Invalid field key/],
    [(f) => f.requestFields.push({ key: 'c_x', label: 'x', type: 'text' }, { key: 'c_x', label: 'y', type: 'text' }), /appears twice/],
    [(f) => f.requestFields.push({ key: 'c_pick', label: 'Pick', type: 'select', options: [] }), /needs at least one option/],
    [(f) => f.itemFields.push({ key: 'c_weird', label: 'Weird', type: 'html' }), /unknown type/],
    [(f) => f.requestFields.push({ key: 'c_blank', label: '  ', type: 'text' }), /needs a label/],
  ];
  for (const [edit, pattern] of bad) {
    await as(ce, async () => rejects(rpc('update_settings', ['form', await withFields(edit)]), pattern));
  }
});

await test('custom fields: required, typed, and saved in data', async () => {
  const form = await withFields((f) => {
    f.requestFields.push(
      { key: 'c_from_china', label: 'From China?', type: 'yesno', required: true },
      { key: 'c_shipping', label: 'Shipping cost', type: 'number', required: false }
    );
    f.itemFields.push({ key: 'c_color', label: 'Color', type: 'select', options: ['Red', 'Blue'], required: false });
    field(f.itemFields, 'vendor').required = false; // built-ins can be made optional
  });
  await as(ce, () => rpc('update_settings', ['form', form]));

  const request = { ...completeRequest, subsystem: 'Battery' };
  const items = [{ item_name: 'Cells', quantity: 4, unit_price: 5, data: { c_color: 'Green' } }];
  const err = await as(member, () => rejects(rpc('save_request', [null, { ...request, data: { c_shipping: 'abc' } }, items, 'submit']), /fix/));
  assert.match(err.detail, /From China\? is required/);
  assert.match(err.detail, /Shipping cost must be a number/);
  assert.match(err.detail, /Item 1: Color must be one of the listed options/);
  assert.doesNotMatch(err.detail, /Vendor/);

  items[0].data.c_color = 'Blue';
  const { rows } = await as(member, () =>
    rpc('save_request', [null, { ...request, data: { c_from_china: 'No', c_shipping: '12.50', c_unknown: 'dropped' } }, items, 'submit'])
  );
  const saved = await db.query(`select r.data, i.data as item_data, i.vendor from requests r join request_items i on i.request_id = r.id where r.request_number = $1`, [rows[0].result]);
  assert.deepEqual(saved.rows[0].data, { c_from_china: 'No', c_shipping: '12.50' });
  assert.deepEqual(saved.rows[0].item_data, { c_color: 'Blue' });
});

await test('hidden fields are never required', async () => {
  const form = await withFields((f) => {
    field(f.requestFields, 'justification').hidden = true;
    field(f.requestFields, 'c_from_china').hidden = true;
  });
  await as(ce, () => rpc('update_settings', ['form', form]));
  const request = { ...completeRequest, subsystem: 'Battery', justification: '' };
  const { rows } = await as(member, () => rpc('save_request', [null, request, [{ item_name: 'x', quantity: 1, unit_price: 1 }], 'submit']));
  assert.equal(await statusOf(rows[0].result), 'Submitted');
});

await test('renamed built-in labels appear in error messages', async () => {
  const form = await withFields((f) => (field(f.itemFields, 'quantity').label = 'How many'));
  await as(ce, () => rpc('update_settings', ['form', form]));
  const err = await as(member, () =>
    rejects(rpc('save_request', [null, { title: 'x' }, [{ item_name: 'x', quantity: '-2', unit_price: 1 }], 'draft']), /fix/)
  );
  assert.match(err.detail, /Item 1: How many must be a positive number/);
});

console.log('Archive & import');

const archiveRows = [
  { row_number: 2, fields: { Requestor: 'Ethan Wright', Date: '2024-09-12', 'Gross Cost': '138.03', 'Date Received': '' },
    order_date: '2024-09-12', requester: 'Ethan Wright', subteam: 'Brakes', item: 'Steel sheet', status: 'Received', ticket: '3272', cost: 138.03 },
  { row_number: 3, fields: { Requestor: 'Youssef', Date: 'not yet' }, order_date: 'not yet', requester: 'Youssef', cost: 'n/a' },
];

let importId;
await test('members cannot import; leads can import a past season', async () => {
  await as(member, () => rejects(rpc('import_archive', ['2024-2025', 'budget.xlsx', 'Orders', ['Requestor', 'Date'], archiveRows]), /does not allow/));
  const { rows } = await as(treasurer, () => rpc('import_archive', ['2024-2025', 'budget.xlsx', 'Orders', ['Requestor', 'Date'], archiveRows]));
  importId = rows[0].result;
  const saved = await db.query(`select row_number, order_date::text, cost::float, fields from archive_orders where import_id = $1 order by row_number`, [importId]);
  assert.equal(saved.rows.length, 2);
  assert.deepEqual([saved.rows[0].order_date, saved.rows[0].cost], ['2024-09-12', 138.03]);
  assert.deepEqual([saved.rows[1].order_date, saved.rows[1].cost], [null, null]); // messy values don't break the import
  assert.equal(saved.rows[1].fields.Date, 'not yet'); // …and the original text is kept
});

await test('every signed-in user can read the archive; anon cannot', async () => {
  const { rows } = await as(member, () => db.query(`select count(*)::int as n from archive_orders`));
  assert.equal(rows[0].n, 2);
  await as(null, () => rejects(db.query(`select * from archive_orders`), /permission denied/));
  await as(member, () => rejects(db.query(`delete from archive_orders`), /permission denied/));
});

await test('deleting an import removes its rows', async () => {
  await as(member, () => rejects(rpc('delete_archive_import', [importId]), /does not allow/));
  await as(ce, () => rpc('delete_archive_import', [importId]));
  assert.equal((await db.query(`select count(*)::int as n from archive_orders`)).rows[0].n, 0);
});

await test('import this season\'s sheet as requests with history', async () => {
  const sheet = [
    { title: 'Loctite glue (+3 more)', requester: 'Bella N', subsystem: 'Battery', priority: 'High', justification: 'Plug',
      date: '2026-08-25', status: 'Received', approver: 'Griffin', ticket: '5985', received_notes: 'Received, in office',
      items: [{ item_name: 'Loctite', vendor: 'lowes.com', quantity: '4', unit_price: '7.38', notes: '', data: { c_from_china: 'No' } }] },
    { title: 'Fuse', requester: 'Josh', subsystem: 'Battery', date: '2026-09-08', status: 'Ordered', approver: 'Josh', ticket: '6157',
      items: [{ item_name: 'Fuse', quantity: '1', unit_price: '29.99' }] },
    { title: 'Waiting', requester: 'Zach', subsystem: 'Battery', date: '2026-09-10', status: 'Submitted', items: [{ item_name: 'Cells', quantity: '2', unit_price: '5' }] },
  ];
  await as(member, () => rejects(rpc('import_requests', [sheet]), /does not allow/));
  const { rows } = await as(ce, () => rpc('import_requests', [sheet]));
  assert.equal(rows[0].result, 3);
  const got = await db.query(`
    select r.title, r.status, r.created_at::date::text as day, r.created_by,
           (select approver from approvals a where a.request_id = r.id) as approver,
           o.department_order_number as ticket, o.received_notes
    from requests r left join order_information o on o.request_id = r.id
    where r.requester in ('Bella N', 'Josh', 'Zach') order by r.created_at`);
  assert.deepEqual(got.rows.map((r) => [r.status, r.day, r.approver, r.ticket, r.created_by]), [
    ['Received', '2026-08-25', 'Griffin', '5985', null],
    ['Ordered', '2026-09-08', 'Josh', '6157', null],
    ['Submitted', '2026-09-10', null, null, null],
  ]);
  assert.equal(got.rows[0].received_notes, 'Received, in office');
});

await test('treasurer can mark an imported order as received', async () => {
  const { rows } = await db.query(`select id from requests where requester = 'Josh' and title = 'Fuse'`);
  await as(treasurer, () => rpc('mark_received', [rows[0].id, '2026-09-30', 'In office']));
  assert.equal((await db.query(`select status from requests where id = $1`, [rows[0].id])).rows[0].status, 'Received');
});

console.log('Shipping & cost adjustments');

await test('004 folds an imported "Shipping Costs" column into Shipping', async () => {
  const { rows } = await db.query(`select item_name, shipping_cost::float as ship, notes from request_items
                                   where request_id = '00000000-0000-0000-0000-00000000f01d' order by position`);
  assert.deepEqual(rows.map((r) => [r.item_name, r.ship, r.notes]), [
    ['Paid shipping', 9.15, ''],
    ['Prime', null, 'Keep dry · Shipping: N/A (Prime)'], // text kept in Notes
    ['No shipping', null, ''], //                           plain "n/a" dropped
  ]);
  const keys = (await currentForm()).itemFields.map((f) => f.key);
  assert.ok(!keys.includes('c_shipping_costs'));
  assert.equal(keys[keys.indexOf('unit_price') + 1], 'shipping_cost'); // right after Unit price
});

let costReq;
await test('members can enter shipping on a request', async () => {
  const items = [
    { item_name: 'Cells', vendor: 'Liion', quantity: 4, unit_price: 5, shipping_cost: '$12.00' },
    { item_name: 'Tape', vendor: 'Uline', quantity: 1, unit_price: 3 },
  ];
  const bad = await as(member, () => rejects(rpc('save_request', [null, { ...completeRequest, subsystem: 'Battery', justification: 'x', c_from_china: 'No', data: { c_from_china: 'No' } }, [{ ...items[0], shipping_cost: 'free' }], 'submit']), /fix/));
  assert.match(bad.detail, /Item 1: Shipping must be a number/);
  const { rows } = await as(member, () => rpc('save_request', [null, { ...completeRequest, subsystem: 'Battery', justification: 'x', data: { c_from_china: 'No' } }, items, 'submit']));
  costReq = (await db.query(`select id from requests where request_number = $1`, [rows[0].result])).rows[0].id;
  const saved = await db.query(`select item_name, shipping_cost::float as ship from request_items where request_id = $1 order by position`, [costReq]);
  assert.deepEqual(saved.rows.map((r) => r.ship), [12, null]);
});

const itemsOf = async (id) => (await db.query(`select id, item_name, unit_price::float as price, shipping_cost::float as ship from request_items where request_id = $1 order by position`, [id])).rows;

await test('costs can only be adjusted after approval, and only by the Treasurer', async () => {
  const [cells] = await itemsOf(costReq);
  await as(treasurer, () => rejects(rpc('update_item_costs', [costReq, [{ id: cells.id, unit_price: 6 }], '']), /once a request is approved/));
  await as(ce, () => rpc('review_request', [costReq, 'approve', '']));
  await as(ce, () => rejects(rpc('update_item_costs', [costReq, [{ id: cells.id, unit_price: 6 }], '']), /does not allow/));
  await as(member, () => rejects(rpc('update_item_costs', [costReq, [{ id: cells.id, unit_price: 6 }], '']), /does not allow/));
});

await test('Treasurer adjusts price and shipping; every change is logged', async () => {
  const [cells, tape] = await itemsOf(costReq);
  const { rows } = await as(treasurer, () =>
    rpc('update_item_costs', [costReq, [
      { id: cells.id, unit_price: '5.50', shipping_cost: '14.25' }, // both changed
      { id: tape.id, unit_price: 3, shipping_cost: '' },           // nothing changed
    ], 'Price went up at checkout'])
  );
  assert.equal(rows[0].result, 2);
  assert.deepEqual((await itemsOf(costReq)).map((i) => [i.price, i.ship]), [[5.5, 14.25], [3, null]]);
  const log = await db.query(`select field, old_value::float as old, new_value::float as new, reason, changed_by_name from cost_changes where request_id = $1 order by field`, [costReq]);
  assert.deepEqual(log.rows.map((r) => [r.field, r.old, r.new, r.reason, r.changed_by_name]), [
    ['shipping_cost', 12, 14.25, 'Price went up at checkout', 'Tess Treasurer'],
    ['unit_price', 5, 5.5, 'Price went up at checkout', 'Tess Treasurer'],
  ]);
});

await test('costs can still be changed after Ordered and Received; bad values are refused', async () => {
  const [cells] = await itemsOf(costReq);
  await as(treasurer, () => rpc('mark_ordered', [costReq, null, '7001', '']));
  await as(treasurer, () => rpc('update_item_costs', [costReq, [{ id: cells.id, shipping_cost: '0' }], 'Free shipping applied']));
  await as(treasurer, () => rpc('mark_received', [costReq, null, '']));
  await as(treasurer, () => rpc('update_item_costs', [costReq, [{ id: cells.id, unit_price: '5.25' }], 'Refund']));
  assert.deepEqual((await itemsOf(costReq))[0], { ...cells, price: 5.25, ship: 0 });
  await as(treasurer, () => rejects(rpc('update_item_costs', [costReq, [{ id: cells.id, unit_price: '-1' }], '']), /number of 0 or more/));
  await as(treasurer, () => rejects(rpc('update_item_costs', [costReq, [{ id: '00000000-0000-0000-0000-000000000abc', unit_price: 1 }], '']), /not on/));
  assert.equal((await db.query(`select count(*)::int as n from cost_changes where request_id = $1`, [costReq])).rows[0].n, 4);
});

await test('members can read the cost history but not write it', async () => {
  const { rows } = await as(member, () => db.query(`select count(*)::int as n from cost_changes`));
  assert.ok(rows[0].n >= 4);
  await as(member, () => rejects(db.query(`delete from cost_changes`), /permission denied/));
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
