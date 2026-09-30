/**
 * The request form is described by data (Admin → Form fields), not hard-coded.
 * Two lists live in the `form` settings: requestFields and itemFields.
 *
 *   { key, label, type, builtin, required, hidden, help, options }
 *
 * Built-in fields map to database columns (title, vendor, ...). Custom fields
 * are stored in the `data` object of the request / item. The database
 * validates the same rules (supabase/migrations/002_form_fields.sql).
 */
import { esc, fmtMoney, fmtDate, optionChip, priorityTag } from './ui.js';

export const FIELD_TYPES = [
  { key: 'text', label: 'Short text' },
  { key: 'textarea', label: 'Long text' },
  { key: 'number', label: 'Number' },
  { key: 'date', label: 'Date' },
  { key: 'select', label: 'Dropdown' },
  { key: 'yesno', label: 'Yes / No' },
  { key: 'url', label: 'Link' },
  { key: 'section', label: 'Section heading', requestOnly: true }, // groups fields; no answer
];

/** Kinds of conditions for "show only when…" (same as field_visible() in the database). */
export const CONDITION_OPS = [
  { key: 'equals', label: 'is', needsValue: true },
  { key: 'notEquals', label: 'is not', needsValue: true },
  { key: 'isOneOf', label: 'is one of', needsValue: true, many: true },
  { key: 'isFilled', label: 'is filled in' },
  { key: 'isEmpty', label: 'is empty' },
];

/** The answer to a field on a request or item (built-in at the top level, custom in data). */
const answer = (obj, key) => {
  if (!obj) return '';
  const v = obj[key] ?? obj.data?.[key] ?? '';
  return String(v).trim();
};

/**
 * Is a field shown, given its "show only when…" condition? Item fields look at
 * their own item first, then the request. Mirrors field_visible() in migration 009.
 */
export function isVisible(field, request, item = null) {
  const c = field.showIf;
  if (!c || !c.field) return true;
  const v = (answer(item, c.field) || answer(request, c.field)).toLowerCase();
  const want = Array.isArray(c.value) ? c.value.map((x) => String(x).toLowerCase()) : String(c.value ?? '').toLowerCase();
  switch (c.op) {
    case 'isFilled':
      return v !== '';
    case 'isEmpty':
      return v === '';
    case 'notEquals':
      return v !== want;
    case 'isOneOf':
      return (Array.isArray(want) ? want : [want]).includes(v);
    default:
      return v === want;
  }
}

/** Plain-language version of a condition, e.g. "Scholarship funding? is Yes". */
export function describeCondition(c, fields) {
  if (!c?.field) return '';
  const label = fields.find((f) => f.key === c.field)?.label || c.field;
  const op = CONDITION_OPS.find((o) => o.key === c.op) || CONDITION_OPS[0];
  const value = Array.isArray(c.value) ? c.value.join(' or ') : c.value;
  return `${label} ${op.label}${op.needsValue ? ` ${value}` : ''}`;
}
export const typeLabel = (type) => FIELD_TYPES.find((t) => t.key === type)?.label || type;

/** Always shown and required — the workflow and totals depend on them. */
export const LOCKED = new Set(['title', 'item_name', 'quantity', 'unit_price']);

/** Built-in number fields shown as dollars. */
export const MONEY_FIELDS = new Set(['unit_price', 'shipping_cost']);

/** Built-in dropdowns whose options are edited on the Settings tab. */
export const LIST_FIELDS = { subsystem: 'subsystems', priority: 'priorities' };

// Defaults match migrations 002/004 and are used if settings don't have field lists yet.
export const DEFAULT_REQUEST_FIELDS = [
  { key: 'title', label: 'Request title', type: 'text', builtin: true, required: true },
  { key: 'requester', label: 'Requester name', type: 'text', builtin: true, required: true },
  { key: 'subsystem', label: 'Subsystem', type: 'select', builtin: true, required: true },
  { key: 'priority', label: 'Priority', type: 'select', builtin: true, required: false },
  { key: 'needed_by', label: 'Needed by', type: 'date', builtin: true, required: true },
  {
    key: 'justification', label: 'Justification', type: 'textarea', builtin: true, required: true,
    help: 'Why do you need these items? Be as descriptive as possible — it makes approval easier.',
  },
];
export const DEFAULT_ITEM_FIELDS = [
  { key: 'item_name', label: 'Item name', type: 'text', builtin: true, required: true },
  { key: 'vendor', label: 'Vendor', type: 'text', builtin: true, required: true },
  { key: 'product_link', label: 'Product link', type: 'url', builtin: true, required: false },
  { key: 'part_number', label: 'Part number', type: 'text', builtin: true, required: false },
  { key: 'quantity', label: 'Quantity', type: 'number', builtin: true, required: true },
  { key: 'unit_price', label: 'Unit price', type: 'number', builtin: true, required: true },
  { key: 'shipping_cost', label: 'Shipping', type: 'number', builtin: true, required: false },
  { key: 'notes', label: 'Notes', type: 'text', builtin: true, required: false, help: 'Pack size, shipping, special instructions' },
];

