/**
 * Tables marked data-fit (see fitTables in js/ui.js) turn into cards on any screen when
 * they don't fit, using the same look as on phones. This copies the phone rules for
 * .stack-mobile / .stack-form tables out of the @media (max-width: 640px) blocks in
 * css/styles.css and re-targets them at `.is-stacked`, between the GENERATED markers.
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
    if (!/\.stack-mobile|\.stack-form|\.detail-items tfoot/.test(sel)) continue;
    const stacked = sel
      .split(',')
      .map((s) =>
        s
          .trim()
          .replace(/\.stack-mobile(?![\w-])/, '.stack-mobile.is-stacked')
          .replace(/\.stack-form(?![\w-])/, '.stack-form.is-stacked')
          .replace(/(^|\s)(\.table)?\.detail-items tfoot/, '$1$2.detail-items.is-stacked tfoot')
      )
      .join(',\n');
    rules.push(`${stacked} {${decls.replace(/\s+/g, ' ').trimEnd()} }`);
  }
}

const out = `${css.trimEnd()}\n\n${START}\n${rules.join('\n')}\n${END}\n`;
writeFileSync(FILE, out);
console.log(`Wrote ${rules.length} stacked-table rules.`);
