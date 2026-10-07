/**
 * Tables marked data-fit (see fitTables in js/ui.js) turn into cards on any screen when
 * they don't fit, using the same look as on phones. This copies the phone rules for the
 * card tables (.stack-mobile, .stack-form, .request-cards, .fields-table) out of the
 * @media (max-width: 640px) blocks in css/styles.css and re-targets them at `.is-stacked`,
 * between the GENERATED markers.
 *
 * Run after changing those phone rules:  node tools/gen-stacked-css.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';

const FILE = new URL('../css/styles.css', import.meta.url);
const START = '/* ---- GENERATED: stacked tables (node tools/gen-stacked-css.mjs) ---- */';
const END = '/* ---- END GENERATED ---- */';

let css = readFileSync(FILE, 'utf8').replace(/\r\n/g, '\n');
const before = css.indexOf(START);
if (before !== -1) css = css.slice(0, before).trimEnd() + '\n' + css.slice(css.indexOf(END) + END.length).replace(/^\n+/, '\n');

// Classes of tables that have a phone card layout.
const MARKERS = [/\.stack-mobile(?![\w-])/, /\.stack-form(?![\w-])/, /\.request-cards(?![\w-])/, /\.fields-table(?![\w-])/, /\.detail-items tfoot/];

const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
const rules = [];
const media = /@media \(max-width: 640px\) \{/g;
let m;
while ((m = media.exec(css))) {
  // The block's body: up to the brace that closes the @media.
  let depth = 1;
  let i = m.index + m[0].length;
  const from = i;
  for (; depth && i < css.length; i++) depth += css[i] === '{' ? 1 : css[i] === '}' ? -1 : 0;
  const body = strip(css.slice(from, i - 1));
  for (const [, selector, decls] of body.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = selector.trim();
    if (!MARKERS.some((re) => re.test(sel))) continue;
    // Mark the first card-table class in each selector (once) as .is-stacked.
    const stacked = sel
      .split(',')
      .map((part) => {
        const p = part.trim();
        const re = MARKERS.find((m) => m.test(p));
        return re ? p.replace(re, (m) => m.replace(/^(\.[\w-]+)/, '$1.is-stacked')) : p;
      })
      .join(',\n');
    rules.push(`${stacked} {${decls.replace(/\s+/g, ' ').trimEnd()} }`);
  }
}

const out = `${css.trimEnd()}\n\n${START}\n${rules.join('\n')}\n${END}\n`;
writeFileSync(FILE, out);
console.log(`Wrote ${rules.length} stacked-table rules.`);
