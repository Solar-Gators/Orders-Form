/** "My account": name, role, notifications, change password, sign out. Also the password-reset landing page. */
import { api } from '../api.js';
import { auth } from '../auth.js';
import { esc, errorBox, setFlash, takeFlash } from '../ui.js';

function passwordForm(buttonLabel) {
  return `
    <form id="password-form" novalidate>
      <div class="field"><label for="a-pass">New password</label>
        <input id="a-pass" name="password" type="password" autocomplete="new-password" minlength="8"></div>
      <div class="field"><label for="a-pass2">Confirm new password</label>
        <input id="a-pass2" name="confirm" type="password" autocomplete="new-password"></div>
      <div id="password-errors"></div>
      <button type="submit" class="btn">${buttonLabel}</button>
    </form>`;
}

function bindPasswordForm(el, onDone) {
  const form = el.querySelector('#password-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const { password, confirm } = Object.fromEntries(new FormData(form));
    const errors = el.querySelector('#password-errors');
    errors.innerHTML = '';
    if (password.length < 8) return (errors.innerHTML = errorBox(new Error('Password must be at least 8 characters.')));
    if (password !== confirm) return (errors.innerHTML = errorBox(new Error('Passwords do not match.')));
    try {
      await auth.updatePassword(password);
      onDone();
    } catch (err) {
      errors.innerHTML = errorBox(err);
    }
  });
}

/** The messages this person can get, worded for them. */
function myEvents(config) {
  const me = auth.user.id;
  const namedInRule = (config.workflow?.rules || []).some((r) => !r.disabled && (r.then?.people || []).includes(me));
  const approver = auth.can('request.review') || auth.can('workflow.edit') || namedInRule;
  return [
    approver && { key: 'submitted', mine: 'A request needs your approval' },
    auth.can('request.order') && { key: 'ready_to_order', mine: 'A request is approved and ready to order' },
    { key: 'approved', mine: 'Your request was approved' },
    { key: 'changes_requested', mine: 'Changes were requested on your request' },
    { key: 'rejected', mine: 'Your request was rejected' },
    { key: 'ordered', mine: 'Your request was ordered' },
    { key: 'received', mine: 'Your request arrived' },
    { key: 'request_update', mine: 'A request you watch changes status' },
    (auth.can('sponsors.view') || auth.can('sponsors.edit')) && { key: 'sponsor_update', mine: 'A sponsor card you watch moves or gets a note' },
  ].filter(Boolean);
}

