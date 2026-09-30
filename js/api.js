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
    return hydrate(row);
  },

  /** Create (id null) or update. action: 'draft' | 'submit'. Returns the request number. */
  async saveRequest(id, { action, request, items }) {
    return unwrap(await supabase.rpc('save_request', { p_id: id || null, p_request: request, p_items: items, p_action: action }));
  },

  async review(id, decision, comment) {
    unwrap(await supabase.rpc('review_request', { p_id: id, p_decision: decision, p_comment: comment }));
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
  },

  /** Treasurer: change unit price / shipping after approval. items: [{ id, unit_price?, shipping_cost? }] */
  async updateItemCosts(id, items, reason) {
    return unwrap(await supabase.rpc('update_item_costs', { p_request_id: id, p_items: items, p_reason: reason }));
  },

  async markReceived(id, { received_date, received_notes }) {
    unwrap(await supabase.rpc('mark_received', { p_id: id, p_received_date: received_date || null, p_notes: received_notes }));
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

  async listProfiles() {
    return unwrap(await supabase.from('profiles').select('*').order('full_name'));
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

  async updateMyProfile(fullName) {
    unwrap(await supabase.rpc('update_my_profile', { p_full_name: fullName }));
  },
};
