/**
 * Database tests: loads supabase/schema.sql into PGlite (real Postgres running
 * in Node) with a small stand-in for Supabase's `auth` schema, then exercises
 * the workflow and security rules as different users.
 *
 *   npm install
 *   npm run test:db
 */
import { readFileSync } from 'node:fs';
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
await db.exec(readFileSync(new URL('../supabase/schema.sql', import.meta.url), 'utf8'));

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
  assert.match(err.detail, /Item 1: quantity must be a positive number/);
  assert.match(err.detail, /Item 1: vendor is required/);
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

await test('members cannot edit settings; CE can', async () => {
  const form = { subsystems: ['Battery', 'Structures'], priorities: ['Normal', 'Urgent'], defaultPriority: 'Normal' };
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

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
