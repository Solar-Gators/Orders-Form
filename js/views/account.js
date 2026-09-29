/** "My account": name, role, change password, sign out. Also the password-reset landing page. */
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

export async function renderAccount(el, { rerender }) {
  const user = auth.user;
  el.innerHTML = `
    ${takeFlash()}
    <div class="page-header"><div><h1>My account</h1></div></div>
    <div class="two-col">
      <section class="card">
        <h2>Profile</h2>
        <form id="profile-form" novalidate>
          <div class="field"><label for="a-name">Full name</label>
            <input id="a-name" name="full_name" type="text" value="${esc(user.full_name)}" autocomplete="name"></div>
          <dl class="meta-grid compact">
            <div><dt>Email</dt><dd>${esc(user.email)}</dd></div>
            <div><dt>Role</dt><dd>${esc(auth.roleLabel)}</dd></div>
          </dl>
          <p class="muted small">Roles are assigned by the Chief Engineer or Treasurer.</p>
          <div id="profile-errors"></div>
          <button type="submit" class="btn btn-primary">Save profile</button>
        </form>
      </section>
      <section class="card">
        <h2>Change password</h2>
        ${passwordForm('Update password')}
        <hr>
        <button type="button" class="btn btn-ghost" id="sign-out">Sign out</button>
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
    location.hash = '#/requests';
  });
}
