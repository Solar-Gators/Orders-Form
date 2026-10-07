# Solar Gators Orders

**https://solar-gators.github.io/Orders-Form/**

The Solar Gators purchasing website. It replaces the shared Excel order sheet. Members request parts, a Chief Engineer approves them, and the Treasurer orders them and tracks delivery. Every step is recorded, so anyone on the team can see where an order stands and what was bought in past seasons.

It works on phones and laptops. Sign in with your **@ufl.edu** email.

---

## How an order moves through the system

```
 Member                 Chief Engineer                  Treasurer
 ──────                 ──────────────                  ─────────
 Draft ──► Submitted ──► Approved ─────────────────────► Ordered ──► Received
               │    ├──► Changes Requested ─► (member edits and resubmits)
               │    └──► Rejected
```

| Status | What it means | Who acts next |
| --- | --- | --- |
| **Draft** | Saved but not sent. Only the person who created it can see the Edit button. | The requester |
| **Submitted** | Waiting for approval. Shows up in **Queue → To approve**. | A Chief Engineer, or whoever the approval rules name |
| **Changes Requested** | The Chief Engineer asked for changes. Their comment shows at the top of the request. | The requester edits and resubmits |
| **Rejected** | Won't be ordered. The Chief Engineer's comment explains why. | — |
| **Approved** | Ready to buy. Shows up in **Queue → To order**. | The Treasurer |
| **Ordered** | Purchased, with the order date and ticket / department order number. | The Treasurer, when it arrives |
| **Received** | Delivered. | — |

Every request gets an ID like **SG-001**. Numbering restarts each season with the year, e.g. **SG27-001** in 2027-28. Its page shows a **History** of who created, approved, ordered, received, and re-priced it, with dates and comments.

---

## Who can do what

A person can have **more than one role** (e.g. Treasurer + Admin), and gets everything those roles allow. These are the defaults:

| | Member | Chief Engineer | Treasurer | Admin |
| --- | :-: | :-: | :-: | :-: |
| Submit requests and edit your own drafts | ✓ | ✓ | ✓ | ✓ |
| See every request, search the Archive, export to Excel | ✓ | ✓ | ✓ | ✓ |
| See the Approvals and Treasurer queues | | ✓ | ✓ | ✓ |
| Approve, reject, or request changes | | ✓ | | ✓ |
| Mark requests **Ordered** and **Received**, adjust prices and shipping | | | ✓ | ✓ |
| Edit the form, dropdowns, and team settings | | ✓ | ✓ | ✓ |
| Start a new season, import spreadsheets | | ✓ | ✓ | ✓ |
| Customize lists (columns, filters, sorting) and appearance (labels, colors) | | | | ✓ |
| Manage people, roles, and permissions | | ✓ | ✓ | ✓ |
| Approval rules, budgets, email / Teams notifications | | | | ✓ |
| See the Finances tab | | ✓ | ✓ | ✓ |
| Edit the Finances tab (sheets, columns, rows) | | | ✓ | ✓ |

All of this can be changed in **Admin → Team → Roles & permissions**, and you can add roles of your own (e.g. "Subsystem Lead", "Faculty Advisor"). Each person only sees the top-bar items their roles use: a Member sees **Requests** and the **+ New Request** button; leads also get **Queue**; the Treasurer **Finances**; the Business Coordinator **Sponsors**; Admins **Admin**. On the other role's part of the Queue the page is marked **view only**.

---

## Using the site

### Requesting parts (everyone)
1. Click **+ New Request** (top right, on every page).
2. Fill in the request details: title, subsystem, needed-by date, priority, and why you need the items.
3. Enter the **vendor** once, then add one row per item: name, link, quantity and unit price. Enter **shipping once for the whole order** (under the items), the way the vendor charges it. Totals update as you type. (Leads can switch to per-item shipping in Admin → Request form → Dropdowns & rules.)
   - **Same for every item:** you still add a row for every item, but you can tick a field (the link, quantity, unit price, or any other required item field) to type it once for all rows, e.g. one shared Digi-Key or McMaster-Carr cart link.
   - **One vendor per request:** each request is a single purchase. Buying from McMaster-Carr and Amazon? Submit two requests. (Leads can turn this rule off in Admin → Request form → Dropdowns & rules.)
4. Click **Submit Request**, or **Save Draft** to finish later. Pressing Enter moves to the next box (and adds an item from the last one); it never submits. If something's missing, the box is outlined in red. Leaving the page with unsaved changes asks first.

