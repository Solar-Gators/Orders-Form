/**
 * Importing an old sponsor spreadsheet into the Sponsors board (Sponsors → "Import
 * from spreadsheet…"), e.g. each car's sponsor list or this year's outreach tracker.
 * Every sheet with a row of column titles is read. Columns are recognised by their
 * titles; anything not recognised is kept in the card's "About this sponsor".
 *
 *   findSponsorHeader(grid)             → index of the row with the column titles (or -1)
 *   guessSponsorColumns(headers)        → { columnIndex: field }
 *   readSponsorRows(grid, opts)         → [{ row, name, fields…, junk }]  (one per sponsor row)
 *   toSponsorCard(row, opts)            → what import_sponsor_cards takes
 *   guessCar(filename)                  → "Flare" from "Flare Sponsors.xlsx"
 *
 * The pure parts are tested in tests/sponsorImport.test.mjs.
 */
import { toMoney } from './itemImport.js';

// Title patterns per field, in the order columns are claimed (each column is used once).
const COLUMNS = [
  ['name', /sponsor\s*name|^\s*(company|organi[sz]ation|business|donor|sponsor)(\s*name)?\s*$|^\s*name\s*$/i],
  ['amount', /money|monley|amount|\$|value|dollars|cash/i],
  ['level', /level|tier/i],
  ['gave', /helped how|^\s*donated|what they|requested support|offer|gave|provided|contribution|in[-\s]?kind/i],
  ['contacted', /date contacted|contacted on|last contact/i],
  ['contact_email', /e-?mail/i],
  ['contact_phone', /phone|number|\btel\b|cell/i],
  ['contact_name', /contact\s*name|^\s*contact\s*(person)?\s*$/i],
  ['other_contact', /contact/i],
  ['address', /address|mailing/i],
  ['lead', /responsible|assigned|team member|\blead\b|point of contact|\bpoc\b|owner/i],
  ['system', /system|sub-?team/i],
  ['website', /website|\burl\b|link|web\s*page/i],
  ['follow_up', /follow/i],
  ['status', /status|stage/i],
  ['outcome', /outcome|result/i],
  ['priority', /priority/i],
  ['category', /category/i],
  ['why', /why/i],
  ['notes', /note|comment|remark/i],
];

/** The row with the column titles: in the top 15, the first with a sponsor-name column and another we know. */
export function findSponsorHeader(grid) {
  for (let r = 0; r < Math.min(15, grid.length); r++) {
    const fields = Object.values(guessSponsorColumns(grid[r] || []));
    if (fields.includes('name') && fields.length >= 2) return r;
  }
  return -1;
}

/** { column index: field } from the titles. */
export function guessSponsorColumns(headers) {
  const out = {};
  const used = new Set();
  for (const [field, re] of COLUMNS) {
    const i = headers.findIndex((h, n) => !used.has(n) && h && re.test(h));
    if (i >= 0) {
      out[i] = field;
      used.add(i);
    }
  }
  return out;
}

const EMAIL = /[^@\s,;<>()]+@[^@\s,;<>()]+\.[a-z]{2,}/gi;
const oneLine = (s) => String(s || '').replace(/\s*\r?\n\s*/g, ', ').replace(/\t/g, ' ').trim();
const isNone = (s) => /^\s*(n\/?a|none|-+|\?)?\s*$/i.test(s || '');

/**
 * Sponsor rows of one sheet. opts: { sheet } (its name, added as a tag when the
 * workbook has several sheets, e.g. "Mechanical Sponsors" → "mechanical").
 * Rows that look like totals, questions ("Mitsuba?") or have only a name are marked junk.
 */
export function readSponsorRows(grid, { sheet = '' } = {}) {
  const h = findSponsorHeader(grid);
  if (h < 0) return [];
  const headers = grid[h];
  const map = guessSponsorColumns(headers);
  const nameCol = Number(Object.keys(map).find((k) => map[k] === 'name'));
  const sheetTag = sheet.replace(/\b(sponsors?|sponsorships?|sheet\d*|outreach|tracker)\b/gi, '').trim().toLowerCase();
  const rows = [];
  for (let r = h + 1; r < grid.length; r++) {
    const cells = grid[r] || [];
    const name = oneLine(cells[nameCol]);
    if (!name) continue;
    const row = { row: r + 1, sheet, name, sheetTag, extra: [] };
    let filled = 0;
    cells.forEach((v, c) => {
      const text = String(v ?? '').trim();
      if (c === nameCol || !text) return;
      filled++;
      const field = map[c];
      if (field) row[field] = text;
      else if (headers[c]) row.extra.push([oneLine(headers[c]), text]);
    });
    if (/^(total|grand total|sum|subtotal)\b/i.test(name)) row.junk = 'Looks like a total';
    else if (/\?\s*$/.test(name)) row.junk = 'Ends with a question mark';
    else if (!filled) row.junk = 'Only a name';
    rows.push(row);
  }
  return rows;
}

