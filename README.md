# v22 — Admin Dashboard Upgrade (2026-08-03)

This is the biggest single round yet, covering everything from "let's
upgrade the Admin dashboard" — collapsible sections, full account controls
(Delete / Revoke Access / Restore Access) for any Intern or Client, Intern
Teams, and multi-recipient task assignment. Deploy this one carefully and
test it before moving on, since it's the first round touching Firebase Auth
directly.

## 1. Collapsible sections

Every section (Client Corner and Internship Corner alike) is now a click-to-
expand panel with a count badge showing how many items are in it, instead of
one long scroll. Each section remembers its own open/closed state in the
browser (so it stays how you left it next time), except the very first time
you open the new dashboard — then Pending Stage Advancement Requests,
Pending Internship Applications, Tasks Awaiting Review, Attendance, and
Intern Requests start open (the "needs your attention" sections), and
everything else starts collapsed.

## 2. Delete & Revoke Access — the big one

Every Intern Roster and new Client Roster row now has account-control
buttons. Here's exactly what each does, matching what we agreed on:

**Revoke Access** — asks for a reason (required, kept on file), then
immediately disables their Firebase login and force-signs-out any session
they currently have open. They cannot sign back in at all until you restore
access. This is fully reversible — a **Restore Access** button appears in
its place once revoked.

