/** Help page: the team's own instructions, written in Admin → Text & banner. */
import { auth } from '../auth.js';
import { renderRichText } from '../ui.js';

export async function renderHelp(el, { config }) {
  const text = config.appearance?.helpText || '';
  el.innerHTML = `
    <div class="page-header"><div><h1>Help</h1></div></div>
    <section class="card help-page">${
      renderRichText(text) ||
      `<p class="muted">No help has been written yet.${auth.can('site.customize') ? ' Add it in <a href="#/admin/text">Admin → Text & banner</a>.' : ''}</p>`
    }</section>`;
}