/** "Flare Sponsors.xlsx" → "Flare"; "Car 3 Sponsors.xlsx" → "Car 3"; the outreach tracker → "". */
export function guessCar(filename) {
  return String(filename || '')
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/\(\d+\)/g, '')
    .replace(/[_]+/g, ' ')
    .replace(/\b(solar\s*gators|sponsors?|sponsorships?|outreach|tracker|list|contacts?|donors?|\d{4}\s*-\s*\d{2,4})\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The board stage for a row's outreach status / outcome, or null (use the default). */
export function stageFor(row, stages) {
  const find = (re, kind) => stages.find((s) => re.test(s.label) || re.test(s.key)) || (kind && stages.find((s) => s.kind === kind));
  const outcome = String(row.outcome || '');
  const status = String(row.status || '');
  if (/declin|reject|not interested|turned down|no response|\bno\b|lost|not this year/i.test(outcome + ' ' + status)) return find(/declin|not this year|lost/i, 'lost')?.key ?? null;
  if (/thank/i.test(outcome + ' ' + status)) return find(/thank/i, 'done')?.key ?? null;
  if (/received|paid|delivered|arrived/i.test(outcome + ' ' + status)) return find(/receiv/i, 'received')?.key ?? null;
  if (/secured|accepted|approved|\byes\b|won|committed|confirmed|agreed/i.test(outcome + ' ' + status)) return find(/commit/i)?.key ?? null;
  if (/talk|meeting|negotiat|repl(y|ied)|respond|call scheduled/i.test(status)) return find(/talk/i)?.key ?? null;
  if (/sent|contacted|emailed|called|reached|submitted|applied/i.test(status)) return find(/contact/i)?.key ?? null;
  if (/not assigned|drafting|to ?do|not started|research|prospect|idea/i.test(status)) return stages[0]?.key ?? null;
  return null;
}

/** The board's type for a row: matched to the board's own list of types where it can. */
function kindFor(row, kinds) {
  const level = String(row.level || '');
  const gave = String(row.gave || '');
  const pick = (word) => kinds.find((k) => k.toLowerCase().startsWith(word.toLowerCase())) || (kinds.length ? '' : word);
  // "Discount on bearings", "Educational discount"; not an ask for "free or discounted parts".
  if (/^\W*discount|discount (on|of|for)|(educational|education|student) discount/i.test(gave)) return pick('Discount');
  if (/grant|scholarship/i.test(gave) || /foundation/i.test(row.name)) return pick('Grant');
  if (/donation/i.test(level)) return pick('Donation');
  if (/^\s*(money|cash)/i.test(gave)) return pick('Sponsorship');
  if (gave && !isNone(gave)) return pick('In-kind');
  return toMoney(row.amount) ? pick('Sponsorship') : '';
}

/**
 * One row → a card for import_sponsor_cards. opts: { car, season, stage (the
 * default), stages, kinds }.
 */
export function toSponsorCard(row, { car = '', season = '', stage = '', stages = [], kinds = [] } = {}) {
  const amount = toMoney(row.amount);
  const emails = String(row.contact_email || '').match(EMAIL) || [];
  const priority = /^\s*[1-5]\s*$/.test(row.priority || '') ? row.priority.trim() : '';
  const contactedOn = /^\d{4}-\d{2}-\d{2}$/.test(row.contacted || '') ? row.contacted : '';
  const tags = [
    !isNone(row.level) && row.level,
    ...String(row.system || '').split(/[/,&+]|\band\b/i),
    row.sheetTag,
  ]
    .map((t) => String(t || '').trim().toLowerCase())
    .filter((t) => t && !isNone(t) && t.length <= 40);
  const about = [
    ['What they gave', row.gave],
    ['Why it matters', row.why],
    ['Priority', priority ? '' : row.priority],
    ['Team member', row.lead],
    ['Other contact', row.other_contact],
    ['Address', row.address],
    ['Contact email', emails.length ? '' : row.contact_email],
    ['Other emails', emails.slice(1).join(', ')],
    ['Amount', amount === null && !isNone(row.amount) ? row.amount : ''],
    ['Outreach status', row.status],
    ['Date contacted', contactedOn ? '' : row.contacted],
    ['Outcome', row.outcome],
    ...row.extra,
  ]
    .filter(([, v]) => v && !isNone(v))
    .map(([k, v]) => `**${k}:** ${oneLine(v)}`);
  const followUp = /^\d{4}-\d{2}-\d{2}$/.test(row.follow_up || '') ? row.follow_up : '';
  if (row.follow_up && !followUp) about.push(`**Follow up:** ${oneLine(row.follow_up)}`);
  return {
    name: row.name,
    stage: stageFor(row, stages) || stage,
    season,
    car,
    kind: kindFor(row, kinds),
    amount: amount === null ? '' : String(Math.round(amount * 100) / 100),
    contact_name: isNone(row.contact_name) ? '' : oneLine(row.contact_name),
    contact_email: emails[0] || '',
    contact_phone: oneLine(row.contact_phone),
    website: oneLine(row.website),
    tags: [...new Set(tags)],
    description: about.join('\n'),
    playbook: String(row.notes || '').trim(),
    follow_up: followUp,
    priority,
    category: oneLine(row.category).slice(0, 80),
    contacted_on: contactedOn,
    lead: oneLine(row.lead),
  };
}
