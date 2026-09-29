# Solar Gators Orders

The Solar Gators purchase request system. It replaces the Excel order sheet.

```
Member submits request → Chief Engineer approves / requests changes / rejects
→ Treasurer marks Ordered → Treasurer marks Received → export everything to Excel
```

- **Website:** plain HTML/CSS/JavaScript, hosted on **GitHub Pages**. There is no build step and no server.
- **Accounts + database:** [Supabase](https://supabase.com) (free tier). It handles sign-in, stores the data, and enforces who can do what.

## Roles

Everyone creates their own account with a UF email and starts as a **Member**. A Chief Engineer or Treasurer then assigns roles on the **Admin → Users & roles** page.

| | Member | Chief Engineer | Treasurer |
| --- | :-: | :-: | :-: |
| Create, edit, and submit your own requests | ✓ | ✓ | ✓ |
| View all requests, search the Archive, export to Excel | ✓ | ✓ | ✓ |
| See the Approvals and Treasurer queues | | ✓ | ✓ |
| Approve / request changes / reject | | ✓ | |
| Edit settings and form fields, import spreadsheets | | ✓ | ✓ |
| Change other people's roles | | ✓ | ✓ |
| Mark requests **Ordered** and **Received** | | | ✓ |

Nobody can change their own role, so the team can't lock itself out by accident. Chief Engineers and the Treasurer see every tab, but the other role's queue is **view only** (the page says so). Members only see the tabs they can use.

The permissions are stored in the database (`role_permissions` table), not in code. To change what a role can do, add or remove rows in that table in Supabase's Table Editor.

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
npm run test:db
```

This runs every file in `supabase/migrations/` in PGlite and checks the security rules as different users, e.g. "a Member can't approve", "a Chief Engineer can't mark ordered", "you can't edit someone else's draft", and "non-UF emails can't sign up". Run it after any database change.

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

## Editing the form

Chief Engineers and Treasurers can change the request form from **Admin → Form fields**, with no code changes:
- **Rename** any field, e.g. change "Vendor" to "Vendor / store".
- **Reorder** fields with the ↑ ↓ buttons.
- **Required / Shown:** make a field required or optional, or hide it.
- **Add custom fields** to the request (asked once) or to each item. Types: short text, long text, number, date, dropdown, yes/no, link. Examples: "From China?", "Shipping cost", "Scholarship funding".
- **Help text:** add a hint shown with any field.

**Locked** fields (request title, item name, quantity, unit price) are always shown and required because approvals and totals depend on them. Hidden fields keep their saved answers, which come back if you show the field again. The Excel export always matches the current form.

## Archive and importing old spreadsheets

**Archive tab** (everyone): every past season's order sheet, searchable. Type any words (item, vendor, part number, person, ticket) and filter by season, subteam, or status. Click a row to see **every column exactly as it was in the sheet**, even columns that changed between years.

**Admin → Import** (Chief Engineer and Treasurer):
1. Choose an `.xlsx` file. The app reads it in your browser and picks the sheet with the orders.
2. Choose where it goes:
   - **Archive (past season):** enter the season, e.g. `2024-2025`. It's guessed from the file name. All columns are kept as-is.
   - **This season's requests:** rows become real requests.
     - **Grouping:** rows with the same requester, date, subteam, ticket #, and status become one request.
     - **History:** CE Approval, Order Status, and Ticket Number become the approval and order history.
     - **Subteam names** that aren't in your list can be mapped ("Batt Pack" → Battery) or added.
     - **Extra columns** (Shipping, From China, Scholarship) become item fields.
3. Check the preview, then click **Import**. A requests import is all-or-nothing, so a failed import never leaves half a sheet behind.

A past season imported by mistake can be deleted from the same page. The spreadsheets themselves are never committed to GitHub (`.gitignore` excludes them); the data lives only in Supabase, visible to signed-in team members.

## Database updates

New features sometimes need a database change. These live in `supabase/migrations/` as numbered files. When one is added, leads see a yellow **"Database update needed"** banner naming the file. To apply it:
1. Open the file on GitHub and copy its contents.
2. In Supabase, go to **SQL Editor → New query**, paste, and click **Run**.

Each migration only needs to run once.

## Editing settings

Chief Engineers and Treasurers can edit these from **Admin → Settings**, with no code changes:
- Subsystems
- Priorities and the default priority
- Team name and season
- Request ID prefix
- Allowed sign-up email domains

## Roadmap

- **Later:** budget tracking, vendor batching, attachments (Supabase Storage), notifications, and automatic CE routing by subsystem.

**Free-tier note:** Supabase pauses free projects after about a week with no activity. Normal team use prevents this. If it does pause, a lead can restore it from the Supabase dashboard.
