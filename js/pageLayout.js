/**
 * What a request's page shows (Admin → Request page). Saved in the `layout`
 * settings; everything here is the default when nothing has been changed.
 *
 *   detailFields   request fields in the Details box, in order (sections included)
 *   itemColumns    item fields in the Items table, in order
 *   leadOnly       ["request:key", "item:key"] — only shown to Chief Engineers / Treasurers
 *                  (anyone who can approve or order). A display choice, not a security one:
 *                  the data is still readable by signed-in members.
 *   copyButtons    'order' (default: whoever can mark orders) | 'leads' | 'everyone' | 'none'
 *   itemsFirst     show Items above Details
 */
import { auth } from './auth.js';
import { requestFields, itemFields, shown } from './formFields.js';

export const COPY_MODES = [
  { key: 'order', label: 'People who can order (Treasurer)' },
  { key: 'leads', label: 'Chief Engineers and Treasurers' },
  { key: 'everyone', label: 'Everyone' },
  { key: 'none', label: 'Nobody' },
];

// Shown in the request's header instead of the Details box.
const IN_HEADER = new Set(['title', 'priority']);

export function pageLayout(config) {
  const l = config.layout || {};
  return {
    detailFields: l.detailFields,
    itemColumns: l.itemColumns,
    leadOnly: new Set(l.leadOnly || []),
    copyButtons: COPY_MODES.some((m) => m.key === l.copyButtons) ? l.copyButtons : 'order',
    itemsFirst: !!l.itemsFirst,
  };
}

/** Anyone who can approve or order — sees "lead only" fields. */
export const isLead = () => auth.can('request.review') || auth.can('request.order');

export function copyAllowed(layout) {
  switch (layout.copyButtons) {
    case 'everyone':
      return true;
    case 'leads':
      return isLead();
    case 'none':
      return false;
    default:
      return auth.can('request.order');
  }
}

/** Every request field that can go in Details (sections included), by key. */
export const detailCandidates = (config) => shown(requestFields(config)).filter((f) => !IN_HEADER.has(f.key));
export const itemCandidates = (config) => shown(itemFields(config));

/** The Details fields for this viewer, in order. */
export function detailFieldList(config, layout = pageLayout(config)) {
  const all = detailCandidates(config);
  const byKey = new Map(all.map((f) => [f.key, f]));
  const list = layout.detailFields ? layout.detailFields.map((k) => byKey.get(k)).filter(Boolean) : all;
  return list.filter((f) => isLead() || !layout.leadOnly.has(`request:${f.key}`));
}

/** The Items table columns for this viewer, in order (item name is always included). */
export function itemColumnList(config, layout = pageLayout(config)) {
  const all = itemCandidates(config);
  const byKey = new Map(all.map((f) => [f.key, f]));
  const list = layout.itemColumns ? layout.itemColumns.map((k) => byKey.get(k)).filter(Boolean) : all;
  if (!list.some((f) => f.key === 'item_name') && byKey.has('item_name')) list.unshift(byKey.get('item_name'));
  return list.filter((f) => isLead() || f.key === 'item_name' || !layout.leadOnly.has(`item:${f.key}`));
}
