/**
 * The same sponsor across cars (js/sponsorGroups.js).   node tests/sponsorGroups.test.mjs
 */
import assert from 'node:assert/strict';
import { normalizeName, sponsorKey, groupSponsors, tagLookalikes } from '../js/sponsorGroups.js';

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message}`);
    process.exitCode = 1;
  }
}

test('names that mean the same sponsor match', () => {
  assert.equal(normalizeName('Pellucere Technologies, Inc.'), 'pellucere');
  assert.equal(normalizeName('Fusion Filaments'), normalizeName('Fusion Filament'));
  assert.equal(normalizeName('Tilton Engineering'), normalizeName('Tilton'));
  assert.equal(normalizeName('Bridgestone '), normalizeName('bridgestone'));
  assert.equal(normalizeName('Walmart Stores Inc.'), 'walmart');
  assert.equal(normalizeName('Scuba Steve (Espi)'), 'scuba steve');
  assert.equal(normalizeName('The Company'), 'the company'); // only filler words: keep them
  assert.notEqual(normalizeName('Shen Family'), normalizeName('Matthew Shen'));
  assert.equal(normalizeName('Glass'), 'glass'); // "ss" isn't a plural
});

test('cards group by name unless linked or unlinked by hand', () => {
  const cards = [
    { id: '1', name: 'SKF', car: 'Sunrider', season: '', created_at: '2026-01-01' },
    { id: '2', name: 'SKF', car: 'Flare', season: '2023-2024', created_at: '2026-01-02' },
    { id: '3', name: 'Digikey', car: 'Flare', season: '2023-2024', created_at: '2026-01-02' },
    { id: '4', name: 'Digikey Parts Distributor', car: 'Blaze', season: '2026-2027', created_at: '2026-01-03', sponsor_key: 'digikey' },
    { id: '5', name: 'SKF', car: 'Blaze', season: '2026-2027', created_at: '2026-01-03', sponsor_key: 'solo:5' },
  ];
  const g = groupSponsors(cards);
  assert.deepEqual(g.get('skf').map((c) => c.id), ['2', '1']); // newest first
  assert.deepEqual(g.get('digikey').map((c) => c.id), ['4', '3']);
  assert.equal(sponsorKey(cards[4]), 'solo:5');
});

test('finds tags spelled differently', () => {
  const sets = tagLookalikes({ aerobody: 5, 'aero-body': 1, 'Aero Body': 1, electrical: 9, Electrical: 1, mechanical: 3, aero: 2 });
  assert.deepEqual(sets, [['aerobody', 'Aero Body', 'aero-body'], ['electrical', 'Electrical']]);
});

console.log(`${passed} sponsor group tests passed`);
