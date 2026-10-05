# Maintaining Solar Gators Orders

This guide is for whoever maintains the site: setting it up from scratch, running it locally, applying database updates, and understanding the code. For what the site does and how the team uses it, see the [README](../README.md).

**Stack**
- **Website:** plain HTML/CSS/JavaScript, served by **GitHub Pages** from the `main` branch. There is no build step and no server.
- **Accounts + database:** [Supabase](https://supabase.com) (free tier). It handles sign-in, stores the data, and enforces every permission.
- **Live site:** https://solar-gators.github.io/Orders-Form/
- **Changing the site:** edit files, commit, and push to `main`. Pages redeploys in about a minute.

**Permissions** live in the database (`permissions` and `role_permissions` tables), not in code:
- **Changing what a role can do:** use **Admin → Team → Roles & permissions** on the site. The Table Editor works too.
- **Lockout protection:** the database refuses any change (to a role or to the grid) that would leave nobody with `users.manage`.
- **Roles:** a person can hold several roles (`profile_roles` table); their permissions combine. Built-in roles are Member, Chief Engineer, Treasurer and Admin. More can be created on the site.
- **Current permissions:**
  - `request.review`: approve, reject, or request changes.
  - `request.order`: mark Ordered and Received, and adjust costs.
  - `settings.edit`: form fields, dropdown lists, team settings, request rules.
  - `site.customize`: list columns/filters/sorting, status and priority labels and colors.
  - `seasons.manage`: start a new season, import spreadsheets.
  - `users.manage`: roles, custom roles, and the permission grid.
- **Settings history:** every version of `app_settings` (general, form, lists, appearance) and of the permission grid is kept in `settings_history`. Leads restore versions from the **History** link at the top of each Admin page.

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

Refresh the page. From now on, roles are assigned from **Admin → Team → Users**.

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

`npm test` runs all three test files. `npm run test:import` checks spreadsheet column recognition against the real headers of the 2024-25, 2025-26, and 2026-27 sheets. `npm run test:db` runs every file in `supabase/migrations/` in PGlite and checks the security rules as different users, e.g. "a Member can't approve", "a Chief Engineer can't mark ordered", "you can't edit someone else's draft", and "non-UF emails can't sign up". Run it after any database change. `tests/notify.test.mjs` checks how notification messages are written (placeholders, email HTML, the Teams card).

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
js/workflow.js           Approval rules + budgets (who approves, what's left)
supabase/functions/send-notifications/index.ts   Sends queued email / Teams messages
tests/db.test.mjs        Database security + workflow tests
tests/notify.test.mjs    Notification message tests
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

**Excel export.** On **Requests → Download Excel → Download .xlsx**, the browser builds the file: one row per item, with request, approval, order, and delivery info repeated on each row. The header is bold, filtered, and frozen, and prices and dates are formatted. The columns follow the form fields: every shown request field, then every shown item field, then the approval, order, and delivery columns. Renaming or adding a field in **Admin → Request form → Fields** changes the export too.

## Database updates

New features sometimes need a database change. These live in `supabase/migrations/` as numbered files. When one is added, leads see a yellow **"Database update needed"** banner naming the file. To apply it:
1. Open the file on GitHub and copy its contents.
2. In Supabase, go to **SQL Editor → New query**, paste, and click **Run**.

Each migration only needs to run once.

## Email & Teams notifications

How it works: every workflow step (submit, approve, order, …) writes messages into the `notification_outbox` table in the same database transaction, so nothing is lost. The **send-notifications** Edge Function delivers them. The website calls it right after each action, and **Admin → Approvals & alerts → Notifications → Send waiting messages now** does too. Failed messages are retried up to 5 times, and the log on that page shows each one.

Nothing is sent until an Admin turns it on in **Admin → Approvals & alerts → Notifications**. You need the Edge Function plus **at least one** way to send:
- **Email via Gmail** (simplest, reliable): a team Gmail account sends the emails.
- **Power Automate** (for Teams, and it can also send the emails from Outlook): one flow receives every message and either posts it to the person in Teams or emails it.

### 1. Deploy the Edge Function (once)
1. Supabase → **Edge Functions → Deploy a new function → Via Editor**.
2. Name it exactly `send-notifications`.
3. Replace the sample code with the contents of `supabase/functions/send-notifications/index.ts` and click **Deploy**. Leave "Verify JWT" on.
4. To update it later, open the function → **Code**, paste the new file, and deploy again.
   **After migration 015 (Sponsors board), redeploy it once.** Older versions send "Sponsor card updated" messages with blanks like {sponsor} in them.

(With the Supabase CLI instead: `supabase functions deploy send-notifications`.)

### 2a. Email with Gmail
1. Make a team Gmail account, e.g. `solargators.orders@gmail.com`. Don't use a personal one; it has to outlive your time on the team.
2. Turn on **2-Step Verification** for it, then create an **App password** at https://myaccount.google.com/apppasswords.
3. Supabase → **Edge Functions → Secrets**, add:
   - `SMTP_USER` = the Gmail address
   - `SMTP_PASS` = the 16-letter app password
   - optional `SMTP_FROM_NAME` = e.g. `Solar Gators Orders`

Gmail allows about 500 emails a day, far more than the team needs. Other providers work too: also set `SMTP_HOST` and `SMTP_PORT` (use port 465; Supabase blocks 25 and 587).

### 2b. Teams (and optionally email) with Power Automate
The flow runs under the UF account of whoever builds it, so build it with a lead's account, and add the next lead as a co-owner at handover.

1. Go to https://make.powerautomate.com and sign in with your UF account.
2. **Create → Instant cloud flow**, name it "Orders notifications", and choose the trigger **When a Teams webhook request is received**. Set **Who can trigger the flow** to **Anyone**.
3. Add a **Condition**: `triggerBody()?['channel']` *is equal to* `teams`.
4. Under **True**, add **Microsoft Teams → Post card in a chat or channel**:
   - Post as: **Flow bot** · Post in: **Chat with Flow bot**
   - Recipient: expression `triggerBody()?['recipient']`
   - Adaptive Card: expression `triggerBody()?['card']`
5. Under **False** (email; only if you are *not* using Gmail), add **Office 365 Outlook → Send an email (V2)**:
   - To: `triggerBody()?['recipient']` · Subject: `triggerBody()?['subject']`
   - Body: switch the editor to code view (`</>`) and use `triggerBody()?['html']`
   - The emails then come from the flow owner's UF mailbox. If the team has a shared mailbox, use **Send an email from a shared mailbox** instead.
6. **Save**, open the trigger again, and copy its URL.
7. Supabase → **Edge Functions → Secrets**, add `FLOW_URL` = that URL. Treat it like a password: anyone with it can make the bot post.

If both are set, email goes through Gmail and Teams through the flow. If only `FLOW_URL` is set, both go through the flow.

If UF's tenant doesn't offer the trigger, or says it needs a premium license, post into a team channel instead: in step 4 choose **Post in: Channel** and pick your team's channel. The card still names the request; it just isn't a private message.

### 3. Turn it on
1. **Admin → Approvals & alerts → Notifications**: tick **Send notifications**, check the website address, choose email / Teams per event, and **Save**.
2. Click **Send me a test email** and **Send me a test Teams message**. Setup problems (missing secret, wrong password, flow error) show right there and in **Recent messages**.

3. **Schedule the sender (recommended):** Supabase → **Integrations → Cron → Create job** → type "Supabase Edge Function" → `send-notifications`, every 5–10 minutes. "Needs your approval" messages wait (30 minutes by default, Admin → Approvals & alerts → Notifications) so a CE approving their own order doesn't notify the others; the schedule is what sends the ones still waiting. It also retries failed messages.

## Yearly handover checklist

When the new leads take over (usually with **Admin → Team → Team & season → Start a new season**):
1. **Start the season:** Admin → Team → Team & season → **Start a new season**. Numbering restarts (e.g. SG27-001), last season moves to the Archive, and unfinished orders stay in the queues.
2. **Roles:** give the new Chief Engineer and Treasurer their roles in **Admin → Team → Users**, and set graduating leads to Member. At least one person must always keep "Manage people".
3. **Supabase:** invite the new leads to the Supabase organization (Organization settings → Team) so someone can run database updates and restore the project if it pauses.
4. **GitHub:** give the new leads access to the `Solar-Gators/Orders-Form` repository.
5. **Email (optional):** if you set up custom SMTP for sign-up and password-reset emails, make sure the account behind it isn't tied to someone who's graduating.
6. **Notifications:** the Power Automate flow belongs to whoever built it. Add the new leads as co-owners (flow → **Share**) before the old owner's UF account goes away, or rebuild it and update `FLOW_URL`. Hand over the team Gmail's password too.
7. **Workflow rules:** rules that name specific people (Admin → Approvals & alerts → Approval rules) need updating when those people leave. A rule whose people are all gone falls back to "any Chief Engineer".
