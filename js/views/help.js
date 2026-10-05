/**
 * Help page: the team's own instructions, written in Admin → Look & text → Text & banner.
 * The Help tab only appears once someone has written it.
 */
import { auth } from '../auth.js';
import { renderRichText } from '../ui.js';

/** Has the team written a Help page? (Decides whether the Help tab shows.) */
export const hasHelp = (config) => String(config.appearance?.helpText || '').trim() !== '';

export async function renderHelp(el, { config }) {
  const own = String(config.appearance?.helpText || '').trim();
  el.innerHTML = `
    <div class="page-header"><div><h1>Help</h1></div></div>
    ${
      own
        ? `<section class="card help-page">${renderRichText(own)}</section>`
        : `<div class="empty">There's no Help page yet.${
            auth.can('site.customize') ? ' Write one in <a href="#/admin/text">Admin → Look &amp; text → Text &amp; banner</a>, and a Help tab appears for everyone.' : ''
          }</div>`
    }`;
}
