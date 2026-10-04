/**
 * Help page: the team's own instructions, written in Admin → Text & banner.
 * Until leads write their own, a short built-in guide is shown.
 */
import { auth } from '../auth.js';
import { renderRichText } from '../ui.js';

export const DEFAULT_HELP = `# Ordering parts
## 1. Make a request
- Click **New Request**. Fill in what it's for and why, then add one row per item.
- One request = one vendor. Buying from McMaster-Carr and Digi-Key? Make two requests.
- Enter **shipping once** for the whole order, the way the vendor charges it.
- Ordering a whole cart? Tick **Same for every item** for the cart link (or quantity) so you type it once. Every item still needs its own row.
- Not ready? **Save Draft** and finish later. Drafts can be deleted from the request's page.

## 2. Approval
- A Chief Engineer approves it, rejects it, or asks for changes.
- If changes are requested, the request shows at the top of **Requests** under **Needs your action**. Open it, click **Edit request**, fix it and submit again.
- Changed your mind? Open a submitted request and click **Withdraw request**.

## 3. Ordering and delivery
- The Treasurer orders approved requests and marks them **Ordered**, then **Received** when they arrive.
- Each request's **History** shows who did what, and when.

## Finding things
- **Requests** searches IDs, titles, people, vendors, item names, part numbers and ticket numbers.
- **Archive** has past seasons, including the old spreadsheets.
- **My account** is where you choose which emails and Teams messages you get.`;

export async function renderHelp(el, { config }) {
  const own = String(config.appearance?.helpText || '').trim();
  el.innerHTML = `
    <div class="page-header"><div><h1>Help</h1></div></div>
    <section class="card help-page">${renderRichText(own || DEFAULT_HELP)}</section>
    ${!own && auth.can('site.customize') ? '<p class="muted small">This is the built-in guide. Write your team\'s own in <a href="#/admin/text">Admin → Text &amp; banner</a>.</p>' : ''}`;
}