function normalize(list, defaults) {
  if (!Array.isArray(list) || !list.length) return defaults.map((f) => ({ ...f }));
  const out = list.map((f) => (f.builtin ? { ...defaults.find((d) => d.key === f.key), ...f } : { ...f }));
  for (const d of defaults) if (!out.some((f) => f.key === d.key)) out.push({ ...d });
  return out;
}

export const requestFields = (config) => normalize(config.requestFields, DEFAULT_REQUEST_FIELDS);
export const itemFields = (config) => normalize(config.itemFields, DEFAULT_ITEM_FIELDS);
export const shown = (fields) => fields.filter((f) => !f.hidden);
/** Fields that take an answer (everything except section headings). */
export const answerable = (fields) => fields.filter((f) => f.type !== 'section');

export function fieldOptions(field, config) {
  if (field.builtin && LIST_FIELDS[field.key]) return config[LIST_FIELDS[field.key]] || [];
  if (field.type === 'yesno') return ['Yes', 'No'];
  return field.options || [];
}

/** Read a field's value from a request or item (built-in column or data). */
export const getValue = (record, field) => (field.builtin ? record[field.key] : record.data?.[field.key]) ?? '';

/** Write a field's value into a request or item object. */
export function setValue(record, field, value) {
  if (field.builtin) record[field.key] = value;
  else (record.data ??= {})[field.key] = value;
}

/** HTML for an input. `attrs` is extra attribute text (id, data-*, aria-label …). */
export function renderInput(field, value, config, attrs = '') {
  const v = esc(value ?? '');
  // Limits from Admin → Form fields (the database checks them too).
  if (field.maxLength && ['text', 'textarea', 'url'].includes(field.type)) attrs += ` maxlength="${Number(field.maxLength)}"`;
  const ph = field.placeholder ? ` placeholder="${esc(field.placeholder)}"` : '';
  switch (field.type) {
    case 'textarea':
      return `<textarea rows="3" ${attrs}${ph}>${v}</textarea>`;
    case 'select':
    case 'yesno': {
      // Priority always has a value (the default), so it gets no blank choice.
      const blank = field.key === 'priority' ? '' : '<option value="">Select…</option>';
      const opts = fieldOptions(field, config)
        .map((o) => `<option value="${esc(o)}" ${String(o) === String(value) ? 'selected' : ''}>${esc(o)}</option>`)
        .join('');
      return `<select ${attrs}>${blank}${opts}</select>`;
    }
    case 'date':
      return `<input type="date" value="${v}" ${attrs}>`;
    case 'number':
      return `<input type="number" step="any" min="${esc(field.min ?? 0)}"${
        field.max !== undefined && field.max !== '' ? ` max="${esc(field.max)}"` : ''
      } inputmode="decimal" value="${v}" ${attrs}${ph}>`;
    case 'url':
      return `<input type="url" value="${v}" ${attrs}${ph || ' placeholder="https://…"'}>`;
    default:
      return `<input type="text" value="${v}" ${attrs}${ph}>`;
  }
}

/** Read-only HTML for a value (detail page). */
export function displayValue(field, value) {
  if (value === '' || value === null || value === undefined) return '—';
  if (MONEY_FIELDS.has(field.key)) return fmtMoney(value);
  if (field.type === 'date') return fmtDate(value);
  if (field.key === 'priority') return priorityTag(value); // has its own colors
  if (field.type === 'select' || field.type === 'yesno') return optionChip(field.key, value);
  if (field.type === 'url' || /^https?:\/\//i.test(value)) {
    return /^https?:\/\//i.test(value)
      ? `<a href="${esc(value)}" target="_blank" rel="noopener noreferrer">${field.key === 'product_link' ? 'Link' : esc(value)} ↗</a>`
      : esc(value);
  }
  return esc(value);
}

/** Make a unique custom-field key from a label, e.g. "From China?" -> "c_from_china". */
export function makeKey(label, existingKeys) {
  const base = `c_${label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30) || 'field'}`;
  let key = base;
  for (let n = 2; existingKeys.has(key); n++) key = `${base}_${n}`;
  return key;
}
