/**
 * Which columns, filters and default sort each request list shows.
 * Saved in the `lists` settings (Admin → Display → Lists, layout & Excel) — these are just the defaults.
 *
 * A column is either a request field (built-in like Subsystem, or custom like
 * Cost center — keyed by the field key) or a computed value (Requested, Total,
 * Status, Approved date, …). Column objects are the same shape as ui.js COLUMNS.
 */
import { COLUMNS, priorityTag, statusLabel, optionChip } from './ui.js';
import { requestFields, getValue, displayValue, fieldOptions, answerable } from './formFields.js';

export const LISTS = {
  requests: {
    label: 'Requests',
    help: 'Everyone sees this list: all of the season\'s requests.',
    columns: ['requested', 'title', 'requester', 'subsystem', 'total', 'status', 'needed_by'],
    sort: { key: 'requested', dir: 'desc' },
    filters: ['owner', 'status', 'subsystem'],
  },
  approvals: {
    label: 'Approvals',
    help: 'Requests waiting for a Chief Engineer.',
    columns: ['requested', 'title', 'requester', 'subsystem', 'total', 'needed_by'],
    sort: { key: 'needed_by', dir: 'asc' },
  },
  treasurerToOrder: {
    label: 'Treasurer — To order',
    help: 'Approved requests waiting to be ordered.',
    columns: ['requested', 'title', 'requester', 'subsystem', 'total', 'vendors', 'approvedOn'],
    sort: { key: 'approvedOn', dir: 'asc' },
  },
  treasurerOrdered: {
    label: 'Treasurer — Awaiting delivery',
    help: 'Ordered requests waiting to arrive.',
    // Same first columns as To order, so the two tables on the page line up.
    columns: ['requested', 'title', 'requester', 'subsystem', 'total', 'vendors', 'orderNumber', 'orderedOn'],
    sort: { key: 'orderedOn', dir: 'asc' },
  },
};

// Computed (non-field) columns that can be added to any list.
const COMPUTED = ['requested', 'total', 'shipping', 'itemCount', 'status', 'vendors', 'approvedOn', 'orderedOn', 'orderNumber', 'receivedOn', 'season', 'id'];

// Built-in fields with special display (title links to the request, overdue dates in red, …).
const SPECIAL = { title: 'title', requester: 'requester', subsystem: 'subsystem', needed_by: 'neededBy' };

/** A list column for any request field. */
function fieldColumn(f) {
  const special = SPECIAL[f.key] && COLUMNS[SPECIAL[f.key]];
  if (special) return { ...special, key: f.key, label: f.label, fromField: true };
  const isNum = f.type === 'number';
  return {
    key: f.key,
    label: f.label,
    fromField: true,
    className: isNum ? 'num' : '',
    cell: (r) => {
      const v = getValue(r, f);
      if (f.key === 'priority') return v ? priorityTag(v) : '—';
      if (f.type === 'select' || f.type === 'yesno') return optionChip(f.key, v);
      return displayValue(f, v);
    },
    sort: (r) => {
      const v = getValue(r, f);
      return isNum && v !== '' ? Number(v) : v;
    },
    defaultDir: f.type === 'date' ? 'asc' : undefined,
    dirLabels: f.type === 'date' ? { asc: 'earliest first', desc: 'latest first' } : undefined,
  };
}

/** Every column that can be shown: the form's request fields, then computed values. */
export function availableColumns(config) {
  const fields = answerable(requestFields(config)).filter((f) => !f.hidden).map(fieldColumn);
  return [...fields, ...COMPUTED.map((k) => COLUMNS[k])];
}

/** Saved settings for a list, falling back to the defaults above. */
export function listSettings(listName, config) {
  return { ...LISTS[listName], ...(config.lists?.[listName] || {}) };
}

/** The columns a list shows, in order. Title is always included (it's the link to the request). */
export function listColumns(listName, config) {
  const all = new Map(availableColumns(config).map((c) => [c.key, c]));
  const keys = listSettings(listName, config).columns || LISTS[listName].columns;
  const cols = keys.map((k) => all.get(k)).filter(Boolean);
  if (!cols.some((c) => c.key === 'title')) cols.splice(Math.min(1, cols.length), 0, all.get('title'));
  return cols;
}

/** The starting sort for a list (must be one of its columns). */
export function listSort(listName, config) {
  const cols = listColumns(listName, config);
  const saved = listSettings(listName, config).sort;
  const fallback = LISTS[listName].sort;
  const ok = (s) => s && cols.some((c) => c.key === s.key && c.sort);
  return { ...(ok(saved) ? saved : ok(fallback) ? fallback : { key: cols.find((c) => c.sort)?.key, dir: 'asc' }) };
}

/**
 * Filters that can appear above the Requests list: "Everyone / My requests",
 * Status, and any dropdown or yes/no request field.
 */
export function availableFilters(config) {
  return [
    {
      key: 'owner', label: 'Whose requests', options: [['mine', 'My requests'], ['watching', 'Requests I watch']], all: 'Everyone',
      match: (r, v, ctx) => (v === 'watching' ? ctx.watching?.has(r.id) : r.created_by === ctx.userId),
    },
    { key: 'status', label: 'Status', options: config.statuses.map((s) => [s, statusLabel(s)]), all: 'All statuses', match: (r, v) => r.status === v },
    ...requestFields(config)
      .filter((f) => !f.hidden && (f.type === 'select' || f.type === 'yesno'))
      .map((f) => ({
        key: f.key,
        label: f.label,
        options: fieldOptions(f, config).map((o) => [o, o]),
        all: `Any ${f.label.toLowerCase()}`,
        match: (r, v) => String(getValue(r, f)) === v,
      })),
  ];
}

/** The filters the Requests list shows, in order. */
export function listFilters(config) {
  const all = new Map(availableFilters(config).map((f) => [f.key, f]));
  const keys = listSettings('requests', config).filters || LISTS.requests.filters;
  return keys.map((k) => all.get(k)).filter(Boolean);
}