export async function renderAccount(el, { config, rerender }) {
  const user = auth.user;
  const notify = config.notifications || {};
  el.innerHTML = `
    ${takeFlash()}
    <div class="page-header"><div><h1>My account</h1></div>
      <button type="button" class="btn btn-sm" id="sign-out">Sign out</button></div>
    <div class="account-page">
      <section class="card">
        <h2>Profile</h2>
        <form id="profile-form" novalidate>
          <div class="field"><label for="a-name">Full name</label>
            <input id="a-name" name="full_name" type="text" value="${esc(user.full_name)}" autocomplete="name"></div>
          <dl class="meta-grid compact">
            <div><dt>Email</dt><dd>${esc(user.email)}</dd></div>
            <div><dt>Role</dt><dd>${esc(auth.roleLabel)}</dd></div>
          </dl>
          <p class="muted small">Roles are given by your team leads.</p>
          <div id="profile-errors"></div>
          <button type="submit" class="btn btn-primary">Save profile</button>
        </form>
      </section>
      <section class="card">
        <h2>Notifications</h2>
        <p class="muted small">${notify.enabled
          ? `Messages go to <strong>${esc(user.email)}</strong> (email and/or Teams). Untick anything you don't want; changes save right away.`
          : 'Email and Teams messages are turned off for the whole team right now. Your choices here apply once they are turned on.'}</p>
        <div id="notify-table"></div>
        <div id="notify-errors"></div>
        <p class="muted small" id="notify-saved" hidden>Saved.</p>
      </section>
      <section class="card">
        <h2>Change password</h2>
        ${passwordForm('Update password')}
      </section>
    </div>`;

  el.querySelector('#profile-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = e.target.full_name.value.trim();
    try {
      await api.updateMyProfile(name);
      await auth.refresh();
      setFlash('Profile saved.');
      await rerender();
    } catch (err) {
      el.querySelector('#profile-errors').innerHTML = errorBox(err);
    }
  });

  // ---- Notifications: an overall switch per channel, then one row per event ----
  const CHANNELS = [['email', 'Email', 'notify_email'], ['teams', 'Teams', 'notify_teams']];
  const choices = structuredClone(user.notify_events || {});
  const teamOn = (ev, ch) => notify.events?.[ev]?.[ch] === true;
  const mineOn = (ev, ch) => choices[ev]?.[ch] !== false;
  const events = myEvents(config);

  const drawNotify = () => {
    const box = (checked, attrs, disabled, title = '') =>
      `<input type="checkbox" ${attrs} ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''} ${title ? `title="${esc(title)}"` : ''}>`;
    el.querySelector('#notify-table').innerHTML = `
      <div class="table-wrap flat"><table class="table events-table">
        <thead><tr><th></th>${CHANNELS.map(([, label]) => `<th class="center">${label}</th>`).join('')}</tr></thead>
        <tbody>
          <tr class="notify-all"><td><strong>All messages</strong><div class="muted small">Turn a channel off completely</div></td>
            ${CHANNELS.map(([ch, label, col]) => `<td class="center">${box(user[col] !== false, `data-all="${ch}" aria-label="All ${label}"`, false)}</td>`).join('')}</tr>
          ${events
            .map(
              (ev) => `<tr><td>${esc(ev.mine)}</td>
                ${CHANNELS.map(([ch, label, col]) => {
                  const off = !teamOn(ev.key, ch);
                  return `<td class="center">${
                    off ? `<span class="muted small" title="Your leads turned ${label} off for this message">—</span>`
                      : box(mineOn(ev.key, ch), `data-ev="${ev.key}" data-ch="${ch}" aria-label="${esc(label)}: ${esc(ev.mine)}"`, user[col] === false)
                  }</td>`;
                }).join('')}</tr>`
            )
            .join('')}
        </tbody>
      </table></div>
      <p class="muted small">— means your leads don't send that message by that channel (Admin → Approvals &amp; alerts → Notifications).</p>`;
  };

  const saved = async (fn) => {
    try {
      await fn();
      el.querySelector('#notify-errors').innerHTML = '';
      el.querySelector('#notify-saved').hidden = false;
    } catch (err) {
      el.querySelector('#notify-errors').innerHTML = errorBox(err);
    }
  };
  el.querySelector('#notify-table').addEventListener('change', async (e) => {
    const t = e.target;
    if (t.dataset.all) {
      const email = el.querySelector('[data-all="email"]').checked;
      const teams = el.querySelector('[data-all="teams"]').checked;
      await saved(async () => {
        await api.updateMyNotificationPrefs(email, teams);
        Object.assign(user, { notify_email: email, notify_teams: teams });
      });
      drawNotify();
    } else if (t.dataset.ev) {
      const { ev, ch } = t.dataset;
      choices[ev] = { ...(choices[ev] || {}), [ch]: t.checked };
      if (t.checked) delete choices[ev][ch]; // on is the default; only "off" is stored
      if (!Object.keys(choices[ev]).length) delete choices[ev];
      await saved(async () => {
        await api.updateMyNotificationEvents(choices);
        user.notify_events = structuredClone(choices);
      });
    }
  });
  drawNotify();

  bindPasswordForm(el, async () => {
    setFlash('Password updated.');
    await rerender();
  });

  el.querySelector('#sign-out').addEventListener('click', () => auth.signOut());
}

/** Landing page after clicking a password-reset email link. */
export async function renderResetPassword(el) {
  el.innerHTML = `
    <div class="auth-wrap">
      <div class="auth-card card">
        <h1>Choose a new password</h1>
        ${passwordForm('Save new password')}
      </div>
    </div>`;
  bindPasswordForm(el, () => {
    setFlash('Password updated. You are signed in.');
    location.hash = '#/home';
  });
}
