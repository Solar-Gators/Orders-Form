/**
 * Data access. Reads query tables directly (row-level security allows reads
 * for signed-in users); every write calls a database function (supabase.rpc)
 * that checks permissions and workflow rules — see supabase/schema.sql.
 *
 * Views only use this module, so they don't know or care about Supabase.
 */
import { supabase } from './supabase.js';
import { itemTotal, round2 } from './ui.js';

const REQUEST_SELECT = '*, request_items(*), approvals(*), order_information(*)';

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
  const { request_items, order_information, ...rest } = row;
  return {
    ...rest,
    items,
    approvals,
    latest_approval: approvals[approvals.length - 1] || null,
    order,
    total: round2(items.reduce((s, i) => s + i.item_total, 0)),
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
  async listRequests(status) {
    let q = supabase.from('requests').select(REQUEST_SELECT).order('created_at', { ascending: false });
    if (Array.isArray(status)) q = q.in('status', status);
    else if (status) q = q.eq('status', status);
    return unwrap(await q).map(hydrate);
  },

  async countByStatus(status) {
    const { count, error } = await supabase.from('requests').select('id', { count: 'exact', head: true }).eq('status', status);
    if (error) throw toError(error);
    return count || 0;
  },

  /** Look up by request number, e.g. "SG-001". */
  async getRequest(requestNumber) {
    const row = unwrap(await supabase.from('requests').select(REQUEST_SELECT).eq('request_number', requestNumber).maybeSingle());
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

  async markReceived(id, { received_date, received_notes }) {
    unwrap(await supabase.rpc('mark_received', { p_id: id, p_received_date: received_date || null, p_notes: received_notes }));
  },

  // ---- People ---------------------------------------------------------------

  async listProfiles() {
    return unwrap(await supabase.from('profiles').select('*').order('full_name'));
  },

  async setUserRole(userId, role) {
    unwrap(await supabase.rpc('set_user_role', { p_user_id: userId, p_role: role }));
  },

  async updateMyProfile(fullName) {
    unwrap(await supabase.rpc('update_my_profile', { p_full_name: fullName }));
  },
};
