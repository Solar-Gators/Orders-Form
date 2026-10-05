/**
 * Data access. Reads query tables directly (row-level security allows reads
 * for signed-in users); every write calls a database function (supabase.rpc)
 * that checks permissions and workflow rules — see supabase/schema.sql.
 *
 * Views only use this module, so they don't know or care about Supabase.
 */
import { supabase } from './supabase.js';
import { itemTotal, round2 } from './ui.js';

const BASE_SELECT = '*, request_items(*), approvals(*), order_information(*)';
// cost_changes arrives with migration 004. Until a database has it, fall back to
// the base select so the site keeps working (leads see the "update needed" banner).
let withCostChanges = true;
let hasSeasons = true; // requests.season arrives with migration 006
const requestSelect = () => (withCostChanges ? `${BASE_SELECT}, cost_changes(*)` : BASE_SELECT);

/** Run a requests query; if the database doesn't have cost_changes yet, retry without it. */
async function selectRequests(build) {
  let res = await build(requestSelect());
  if (res.error && withCostChanges && /cost_changes/.test(res.error.message || '')) {
    withCostChanges = false;
    res = await build(requestSelect());
  }
  return res;
}

/** Turn a Supabase/PostgREST error into an Error with a `details` list. */
function toError(e) {
  const err = new Error(e.message || 'Something went wrong.');
  err.details = e.details ? String(e.details).split('\n').filter(Boolean) : [];
  return err;
}

function unwrap({ data, error }) {
  if (error) throw toError(error);
  return data;
}

/** Add items/approvals/order info and computed totals to a request row. */
function hydrate(row) {
  const items = [...(row.request_items || [])]
    .sort((a, b) => a.position - b.position)
    .map((i) => ({ ...i, item_total: itemTotal(i) }));
  const approvals = [...(row.approvals || [])].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const order = Array.isArray(row.order_information) ? row.order_information[0] || null : row.order_information || null;
  const costChanges = [...(row.cost_changes || [])].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const subtotal = round2(items.reduce((s, i) => s + i.item_total, 0));
  const shipping = round2(items.reduce((s, i) => s + (Number(i.shipping_cost) || 0), 0));
  const { request_items, order_information, cost_changes, ...rest } = row;
  return {
    ...rest,
    items,
    approvals,
    latest_approval: approvals[approvals.length - 1] || null,
    order,
    cost_changes: costChanges,
    subtotal, // items only (quantity × unit price)
    shipping,
    total: round2(subtotal + shipping),
    vendors: [...new Set(items.map((i) => i.vendor).filter(Boolean))],
  };
}

// Email / Teams: after each workflow step, ask the send-notifications Edge
// Function to deliver what the database queued. Only when turned on in
// Admin → Notifications (so nothing is called before the function exists).
let notificationsOn = false;
export function setNotificationsOn(on) {
  notificationsOn = !!on;
}
function deliver() {
  if (!notificationsOn || !supabase.functions) return;
  supabase.functions.invoke('send-notifications', { body: {} }).catch(() => {}); // failures are retried next time
}

