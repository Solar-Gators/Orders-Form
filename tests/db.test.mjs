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

/** Give someone exactly one role (test setup, as the database owner). */
const setRole = (uid, role) =>
  db.exec(`delete from profile_roles where user_id = '${uid}'; insert into profile_roles (user_id, role) values ('${uid}', '${role}');`);
/** Someone's roles, comma-separated and sorted, e.g. "admin,treasurer". */
const roleOf = async (uid) =>
  (await db.query(`select string_agg(role, ',' order by role) as r from profile_roles where user_id = $1`, [uid])).rows[0].r;
const rpc = (fn, args) => db.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) as result`, args);
const statusOf = async (number) => (await db.query(`select status from requests where request_number = $1`, [number])).rows[0].status;

const completeRequest = {
  title: 'Steering hardware', requester: 'Austin Stang', subsystem: 'Suspension', priority: 'Urgent',
  needed_by: '2026-10-05', justification: 'Steering cam assembly',
};
const completeItems = [
  { item_name: 'M3 SHCS', vendor: 'McMaster-Carr', quantity: '2', unit_price: '7.11' },
  { item_name: '', vendor: '', quantity: '', unit_price: '' }, // blank row is dropped
  { item_name: 'Control cable', vendor: '  mcmaster-CARR ', quantity: 15, unit_price: '$2.38' }, // same vendor, different spelling
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
  const { rows } = await db.query(`select email, full_name from profiles where id in ($1, $2) order by email`, [member, other]);
  assert.deepEqual(rows.map((r) => r.full_name), ['Mia Member', 'Otto Other']);
  assert.deepEqual([await roleOf(member), await roleOf(other)], ['member', 'member']);
});

await test('anon can read general and appearance settings but not requests or profiles', async () => {
  await as(null, async () => {
    const { rows } = await db.query(`select key from app_settings order by key`);
    assert.deepEqual(rows.map((r) => r.key), ['appearance', 'general']); // sign-in page: team name, logo, colors
    await rejects(db.query(`select * from settings_history`), /permission denied/);
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
    await rejects(db.query(`insert into profile_roles (user_id, role) values ($1, 'treasurer')`, [member]), /permission denied/);
    await rejects(db.query(`update profiles set full_name = 'x' where id = $1`, [member]), /permission denied/);
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

await test('CE can promote a member', async () => {
  await as(ce, () => rpc('set_user_role', [other, 'treasurer']));
  assert.equal(await roleOf(other), 'treasurer');
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
  assert.equal(after.schemaVersion, 18);
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
    { item_name: 'Tape', vendor: 'Liion', quantity: 1, unit_price: 3 },
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

console.log('Editable permissions');

const permsOf = async (role) =>
  (await db.query(`select permission from role_permissions where role = $1 order by 1`, [role])).rows.map((r) => r.permission);

await test('everyone signed in can read the permission list', async () => {
  const { rows } = await as(member, () => db.query(`select key from permissions order by sort`));
  assert.deepEqual(rows.map((r) => r.key), ['request.review', 'request.order', 'settings.edit', 'site.customize', 'seasons.manage', 'workflow.edit', 'finances.view', 'finances.edit', 'sponsors.view', 'sponsors.edit', 'users.manage']);
});

await test('members cannot change permissions', async () => {
  await as(member, () => rejects(rpc('set_role_permissions', ['member', ['request.review']]), /does not allow/));
});

await test('a CE can give their own role a new permission, and it takes effect', async () => {
  const [cells] = await itemsOf(costReq);
  await as(ce, () => rejects(rpc('update_item_costs', [costReq, [{ id: cells.id, unit_price: 5 }], '']), /does not allow/));
  await as(ce, () => rpc('set_role_permissions', ['ce', ['request.review', 'request.order', 'settings.edit', 'users.manage']]));
  assert.deepEqual(await permsOf('ce'), ['request.order', 'request.review', 'settings.edit', 'users.manage']);
  await as(ce, () => rpc('update_item_costs', [costReq, [{ id: cells.id, unit_price: 5 }], 'CE can order now']));
  await as(ce, () => rpc('set_role_permissions', ['ce', ['request.review', 'settings.edit', 'users.manage']])); // back to normal
});

await test('unknown permissions and roles are refused', async () => {
  await as(ce, () => rejects(rpc('set_role_permissions', ['ce', ['request.review', 'launch.rocket']]), /Unknown permission "launch.rocket"/));
  await as(ce, () => rejects(rpc('set_role_permissions', ['no_such_role', []]), /Unknown role/));
  assert.deepEqual(await permsOf('ce'), ['request.review', 'settings.edit', 'users.manage']); // unchanged
});

await test('you can change your own role', async () => {
  await as(ce, () => rpc('set_user_role', [ce, 'treasurer']));
  assert.equal(await roleOf(ce), 'treasurer');
  await as(ce, () => rpc('set_user_role', [ce, 'ce']));
  assert.equal(await roleOf(ce), 'ce');
});

await test('nobody can remove the last way to manage people', async () => {
  // Removing it from one role is fine while another role still has it…
  await as(ce, () => rpc('set_role_permissions', ['ce', ['request.review', 'settings.edit']]));
  // …but not from the last role that has it.
  await as(treasurer, () => rejects(rpc('set_role_permissions', ['treasurer', ['request.order', 'settings.edit']]), /At least one person must keep/));
  assert.ok((await permsOf('treasurer')).includes('users.manage')); // rolled back
  await as(treasurer, () => rpc('set_role_permissions', ['ce', ['request.review', 'settings.edit', 'users.manage']])); // restore
});

await test('the whole grid saves at once, so "Manage people" can move between roles', async () => {
  // Per role, removing it from treasurer first would be refused; as one save it's fine.
  await as(treasurer, () => rpc('set_permission_matrix', [{ treasurer: ['request.order', 'settings.edit'], ce: ['request.review', 'settings.edit', 'users.manage'] }]));
  assert.ok(!(await permsOf('treasurer')).includes('users.manage'));
  // And a grid that leaves nobody able to manage people is refused as a whole.
  await as(ce, () => rejects(rpc('set_permission_matrix', [{ ce: ['request.review'], member: ['request.review'] }]), /At least one person must keep/));
  assert.deepEqual(await permsOf('member'), []); // nothing from the refused save stuck
  await as(ce, () => rpc('set_permission_matrix', [{ treasurer: ['request.order', 'settings.edit', 'users.manage'] }])); // restore
});

await test('the last person who can manage people cannot demote themselves', async () => {
  // Leave exactly one person with users.manage: only the treasurer role has it, and only `treasurer` holds it.
  await as(treasurer, () => rpc('set_role_permissions', ['ce', ['request.review', 'settings.edit']]));
  await as(treasurer, () => rpc('set_user_role', [other, 'member']));
  await as(treasurer, () => rejects(rpc('set_user_role', [treasurer, 'member']), /At least one person must keep/));
  assert.equal(await roleOf(treasurer), 'treasurer');
  await as(treasurer, () => rpc('set_role_permissions', ['ce', ['request.review', 'settings.edit', 'users.manage']])); // restore
});

console.log('Seasons');

// The permission tests above left the CE with a hand-picked list; put the defaults back.
await db.exec(`insert into role_permissions (role, permission) values ('ce', 'seasons.manage') on conflict do nothing`);

const general = async () => (await db.query(`select value from app_settings where key = 'general'`)).rows[0].value;
const newDraft = async (who = member) => (await as(who, () => rpc('save_request', [null, { title: 'Season test' }, [], 'draft']))).rows[0].result;
const seasonOf = async (num) => (await db.query(`select season from requests where request_number = $1`, [num])).rows[0].season;

await test('existing requests belong to the current season', async () => {
  const { rows } = await db.query(`select count(*)::int as n from requests where season is distinct from '2026-2027'`);
  assert.equal(rows[0].n, 0);
});

await test('numbering continues within the current season', async () => {
  const before = (await db.query(`select max(substring(request_number from '\\d+$')::int) as n from requests where request_number like 'SG27-%'`)).rows[0].n;
  const num = await newDraft();
  assert.equal(num, `SG27-${String(before + 1).padStart(3, '0')}`); // prefix from the earlier prefix test
  assert.equal(await seasonOf(num), '2026-2027');
});

await test('the season can only change through "Start new season"', async () => {
  const g = await general();
  await as(ce, () => rpc('update_settings', ['general', { ...g, season: '2030-2031', seasonPrefix: 'X' }]));
  assert.equal((await general()).season, '2026-2027');
});

await test('members cannot start a new season; bad seasons are refused', async () => {
  await as(member, () => rejects(rpc('start_new_season', ['2027-2028']), /does not allow/));
  await as(ce, () => rejects(rpc('start_new_season', ['27-28']), /YYYY-YYYY/));
  await as(ce, () => rejects(rpc('start_new_season', ['2027-2029']), /YYYY-YYYY/));
  await as(ce, () => rejects(rpc('start_new_season', ['2025-2026']), /must come after/));
});

let oldOrder;
await test('starting 2027-2028 restarts numbering at SG27-001', async () => {
  // Put the prefix back to the normal SG so the new season prefix is SG + 27.
  const g = await general();
  await as(ce, () => rpc('update_settings', ['general', { ...g, requestIdPrefix: 'SG' }]));
  oldOrder = (await db.query(`select request_number from requests where status = 'Ordered' limit 1`)).rows[0]?.request_number;
  const { rows } = await as(ce, () => rpc('start_new_season', ['2027-2028']));
  assert.equal(rows[0].result, 'SG27');
  assert.deepEqual([(await general()).season, (await general()).seasonPrefix], ['2027-2028', 'SG27']);
  const a = await newDraft();
  const b = await newDraft(other);
  assert.deepEqual([a, b], ['SG27-001', 'SG27-002']);
  assert.deepEqual([await seasonOf(a), await seasonOf(b)], ['2027-2028', '2027-2028']);
});

await test('last season\'s requests keep their season and can still be finished', async () => {
  assert.equal(await seasonOf('SG-001'), '2026-2027');
  if (oldOrder) {
    const id = (await db.query(`select id from requests where request_number = $1`, [oldOrder])).rows[0].id;
    await as(treasurer, () => rpc('mark_received', [id, null, 'Arrived after the rollover']));
    assert.equal(await seasonOf(oldOrder), '2026-2027');
  }
});

await test('you can\'t start the same (or an earlier) season twice', async () => {
  await as(ce, () => rejects(rpc('start_new_season', ['2027-2028']), /must come after/));
});

console.log('One vendor per request');

const twoVendors = [
  { item_name: 'Bolts', vendor: 'McMaster-Carr', quantity: 1, unit_price: 5 },
  { item_name: 'Cable', vendor: 'Aircraft Spruce', quantity: 1, unit_price: 9 },
];
const vendorRequest = { ...completeRequest, subsystem: 'Battery', justification: 'x', data: { c_from_china: 'No' } };

await test('a request with items from two vendors is refused (drafts too)', async () => {
  const err = await as(member, () => rejects(rpc('save_request', [null, vendorRequest, twoVendors, 'submit']), /fix/));
  assert.match(err.detail, /same vendor\. This one has: Aircraft Spruce, McMaster-Carr\. Split them/);
  await as(member, () => rejects(rpc('save_request', [null, { title: 'Draft' }, twoVendors, 'draft']), /fix/));
});

await test('the rule can be turned off in settings', async () => {
  const form = await currentForm();
  await as(ce, () => rpc('update_settings', ['form', { ...form, oneVendorPerRequest: false }]));
  const { rows } = await as(member, () => rpc('save_request', [null, vendorRequest, twoVendors, 'submit']));
  assert.match(rows[0].result, /-\d{3}$/);
  await as(ce, () => rpc('update_settings', ['form', { ...form, oneVendorPerRequest: true }]));
});

await test('the rule is skipped when the Vendor field is hidden', async () => {
  const form = await currentForm();
  const hidden = { ...form, itemFields: form.itemFields.map((f) => (f.key === 'vendor' ? { ...f, hidden: true, required: false } : f)) };
  await as(ce, () => rpc('update_settings', ['form', hidden]));
  await as(member, () => rpc('save_request', [null, vendorRequest, twoVendors, 'submit']));
  await as(ce, () => rpc('update_settings', ['form', form]));
});

console.log('Multiple roles & Admin');

await test('someone can hold several roles; their permissions combine', async () => {
  await as(ce, () => rpc('set_user_roles', [other, ['treasurer', 'ce']]));
  assert.equal(await roleOf(other), 'ce,treasurer');
  // They can both review (CE) and order (Treasurer).
  const req = await as(member, () => rpc('save_request', [null, vendorRequest, [twoVendors[0]], 'submit']));
  const id = (await db.query(`select id from requests where request_number = $1`, [req.rows[0].result])).rows[0].id;
  await as(other, () => rpc('review_request', [id, 'approve', '']));
  await as(other, () => rpc('mark_ordered', [id, null, '9001', '']));
  assert.equal((await db.query(`select status from requests where id = $1`, [id])).rows[0].status, 'Ordered');
});

await test('no roles means Member; unknown roles are refused', async () => {
  await as(ce, () => rpc('set_user_roles', [other, []]));
  assert.equal(await roleOf(other), 'member');
  await as(ce, () => rejects(rpc('set_user_roles', [other, ['ce', 'wizard']]), /Unknown role "wizard"/));
  assert.equal(await roleOf(other), 'member'); // unchanged
});

await test('Admin has every permission, including the new ones', async () => {
  const perms = (await db.query(`select string_agg(permission, ',' order by permission) as p from role_permissions where role = 'admin'`)).rows[0].p;
  assert.equal(perms, 'finances.edit,finances.view,request.order,request.review,seasons.manage,settings.edit,site.customize,sponsors.edit,sponsors.view,users.manage,workflow.edit');
});

await test('custom roles: create, rename, grant, and delete', async () => {
  await as(member, () => rejects(rpc('create_role', ['Subsystem Lead']), /does not allow/));
  const key = (await as(ce, () => rpc('create_role', ['Subsystem Lead']))).rows[0].result;
  assert.equal(key, 'subsystem_lead');
  await as(ce, () => rejects(rpc('create_role', ['subsystem lead']), /already a role/));
  await as(ce, () => rpc('rename_role', [key, 'Team Lead']));
  await as(ce, () => rpc('set_permission_matrix', [{ [key]: ['request.review'] }]));
  await as(ce, () => rpc('set_user_roles', [other, [key]]));
  // Deleting the role leaves them as a Member.
  await as(ce, () => rejects(rpc('delete_role', ['treasurer']), /Built-in roles/));
  await as(ce, () => rpc('delete_role', [key]));
  assert.equal(await roleOf(other), 'member');
  assert.equal((await db.query(`select count(*)::int as n from roles where key = $1`, [key])).rows[0].n, 0);
});

await test('lockout protection still holds with several roles', async () => {
  // treasurer + ce both have users.manage; strip it from everyone except a role nobody holds…
  await as(ce, () => rejects(rpc('set_permission_matrix', [{
    ce: ['request.review'], treasurer: ['request.order'], admin: ['request.review'],
  }]), /At least one person must keep/));
});

console.log('Finer permissions');

await test('lists & appearance need "Customize lists & appearance"', async () => {
  await as(ce, () => rejects(rpc('update_settings', ['appearance', { statuses: {} }]), /site.customize/));
  await setRole(other, 'admin');
  await as(other, () => rpc('update_settings', ['appearance', { statuses: { Ordered: { label: 'Purchased', color: 'blue' } } }]));
  await as(other, () => rpc('update_settings', ['lists', { requests: { columns: ['requested', 'title', 'c_cost_center'] } }]));
  const { rows } = await db.query(`select key, value from app_settings where key in ('appearance', 'lists') order by key`);
  assert.equal(rows[0].value.statuses.Ordered.label, 'Purchased');
  assert.deepEqual(rows[1].value.requests.columns, ['requested', 'title', 'c_cost_center']);
  await as(ce, () => rejects(rpc('update_settings', ['bogus', {}]), /Unknown settings key/));
});

await test('seasons & imports need "Seasons & imports"', async () => {
  await as(ce, () => rpc('set_permission_matrix', [{ ce: ['request.review', 'settings.edit', 'users.manage'] }]));
  await as(ce, () => rejects(rpc('import_archive', ['2020-2021', 'x.xlsx', 'Sheet1', ['A'], [{ row_number: 2, fields: { A: '1' } }]]), /seasons.manage/));
  await as(ce, () => rejects(rpc('start_new_season', ['2030-2031']), /seasons.manage/));
  await as(ce, () => rpc('set_permission_matrix', [{ ce: ['request.review', 'settings.edit', 'seasons.manage', 'users.manage'] }]));
});

console.log('Settings history');

const history = async (key) =>
  (await db.query(`select id, value, changed_by_name, note from settings_history where key = $1 order by id`, [key])).rows;

await test('every settings change is kept as a version, with who made it', async () => {
  const before = (await history('form')).length;
  const form = await currentForm();
  await as(ce, () => rpc('update_settings', ['form', { ...form, priorities: [...form.priorities, 'Someday'] }]));
  const after = await history('form');
  assert.equal(after.length, before + 1);
  assert.equal(after.at(-1).changed_by_name, 'Griffin York');
  assert.ok(after.at(-1).value.priorities.includes('Someday'));
  // Saving identical settings doesn't add noise.
  await as(ce, () => rpc('update_settings', ['form', after.at(-1).value]));
  assert.equal((await history('form')).length, before + 1);
});

await test('restoring a version puts it back (and is itself a new version)', async () => {
  const versions = await history('form');
  const previous = versions.at(-2);
  await as(ce, () => rpc('restore_settings_version', [previous.id]));
  assert.ok(!(await currentForm()).priorities.includes('Someday'));
  const now = await history('form');
  assert.equal(now.length, versions.length + 1);
  assert.match(now.at(-1).note, /^Restored the version from/);
});

await test('restore uses the same permission checks as saving', async () => {
  const [version] = (await history('appearance')).slice(-1);
  await as(member, () => rejects(rpc('restore_settings_version', [version.id]), /does not allow/));
  await as(ce, () => rejects(rpc('restore_settings_version', [version.id]), /site.customize/));
});

await test('permission grid changes are versioned and can be undone', async () => {
  const before = await history('permissions');
  await as(ce, () => rpc('set_permission_matrix', [{ member: ['request.review'] }]));
  const after = await history('permissions');
  assert.equal(after.length, before.length + 1);
  assert.deepEqual(after.at(-1).value.member, ['request.review']);
  await as(ce, () => rpc('restore_settings_version', [before.at(-1).id]));
  assert.deepEqual(await permsOf('member'), []);
});

await test('even the first Lists/Appearance change can be undone (back to defaults)', async () => {
  const versions = await history('appearance');
  assert.deepEqual(versions[0].value, {}); // starting point = built-in defaults
  await as(other, () => rpc('restore_settings_version', [versions[0].id])); // `other` is Admin
  assert.deepEqual((await db.query(`select value from app_settings where key = 'appearance'`)).rows[0].value, {});
});

await test('the history starts with the settings as they were before 008', async () => {
  const first = (await db.query(`select changed_by_name, note from settings_history order by id limit 1`)).rows[0];
  assert.deepEqual(first, { changed_by_name: 'Before history started', note: 'Starting point' });
});

console.log('Form sections, conditions & limits');

const oneItem = [{ item_name: 'Bolts', vendor: 'McMaster-Carr', quantity: 1, unit_price: 5 }];
const submit = (request, items = oneItem) => as(member, () => rpc('save_request', [null, request, items, 'submit']));
const saveForm = async (edit) => as(ce, async () => rpc('update_settings', ['form', await withFields(edit)]));

await test('section headings are allowed on requests, never required, and not on items', async () => {
  await saveForm((f) => f.requestFields.push({ key: 'c_funding_section', label: 'Funding', type: 'section', required: false }));
  await as(ce, async () => rejects(rpc('update_settings', ['form', await withFields((f) => (field(f.requestFields, 'c_funding_section').required = true))]), /can't be required/));
  await as(ce, async () => rejects(rpc('update_settings', ['form', await withFields((f) => f.itemFields.push({ key: 'c_sec', label: 'Sec', type: 'section' }))]), /unknown type/));
  await submit(vendorRequest); // a section never blocks a submit
});

await test('a field shown only when another matches is only required then — and hidden answers are dropped', async () => {
  await saveForm((f) =>
    f.requestFields.push(
      { key: 'c_scholarship', label: 'Scholarship funding?', type: 'yesno', required: false },
      { key: 'c_scholarship_form', label: 'Scholarship form sent?', type: 'yesno', required: true, showIf: { field: 'c_scholarship', op: 'equals', value: 'Yes' } }
    )
  );
  // Condition not met: not required, and a stray answer isn't saved.
  const { rows } = await submit({ ...vendorRequest, data: { ...vendorRequest.data, c_scholarship: 'No', c_scholarship_form: 'Yes' } });
  const saved = (await db.query(`select data from requests where request_number = $1`, [rows[0].result])).rows[0].data;
  assert.equal(saved.c_scholarship_form, undefined);
  // Condition met: now it's required.
  const err = await rejects(submit({ ...vendorRequest, data: { ...vendorRequest.data, c_scholarship: 'Yes' } }), /fix/);
  assert.match(err.detail, /Scholarship form sent\? is required/);
});

await test('conditions work on built-in fields too (e.g. Needed by only for Urgent)', async () => {
  await saveForm((f) => (field(f.requestFields, 'needed_by').showIf = { field: 'priority', op: 'isOneOf', value: ['Urgent'] }));
  await submit({ ...vendorRequest, priority: 'Normal', needed_by: '' });
  const err = await rejects(submit({ ...vendorRequest, priority: 'Urgent', needed_by: '' }), /fix/);
  assert.match(err.detail, /Needed by is required/);
  await saveForm((f) => delete field(f.requestFields, 'needed_by').showIf);
});

await test('item fields can depend on the same item (e.g. only for McMaster)', async () => {
  await saveForm((f) => f.itemFields.push({ key: 'c_pack', label: 'Pack size', type: 'text', required: true, showIf: { field: 'vendor', op: 'equals', value: 'mcmaster-carr' } }));
  const err = await rejects(submit(vendorRequest), /fix/);
  assert.match(err.detail, /Item 1: Pack size is required/);
  await submit(vendorRequest, [{ ...oneItem[0], vendor: 'Uline' }]); // other vendor: not asked
  await submit(vendorRequest, [{ ...oneItem[0], data: { c_pack: '50' } }]);
  await saveForm((f) => (f.itemFields = f.itemFields.filter((x) => x.key !== 'c_pack')));
});

await test('min, max and maximum length are enforced', async () => {
  await saveForm((f) =>
    f.requestFields.push(
      { key: 'c_budget_line', label: 'Budget line', type: 'number', required: false, min: '1', max: '100' },
      { key: 'c_code', label: 'Account code', type: 'text', required: false, maxLength: '5' }
    )
  );
  const err = await rejects(submit({ ...vendorRequest, data: { ...vendorRequest.data, c_budget_line: '150', c_code: 'ABCDEFG' } }), /fix/);
  assert.match(err.detail, /Budget line must be at most 100/);
  assert.match(err.detail, /Account code must be 5 characters or fewer/);
  const low = await rejects(submit({ ...vendorRequest, data: { ...vendorRequest.data, c_budget_line: '0' } }), /fix/);
  assert.match(low.detail, /Budget line must be at least 1/);
  await submit({ ...vendorRequest, data: { ...vendorRequest.data, c_budget_line: '42', c_code: 'AB12' } });
});

await test('broken rules are refused when saving the form', async () => {
  const bad = [
    [(f) => (field(f.requestFields, 'title').showIf = { field: 'priority', op: 'isFilled' }), /always shown/],
    [(f) => (field(f.requestFields, 'c_code').showIf = { field: 'c_code', op: 'isFilled' }), /depend on itself/],
    [(f) => (field(f.requestFields, 'c_code').showIf = { field: 'priority', op: 'contains', value: 'x' }), /unknown rule/],
    [(f) => (field(f.requestFields, 'c_code').showIf = { field: 'priority', op: 'equals' }), /needs a value/],
    [(f) => (field(f.requestFields, 'c_code').showIf = { field: 'c_nope', op: 'isFilled' }), /doesn't exist/],
    [(f) => Object.assign(field(f.requestFields, 'c_budget_line'), { min: '10', max: '5' }), /more than its maximum/],
    [(f) => (field(f.requestFields, 'c_code').maxLength = '0'), /between 1 and 5000/],
  ];
  for (const [edit, pattern] of bad) await as(ce, async () => rejects(rpc('update_settings', ['form', await withFields(edit)]), pattern));
});

await test('request page layout and export templates need "Customize lists & appearance"', async () => {
  await as(ce, () => rejects(rpc('update_settings', ['layout', { detailFields: ['requester'] }]), /site.customize/));
  await as(other, () => rpc('update_settings', ['exports', { templates: [{ id: 'dept', name: 'Dept form', rowPer: 'item', columns: ['id', 'item_name'] }] }]));
  await as(other, () => rpc('update_settings', ['layout', { detailFields: ['requester', 'c_cost_center'] }]));
  await as(other, () => rejects(rpc('update_settings', ['appearance', { accent: 'orange' }]), /accent color/));
  await as(other, () => rpc('update_settings', ['appearance', { accent: '#0b7a3e' }]));
});

console.log('\nWorkflow rules, budgets, notifications (010)');

const admin = await signUp('admin@ufl.edu', 'Ada Admin');
const ce2 = await signUp('ce2@ufl.edu', 'Cara Second');
await setRole(admin, 'admin');
await setRole(ce2, 'ce');
await setRole(other, 'member'); // earlier tests made Otto an admin
await saveForm((f) => f.subsystems.push('Aero', 'Suspension'));
const numberOf = (res) => res.rows[0].result;
const planOf = async (number) => (await db.query(`select approval_plan from requests where request_number = $1`, [number])).rows[0].approval_plan;
const setWorkflow = (value) => as(admin, () => rpc('update_settings', ['workflow', value]));
const outbox = async () => (await db.query(`select event, email, channel from notification_outbox order by id`)).rows;
const review = (who, number, decision, comment = '') =>
  as(who, async () => {
    const { rows } = await db.query(`select id from requests where request_number = $1`, [number]);
    return rpc('review_request', [rows[0].id, decision, comment]);
  });

await test('workflow settings need "Workflow, budgets & notifications" (Admin by default)', async () => {
  await as(ce, () => rejects(rpc('update_settings', ['workflow', { rules: [] }]), /workflow.edit/));
  await as(ce, () => rejects(rpc('update_settings', ['notifications', { enabled: true }]), /workflow.edit/));
  await as(admin, () => rejects(rpc('update_settings', ['workflow', { rules: {} }]), /must be a list/));
  await as(admin, () => rejects(rpc('update_settings', ['notifications', { siteUrl: 'example.com' }]), /https/));
});

await test('no rules: any CE approves, as before', async () => {
  const number = numberOf(await submit(vendorRequest));
  assert.equal((await planOf(number)).type, 'any');
  await review(ce2, number, 'approve');
  assert.equal(await statusOf(number), 'Approved');
});

await test('rules: auto-approve small orders, specific CE for a cost center, first match wins', async () => {
  await setWorkflow({
    rules: [
      { name: 'Battery', when: { field: 'subsystem', op: 'equals', value: 'battery' }, then: { type: 'people', people: [ce2] } },
      { name: 'Small', when: { maxTotal: '10' }, then: { type: 'auto' } },
    ],
  });
  // $5 Battery order: Battery matches first, so it waits for Cara.
  const battery = numberOf(await submit(vendorRequest));
  assert.deepEqual(await planOf(battery).then((p) => [p.rule, p.type, p.people]), ['Battery', 'people', [ce2]]);
  await rejects(review(ce, battery, 'approve'), /Only Cara Second can review/);
  await review(admin, battery, 'request_changes', 'Admins can step in'); // workflow.edit can always review
  assert.equal(await statusOf(battery), 'Changes Requested');

  // $5 Suspension order: auto-approved with a note in the history.
  const small = numberOf(await submit({ ...vendorRequest, subsystem: 'Suspension' }));
  assert.equal(await statusOf(small), 'Approved');
  const { rows } = await db.query(`select approver, comment from approvals a join requests r on r.id = a.request_id where request_number = $1`, [small]);
  assert.deepEqual(rows.map((r) => r.approver), ['Automatic']);
  assert.match(rows[0].comment, /"Small"/);

  // $50 Suspension order: no rule matches → any CE.
  const big = numberOf(await submit({ ...vendorRequest, subsystem: 'Suspension' }, [{ ...oneItem[0], unit_price: 50 }]));
  assert.equal((await planOf(big)).type, 'any');
  await rejects(review(member, big, 'approve'), /request.review/);
});

await test('"all of" needs every listed person, counted since the last submit', async () => {
  await setWorkflow({ rules: [{ name: 'Big', when: { minTotal: '100' }, then: { type: 'people', people: [ce, ce2], needAll: true } }] });
  const items = [{ ...oneItem[0], unit_price: 150 }];
  const number = numberOf(await submit(vendorRequest, items));
  await review(ce, number, 'approve');
  assert.equal(await statusOf(number), 'Submitted'); // still waiting on Cara
  await review(ce2, number, 'request_changes', 'Cheaper please');
  // Resubmitted: Griffin's earlier approval no longer counts.
  const { rows } = await db.query(`select id from requests where request_number = $1`, [number]);
  await as(member, () => rpc('save_request', [rows[0].id, vendorRequest, items, 'submit']));
  await review(ce2, number, 'approve');
  assert.equal(await statusOf(number), 'Submitted');
  await review(ce, number, 'approve');
  assert.equal(await statusOf(number), 'Approved');
});

await test('budgets can block the approval that would go over', async () => {
  await setWorkflow({ rules: [], budgets: { field: 'subsystem', amounts: { Aero: '100' }, block: true } });
  const aero = { ...vendorRequest, subsystem: 'Aero' };
  const first = numberOf(await submit(aero, [{ ...oneItem[0], unit_price: 60 }]));
  await review(ce, first, 'approve');
  const second = numberOf(await submit(aero, [{ ...oneItem[0], unit_price: 60 }]));
  await rejects(review(ce, second, 'approve'), /over its budget: \$60\.00 used \+ \$60\.00 = \$120\.00 of \$100\.00/);
  assert.equal(await statusOf(second), 'Submitted');
  await review(ce, second, 'reject', 'Over budget'); // rejecting is always allowed
  // Without "block" it's only shown on the website.
  await setWorkflow({ rules: [], budgets: { field: 'subsystem', amounts: { Aero: '100' }, block: false } });
  const third = numberOf(await submit(aero, [{ ...oneItem[0], unit_price: 60 }]));
  await review(ce, third, 'approve');
  assert.equal(await statusOf(third), 'Approved');
});

await test('notifications are off until turned on', async () => {
  await submit(vendorRequest);
  assert.equal((await outbox()).length, 0);
});

await test('each step queues email / Teams messages for the right people', async () => {
  await setWorkflow({ rules: [] });
  await db.exec(`delete from profile_roles where role = 'ce' and user_id <> '${ce}'`); // one CE, to keep this readable
  await as(admin, () => rpc('update_settings', ['notifications', {
    enabled: true, siteUrl: 'https://solar-gators.github.io/Orders-Form/',
    events: { submitted: { email: true, teams: true }, approved: { email: true }, ready_to_order: { teams: true }, ordered: { email: true }, received: { email: true, teams: true } },
  }]));
  await as(member, () => rpc('update_my_notification_prefs', [true, false])); // Mia: email only
  const number = numberOf(await submit(vendorRequest, [{ ...oneItem[0], unit_price: 20 }]));
  await review(ce, number, 'approve', 'Go for it');
  const { rows } = await db.query(`select id from requests where request_number = $1`, [number]);
  await as(treasurer, () => rpc('mark_ordered', [rows[0].id, '2026-09-30', 'PO-77', '']));
  await as(treasurer, () => rpc('mark_received', [rows[0].id, '2026-10-03', '']));
  // Admins have every permission, so they hear about approvals and orders too.
  assert.deepEqual((await outbox()).map((m) => `${m.event} ${m.email} ${m.channel}`).sort(), [
    'submitted admin@ufl.edu email', 'submitted admin@ufl.edu teams',
    'submitted ce@ufl.edu email', 'submitted ce@ufl.edu teams',
    'approved member@ufl.edu email',
    'ready_to_order admin@ufl.edu teams', 'ready_to_order treasurer@ufl.edu teams',
    'ordered member@ufl.edu email',
    'received member@ufl.edu email', // Mia turned Teams off
  ].sort());
  const { rows: [msg] } = await db.query(`select payload from notification_outbox where event = 'ordered'`);
  assert.equal(msg.payload.request_number, number);
  assert.equal(msg.payload.ticket, 'PO-77');
  assert.equal(Number(msg.payload.total), 20);
  assert.match(msg.payload.recipient_name, /^Mia/);
  await db.exec(`insert into profile_roles (user_id, role) values ('${ce2}', 'ce')`);
});

await test('the outbox is private to workflow admins; test messages go to yourself', async () => {
  await as(member, async () => assert.equal((await db.query(`select * from notification_outbox`)).rows.length, 0));
  await as(member, () => rejects(db.query(`delete from notification_outbox`), /permission denied/));
  await as(ce, () => rejects(rpc('queue_test_notification', ['email']), /workflow.edit/));
  await as(admin, () => rpc('queue_test_notification', ['teams']));
  await as(admin, async () => {
    const { rows } = await db.query(`select event, email, channel from notification_outbox order by id desc limit 1`);
    assert.deepEqual(rows[0], { event: 'test', email: 'admin@ufl.edu', channel: 'teams' });
  });
});

await test('the sender claims each message once, retries failures, then gives up', async () => {
  await as(member, () => rejects(rpc('claim_notifications', [5]), /permission denied/));
  await db.exec('grant all on notification_outbox to service_role'); // Supabase grants this by default
  await db.exec('set role service_role');
  try {
    const first = (await db.query(`select * from claim_notifications(3)`)).rows;
    const second = (await db.query(`select * from claim_notifications(100)`)).rows;
    assert.equal(first.length, 3);
    assert.equal(new Set([...first, ...second].map((r) => r.id)).size, first.length + second.length); // no overlap
    const id = first[0].id;
    await db.query(`select finish_notification($1, true, '')`, [first[1].id]);
    for (let i = 0; i < 5; i++) {
      await db.query(`select finish_notification($1, false, 'Mailbox unavailable')`, [id]);
      if (i < 4) await db.query(`select * from claim_notifications(100)`); // back to pending → picked up again
    }
    const row = async (x) => (await db.query(`select status, attempts, error from notification_outbox where id = $1`, [x])).rows[0];
    assert.deepEqual(await row(id), { status: 'failed', attempts: 5, error: 'Mailbox unavailable' });
    assert.deepEqual(await row(first[1].id), { status: 'sent', attempts: 1, error: '' });
  } finally {
    await db.exec('reset role');
  }
  await as(admin, async () => {
    const { rows } = await db.query(`select id from notification_outbox where status = 'failed'`);
    await rpc('retry_notification', [rows[0].id]);
    assert.equal((await db.query(`select status from notification_outbox where id = $1`, [rows[0].id])).rows[0].status, 'pending');
  });
});

await test('each person can mute single events per channel (011)', async () => {
  await db.exec(`delete from notification_outbox`);
  await as(member, () => rpc('update_my_notification_prefs', [true, true]));
  // Mia: no "approved" email, no "received" at all; junk keys are dropped.
  await as(member, () => rpc('update_my_notification_events', [{
    approved: { email: false }, received: { email: false, teams: false }, launched: { email: false }, ordered: { email: 'no' },
  }]));
  const { rows: [p] } = await db.query(`select notify_events from profiles where id = $1`, [member]);
  assert.deepEqual(p.notify_events, { approved: { email: false }, received: { email: false, teams: false }, ordered: {} });
  await as(admin, () => rpc('update_settings', ['notifications', {
    enabled: true, events: Object.fromEntries(['approved', 'ordered', 'received'].map((e) => [e, { email: true, teams: true }])),
  }]));
  const number = numberOf(await submit(vendorRequest, [{ ...oneItem[0], unit_price: 20 }]));
  await review(ce, number, 'approve');
  const { rows } = await db.query(`select id from requests where request_number = $1`, [number]);
  await as(treasurer, () => rpc('mark_ordered', [rows[0].id, '2026-09-30', 'PO-78', '']));
  await as(treasurer, () => rpc('mark_received', [rows[0].id, '2026-10-03', '']));
  const mine = (await outbox()).filter((m) => m.email === 'member@ufl.edu').map((m) => `${m.event} ${m.channel}`).sort();
  assert.deepEqual(mine, ['approved teams', 'ordered email', 'ordered teams']);
  await as(member, () => rejects(rpc('update_my_notification_events', [[]]), /JSON object/));
});

await test('imported requests are linked to accounts by name (012)', async () => {
  const ownerOf = async (requester) =>
    (await db.query(`select p.full_name from requests r left join profiles p on p.id = r.created_by where r.requester = $1 limit 1`, [requester])).rows[0]?.full_name ?? null;
  // Imported earlier as "Bella N", "Josh", "Zach", with no account behind them.
  assert.equal(await ownerOf('Bella N'), null);
  await signUp('bella@ufl.edu', 'Bella Nguyen'); // first name + initial
  await signUp('josh@ufl.edu', 'Josh  Weiss'); // first name only (the only Josh)
  await signUp('zach1@ufl.edu', 'Zach Adams'); // the only Zach so far: gets "Zach"
  await signUp('zach2@ufl.edu', 'Zach Brown');
  assert.deepEqual([await ownerOf('Bella N'), await ownerOf('Josh'), await ownerOf('Zach')], ['Bella Nguyen', 'Josh  Weiss', 'Zach Adams']);
  // A lead fixes it by hand; only leads can.
  const zachReq = (await db.query(`select id from requests where requester = 'Zach'`)).rows[0].id;
  const zach2Id = (await db.query(`select id from profiles where email = 'zach2@ufl.edu'`)).rows[0].id;
  await as(member, () => rejects(rpc('set_request_owner', [zachReq, zach2Id]), /does not allow/));
  await as(ce, () => rpc('set_request_owner', [zachReq, zach2Id]));
  assert.equal(await ownerOf('Zach'), 'Zach Brown');
  await as(ce, () => rpc('set_request_owner', [zachReq, null])); // "no account", on purpose
  await signUp('zach3@ufl.edu', 'Zach Cole');
  assert.equal(await ownerOf('Zach'), null); // a hand-picked choice is never re-matched

  // New imports link straight away; middle names and punctuation don't matter.
  const sheet = [
    { title: 'Tape', requester: 'bella  nguyen', subsystem: 'Battery', date: '2026-09-12', status: 'Received', items: [{ item_name: 'Tape', quantity: '1', unit_price: '3' }] },
    { title: 'Wire', requester: 'Zach A.', subsystem: 'Battery', date: '2026-09-12', status: 'Received', items: [{ item_name: 'Wire', quantity: '1', unit_price: '3' }] },
  ];
  await as(ce, () => rpc('import_requests', [sheet]));
  assert.equal(await ownerOf('bella  nguyen'), 'Bella Nguyen');
  assert.equal(await ownerOf('Zach A.'), 'Zach Adams');

  // Several people share a first name: "Zach" alone isn't guessed.
  await as(ce, () => rpc('import_requests', [[{ title: 'Nuts', requester: 'Zach', subsystem: 'Battery', date: '2026-09-13', status: 'Received', items: [{ item_name: 'Nuts', quantity: '1', unit_price: '1' }] }]]));
  assert.equal((await db.query(`select created_by from requests where title = 'Nuts'`)).rows[0].created_by, null);

  // Fixing your name on My account picks up your requests.
  await as(ce, () => rpc('import_requests', [[{ title: 'Bolts', requester: 'Pat Quinn', subsystem: 'Battery', date: '2026-09-13', status: 'Received', items: [{ item_name: 'Bolts', quantity: '1', unit_price: '1' }] }]]));
  const pat = await signUp('pat@ufl.edu', 'PQ');
  assert.equal(await ownerOf('Pat Quinn'), null);
  await as(pat, () => rpc('update_my_profile', ['Pat Quinn']));
  assert.equal(await ownerOf('Pat Quinn'), 'Pat Quinn');
  // Requests made on the site keep their real owner.
  assert.equal((await db.query(`select count(*)::int n from requests r join profiles p on p.id = r.created_by where r.requester = 'Austin Stang' and p.email <> 'member@ufl.edu'`)).rows[0].n, 0);
});

console.log('\nHistory, deleting, withdrawing, ticket number (013)');

const events = async (number) =>
  (await db.query(`select kind, actor_name, changes, note from request_events e join requests r on r.id = e.request_id where r.request_number = $1 order by e.id`, [number])).rows;

await test('submitting and resubmitting are logged, with what changed since the last submission', async () => {
  await setWorkflow({ rules: [] });
  const number = numberOf(await submit(vendorRequest, [{ ...oneItem[0], unit_price: 5 }, { ...oneItem[0], item_name: 'Nuts', unit_price: 2 }]));
  await review(ce, number, 'request_changes', 'Cheaper bolts please');
  const id = await idOf(number);
  // Saving a draft in between doesn't log anything; the comparison is with what the CE last saw.
  await as(member, () => rpc('save_request', [id, { ...vendorRequest, needed_by: '2026-10-09' }, [{ ...oneItem[0], unit_price: 4 }, { ...oneItem[0], item_name: 'Nuts', unit_price: 2 }], 'draft']));
  await as(member, () => rpc('save_request', [id, { ...vendorRequest, needed_by: '2026-10-09' }, [{ ...oneItem[0], unit_price: '4.00' }], 'submit']));
  const log = await events(number);
  assert.deepEqual(log.map((e) => e.kind), ['submitted', 'resubmitted']);
  assert.match(log[0].actor_name, /^Mia/);
  assert.deepEqual(log[0].changes, []);
  assert.ok(log[1].changes.includes('Needed by: 2026-10-05 → 2026-10-09'), log[1].changes.join(' | '));
  assert.ok(log[1].changes.includes('Items: 2 → 1'));
  assert.ok(log[1].changes.includes('Item 1 Unit price: 5 → 4'), log[1].changes.join(' | '));
  assert.equal(log[1].changes.length, 3); // 4 vs 4.00 isn't a change; nothing else changed
});

await test('the requester can withdraw a submitted request, and delete drafts / sent-back requests', async () => {
  const number = numberOf(await submit(vendorRequest));
  const id = await idOf(number);
  await as(other, () => rejects(rpc('withdraw_request', [id]), /Only the person who made/));
  await as(member, () => rpc('withdraw_request', [id]));
  assert.equal(await statusOf(number), 'Draft');
  assert.deepEqual((await events(number)).map((e) => e.kind), ['submitted', 'withdrawn']);
  await as(member, () => rejects(rpc('withdraw_request', [id]), /not Submitted/));
  await as(other, () => rejects(rpc('delete_request', [id]), /Only the person who made/));
  await as(member, () => rpc('delete_request', [id]));
  assert.equal((await db.query(`select count(*)::int n from requests where id = $1`, [id])).rows[0].n, 0);
  // Approved requests can't be deleted.
  const kept = numberOf(await submit(vendorRequest));
  await review(ce, kept, 'approve');
  const keptId = await idOf(kept);
  await as(member, () => rejects(rpc('delete_request', [keptId]), /Only drafts and requests sent back/));
});

await test('marking Ordered needs a ticket number unless Settings says otherwise; Ordered / Received record who', async () => {
  const number = numberOf(await submit(vendorRequest));
  await review(ce, number, 'approve');
  const id = await idOf(number);
  await as(treasurer, () => rejects(rpc('mark_ordered', [id, '2026-10-01', '  ', '']), /Enter the ticket/));
  await as(ce, async () => rpc('update_settings', ['form', { ...(await currentForm()), requireOrderNumber: false }]));
  await as(treasurer, () => rpc('mark_ordered', [id, '2026-10-01', '', '']));
  await as(treasurer, () => rpc('mark_received', [id, '2026-10-03', '']));
  const log = await events(number);
  assert.deepEqual(log.map((e) => e.kind), ['submitted', 'ordered', 'received']);
  assert.deepEqual(log.slice(1).map((e) => e.actor_name), ['Tess Treasurer', 'Tess Treasurer']);
  await as(ce, async () => rpc('update_settings', ['form', { ...(await currentForm()), requireOrderNumber: true }]));
});

await test('the Treasurer sets budgets; approving over budget needs a note', async () => {
  const budgets = { field: 'subsystem', amounts: { Aero: '50' }, block: true };
  await as(member, () => rejects(rpc('set_budgets', [budgets]), /Only the Treasurer/));
  await as(treasurer, () => rejects(rpc('set_budgets', [{ ...budgets, amounts: { Aero: 'lots' } }]), /must be a dollar amount/));
  await as(treasurer, () => rpc('set_budgets', [budgets]));
  const wf = (await db.query(`select value from app_settings where key = 'workflow'`)).rows[0].value;
  assert.deepEqual(wf.budgets, budgets);
  assert.ok(Array.isArray(wf.rules)); // the rules are left alone
  const number = numberOf(await submit({ ...vendorRequest, subsystem: 'Aero' }, [{ ...oneItem[0], unit_price: 400 }]));
  await rejects(review(ce, number, 'approve'), /over its budget.*add a note saying why/);
  await review(ce, number, 'approve', 'Competition is next week');
  assert.equal(await statusOf(number), 'Approved');
  const { rows } = await db.query(`select comment from approvals a join requests r on r.id = a.request_id where r.request_number = $1`, [number]);
  assert.deepEqual(rows.map((r) => r.comment), ['Approved over budget: Competition is next week']);
  await as(treasurer, () => rpc('set_budgets', [{ field: '', amounts: {}, block: false }]));
});

await test('"needs your approval" messages wait, and are cancelled if the request is decided first', async () => {
  await as(admin, () => rpc('update_settings', ['notifications', { enabled: true, approvalDelayMinutes: 30, events: { submitted: { email: true } } }]));
  await db.exec(`delete from notification_outbox`);
  const own = numberOf(await submit(vendorRequest)); // e.g. a CE's own order…
  const other = numberOf(await submit(vendorRequest));
  await review(ce, own, 'approve'); // …approved a minute later
  const due = await db.query(`select bool_and(send_after > now() + interval '29 minutes') ok from notification_outbox where event = 'submitted'`);
  assert.equal(due.rows[0].ok, true);
  await db.exec('grant select on requests to service_role'); // Supabase grants this by default
  await db.exec('set role service_role');
  try {
    assert.equal((await db.query(`select * from claim_notifications(100)`)).rows.length, 0); // not due yet
    await db.exec(`update notification_outbox set send_after = now() - interval '1 minute'`); // 30 minutes later
    const sent = (await db.query(`select * from claim_notifications(100)`)).rows;
    const numberOfRow = async (rid) => (await db.query(`select request_number from requests where id = $1`, [rid])).rows[0].request_number;
    assert.ok(sent.length > 0);
    for (const m of sent) assert.equal(await numberOfRow(m.request_id), other); // only the one still waiting
    const cancelled = (await db.query(`select distinct o.status from notification_outbox o join requests r on r.id = o.request_id where r.request_number = $1`, [own])).rows;
    assert.deepEqual(cancelled.map((r) => r.status), ['cancelled']);
  } finally {
    await db.exec('reset role');
  }
  await as(admin, () => rpc('update_settings', ['notifications', { enabled: false }]));
});

await test('nobody can write History directly', async () => {
  await as(member, () => rejects(db.query(`insert into request_events (request_id, kind) select id, 'ordered' from requests limit 1`), /permission denied/));
});

console.log('Finances (014)');

// Earlier tests reshape the Treasurer's and CE's permissions; start from what 014 grants.
await db.exec(`insert into role_permissions (role, permission) values
  ('treasurer', 'finances.view'), ('treasurer', 'finances.edit'), ('ce', 'finances.view') on conflict do nothing;
  delete from role_permissions where role = 'ce' and permission = 'finances.edit';
  delete from role_permissions where role = 'member' and permission like 'finances.%';`);

await test('Finances: the Treasurer edits, Chief Engineers can look, Members see nothing', async () => {
  const sheets = (uid) => as(uid, async () => (await db.query(`select name from finance_sheets order by position`)).rows.map((r) => r.name));
  assert.deepEqual(await sheets(treasurer), ['Ledger']); // the starting sheet
  assert.deepEqual(await sheets(ce), ['Ledger']);
  assert.deepEqual(await sheets(member), []);
  await as(ce, () => rejects(rpc('save_finance_sheet', [null, 'Mine', []]), /does not allow/));
  const ledger = (await db.query(`select id from finance_sheets limit 1`)).rows[0].id;
  await as(member, () => rejects(rpc('add_finance_rows', [ledger, [{ data: {} }]]), /does not allow/));
});

await test('Finances: sheets, rows and cells (two people editing one row keep both edits)', async () => {
  const id = (await as(treasurer, () => rpc('save_finance_sheet', [null, 'Reimbursements', [{ key: 'who', label: 'Who', type: 'text' }, { key: 'amt', label: 'Amount', type: 'money' }]]))).rows[0].result;
  await as(treasurer, () => rejects(rpc('save_finance_sheet', [id, 'Reimbursements', [{ key: 'x', label: ' ' }]]), /needs a name/));
  const added = (await as(treasurer, () => rpc('add_finance_rows', [id, [{ data: { who: 'Mia' } }, { data: { who: 'Otto', amt: '12.50' } }]]))).rows[0].result;
  assert.deepEqual(added.map((r) => r.data.who), ['Mia', 'Otto']);
  assert.ok(added[0].position < added[1].position);
  await as(treasurer, () => rpc('set_finance_cell', [added[0].id, 'amt', '40']));
  await as(admin, () => rpc('set_finance_cell', [added[0].id, 'who', 'Mia Member']));
  const row = (await db.query(`select data from finance_rows where id = $1`, [added[0].id])).rows[0].data;
  assert.deepEqual(row, { who: 'Mia Member', amt: '40' });
  await as(treasurer, () => rpc('set_finance_cell', [added[0].id, 'amt', '']));
  assert.deepEqual((await db.query(`select data from finance_rows where id = $1`, [added[0].id])).rows[0].data, { who: 'Mia Member' });
  await as(treasurer, () => rpc('delete_finance_rows', [[added[1].id]]));
  await as(treasurer, () => rejects(rpc('set_finance_cell', [added[1].id, 'who', 'x']), /deleted/));
  await as(treasurer, () => rpc('delete_finance_sheet', [id]));
  assert.equal((await db.query(`select count(*)::int n from finance_rows where sheet_id = $1`, [id])).rows[0].n, 0);
});

await test('Finances: nobody writes the tables directly', async () => {
  await as(treasurer, () => rejects(db.query(`insert into finance_sheets (name) values ('Sneaky')`), /permission denied/));
  await as(treasurer, () => rejects(db.query(`update finance_rows set data = '{}'`), /permission denied/));
});

console.log('Sponsors board (015)');

const coordinator = await signUp('coord@ufl.edu', 'Cora Coordinator');
await setRole(coordinator, 'coordinator');
// Earlier tests reshape the CE's permissions; start from what 015 grants.
await db.exec(`insert into role_permissions (role, permission) values ('ce', 'sponsors.view'), ('treasurer', 'sponsors.view') on conflict do nothing;
  delete from role_permissions where role in ('ce', 'treasurer') and permission = 'sponsors.edit';`);
const thisSeason = (await db.query(`select value ->> 'season' s from app_settings where key = 'general'`)).rows[0].s;
const cardRpc = (uid, fn, args) => as(uid, () => rpc(fn, args)).then((r) => r.rows[0].result);

await test('Sponsors: the Business Coordinator edits, leads can look and watch, Members see nothing', async () => {
  const id = await cardRpc(coordinator, 'save_sponsor_card', [null, { name: 'Acme Aerospace', kind: 'Sponsorship', amount: '2500', tags: ['aerospace', ' local ', 'local'] }]);
  const card = (await db.query(`select * from sponsor_cards where id = $1`, [id])).rows[0];
  assert.deepEqual([card.stage, card.season, card.amount, card.tags.sort()], ['prospect', thisSeason, '2500.00', ['aerospace', 'local']]);
  assert.equal((await as(member, () => db.query(`select * from sponsor_cards`))).rows.length, 0);
  assert.equal((await as(ce, () => db.query(`select * from sponsor_cards`))).rows.length, 1);
  await as(ce, () => rejects(rpc('save_sponsor_card', [id, { name: 'Hacked' }]), /does not allow/));
  await as(ce, () => rpc('set_sponsor_watch', [id, ce, true])); // can watch themselves
  await as(ce, () => rejects(rpc('set_sponsor_watch', [id, treasurer, true]), /does not allow/)); // not others
  await as(coordinator, () => rejects(rpc('set_sponsor_watch', [id, member, true]), /can't see the Sponsors board/));
  const watchers = (await db.query(`select user_id from sponsor_watchers where card_id = $1 order by user_id`, [id])).rows.map((r) => r.user_id);
  assert.deepEqual(watchers.sort(), [ce, coordinator].sort()); // the creator watches by default
  await as(coordinator, () => rejects(rpc('save_sponsor_card', [id, { amount: 'lots' }]), /must be a number/));
  await as(coordinator, () => rejects(rpc('save_sponsor_card', [id, { stage: 'nowhere' }]), /doesn't exist/));
});

await test('Sponsors: moving and commenting are logged and tell watchers; reaching Received adds income once', async () => {
  const id = (await db.query(`select id from sponsor_cards where name = 'Acme Aerospace'`)).rows[0].id;
  const income = (await as(treasurer, () => rpc('save_finance_sheet', [null, 'Income', [
    { key: 'd', label: 'Date', type: 'date' }, { key: 'f', label: 'From', type: 'text' }, { key: 't', label: 'Type', type: 'select' }, { key: 'a', label: 'Amount', type: 'money' },
  ]]))).rows[0].result;
  const settings = (await db.query(`select value from app_settings where key = 'sponsors'`)).rows[0].value;
  await as(coordinator, () => rpc('save_sponsor_settings', [{ ...settings, income: { sheet: income, columns: { date: 'd', from: 'f', type: 't', amount: 'a' } } }]));
  await as(admin, () => rpc('update_settings', ['notifications', { enabled: true, events: { sponsor_update: { email: true } } }]));
  await db.exec(`delete from notification_outbox`);

  await as(coordinator, () => rpc('move_sponsor_card', [id, 'committed', 1]));
  await as(ce, () => rpc('add_sponsor_comment', [id, 'Called Jane, she wants a logo on the nose cone.']));
  await as(coordinator, () => rpc('save_sponsor_card', [id, { stage: 'received' }]));
  await as(coordinator, () => rpc('move_sponsor_card', [id, 'thanked', 1]));
  await as(coordinator, () => rpc('move_sponsor_card', [id, 'received', 1])); // back and forth: still one income row

  const rows = (await db.query(`select data from finance_rows where sheet_id = $1`, [income])).rows;
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].data.f + '|' + rows[0].data.t + '|' + rows[0].data.a, 'Acme Aerospace|Sponsorship|2500.00');
  const kinds = (await db.query(`select kind from sponsor_activity where card_id = $1 order by id`, [id])).rows.map((r) => r.kind);
  assert.deepEqual(kinds, ['created', 'moved', 'comment', 'moved', 'income', 'moved', 'moved']);
  const sent = (await db.query(`select email, payload from notification_outbox where event = 'sponsor_update' order by id`)).rows;
  // The CE watches: told about the coordinator's moves, not their own comment. The coordinator hears about the comment.
  assert.ok(sent.some((m) => m.email === 'ce@ufl.edu' && /moved from Prospect to Committed/.test(m.payload.what)));
  assert.ok(sent.some((m) => m.email === 'coord@ufl.edu' && /nose cone/.test(m.payload.what)));
  assert.ok(!sent.some((m) => m.email === 'ce@ufl.edu' && /nose cone/.test(m.payload.what)));
  assert.equal(sent[0].payload.path, `/sponsors/${id}`);
  await as(admin, () => rpc('update_settings', ['notifications', { enabled: false }]));
});

await test('Sponsors: renewing copies the card into next season; stages can be renamed but not emptied', async () => {
  const id = (await db.query(`select id from sponsor_cards where name = 'Acme Aerospace'`)).rows[0].id;
  await as(coordinator, () => rpc('save_sponsor_card', [id, { playbook: 'Ask in August, before their budget closes.' }]));
  const next = await cardRpc(coordinator, 'renew_sponsor_card', [id, '2027-2028']);
  const copy = (await db.query(`select * from sponsor_cards where id = $1`, [next])).rows[0];
  assert.deepEqual([copy.season, copy.stage, copy.playbook, copy.renewed_from], ['2027-2028', 'prospect', 'Ask in August, before their budget closes.', id]);
  await as(coordinator, () => rejects(rpc('renew_sponsor_card', [id, '2027-2028']), /already on the 2027-2028 board/));
  await as(coordinator, () => rejects(rpc('save_sponsor_settings', [{ stages: [] }]), /at least one stage/));
  const settings = (await db.query(`select value from app_settings where key = 'sponsors'`)).rows[0].value;
  await as(coordinator, () => rpc('save_sponsor_settings', [{ ...settings, stages: settings.stages.filter((s) => s.key !== 'prospect') }]));
  assert.equal((await db.query(`select stage from sponsor_cards where id = $1`, [next])).rows[0].stage, 'contacted'); // moved to the new first stage
  await as(member, () => rejects(rpc('add_sponsor_comment', [id, 'hi']), /does not allow/));
  await as(treasurer, () => rejects(db.query(`insert into sponsor_activity (card_id, kind) values ('${id}', 'comment')`), /permission denied/));
});

console.log('Request watchers (016)');

await test('Watchers: anyone can watch; only the requester or a lead adds others; watchers hear about status changes', async () => {
  const number = numberOf(await submit(vendorRequest)); // submitted by the member
  const id = (await db.query(`select id from requests where request_number = $1`, [number])).rows[0].id;
  await as(other, () => rpc('set_request_watch', [id, other, true])); // watch it yourself
  await as(other, () => rejects(rpc('set_request_watch', [id, treasurer, true]), /requester or a lead/));
  await as(member, () => rpc('set_request_watch', [id, treasurer, true])); // the requester can add people
  await as(member, () => rpc('set_request_watch', [id, member, true])); // watching your own request: no extra messages
  const watchers = (await db.query(`select user_id from request_watchers where request_id = $1`, [id])).rows.map((r) => r.user_id).sort();
  assert.deepEqual(watchers, [member, other, treasurer].sort());

  await as(admin, () => rpc('update_settings', ['notifications', { enabled: true, events: { request_update: { email: true }, approved: { email: true } } }]));
  await db.exec(`delete from notification_outbox`);
  await review(ce, number, 'approve');
  const sent = (await db.query(`select event, email from notification_outbox order by id`)).rows.map((r) => `${r.event}:${r.email}`);
  assert.ok(sent.includes('request_update:other@cise.ufl.edu'));
  assert.ok(sent.includes('request_update:treasurer@ufl.edu'));
  assert.ok(!sent.includes('request_update:member@ufl.edu')); // the requester gets "approved" instead
  assert.equal(await statusOf(number), 'Approved', sent.join(' '));

  await as(other, () => rpc('set_request_watch', [id, other, false]));
  assert.equal((await db.query(`select count(*)::int n from request_watchers where request_id = $1 and user_id = $2`, [id, other])).rows[0].n, 0);
  await as(other, () => rejects(db.query(`insert into request_watchers (request_id, user_id) values ('${id}', '${other}')`), /permission denied/));
  await as(admin, () => rpc('update_settings', ['notifications', { enabled: false }]));
});

console.log('Files & links (017)');

await test('Files: who can add and see them on sponsor cards, requests and Finances rows', async () => {
  const card = (await db.query(`select id from sponsor_cards order by created_at limit 1`)).rows[0].id;
  const req = (await db.query(`select id, created_by from requests where created_by = $1 limit 1`, [member])).rows[0].id;
  const sheet = (await db.query(`select id from finance_sheets limit 1`)).rows[0].id;
  const row = (await as(treasurer, () => rpc('add_finance_rows', [sheet, [{ data: {} }]]))).rows[0].result[0].id;
  const add = (uid, kind, owner, path, url, label = '') =>
    as(uid, () => rpc('add_attachment', [kind, owner, path, url, path ? 'file.pdf' : '', path ? 1000 : null, path ? 'application/pdf' : '', label]));

  await add(coordinator, 'sponsor', card, `sponsor/${card}/a-logo.png`, null, 'Logo');
  await add(coordinator, 'sponsor', card, null, 'https://drive.google.com/folder', 'Shared folder');
  await as(ce, () => rejects(add(ce, 'sponsor', card, null, 'https://x.com'), /can't add files/)); // CEs can only look
  await add(member, 'request', req, `request/${req}/b-quote.pdf`, null, 'Quote'); // the requester
  await as(other, () => rejects(add(other, 'request', req, null, 'https://x.com'), /can't add files/)); // someone else's request
  await add(treasurer, 'finance', row, `finance/${row}/c-receipt.pdf`, null);
  await as(member, () => rejects(add(member, 'finance', row, null, 'https://x.com'), /can't add files/));
  await as(coordinator, () => rejects(add(coordinator, 'sponsor', card, `request/${req}/sneaky.pdf`, null), /wrong place/));
  await as(coordinator, () => rejects(add(coordinator, 'sponsor', card, null, 'javascript:alert(1)'), /https/));

  const sees = async (uid) => (await as(uid, () => db.query(`select label from attachments order by label`))).rows.map((r) => r.label);
  assert.deepEqual(await sees(member), ['Quote']); // members see request files only
  assert.deepEqual((await sees(ce)).sort(), ['', 'Logo', 'Quote', 'Shared folder'].sort()); // CE: sponsors + finances (view) + requests
  const counts = (await as(coordinator, () => rpc('attachment_counts', ['sponsor']))).rows[0].result;
  assert.equal(counts[card], 2);
  const log = (await db.query(`select body from sponsor_activity where card_id = $1 and kind = 'file' order by id`, [card])).rows.map((r) => r.body);
  assert.deepEqual(log, ['Added the file "Logo".', 'Added the link "Shared folder".']);
});

await test('Files: renewing a card keeps its files; storage is freed only when the last link to a file goes', async () => {
  const card = (await db.query(`select id from sponsor_cards order by created_at limit 1`)).rows[0].id;
  const next = (await as(coordinator, () => rpc('renew_sponsor_card', [card, '2099-2100']))).rows[0].result;
  const logo = (await db.query(`select id, path from attachments where sponsor_card_id = $1 and label = 'Logo'`, [card])).rows[0];
  assert.equal((await db.query(`select count(*)::int n from attachments where sponsor_card_id = $1`, [next])).rows[0].n, 2);
  const first = (await as(coordinator, () => rpc('delete_attachment', [logo.id]))).rows[0].result;
  assert.equal(first, null); // the renewed card still uses it
  const copy = (await db.query(`select id from attachments where sponsor_card_id = $1 and label = 'Logo'`, [next])).rows[0].id;
  const last = (await as(coordinator, () => rpc('delete_attachment', [copy]))).rows[0].result;
  assert.equal(last, logo.path); // now the website deletes the file itself
  const quote = (await db.query(`select id from attachments where label = 'Quote'`)).rows[0].id;
  await as(other, () => rejects(rpc('delete_attachment', [quote]), /can't remove/));
  await as(member, () => rejects(db.query(`delete from attachments`), /permission denied/));
});

console.log("Treasurer's ledger (018)");

await test('Ledger: purchases on their own and the department steps of a request; only the Treasurer edits', async () => {
  const own = (await as(treasurer, () => rpc('save_purchase', [null, { description: 'CNC machining', amount: '3440', category: 'Extraneous', dept: 'M', dept_status: 'sent', order_number: '6369', notes: 'PayPal link' }]))).rows[0].result;
  const row = (await db.query(`select * from finance_purchases where id = $1`, [own])).rows[0];
  assert.deepEqual([row.amount, row.category, row.dept_status, row.season], ['3440.00', 'Extraneous', 'sent', thisSeason]);
  await as(treasurer, () => rejects(rpc('save_purchase', [own, { amount: 'a lot' }]), /must be a number/));
  await as(ce, () => rejects(rpc('save_purchase', [own, { notes: 'x' }]), /does not allow/));
  assert.equal((await as(ce, () => db.query(`select * from finance_purchases`))).rows.length, 1); // CEs can look
  assert.equal((await as(member, () => db.query(`select * from finance_purchases`))).rows.length, 0);

  const number = numberOf(await submit(vendorRequest));
  const req = (await db.query(`select id from requests where request_number = $1`, [number])).rows[0].id;
  const linked = (await as(treasurer, () => rpc('save_purchase', [null, { request_id: req, dept: 'E', dept_status: 'sent', description: 'ignored', amount: '1' }]))).rows[0].result;
  const again = (await as(treasurer, () => rpc('save_purchase', [null, { request_id: req, notes: 'PO# 2701564675' }]))).rows[0].result;
  assert.equal(again, linked); // one row per request
  const l = (await db.query(`select * from finance_purchases where id = $1`, [linked])).rows[0];
  assert.deepEqual([l.dept, l.dept_status, l.notes, l.description, l.amount], ['E', 'sent', 'PO# 2701564675', '', null]);
  await as(treasurer, () => rejects(rpc('save_purchase', [linked, { dept_status: 'ordered' }]), /from its own page/));
  await as(treasurer, () => rejects(rpc('delete_purchase', [linked]), /comes from a request/));
  await as(treasurer, () => rpc('delete_purchase', [own]));
});

await test('Ledger: purchases on their own count toward a budget when approving', async () => {
  // What earlier tests already approved for Aero this season; the budget leaves room for 100 more.
  const used = Number((await db.query(`select coalesce(sum(request_total(id)), 0) n from requests where subsystem = 'Aero' and season = $1 and status in ('Approved', 'Ordered', 'Received')`, [thisSeason])).rows[0].n);
  await as(treasurer, () => rpc('set_budgets', [{ field: 'subsystem', amounts: { Aero: String(used + 100) }, block: true }]));
  await as(treasurer, () => rpc('save_purchase', [null, { description: 'Primer', amount: '80', category: 'aero ', dept_status: 'ordered' }]));
  const number = numberOf(await submit({ ...vendorRequest, subsystem: 'Aero' }, [{ ...oneItem[0], quantity: 1, unit_price: 30 }]));
  const err = await rejects(review(ce, number, 'approve'), /over its budget/);
  assert.ok(err.message.includes(`$${(used + 80).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} used + $30.00`), err.message);
  const cancelled = (await db.query(`select id from finance_purchases where description = 'Primer'`)).rows[0].id;
  await as(treasurer, () => rpc('save_purchase', [cancelled, { dept_status: 'cancelled' }]));
  await review(ce, number, 'approve'); // cancelled purchases don't count
  assert.equal(await statusOf(number), 'Approved');
  await as(treasurer, () => rpc('set_budgets', [{ field: '', amounts: {}, block: false }]));
});

await test('Ledger: receipts can be attached to purchases logged on their own', async () => {
  const own = (await as(treasurer, () => rpc('save_purchase', [null, { description: 'Gloves', amount: '55.99' }]))).rows[0].result;
  await as(treasurer, () => rpc('add_attachment', ['purchase', own, `purchase/${own}/r-receipt.pdf`, null, 'receipt.pdf', 2000, 'application/pdf', 'Receipt']));
  await as(member, () => rejects(rpc('add_attachment', ['purchase', own, null, 'https://x.com', '', null, '', '']), /can't add files/));
  assert.equal((await as(ce, () => db.query(`select * from attachments where finance_purchase_id = $1`, [own]))).rows.length, 1); // CEs can look
  assert.equal((await as(member, () => db.query(`select * from attachments where finance_purchase_id = $1`, [own]))).rows.length, 0);
  assert.equal((await as(treasurer, () => rpc('attachment_counts', ['purchase']))).rows[0].result[own], 1);
  await as(treasurer, () => rpc('delete_purchase', [own]));
  assert.equal((await db.query(`select count(*)::int n from attachments where finance_purchase_id = $1`, [own])).rows[0].n, 0);
});

await test('Ledger: funding sources and the season notes', async () => {
  const fund = (await as(treasurer, () => rpc('save_fund', [null, { name: 'Donations', kind: 'Donation', expected: '24000', received: '18500' }]))).rows[0].result;
  await as(treasurer, () => rejects(rpc('save_fund', [fund, { expected: 'twenty' }]), /must be numbers/));
  await as(treasurer, () => rpc('save_finance_season', [thisSeason, { rainy_day: '2128.75', notes: '$13,970 minimum for competition' }]));
  await as(treasurer, () => rpc('save_finance_season', [thisSeason, { notes: 'Updated' }])); // the balance is kept
  const s = (await db.query(`select rainy_day, notes from finance_seasons where season = $1`, [thisSeason])).rows[0];
  assert.deepEqual([s.rainy_day, s.notes], ['2128.75', 'Updated']);
  await as(ce, () => rejects(rpc('delete_fund', [fund]), /does not allow/));
  await as(treasurer, () => rejects(db.query(`update finance_funds set received = 0`), /permission denied/));
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
