/**
 * Sign in / create account / forgot password. Shown for every route while
 * signed out.
 */
import { auth } from '../auth.js';
import { esc, errorBox, renderRichText } from '../ui.js';

let mode = 'signin'; // 'signin' | 'signup' | 'forgot'
let notice = '';

/** Friendlier wording for common Supabase auth errors. */
function explain(err) {
  const msg = err?.message || '';
  if (/invalid login credentials/i.test(msg)) return new Error('Incorrect email or password.');
  if (/email not confirmed/i.test(msg)) return new Error('Please confirm your email first — check your inbox for the link.');
  if (/database error saving new user/i.test(msg)) return new Error('That email address is not allowed to sign up.');
  if (/rate limit/i.test(msg)) return new Error('Too many emails sent recently. Please wait a few minutes and try again.');
  return err;
}

export async function renderLogin(el, { config }) {
  const domains = config.allowedEmailDomains || [];
  const domainHint = domains.length ? `Use your ${domains.map((d) => '@' + d).join(' or ')} email.` : '';

  const titles = { signin: 'Sign in', signup: 'Create an account', forgot: 'Reset your password' };
  const fields = {
    signin: `
      <div class="field"><label for="l-email">Email</label>
        <input id="l-email" name="email" type="email" autocomplete="email" required></div>
      <div class="field"><label for="l-pass">Password</label>
        <input id="l-pass" name="password" type="password" autocomplete="current-password" required></div>`,
    signup: `
      <div class="field"><label for="l-name">Full name</label>
        <input id="l-name" name="fullName" type="text" autocomplete="name" required></div>
      <div class="field"><label for="l-email">Email</label>
        <input id="l-email" name="email" type="email" autocomplete="email" required>
        ${domainHint ? `<div class="hint">${esc(domainHint)}</div>` : ''}</div>
      <div class="field"><label for="l-pass">Password</label>
        <input id="l-pass" name="password" type="password" autocomplete="new-password" minlength="8" required>
        <div class="hint">At least 8 characters.</div></div>`,
    forgot: `
      <div class="field"><label for="l-email">Email</label>
        <input id="l-email" name="email" type="email" autocomplete="email" required></div>`,
  };
  const submitLabel = { signin: 'Sign in', signup: 'Create account', forgot: 'Send reset link' };

  const links = {
    signin: `<button type="button" class="link-btn" data-mode="forgot">Forgot password?</button>
             <span>New to the team? <button type="button" class="link-btn" data-mode="signup">Create an account</button></span>`,
    signup: `<span>Already have an account? <button type="button" class="link-btn" data-mode="signin">Sign in</button></span>`,
    forgot: `<button type="button" class="link-btn" data-mode="signin">← Back to sign in</button>`,
  };

  // Errors from email links (e.g. an expired link) come back in the URL.
  const urlError = new URLSearchParams(location.search).get('error_description');

  el.innerHTML = `
    <div class="auth-wrap">
      <div class="auth-card card">
        <div class="auth-brand">${esc(config.teamName)} Orders</div>
        <h1>${titles[mode]}</h1>
        ${urlError ? `<div class="alert alert-error">${esc(urlError)}</div>` : ''}
        ${notice ? `<div class="alert alert-success">${esc(notice)}</div>` : ''}
        <div id="auth-errors"></div>
        <form id="auth-form" novalidate>
          ${fields[mode]}
          <button type="submit" class="btn btn-primary btn-block">${submitLabel[mode]}</button>
        </form>
        <div class="auth-links">${links[mode]}</div>
      </div>
      ${config.appearance?.signInMessage ? `<div class="auth-message">${renderRichText(config.appearance.signInMessage)}</div>` : ''}
      <p class="muted small auth-foot">${esc(config.teamName)} · ${esc(config.season)} season</p>
    </div>`;

  const switchMode = (next) => {
    mode = next;
    notice = '';
    renderLogin(el, { config });
  };
  el.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => switchMode(b.dataset.mode)));

  const form = el.querySelector('#auth-form');
  const errors = el.querySelector('#auth-errors');
  form.querySelector('input')?.focus();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    const email = (data.email || '').trim().toLowerCase();
    errors.innerHTML = '';

    // Friendly checks first; the database enforces the same rules.
    const problems = [];
    if (!email.includes('@')) problems.push('Enter a valid email address.');
    if (mode === 'signup') {
      if (!data.fullName?.trim()) problems.push('Enter your full name.');
      const domain = email.split('@')[1] || '';
      if (domains.length && !domains.some((d) => domain === d || domain.endsWith('.' + d))) problems.push(domainHint);
      if ((data.password || '').length < 8) problems.push('Password must be at least 8 characters.');
    }
    if (mode === 'signin' && !data.password) problems.push('Enter your password.');
    if (problems.length) {
      errors.innerHTML = errorBox(Object.assign(new Error('Please fix the following:'), { details: problems }));
      return;
    }

    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      if (mode === 'signin') {
        await auth.signIn(email, data.password);
        // The auth listener in main.js re-renders once the session is ready.
      } else if (mode === 'signup') {
        const needsConfirm = await auth.signUp({ email, password: data.password, fullName: data.fullName.trim() });
        if (needsConfirm) {
          mode = 'signin';
          notice = `Almost done! We sent a confirmation link to ${email}. Click it, then sign in.`;
          renderLogin(el, { config });
        }
      } else {
        await auth.sendPasswordReset(email);
        mode = 'signin';
        notice = `If ${email} has an account, a password reset link is on its way.`;
        renderLogin(el, { config });
      }
    } catch (err) {
      errors.innerHTML = errorBox(explain(err));
      button.disabled = false;
    }
  });
}
