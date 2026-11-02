/**
 * The same sponsor across cars and seasons (migration 027). Cards are grouped by
 * name, give or take "Inc.", "The", plurals and punctuation ("Fusion Filaments" /
 * "Fusion Filament", "Tilton" / "Tilton Engineering"), unless someone linked or
 * unlinked them by hand (sponsor_key).
 *
 *   sponsorKey(card)        → the group a card belongs to
 *   groupSponsors(cards)    → Map(key → cards, newest first)
 *   tagLookalikes(counts)   → [[tag, tag…]] spelled differently but the same ("aero-body", "aerobody")
 *
 * Tested in tests/sponsorGroups.test.mjs.
 */

// Words that don't tell sponsors apart.
const FILLER = new Set(['the', 'inc', 'incorporated', 'llc', 'ltd', 'limited', 'corp', 'corporation', 'co', 'company', 'companies',
  'international', 'intl', 'usa', 'us', 'america', 'americas', 'group', 'holdings', 'technologies', 'technology', 'tech',
  'engineering', 'stores', 'store', 'industries', 'manufacturing', 'mfg', 'plc', 'gmbh', 'ag', 'sa', 'of']);

/** "Pellucere Technologies, Inc." → "pellucere"; "Fusion Filaments" → "fusion filament". */
export function normalizeName(name) {
  const words = String(name || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\(.*?\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(Boolean);
  const kept = words.filter((w) => !FILLER.has(w));
  return (kept.length ? kept : words).map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w)).join(' ');
}

export const sponsorKey = (card) => card.sponsor_key || normalizeName(card.name) || card.id;

/** Newest first: by season (no season counts as oldest), then when the card was added. */
const newest = (a, b) => (b.season || '').localeCompare(a.season || '') || String(b.created_at).localeCompare(String(a.created_at));

export function groupSponsors(cards) {
  const groups = new Map();
  for (const c of cards) {
    const k = sponsorKey(c);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c);
  }
  for (const list of groups.values()) list.sort(newest);
  return groups;
}

const tagForm = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, '').replace(/(?<=.{3})s$/, '');

/** Tags that are the same apart from spaces, hyphens, case or a plural, most used first in each set. */
export function tagLookalikes(counts) {
  const sets = new Map();
  for (const tag of Object.keys(counts)) {
    const f = tagForm(tag);
    if (!sets.has(f)) sets.set(f, []);
    sets.get(f).push(tag);
  }
  return [...sets.values()].filter((s) => s.length > 1).map((s) => s.sort((a, b) => counts[b] - counts[a] || a.localeCompare(b)));
}
