/**
 * FAKE Supabase client for local development and testing (npm run dev -- --fake).
 * Never used on the live site.
 *
 * Implements just the parts of supabase-js this app uses, on top of PGlite
 * (real Postgres in the browser) loaded with supabase/schema.sql. Queries run
 * as the `authenticated` role with auth.uid() set, so row-level security and
 * permission checks behave like production.
 *
 * Differences from real Supabase: no emails are sent (sign-up signs you in
 * immediately; password reset is not available), and passwords are stored in
 * plain text in the local database. Data is kept in this browser (IndexedDB).
 *
 * Handy from the browser console:
 *   await fakeSql("update profiles set role = 'treasurer' where email = 'you@ufl.edu'")
 *   await fakeReset()   // wipe all local data
 */
import { PGlite } from '/node_modules/@electric-sql/pglite/dist/index.js';

export const isConfigured = true;
export const siteUrl = () => `${location.origin}${location.pathname}`;

const DB_NAME = 'idb://sg-orders-fake';
// Keep in sync with the files in supabase/migrations/.
const MIGRATIONS = ['001_initial.sql', '002_form_fields.sql', '003_archive_and_import.sql', '004_cost_adjustments.sql', '005_editable_permissions.sql', '006_seasons.sql', '007_one_vendor_per_request.sql', '008_roles_admin_history.sql', '009_form_rules_layout_exports.sql', '010_workflow_budgets_notifications.sql', '011_notification_choices.sql', '012_link_imported_requests.sql', '013_history_drafts_ticket.sql', '014_finances.sql', '015_sponsors.sql', '016_request_watchers.sql', '017_attachments.sql', '018_treasurer_ledger.sql', '019_fix_wording_pickup.sql', '020_ledger_category.sql'];
const SESSION_KEY = 'sg-orders-fake-session';

const STUB = `
  create role anon nologin;
  create role authenticated nologin;
  create schema auth;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text unique not null,
                           raw_user_meta_data jsonb default '{}', password text not null);
  create function auth.uid() returns uuid language sql stable
    as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth to anon, authenticated;
  grant usage on schema public to anon, authenticated;
`;

const ready = (async () => {
  // Return `date` columns (type OID 1082) as "YYYY-MM-DD" strings, like PostgREST does.
  const db = new PGlite(DB_NAME, { parsers: { 1082: (value) => value } });
  const { rows } = await db.query(`select to_regclass('public.requests') as t`);
  const fresh = !rows[0].t;
  if (fresh) await db.exec(STUB);

  // Apply supabase/migrations/* in order, remembering which ran (like running them in Supabase).
  await db.exec(`create schema if not exists fake_meta;
                 create table if not exists fake_meta.migrations (name text primary key)`);
  const applied = new Set((await db.query(`select name from fake_meta.migrations`)).rows.map((r) => r.name));
  if (!fresh && !applied.size) applied.add('001_initial.sql'); // local DB created before migrations were tracked
  for (const name of MIGRATIONS) {
    if (applied.has(name)) continue;
    await db.exec(await (await fetch(`supabase/migrations/${name}`)).text());
    await db.query(`insert into fake_meta.migrations values ($1) on conflict do nothing`, [name]);
  }
  if (!fresh) await db.query(`insert into fake_meta.migrations values ('001_initial.sql') on conflict do nothing`);
  return db;
})();

// ---- running queries as a user ------------------------------------------------------

let session = (() => {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
  } catch {
    return null;
  }
})();

let queue = Promise.resolve();
/** Serialize queries so role/claim settings never interleave. */
function asCurrentUser(fn) {
  const run = queue.then(async () => {
    const db = await ready;
    await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [session?.user?.id || '']);
    await db.exec(session ? 'set role authenticated' : 'set role anon');
    try {
      return await fn(db);
    } finally {
      await db.exec('reset role');
    }
  });
  queue = run.catch(() => {});
  return run;
}

const toError = (e) => ({ message: e.message, details: e.detail || null, code: e.code });

// ---- query builder: from(table).select(...).eq().in().order().maybeSingle() -----------

// Embedded relations used by the app: name -> [fk column, one-to-one?]
const EMBEDS = { request_events: ['request_id', false], request_items: ['request_id', false], approvals: ['request_id', false], order_information: ['request_id', true], cost_changes: ['request_id', false], profile_roles: ['user_id', false] };