export const api = {
  // ---- Settings -------------------------------------------------------------

  /** { general: {...}, form: {...} }. Only `general` is readable before sign-in. */
  async getSettings() {
    const rows = unwrap(await supabase.from('app_settings').select('key, value'));
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  },

  async updateSettings(key, value) {
    unwrap(await supabase.rpc('update_settings', { p_key: key, p_value: value }));
  },

  // ---- Requests ---------------------------------------------------------------

  /** All requests, newest first. `status` may be a string or an array. */
  /**
   * Requests, newest first. `status`: a status or list of statuses.
   * `season`: only that season; `notSeason`: every season except that one (Archive).
   */
  async listRequests(status, { season, notSeason } = {}) {
    const run = () =>
      selectRequests((select) => {
        let q = supabase.from('requests').select(select).order('created_at', { ascending: false });
        if (Array.isArray(status)) q = q.in('status', status);
        else if (status) q = q.eq('status', status);
        if (hasSeasons && season) q = q.eq('season', season);
        if (hasSeasons && notSeason) q = q.neq('season', notSeason);
        return q;
      });
    let res = await run();
    // Before migration 006 there is no season column: everything is "this season".
    if (res.error && hasSeasons && /season/.test(res.error.message || '')) {
      hasSeasons = false;
      if (notSeason) return [];
      res = await run();
    }
    return unwrap(res).map(hydrate);
  },

  /** Seasons that have requests, newest first. */
  async listSeasons() {
    const { data, error } = await supabase.from('requests').select('season');
    if (error) return []; // before migration 006 there is no season column
    return [...new Set(data.map((r) => r.season).filter(Boolean))].sort().reverse();
  },

  /** Leads: switch to a new season (numbering restarts, e.g. SG27-001). Returns the new ID prefix. */
  async startNewSeason(season) {
    return unwrap(await supabase.rpc('start_new_season', { p_season: season }));
  },

  async countByStatus(status) {
    const { count, error } = await supabase.from('requests').select('id', { count: 'exact', head: true }).eq('status', status);
    if (error) throw toError(error);
    return count || 0;
  },

  /** Look up by request number, e.g. "SG-001". */
  async getRequest(requestNumber) {
    const row = unwrap(await selectRequests((select) => supabase.from('requests').select(select).eq('request_number', requestNumber).maybeSingle()));
    if (!row) throw new Error(`Request ${requestNumber} was not found.`);
    const r = hydrate(row);
    // History entries (submitted, resubmitted, withdrawn, ordered, received), from migration 013.
    const ev = await supabase.from('request_events').select('*').eq('request_id', r.id).order('id');
    r.events = ev.error ? [] : ev.data;
    return r;
  },

  /** Your own requests that need you (drafts, sent back for changes), from any season. */
  async listMyUnfinished(userId) {
    const res = await selectRequests((select) =>
      supabase.from('requests').select(select).eq('created_by', userId).in('status', ['Changes Requested', 'Draft']).order('updated_at', { ascending: false })
    );
    return res.error ? [] : res.data.map(hydrate);
  },

  /** Your latest requests, any status or season (the Home page). */
  async listMyRecent(userId, limit = 5) {
    const res = await selectRequests((select) =>
      supabase.from('requests').select(select).eq('created_by', userId).order('created_at', { ascending: false }).limit(limit)
    );
    return res.error ? [] : res.data.map(hydrate);
  },

  /** How many of your requests were sent back for changes (for the Requests tab badge). */
  async countMyChangesRequested(userId) {
    const { count, error } = await supabase.from('requests').select('id', { count: 'exact', head: true }).eq('created_by', userId).eq('status', 'Changes Requested');
    return error ? 0 : count || 0;
  },

  /** The requester: delete a draft or a request sent back for changes. */
  async deleteRequest(id) {
    unwrap(await supabase.rpc('delete_request', { p_id: id }));
  },

  /** Treasurer: budgets { field, amounts: { option: dollars }, block }. */
  async setBudgets(budgets) {
    unwrap(await supabase.rpc('set_budgets', { p_budgets: budgets }));
  },

  // ---- Finances (migration 014): the Treasurer's own sheets -----------------------

  async listFinanceSheets() {
    return unwrap(await supabase.from('finance_sheets').select('*').order('position'));
  },
  /** Every row of a sheet, in order (fetched 1,000 at a time, Supabase's page size). */
  async listFinanceRows(sheetId) {
    const rows = [];
    for (let from = 0; ; from += 1000) {
      const page = unwrap(await supabase.from('finance_rows').select('*').eq('sheet_id', sheetId).order('position').range(from, from + 999));
      rows.push(...page);
      if (page.length < 1000) return rows;
    }
  },
  /** Create (id null) or update a sheet. Returns its id. */
  async saveFinanceSheet(id, name, columns, position = null) {
    return unwrap(await supabase.rpc('save_finance_sheet', { p_id: id, p_name: name, p_columns: columns, p_position: position }));
  },
  async deleteFinanceSheet(id) {
    unwrap(await supabase.rpc('delete_finance_sheet', { p_id: id }));
  },
  /** rows: [{ data, request_id? }] → the new rows. */
  async addFinanceRows(sheetId, rows) {
    return unwrap(await supabase.rpc('add_finance_rows', { p_sheet: sheetId, p_rows: rows })) || [];
  },
  async setFinanceCell(rowId, key, value) {
    unwrap(await supabase.rpc('set_finance_cell', { p_row: rowId, p_key: key, p_value: value }));
  },
  async moveFinanceRow(rowId, position) {
    unwrap(await supabase.rpc('move_finance_row', { p_row: rowId, p_position: position }));
  },
  async deleteFinanceRows(ids) {
    unwrap(await supabase.rpc('delete_finance_rows', { p_ids: ids }));
  },

  /** The requester: pull a submitted request back to Draft. */
  async withdrawRequest(id) {
    unwrap(await supabase.rpc('withdraw_request', { p_id: id }));
  },

  /** Create (id null) or update. action: 'draft' | 'submit'. Returns the request number. */
  async saveRequest(id, { action, request, items }) {
    const number = unwrap(await supabase.rpc('save_request', { p_id: id || null, p_request: request, p_items: items, p_action: action }));
    if (action === 'submit') deliver();
    return number;
  },

  async review(id, decision, comment) {
    unwrap(await supabase.rpc('review_request', { p_id: id, p_decision: decision, p_comment: comment }));
    deliver();
  },

  async markOrdered(id, { order_date, department_order_number, treasurer_notes }) {
    unwrap(
      await supabase.rpc('mark_ordered', {
        p_id: id,
        p_order_date: order_date || null,
        p_order_number: department_order_number,
        p_notes: treasurer_notes,
      })
    );
    deliver();
  },

  /** Treasurer: change unit price / shipping after approval. items: [{ id, unit_price?, shipping_cost? }] */
  /** Leads: whose account a request belongs to (null = none). */
  async setRequestOwner(id, userId) {
    unwrap(await supabase.rpc('set_request_owner', { p_id: id, p_user_id: userId }));
  },

  async updateItemCosts(id, items, reason) {
    return unwrap(await supabase.rpc('update_item_costs', { p_request_id: id, p_items: items, p_reason: reason }));
  },

  async markReceived(id, { received_date, received_notes }) {
    unwrap(await supabase.rpc('mark_received', { p_id: id, p_received_date: received_date || null, p_notes: received_notes }));
    deliver();
  },

  // ---- Archive & import -----------------------------------------------------

  async listArchiveImports() {
    return unwrap(await supabase.from('archive_imports').select('*').order('season', { ascending: false }).order('imported_at'));
  },

  /** Every archived row (fetched 1000 at a time — the API's page size). */
  async listArchive() {
    const all = [];
    for (let from = 0; ; from += 1000) {
      const page = unwrap(
        await supabase
          .from('archive_orders')
          .select('*')
          .order('season', { ascending: false })
          .order('row_number')
          .range(from, from + 999)
      );
      all.push(...page);
      if (page.length < 1000) return all;
    }
  },

  async importArchive({ season, sourceFile, sheet, columns, rows }) {
    return unwrap(
      await supabase.rpc('import_archive', { p_season: season, p_source_file: sourceFile, p_sheet: sheet, p_columns: columns, p_rows: rows })
    );
  },

  async deleteArchiveImport(id) {
    unwrap(await supabase.rpc('delete_archive_import', { p_id: id }));
  },

  /** Create requests from this season's sheet. Returns how many were created. */
  async importRequests(requests) {
    return unwrap(await supabase.rpc('import_requests', { p_requests: requests }));
  },

  // ---- People ---------------------------------------------------------------

  /** Everyone, each with `roles: [roleKey, ...]`. */
  async listProfiles() {
    const res = await supabase.from('profiles').select('*, profile_roles(role)').order('full_name');
    if (res.error && /profile_roles/.test(res.error.message || '')) {
      // Before migration 008: one role per person.
      return unwrap(await supabase.from('profiles').select('*').order('full_name')).map((p) => ({ ...p, roles: [p.role] }));
    }
    return unwrap(res).map(({ profile_roles, ...p }) => ({ ...p, roles: (profile_roles || []).map((r) => r.role) }));
  },

  /** The list of abilities, e.g. { key: "request.review", label: "Approve requests", description }. */
  async listPermissions() {
    return unwrap(await supabase.from('permissions').select('*').order('sort'));
  },

  async listRolePermissions() {
    return unwrap(await supabase.from('role_permissions').select('role, permission'));
  },

  /** Save what several roles can do in one step: { roleKey: [permissionKey, ...] }. */
  async setPermissionMatrix(matrix) {
    unwrap(await supabase.rpc('set_permission_matrix', { p_matrix: matrix }));
  },

  async setUserRole(userId, role) {
    unwrap(await supabase.rpc('set_user_role', { p_user_id: userId, p_role: role }));
  },

  /** Give someone exactly these roles (empty list = Member). */
  async setUserRoles(userId, roles) {
    unwrap(await supabase.rpc('set_user_roles', { p_user_id: userId, p_roles: roles }));
  },

  /** Custom roles. createRole returns the new role's key. */
  async createRole(label) {
    return unwrap(await supabase.rpc('create_role', { p_label: label }));
  },
  async renameRole(key, label) {
    unwrap(await supabase.rpc('rename_role', { p_key: key, p_label: label }));
  },
  async deleteRole(key) {
    unwrap(await supabase.rpc('delete_role', { p_key: key }));
  },

  // ---- Settings history ------------------------------------------------------

  /** Saved versions of settings and permissions, newest first. */
  async listSettingsHistory(limit = 150) {
    return unwrap(await supabase.from('settings_history').select('*').order('id', { ascending: false }).range(0, limit - 1));
  },
  async restoreSettingsVersion(id) {
    unwrap(await supabase.rpc('restore_settings_version', { p_id: id }));
  },

  async updateMyProfile(fullName) {
    unwrap(await supabase.rpc('update_my_profile', { p_full_name: fullName }));
  },

  // ---- Notifications ---------------------------------------------------------

  async updateMyNotificationPrefs(email, teams) {
    unwrap(await supabase.rpc('update_my_notification_prefs', { p_email: email, p_teams: teams }));
  },
  /** Per-event choices: { event: { email: false, teams: false } } (missing = on). */
  async updateMyNotificationEvents(events) {
    unwrap(await supabase.rpc('update_my_notification_events', { p_events: events }));
  },
  /** Recent queued / sent messages (needs "Workflow, budgets & notifications"). */
  async listNotifications(limit = 100) {
    return unwrap(
      await supabase.from('notification_outbox').select('id, created_at, event, email, channel, status, attempts, sent_at, error, payload').order('id', { ascending: false }).range(0, limit - 1)
    );
  },
  async queueTestNotification(channel) {
    unwrap(await supabase.rpc('queue_test_notification', { p_channel: channel }));
  },
  async retryNotification(id) {
    unwrap(await supabase.rpc('retry_notification', { p_id: id }));
  },
  /** Run the sender now and wait for its answer: { sent, failed, errors }. */
  async sendNotificationsNow() {
    if (!supabase.functions) throw new Error('Sending is not available in local test mode.');
    const { data, error } = await supabase.functions.invoke('send-notifications', { body: {} });
    if (error) {
      let detail = '';
      try {
        detail = (await error.context?.json?.())?.error || '';
      } catch {}
      throw new Error(detail || `The send-notifications function didn't answer (${error.message}). Is it deployed? See docs/MAINTAINING.md.`);
    }
    const result = typeof data === 'string' ? JSON.parse(data || '{}') : data;
    if (typeof result?.sent !== 'number') {
      throw new Error(
        `The send-notifications function answered, but not with the order form's code (it said: ${JSON.stringify(result).slice(0, 120)}). ` +
          'In Supabase → Edge Functions → send-notifications → Code, replace everything with supabase/functions/send-notifications/index.ts and deploy again.'
      );
    }
    return result;
  },
};