If the Chief Engineer requests changes, the request appears at the top of **Requests** under **Needs your action** (the Requests tab shows a count), with their comment. Click **Edit request**, fix it, and resubmit; the History then lists exactly what you changed.

**Typo after submitting?** Open the request and click **Fix wording** (next to Details). You can fix the title, the justification, other text answers, and item names and notes, at any point after submitting. Nothing that changes the order can be changed this way (vendor, links, part numbers, quantities, prices, dropdowns, dates), and neither can a field an approval rule or budget looks at. Every fix is listed in the request's History. Chief Engineers and the Treasurer can fix wording too.

**Picked it up yourself?** If you collect your package from the receiving room, open the request and use **Picked it up?** to mark it received. Say where you got it (e.g. "MAE receiving room"); the note is required.

**Order again:** buying the same things as an earlier request (yours or anyone's)? Open it and click **Order again** above its items. A new request opens with the same vendor, subsystem, items, prices and shipping; add the needed-by date and why, check the prices and quantities, and submit. The original isn't changed.

Changed your mind? Open a submitted request and click **Withdraw request** to turn it back into a draft. Drafts and requests sent back for changes can be deleted.

**Watchers:** anyone can click **Watch** on a request to get an email / Teams message whenever its status changes (submitted, approved, sent back, rejected, ordered, received). The requester and leads can also add other people, e.g. a subsystem lead or a teammate waiting on the part. On **Requests**, the "Requests I watch" filter lists them.

**Files & links:** a request's page has a small **📎 Attach a quote, receipt or spec sheet** line (the requester and leads can add; everyone can open them). The same panel is on sponsor cards (logos, agreements, the packet you sent) and on Finances rows (the 📎 next to each row number, for receipts and invoices). Files are private to people who can see that page, up to 10 MB each (PDF, images, Office files, text, zip); for anything bigger or shared, paste a link (Google Drive, OneDrive, Canva). Don't upload W-9s, tax IDs or bank details. Renewing a sponsor card keeps its files.

### Approving (Chief Engineer)
- **Queue → To approve** lists everything waiting, sorted by needed-by date. The number on **Queue** is how many requests are waiting on you.
- Open a request and choose **Approve**, **Request Changes**, or **Reject**. Changes and rejections need a comment so the requester knows why.
- When approval rules send some requests to specific people, To approve splits into **Waiting on you** and **Waiting on someone else**.
- The review box says who has to approve (e.g. "all of: Griffin ✓, Cara") and, if budgets are set up, how much of the budget is used and what approving would bring it to.

### Ordering and delivery (Treasurer)
- **Queue → To order & deliveries** has two lists: **To order** (approved) and **Awaiting delivery** (ordered). For the Treasurer, **Queue** opens here.
- **Mark as Ordered:** record the order date, ticket / department order number (required unless turned off in Admin → Request form → Dropdowns & rules), and any notes.
- **Order several at once:** bought a few approved requests in one checkout? Open **Order several at once** there, tick them (grouped by vendor), and enter the date and ticket number once.
- **Late deliveries:** Awaiting delivery shows how long each order has been out, and highlights anything over 14 days.
- **Mark as Received:** record when it arrived and **where it is now** (required, e.g. "in our office"). The requester gets a message that says where. Requesters who pick up their own package can mark it received themselves, with a note saying where they got it.
- **Budgets:** the Treasurer sets them on the **Budget** tab of **Finances**: pick the dropdown budgets go by (e.g. Cost center) under **Budget settings**, then type an amount for each category. The tab shows each budget, what's spent, what's in the pipeline, and what's left. Optionally, approving over budget needs a written reason, which is kept in the request's History. The Queue warns when a budget is over.
- **Copy buttons:** every value on a request has a small copy icon (item name, vendor, link, part #, quantity, prices, request ID, total), for pasting into purchasing forms. **Copy all items** copies the whole item list as a table that pastes straight into Excel or Google Sheets.
- **Edit costs:** if a price or shipping cost turns out different from what was requested, open the request and click **Edit costs**. This works on Approved, Ordered, and Received requests. Change any item's unit price or the order's shipping, and add a reason. The new total is previewed before saving. Every change is logged in the request's History (who, when, old → new, and why), and the item list is tagged **Costs adjusted**.

### Finances (Treasurer)
The **Finances** tab follows the Treasurer's own spreadsheet, so it can replace it. At the top: the season's budget, spent, in the pipeline, left, funds received and the rainy-day fund. Then five tabs:
- **Purchases:** the ledger. Every request shows up here once it's approved, plus anything bought outside the site (**+ Add a purchase**: a PayPal invoice, a quote over the phone).
  - Each line has its **purchasing step**, colored like the old sheet's legend: To submit → Request sent (to MAE / ECE purchasing) → Dept approved → Ordered → Received, or Cancelled. Click a step at the top to see only those lines.
  - Also **M/E** (who orders it: M = MAE, E = ECE, A = other), category, order #, date, notes, and 📎 for receipts and quotes.
  - A request's description, cost, category and order # come from the request; Ordered and Received are marked on the request itself (they record the date and ticket number, and tell the requester).
- **Budget:** per category (from the budgets' dropdown, e.g. Cost center): budget, spent (ordered + received), in the pipeline (approved but not ordered), and left. Type a budget straight into the table or add a category. Purchases added by hand count too, including in the approver's over-budget warning; cancelled ones don't.
- **Funding:** where the money comes from (the allocation, donations, ECE…), expected and received; the Sponsors board's received cards add themselves. Shows the expected funds against the total budget (to spare / short), and the rainy-day fund balance.
- **Notes:** the Treasurer's planning notes for the season.
- **Custom sheets:** free-form spreadsheets for anything else (below).
- **Import from spreadsheet…** reads the old Financials workbook: each line with its status (from the row's color), M/E, subteam, order # and notes; the budget table; the rainy-day balance; and the notes. A preview comes first; lines that match a request by order # are linked instead of duplicated, and importing the same file again skips what's already there. **Download .xlsx** gives the season back as a workbook (purchases in the legend colors, budget, funding, notes).
- Seasons: the season picker under the title shows earlier seasons.

**Custom sheets**
- **Sheets:** as many as he likes (e.g. Ledger, Reimbursements, Sponsorships). A **Ledger** sheet is there to start; rename, reshape or delete it.
- **New sheet:** start blank, or from a template: **Budget by cost center**, **Income (sponsorships & donations)**, or **Funds overview** (the general pool: money in minus what's spent and approved).
- **Columns & sheet:** add, rename, reorder or delete columns. Typed-in columns: text, money, number, date, dropdown (your own options, or the form's list, e.g. Cost center), checkbox, link, request (an SG number, linked to the request). Money and number columns can show a total at the bottom.
- **Calculated columns** (shaded; click any cell to see exactly what was added up). They're set up with menus, never typed formulas:
  - **Budget:** the site's budget for the row's cost center. It's the same number as in the Budgets card, and typing one here changes it there too.
  - **From orders:** requests that are spent (ordered + received), approved but not ordered, or waiting for approval, this season or every season, per row's cost center or for the whole team.
  - **Total from a sheet:** add up a money column of any sheet, for every row or only matching rows, optionally only where a column has a value (e.g. Type is Sponsorship).
  - **From the request:** a detail of the request in the row (total, vendor, status, Cost center…), kept up to date.
  - **Math:** + and − of other amount columns in the same row, e.g. Budget − Spent − Approved.
  - **Running total:** a balance down the rows.
  - Math only uses typed amounts and the columns above, and totals only add up typed amounts, so nothing can loop back on itself. The editor explains anything that doesn't fit before saving.
- **Add a row per Cost center** fills a summary sheet in one click when a dropdown uses the form's list.
- **Cells save as you leave them.** Enter moves down a row (and adds one at the bottom); Tab moves right.
- **Add ordered requests:** adds a row for every Ordered or Received request not yet in the sheet, filling the columns you linked to a request detail (ID, title, vendor, total, ticket #, order date, Cost center…).
- **Search, sort** (click a heading; **Keep this order** saves it), **Download .xlsx**, and **Import Excel…**: each worksheet of an existing file becomes a sheet, with column types guessed (dates, money, checkboxes, links). Formulas come in as their values.
- Who can see and edit it is set in Admin → Team → Roles & permissions (**See finances** / **Edit finances**). By default the Treasurer edits, Chief Engineers can look, and Members can't see it.

### Sponsors (Business Coordinator)
The **Sponsors** tab tracks sponsorships and donations on a board, and keeps every season for future teams.
- **Board:** one column per stage: Prospect → Contacted → In talks → Committed → Received → Thanked, plus Not this year. Drag cards between columns (on a phone, use the small menu on each card). Each column shows its count and total. **Board settings** renames, adds or reorders stages, and sets the list of types (Sponsorship, Donation, In-kind…).
- **Cards:** sponsor name, type, amount, season, lead, follow-up date, tags (e.g. aerospace, local, alumni), contact name / email / phone, website, plus two write-ups:
  - **About this sponsor:** who they are, what they gave, what they asked for in return.
  - **Tips for next time:** how we found them, who to ask, when to ask, what worked.
- **Watchers:** anyone who can see the board can watch a card; the coordinator can add others. Watchers get an email / Teams message when the card moves or someone adds a note (Admin → Approvals & alerts → Notifications → "Sponsor card updated").
- **Notes & history:** add notes after each call or email; moves, edits and money received are logged automatically, with who and when.
- **Money received:** when a card reaches a "money received" stage, its amount is added once to the Finances sheet chosen in Board settings (e.g. **Income**), so the **Funds overview** updates on its own.
- **Follow-ups:** a card's follow-up date shows up on Home ("Follow up with…") for its lead and watchers.
- **For future teams:** **All sponsors** lists every card from every season, searchable by name, contact, tag, notes and tips. Each card suggests **similar sponsors** (shared tags or type), and **Renew for next season** copies a card (contacts, notes, tips, watchers) onto next season's board.
- Permissions: **See sponsors** / **Edit sponsors**. A **Business Coordinator** role has both (and can see Finances). Chief Engineers and the Treasurer can see the board and watch cards.

### Finding things
- **Requests:** this season's requests, with three tabs at the top: **Requests**, **Archive** and **Download Excel**. A season picker lets you look back at earlier seasons.
- **Your name (top right):** My account & notifications, Help (once your team writes it), and Sign out.
- **Home:** click the logo (or "Orders") at the top left. It shows what needs you right now, your latest requests, and how ordering works. It is the page the site opens on.
- **Sorting:** click any column heading on Requests or either part of the Queue to sort by it, and click again to reverse. On a phone, use the **Sort by** menu above the list. Search by ID, title, requester, vendor, item name, part number or ticket number, and filter by status, subsystem, or "My requests".
- **Requests → Archive:** orders from past seasons: requests made on this site in earlier seasons, plus the old spreadsheets imported from Excel. Type any words (item, vendor, part number, person, ticket) and filter by season, subteam, or status. Click a row to see every column exactly as it was in the original sheet.
- **Requests → Download Excel:** download a season (or all seasons) as an Excel file. Pick a **template**: the full export (every column, one row per item), or ones your leads made, e.g. the exact columns the department's purchasing form wants. There's one row per item, with request, approval, order, and delivery details on each row, ready to filter or pivot.

### Admin

Admin has four tabs, each with a few pages (on a phone, one menu lists them all). Each page appears only for people whose roles allow it, and each has a **History** link (top right) listing earlier versions of its settings, with who changed what and when. **Restore** puts back any earlier version, and a restore can itself be undone; if something looks wrong after a change, that's the first place to go.

**Team**
- **Users:** tick the roles each person has; someone can hold several.
- **Roles & permissions:** add your own roles, rename any role, or delete custom ones, and a checkbox grid of what each role can do. There's one safety rule: at least one person must always keep **Manage people & roles**, so the team can't lock itself out.
- **Team & season:** the team name, request ID prefix, allowed sign-up email domains, **Start a new season**, and **Import old spreadsheets**:
  - A **past season** goes into the Archive with every column kept.
  - **This season's** sheet becomes real requests, including their approvals, order status, ticket numbers, and shipping.
  - Imported requests are linked to people's accounts by the Requester name ("Bella N" → Bella Nguyen, or "Josh" when there's only one Josh), so they show under **My requests** and their requester gets notifications. This also happens when someone signs up later or fixes their name on My account. If a match is wrong or missing, a lead can pick the right person under **Account → Change** on the request's page.
  - You see a preview before anything is saved, with a checkbox per request. Orders already on the site (same person, day and total) start unticked, so you can re-import an updated copy of the sheet to add just the new rows.

**Request form**
- **Fields:** change the request form without touching code.
  - Rename, reorder, hide, or require/unrequire fields.
  - Add your own fields: text, number, date, dropdown, yes/no, link, or a **section heading** to group fields.
  - **Rules** (per field):
    - **Show only when…** another answer matches, e.g. "Scholarship form sent?" only when "Scholarship funding?" is Yes. A hidden field is never required, which also gives you "required only when…".
    - **Allowed range** for numbers and **maximum length** for text.
    - A **default value** for new requests.
    - The database enforces all of these too.
  - The Excel export follows the form automatically.
  - Request title, item name, quantity, and unit price are locked because totals and approvals depend on them.
- **Dropdowns & rules:** the options of every dropdown on the form (built-in ones like Subsystem and Priority, plus any you add, e.g. "Cost center"), and the request rules: one vendor per request, shipping as one total, ticket number required.

**Display**
- **Lists, layout & Excel** (three sections):
  - **Request lists:** choose the columns of the Requests list and both parts of the Queue. Any request field works, including custom ones like Cost center, plus values like Total, Vendor, and Approved date. Also set each list's default sort, and which filters appear above the Requests list.
  - **Request page:** which fields show in a request's Details box and Items table, and in what order. Also: fields only leads see, who gets copy buttons, and whether Items comes first.
  - **Excel templates:** your own columns and headings, one row per item or per request, an optional status filter, and a file name.
- **Colors & logo:** upload the logo, pick the accent color, and give dropdown answers colors (e.g. one per Cost center). Also rename how statuses are shown (e.g. "Ordered" → "Purchased") and pick their colors, plus priority colors. Only the display changes; the workflow stays the same.
- **Text & banner:** an announcement banner at the top of every page (with an optional end date), a message on the sign-in page, your own intro line for each page (including Home), and the team's own **Help** page (it appears in the menu under your name once it has text).

**Approvals & alerts**
- **Approval rules:**
  - Rules are checked from the top when a request is submitted; the first that matches decides who approves. A rule can look at any answer on the form (e.g. Cost center is Battery) and/or the total (e.g. $1,000 or more).
  - Each rule lets **any Chief Engineer** approve, sends it to **specific people** (any one of them, or **all** of them, e.g. two CEs for big orders), or **approves automatically** (e.g. under $25).
  - No matching rule → any Chief Engineer, as before. Admins can always step in.
  - **Budgets** are set by the Treasurer in the Budgets card on **Finances**.
- **Notifications:** email and Microsoft Teams messages (see below).

---

## Email and Teams notifications

Once your leads turn them on (**Admin → Approvals & alerts → Notifications**), the site messages people when something needs them:

| When a request is… | Who hears about it |
| --- | --- |
| Submitted | Whoever has to approve it (any CE, or the people its rule names) |
| Approved | The requester, and the Treasurer ("ready to order") |
| Changes requested / Rejected | The requester, with the comment |
| Ordered / Received | The requester |
| Any status change | Everyone watching the request |

Messages go to your UF email and/or a Teams chat from the Power Automate bot, with a button that opens the request. Leads choose which events use email, Teams, or both, and can reword every message. On **My account** you choose for yourself: turn email or Teams off completely, or mute single messages (e.g. keep "needs your approval" but skip "your order arrived"). "Needs your approval" messages wait a little (30 minutes by default) and are skipped if the request was already decided, so a CE approving their own order doesn't ping the other CEs. You never get messages about things you did yourself.

## Starting a new season

Once a year, when the new season's orders begin, a Chief Engineer or Treasurer goes to **Admin → Team → Team & season → Start a new season** and clicks **Start 2027-2028** (or whichever year is next). That's the only step. It:
- **Numbering:** restarts request numbers with the new year (**SG27-001**, **SG27-002**, …).
- **Requests & Export:** shows the new season by default.
- **Archive:** moves last season's requests there, searchable with their full history.
- **Unfinished orders:** keeps anything still waiting on approval, ordering, or delivery in the Approvals and Treasurer queues, labeled with its season, until it's done.

Also hand over the roles: give the new Chief Engineer and Treasurer their roles in **Admin → Team → Users**, and set graduating leads back to Member.

---

## Questions

**How do I get an account?**
Go to the site, click **Create an account**, and use your @ufl.edu email. You start as a Member; ask the Chief Engineer or Treasurer if you need a different role.

**I submitted something with a mistake.**
Ask a Chief Engineer to **Request Changes**. The request comes back to you to edit. Submitted requests can't be edited directly, so what gets approved is what was reviewed.

**The price changed after approval. Does it need re-approval?**
No. The Treasurer can **Edit costs** at any point after approval, and the change and reason are recorded in the request's History for everyone to see.

**Where are the old order sheets?**
In **Requests → Archive**, once a lead has imported them (Admin → Team → Team & season → Import old spreadsheets). Each season is searchable, with every original column. This season's sheet is imported as regular requests instead, so it can keep moving through ordering and delivery.

**Is our order data public?**
No. The website's code is public on GitHub, but the order data lives in a private database. Only signed-in team members can see it, and the database itself enforces who can approve, order, or change anything.

**Something's broken or I have an idea.**
Tell the Chief Engineer or Treasurer, or open an issue on this GitHub repository.

---

*Maintaining the site (setup, database updates, running it locally, how the code works): see [docs/MAINTAINING.md](docs/MAINTAINING.md).*