class Query {
  constructor(table) {
    this.table = table;
    this.filters = [];
    this.params = [];
    this.orders = [];
    this.mode = 'many';
    this.columns = '*';
  }
  select(columns = '*', opts = {}) {
    this.columns = columns;
    this.head = opts.head;
    this.count = opts.count;
    return this;
  }
  eq(col, value) {
    this.params.push(value);
    this.filters.push(`t.${col} = $${this.params.length}`);
    return this;
  }
  neq(col, value) {
    this.params.push(value);
    this.filters.push(`t.${col} is distinct from $${this.params.length}`);
    return this;
  }
  in(col, values) {
    this.params.push(values);
    this.filters.push(`t.${col} = any($${this.params.length})`);
    return this;
  }
  order(col, { ascending = true } = {}) {
    this.orders.push(`t.${col} ${ascending ? 'asc' : 'desc'}`);
    return this;
  }
  range(from, to) {
    this.limitSql = ` limit ${Number(to) - Number(from) + 1} offset ${Number(from)}`;
    return this;
  }
  limit(n) {
    this.limitSql = ` limit ${Number(n)}`;
    return this;
  }
  maybeSingle() {
    this.mode = 'maybeSingle';
    return this;
  }
  single() {
    this.mode = 'single';
    return this;
  }
  sql() {
    const parts = this.columns.split(',').map((s) => s.trim()).filter(Boolean).map((c) => {
      // Embeds: "table(*)" or "table(col, col)".
      const m = c.match(/^(\w+)\(([^)]*)\)$/);
      if (!m) return c === '*' ? 't.*' : `t.${c}`;
      const [fk, one] = EMBEDS[m[1]];
      const cols = m[2].split(',').map((s) => s.trim()).filter(Boolean);
      const row = cols.length === 1 && cols[0] === '*' ? 'x' : `json_build_object(${cols.map((k) => `'${k}', x.${k}`).join(', ')})`;
      return one
        ? `(select ${row === 'x' ? 'row_to_json(x)' : row} from ${m[1]} x where x.${fk} = t.id) as ${m[1]}`
        : `(select coalesce(json_agg(${row}), '[]') from ${m[1]} x where x.${fk} = t.id) as ${m[1]}`;
    });
    const where = this.filters.length ? ` where ${this.filters.join(' and ')}` : '';
    const order = this.orders.length ? ` order by ${this.orders.join(', ')}` : '';
    return `select ${parts.join(', ')} from ${this.table} t${where}${order}${this.limitSql || ''}`;
  }
  async run() {
    try {
      return await asCurrentUser(async (db) => {
        if (this.head) {
          const { rows } = await db.query(`select count(*)::int as n from (${this.sql()}) q`, this.params);
          return { data: null, count: rows[0].n, error: null };
        }
        const { rows } = await db.query(this.sql(), this.params);
        const data = JSON.parse(JSON.stringify(rows, (k, v) => (typeof v === 'bigint' ? Number(v) : v)));
        if (this.mode === 'many') return { data, error: null };
        if (data.length > 1 || (this.mode === 'single' && !data.length)) return { data: null, error: { message: 'Expected one row' } };
        return { data: data[0] || null, error: null };
      });
    } catch (e) {
      return { data: null, error: toError(e) };
    }
  }
  then(resolve, reject) {
    return this.run().then(resolve, reject);
  }
}

// ---- auth -----------------------------------------------------------------------------

const listeners = new Set();
function setSession(next, event) {
  session = next;
  try {
    next ? localStorage.setItem(SESSION_KEY, JSON.stringify(next)) : localStorage.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
  listeners.forEach((cb) => cb(event, session));
}

async function superuser(sql, params) {
  const db = await ready;
  return (await db.query(sql, params)).rows;
}

const authApi = {
  async getSession() {
    return { data: { session }, error: null };
  },
  onAuthStateChange(cb) {
    listeners.add(cb);
    return { data: { subscription: { unsubscribe: () => listeners.delete(cb) } } };
  },
  async signInWithPassword({ email, password }) {
    const [user] = await superuser(`select id, email from auth.users where lower(email) = lower($1) and password = $2`, [email, password]);
    if (!user) return { data: {}, error: { message: 'Invalid login credentials' } };
    setSession({ user }, 'SIGNED_IN');
    return { data: { session }, error: null };
  },
  async signUp({ email, password, options }) {
    try {
      const [user] = await superuser(
        `insert into auth.users (email, password, raw_user_meta_data) values ($1, $2, $3) returning id, email`,
        [email, password, options?.data || {}]
      );
      setSession({ user }, 'SIGNED_IN');
      return { data: { session, user }, error: null };
    } catch (e) {
      const message = /duplicate key/.test(e.message) ? 'User already registered' : 'Database error saving new user';
      return { data: {}, error: { message } };
    }
  },
  async resetPasswordForEmail() {
    return { data: {}, error: { message: 'Password reset emails are not available in fake mode.' } };
  },
  async updateUser({ password }) {
    await superuser(`update auth.users set password = $2 where id = $1`, [session.user.id, password]);
    return { data: {}, error: null };
  },
  async signOut() {
    setSession(null, 'SIGNED_OUT');
    return { error: null };
  },
};

// Files: kept in memory for this tab (gone after a reload), enough to try attachments.
const fakeFiles = new Map();
const storageApi = {
  from: () => ({
    async upload(path, file) {
      if (fakeFiles.has(path)) return { data: null, error: { message: 'The resource already exists' } };
      fakeFiles.set(path, URL.createObjectURL(file));
      return { data: { path }, error: null };
    },
    async createSignedUrls(paths) {
      return { data: paths.map((path) => ({ path, signedUrl: fakeFiles.get(path) || null, error: fakeFiles.has(path) ? null : 'Not found (fake mode forgets files after a reload)' })), error: null };
    },
    async remove(paths) {
      for (const p of paths) fakeFiles.delete(p);
      return { data: paths.map((name) => ({ name })), error: null };
    },
  }),
};

export const supabase = {
  auth: authApi,
  storage: storageApi,
  from: (table) => new Query(table),
  async rpc(fn, args = {}) {
    try {
      return await asCurrentUser(async (db) => {
        const names = Object.keys(args);
        const { rows } = await db.query(
          `select public.${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(', ')}) as result`,
          names.map((n) => args[n])
        );
        return { data: rows[0]?.result ?? null, error: null };
      });
    } catch (e) {
      return { data: null, error: toError(e) };
    }
  },
};

// Console helpers for testing.
window.fakeSql = async (sql, params) => superuser(sql, params);
window.fakeReset = async () => {
  indexedDB.deleteDatabase('/pglite/sg-orders-fake');
  localStorage.removeItem(SESSION_KEY);
  location.reload();
};

console.info('%cFAKE Supabase backend (local only). Use fakeSql(...) / fakeReset() in the console.', 'color:#f26b1d;font-weight:bold');