**Delete** — asks for a reason, then makes you type their name exactly to
confirm (a safety net since this is irreversible). It then permanently
removes their Firebase login (that email can never sign in again without
being re-invited), their profile document, and every file they uploaded.
**It deliberately does NOT touch their attendance, task, request, or order
history** — those stay in place as records, since you might need them later
(e.g. for accounting on a client's past orders). This matches exactly what
we agreed on.

Every Delete, Revoke, and Restore is permanently logged (who did it, when,
why) to a new `adminAuditLog` collection in Firestore — there's no page to
browse it yet, but the record exists from day one in case you ever want one
built later.

**One more layer of protection**: even during the short window before a
revoked account's existing login session actually expires, the moment they
load their dashboard or portal page it checks for a revoked flag and signs
them out immediately with a clear message, rather than waiting for Firebase
itself to catch up.

Two safety guards built in: you can never delete or revoke your own admin
account, and you can never delete or revoke Pramod's or Neel's account
through this panel.

**Client Roster** is a new section (top of Client Corner) — the same kind
of searchable list as the Intern Roster, but for every founder/client
account, since Delete/Revoke needed a way to find any client, not just
interns.

## 3. Intern Teams

New "Intern Teams" section — name a team, pick its members from a
checklist, and manage membership afterward (add/remove members, or delete
the team entirely — deleting a team never touches tasks already assigned
through it, only the team itself).

## 4. Assign a Daily Task — now multi-recipient

The Assign a Daily Task form now has three modes at the top: **Single
Intern** (the original flow, unchanged), **Multiple Interns** (a checklist
with a Select All checkbox), and **A Team** (pick one of your saved teams —
it shows you the current member list, and assigning creates the task for
every one of them). Whichever mode you use, the title/description/due
date/client-related fields are shared — you fill them in once regardless of
how many people you're assigning to.

## 5. Blogs/Vlogs — not built yet

Noted for later, as discussed — nothing in this round touches it.

## What's in this folder

- **`functions/index.js`** — three new Cloud Functions:
  `adminDeleteAccount`, `adminRevokeAccess`, `adminRestoreAccess`. Everything
  else in this file is unchanged.
- **`js/firebase-init.js`** — added `arrayRemove` and `deleteDoc` to the
  shared exports (needed for team membership management).
- **`admin-dashboard.html`** — the collapsible-section wrapper around every
  existing section, the new Client Roster and Intern Teams sections, account
  control buttons + two confirmation modals, and the reworked multi-mode
  task assignment form.
- **`style.css`** — new sections for collapsible panels, the account-control
  modals, a new always-red `.btn-danger` style for destructive actions, and
  the Teams/multi-select styling.
- **`login.html`, `intern-login.html`** — both now show a clear "your access
  has been revoked" message when redirected here with `?revoked=1`.
- **`intern-dashboard.html`, `intern-portal.html`, `dashboard.html`** — each
  now checks for a revoked account right after loading the user's profile
  and signs them out immediately if so.
- **`firestore.rules`** — a new admin-only `/internTeams` rule, and a small
  security tightening on `/interns` and `/profiles`: the account owner can
  no longer flip their own `accessRevoked` field, even as a side effect of
  some other update (only the new Cloud Functions can change it).

## Deploy checklist

1. Copy every file in this folder over the matching path in your repo (note
   the `js/firebase-init.js` and `functions/index.js` paths), push to
   GitHub.
2. Publish the updated Firestore rules — **Firebase Console → Firestore
   Database → Rules** → paste in the contents of this folder's
   `firestore.rules` → **Publish**. (Small change, but a real one — the
   `/internTeams` block and the accessRevoked tightening are new rule
   content, not just comments this time.)
3. Redeploy Cloud Functions (fresh clone, as always):
   ```
   cd ~
   rm -rf ~/ried
   git clone https://github.com/neelkamal213/ried.git ~/ried
   cd ~/ried/functions
   npm install
   ls node_modules | grep nodemailer
   ```
   (if that prints nothing: `npm install nodemailer@6.9.14 --save`), then:
   ```
   cd ~/ried
   firebase deploy --only functions:adminDeleteAccount,functions:adminRevokeAccess,functions:adminRestoreAccess
   ```
   Only these 3 functions are new this round, so — same habit as last
   time — the deploy is scoped to just them rather than a bare
   `--only functions` across all 25.
4. **One thing to double-check after deploying**: `adminDeleteAccount` is
   the first Cloud Function in this project that deletes files from Cloud
   Storage directly (rather than a user's own browser doing it). If a test
   Delete fails with a permission-style error mentioning Storage, it likely
   means the Cloud Functions service account needs the **Storage Object
   Admin** role — check **Google Cloud Console → IAM & Admin → IAM**, find
   the account ending in `@ried-website.iam.gserviceaccount.com` (or
   similar, tied to Cloud Functions), and confirm it has that role. This is
   a one-time check — if it already works on the first test, there's
   nothing else to do.

## Test checklist

Use throwaway test accounts for the destructive tests (4 and 5) — Delete
truly cannot be undone.

1. **Collapsible sections**: confirm every section can be expanded/
   collapsed, counts look right, and your open/closed choices are
   remembered after a page refresh.
2. **Client Roster**: confirm it lists every founder account, and search
   narrows it down.
3. **Revoke Access**: pick a test intern or client, click Revoke Access,
   enter a reason, confirm. Try signing in as that account — confirm it's
   rejected. Confirm the roster now shows "Access Revoked" with a Restore
   Access button. Click Restore Access, then confirm that account can sign
   in again normally.
4. **Delete (use a real throwaway test account for this one)**: click
   Delete, confirm it requires both a reason AND typing the name exactly
   before the button does anything. Confirm it goes through, the account
   disappears from the roster, and trying to sign in with that email now
   fails entirely (not just "account not found" — it should behave like
   that email never existed). Spot-check in the Firebase Console that their
   Storage folder is actually empty.
5. **Self/admin protection**: confirm you cannot Delete or Revoke your own
   logged-in admin account, and cannot do either to the other admin's
   account.
6. **Teams**: create a team with 2-3 interns, confirm it appears in
   Assign a Daily Task's "A Team" mode with the right member list. Assign a
   task to the team, confirm every member gets it individually in their
   portal. Remove a member from the team and confirm a task assigned
   earlier to them is untouched.
7. **Multiple Interns mode**: try Select All, then assign a task, and
   confirm every approved intern gets it.
