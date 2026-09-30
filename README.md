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
| **Submitted** | Waiting for approval. Shows up in the **Approvals** tab. | A Chief Engineer |
| **Changes Requested** | The Chief Engineer asked for changes. Their comment shows at the top of the request. | The requester edits and resubmits |
| **Rejected** | Won't be ordered. The Chief Engineer's comment explains why. | — |
| **Approved** | Ready to buy. Shows up in the **Treasurer** tab. | The Treasurer |
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

All of this can be changed in **Admin → Users & roles → Permissions**, and you can add roles of your own (e.g. "Subsystem Lead", "Faculty Advisor"). The Chief Engineer and Treasurer see every tab; on the other role's queue the page is marked **view only**. Members only see the tabs they can use.

--- | :-: | :-: | :-: |
| Submit requests and edit your own drafts | ✓ | ✓ | ✓ |
| See every request, search the Archive, export to Excel | ✓ | ✓ | ✓ |
| See the Approvals and Treasurer queues | | ✓ | ✓ |
| Approve, reject, or request changes | | ✓ | |
| Mark requests **Ordered** and **Received** | | | ✓ |
| Adjust prices and shipping after approval | | | ✓ |
| Manage roles, edit the form and settings, import spreadsheets | | ✓ | ✓ |

This is the default setup. The Chief Engineer and Treasurer can change it from **Admin → Users & roles → Permissions**. The Chief Engineer and the Treasurer can see every tab. On the other role's queue the page is marked **view only**. Members only see the tabs they can use.

---

## Using the site

### Requesting parts (everyone)
1. Click **New Request**.
2. Fill in the request details: title, subsystem, needed-by date, priority, and why you need the items.
3. Enter the **vendor** once, then add one row per item: name, link, quantity, unit price, and shipping if you know it. Totals update as you type.
   - **One vendor per request:** each request is a single purchase. Buying from McMaster-Carr and Amazon? Submit two requests. (Leads can turn this rule off in Admin → Settings.)
4. Click **Submit Request**, or **Save Draft** to finish later.

If the Chief Engineer requests changes, you'll see their comment on the request. Click **Edit request**, fix it, and resubmit.

### Approving (Chief Engineer)
- The **Approvals** tab lists everything waiting, sorted by needed-by date. The number on the tab is how many are waiting.
- Open a request and choose **Approve**, **Request Changes**, or **Reject**. Changes and rejections need a comment so the requester knows why.

### Ordering and delivery (Treasurer)
- The **Treasurer** tab has two lists: **To order** (approved) and **Awaiting delivery** (ordered).
- **Mark as Ordered:** record the order date, ticket / department order number, and any notes.
- **Mark as Received:** record when it arrived, e.g. "in office".
- **Copy buttons:** every value on a request has a small copy icon (item name, vendor, link, part #, quantity, prices, request ID, total), for pasting into purchasing forms. **Copy all items** copies the whole item list as a table that pastes straight into Excel or Google Sheets.
- **Edit costs:** if a price or shipping cost turns out different from what was requested, open the request and click **Edit costs**. This works on Approved, Ordered, and Received requests. Change the unit price or shipping for any item and add a reason. The new total is previewed before saving. Every change is logged in the request's History (who, when, old → new, and why), and the item list is tagged **Costs adjusted**.

### Finding things
- **Requests:** this season's requests. A season picker lets you look back at earlier seasons.
- **Sorting:** click any column heading on Requests, Approvals, or Treasurer to sort by it, and click again to reverse. On a phone, use the **Sort by** menu above the list. Search by ID, title, requester, or vendor, and filter by status, subsystem, or "My requests".
- **Archive:** orders from past seasons: requests made on this site in earlier seasons, plus the old spreadsheets imported from Excel. Type any words (item, vendor, part number, person, ticket) and filter by season, subteam, or status. Click a row to see every column exactly as it was in the original sheet.
- **Export:** download a season (or all seasons) as an Excel file. There's one row per item, with request, approval, order, and delivery details on each row, ready to filter or pivot.

### Admin

Each Admin tab appears only for people whose roles allow it.

- **Users & roles:** tick the roles each person has; someone can hold several.
  - **Roles:** add your own roles, rename any role, or delete custom ones.
  - **Permissions:** a checkbox grid of what each role can do. There's one safety rule: at least one person must always keep **Manage people & roles**, so the team can't lock itself out.
- **Form fields:** change the request form without touching code.
  - Rename, reorder, hide, or require/unrequire fields.
  - Add your own fields: text, number, date, dropdown, yes/no, or link.
  - The Excel export follows the form automatically.
  - Request title, item name, quantity, and unit price are locked because totals and approvals depend on them.
- **Settings:** the options of every dropdown on the form (built-in ones like Subsystem and Priority, plus any you add, e.g. "Cost center"), the team name, request ID prefix, allowed sign-up email domains, request rules, and **Start a new season**.
- **Lists:** choose the columns of the Requests, Approvals, and Treasurer lists. Any request field works, including custom ones like Cost center, plus values like Total, Vendor, and Approved date. Also set each list's default sort, and which filters appear above the Requests list.
- **Appearance:** rename how statuses are shown (e.g. "Ordered" → "Purchased") and pick their colors, plus priority colors. Only the display changes; the workflow stays the same.
- **Import:** bring in an old Excel order sheet.
  - A **past season** goes into the Archive with every column kept.
  - **This season's** sheet becomes real requests, including their approvals, order status, ticket numbers, and shipping.
  - You see a preview before anything is saved.
- **History:** every change to settings and permissions, with who made it and when.
  - **Restore** puts back any earlier version, and a restore can itself be undone.
  - If something looks wrong after a change, this is the first place to go.

---

## Starting a new season

Once a year, when the new season's orders begin, a Chief Engineer or Treasurer goes to **Admin → Settings → Start a new season** and clicks **Start 2027-2028** (or whichever year is next). That's the only step. It:
- **Numbering:** restarts request numbers with the new year (**SG27-001**, **SG27-002**, …).
- **Requests & Export:** shows the new season by default.
- **Archive:** moves last season's requests there, searchable with their full history.
- **Unfinished orders:** keeps anything still waiting on approval, ordering, or delivery in the Approvals and Treasurer queues, labeled with its season, until it's done.

Also hand over the roles: give the new Chief Engineer and Treasurer their roles in **Admin → Users & roles**, and set graduating leads back to Member.

---

## Questions

**How do I get an account?**
Go to the site, click **Create an account**, and use your @ufl.edu email. You start as a Member; ask the Chief Engineer or Treasurer if you need a different role.

**I submitted something with a mistake.**
Ask a Chief Engineer to **Request Changes**. The request comes back to you to edit. Submitted requests can't be edited directly, so what gets approved is what was reviewed.

**The price changed after approval. Does it need re-approval?**
No. The Treasurer can **Edit costs** at any point after approval, and the change and reason are recorded in the request's History for everyone to see.

**Where are the old order sheets?**
In the **Archive** tab, once a lead has imported them (Admin → Import). Each season is searchable, with every original column. This season's sheet is imported as regular requests instead, so it can keep moving through ordering and delivery.

**Is our order data public?**
No. The website's code is public on GitHub, but the order data lives in a private database. Only signed-in team members can see it, and the database itself enforces who can approve, order, or change anything.

**Something's broken or I have an idea.**
Tell the Chief Engineer or Treasurer, or open an issue on this GitHub repository.

---

*Maintaining the site (setup, database updates, running it locally, how the code works): see [docs/MAINTAINING.md](docs/MAINTAINING.md).*
