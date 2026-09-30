# Maintaining Solar Gators Orders

This guide is for whoever maintains the site: setting it up from scratch, running it locally, applying database updates, and understanding the code. For what the site does and how the team uses it, see the [README](../README.md).

**Stack**
- **Website:** plain HTML/CSS/JavaScript, served by **GitHub Pages** from the `main` branch. There is no build step and no server.
- **Accounts + database:** [Supabase](https://supabase.com) (free tier). It handles sign-in, stores the data, and enforces every permission.
- **Live site:** https://solar-gators.github.io/Orders-Form/
- **Changing the site:** edit files, commit, and push to `main`. Pages redeploys in about a minute.

**Permissions** live in the database (`permissions` and `role_permissions` tables), not in code:
- **Changing what a role can do:** use **Admin → Users & roles → Permissions** on the site. The Table Editor works too.
- **Lockout protection:** the database refuses any change (to a role or to the grid) that would leave nobody with `users.manage`.
- **Roles:** a person can hold several roles (`profile_roles` table); their permissions combine. Built-in roles are Member, Chief Engineer, Treasurer and Admin. More can be created on the site.
- **Current permissions:**
  - `request.review`: approve, reject, or request changes.
  - `request.order`: mark Ordered and Received, and adjust costs.
  - `settings.edit`: form fields, dropdown lists, team settings, request rules.
  - `site.customize`: list columns/filters/sorting, status and priority labels and colors.
  - `seasons.manage`: start a new season, import spreadsheets.
  - `users.manage`: roles, custom roles, and the permission grid.
- **Settings history:** every version of `app_settings` (general, form, lists, appearance) and of the permission grid is kept in `settings_history`. Leads restore versions from **Admin → History**.

## Setup (one time, about 15 minutes)

### 1. Create the Supabase project
1. Sign up at https://supabase.com. Create a **team organization** (e.g. "UF Solar Gators") so the project isn't tied to one student's personal account, then invite the other leads.
2. **New project** → any name → pick a strong database password and save it somewhere safe.
3. Open **SQL Editor → New query**. Paste each file in [`supabase/migrations/`](supabase/migrations) **in order** (`001_…`, then `002_…`, …) and click **Run** after each one. Together they create every table, permission, and security rule.

### 2. Configure sign-in
In Supabase, go to **Authentication**:
- **URL Configuration**
  - **Site URL:** your GitHub Pages URL, e.g. `https://<org>.github.io/<repo>/`
  - **Redirect URLs:** add the same URL and `http://localhost:5173/` (for local testing).
- **Emails.** This one matters. Supabase's built-in email service only delivers to members of your Supabase organization, and only a few messages per hour. Pick one:
  - **Recommended:** set up custom SMTP (**Authentication → Emails → SMTP Settings**) with a free provider such as Resend or Brevo. Confirmation and password-reset emails will then work for everyone.
  - **Quick start:** turn off **Confirm email** (**Authentication → Sign In / Providers → Email**). People can sign up and use the site immediately. Only @ufl.edu addresses are accepted, and new accounts can't do anything beyond submit requests until a lead gives them a role. Password-reset emails still need SMTP.

### 3. Connect the website
Open **Project Settings → API** (or the **Connect** button). Copy the **Project URL** and the **anon / publishable** key into [`js/site-config.js`](js/site-config.js).

The anon key is meant to be public. Never paste the `service_role` / secret key anywhere in this repo.

### 4. Make yourself the first Treasurer
Open the site (locally or on GitHub Pages), click **Create an account**, and sign up. Then run this in Supabase's **SQL Editor**:

```sql
update public.profiles set role = 'treasurer' where email = 'you@ufl.edu';
```

Refresh the page. From now on, roles are assigned from **Admin → Users & roles**.

### 5. Publish on GitHub Pages
Push this folder to a GitHub repository. Then go to **Settings → Pages → Build and deployment**, set **Deploy from a branch**, choose `main` and `/ (root)`, and save. The site appears at `https://<org>.github.io/<repo>/` within a minute or two.

> Everything in the repo is public on Pages. `.gitignore` already excludes spreadsheets so real order sheets don't get published.

## Running locally

You need [Node.js](https://nodejs.org) 18+. It's only used for the local server and tests; the site itself has no dependencies.

```bash
npm install
npm run dev
```

Open http://localhost:5173. The site uses the Supabase project configured in `js/site-config.js`.

### Fake mode (no Supabase needed)

```bash
npm run dev -- --fake
```

Fake mode swaps Supabase for an in-browser Postgres ([PGlite](https://pglite.dev)) running the same migrations, so the permissions behave the same. Data stays in your browser. No emails are sent, and signing up logs you in immediately. In the browser console:

```js
await fakeSql("update profiles set role = 'treasurer' where email = 'you@ufl.edu'")  // then refresh
await fakeReset()   // wipe local data
```

### Tests

```bash
npm test
```

`npm test` runs both test files. `npm run test:import` checks spreadsheet column recognition against the real headers of the 2024-25, 2025-26, and 2026-27 sheets. `npm run test:db` runs every file in `supabase/migrations/` in PGlite and checks the security rules as different users, e.g. "a Member can't approve", "a Chief Engineer can't mark ordered", "you can't edit someone else's draft", and "non-UF emails can't sign up". Run it after any database change.

## How it works

```
index.html               Page shell + navigation
css/styles.css           All styling
js/
  site-config.js         Supabase URL + anon key            ← set during setup
  supabase.js            Supabase client
  auth.js                Current user, role, permissions; sign in/up/out
  api.js                 All data reads + actions (views never call Supabase directly)
  router.js              Hash routes (#/new, #/requests, …); sign-in gate; page permissions
  main.js                Startup: settings, account menu, nav visibility
  excel.js               Builds the .xlsx in the browser (column list = export template)
  ui.js                  Statuses, formatting, badges, shared table helpers
  views/                 One file per page (login, account, admin, requests, …)
supabase/migrations/     Database changes, in order: tables, security, permissions, workflow
js/formFields.js         Form field definitions, inputs, and display (used by form, detail, export)
js/sheetImport.js        Reads old Excel order sheets (archive + this-season import)
assets/                  Solar Gators logo
tests/db.test.mjs        Database security + workflow tests
tools/dev-server.mjs     Local static server (+ --fake mode)
tools/fake-supabase.js   Fake backend for local development
```

**Security model.** The website is public, so the database protects itself:
- **Reading:** signed-in users can read requests, items, approvals, profiles, and settings. Signed-out visitors can read only the team name and allowed email domains, which the sign-in page needs.
- **Writing:** nobody can write to a table directly. Every change goes through a database function (`save_request`, `review_request`, `mark_ordered`, `mark_received`, `set_user_role`, `update_settings`, `update_my_profile`). Each function checks the caller's permission and the request's current status.
- **The website's role:** it only hides buttons people can't use. Even a modified copy of the site can't bypass these rules.

**Data** (Supabase tables):
- `requests`
- `request_items`
- `approvals`: every decision, with who made it and when
- `order_information`: order and delivery details
- `profiles`: name, email, and role, one per account
- `roles` and `role_permissions`
- `app_settings`: the `general` and `form` JSON documents

Request IDs (`SG-001`, …) come from a database sequence, and the prefix is set in Settings. Totals are always calculated, never stored.

**Excel export.** On **Export → Download .xlsx**, the browser builds the file: one row per item, with request, approval, order, and delivery info repeated on each row. The header is bold, filtered, and frozen, and prices and dates are formatted. The columns follow the form fields: every shown request field, then every shown item field, then the approval, order, and delivery columns. Renaming or adding a field in **Admin → Form fields** changes the export too.

## Database updates

New features sometimes need a database change. These live in `supabase/migrations/` as numbered files. When one is added, leads see a yellow **"Database update needed"** banner naming the file. To apply it:
1. Open the file on GitHub and copy its contents.
2. In Supabase, go to **SQL Editor → New query**, paste, and click **Run**.

Each migration only needs to run once.

## Yearly handover checklist

When the new leads take over (usually with **Admin → Settings → Start a new season**):
1. **Start the season:** Admin → Settings → **Start a new season**. Numbering restarts (e.g. SG27-001), last season moves to the Archive, and unfinished orders stay in the queues.
2. **Roles:** give the new Chief Engineer and Treasurer their roles in **Admin → Users & roles**, and set graduating leads to Member. At least one person must always keep "Manage people".
3. **Supabase:** invite the new leads to the Supabase organization (Organization settings → Team) so someone can run database updates and restore the project if it pauses.
4. **GitHub:** give the new leads access to the `Solar-Gators/Orders-Form` repository.
5. **Email (optional):** if you set up custom SMTP for sign-up and password-reset emails, make sure the account behind it isn't tied to someone who's graduating.
