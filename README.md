# v20 — Internship Program Phase 4: Mentor/Admin Side (2026-08-03)

## What this adds

This is the last piece of the original Internship Program request — the
Mentor (Neel/Pramod) side of everything Phases 1-3 built. The Admin
Dashboard now has a clear **Client Corner** (your existing founder
Flywheel approvals + Marketplace payouts, unchanged) and a brand new
**Internship Corner** below it, per your instruction partway through Phase 1
to keep these visually separate rather than one mixed list.

Internship Corner has five sections:

1. **Pending Internship Applications** — every candidate who's finished
   their skills check, with their score breakdown, and Approve / Reject
   buttons. Approving is what actually unlocks their Intern Portal — this
   replaces the manual Firebase Console edit the v19 README had you doing
   as a stand-in. Both approving and rejecting email the candidate directly
   (a real notification either way), plus a copy to hello@ried.co.in.
2. **Assign a Daily Task** — pick an approved intern, and you'll see 1-2
   suggested tasks based on their strongest skills-check category (you can
   use a suggestion as a starting point or ignore it and write your own).
   Fill in a title, description, and due date, tick "client-related" if it
   is one, and assign it — it shows up on their Intern Portal immediately.
3. **Tasks Awaiting Review** — every task an intern has marked complete.
   Add a comment and either Approve & Close it, or Reopen With Comment to
   send it back (which puts a "Mark Complete" button back on their end).
4. **Attendance** — three one-click CSV exports (Today / This Week / This
   Month) with every intern's clock times, break minutes, and worked
   minutes, plus a "Flagged Days" list surfacing anything that looked off
   (break ran long, or the day was well under 9 hours) so you don't have to
   scroll through everyone's raw attendance to find what's worth a look.
5. **Intern Requests** — every pending Edit Profile / Appointment Letter /
   Leave Request / Experience Letter / Resignation request, with an
   optional note back to the intern, and Approve / Reject. Both actions
   email the intern directly plus hello@ried.co.in — this is also where
   Leave Request approvals get their required "goes to both the intern and
   hello@ried.co.in" email from your original ask.

## A nice side effect of how this was built

Every write this round needed — approving an application, assigning a task,
reviewing one, deciding on a request — turned out to already be covered by
the Firestore rules built back in Phase 3 (they were written ahead of time
specifically so this round wouldn't need a rules republish). **So this
round needs NO Firestore rules changes at all** — only a Cloud Functions
deploy, for the two new notification emails. `firestore.rules` is included
in this folder unchanged, just so the folder is a complete, self-contained
snapshot — you don't need to redeploy it.

## What's in this folder

- **`functions/index.js`** — two new triggers appended at the end:
  `notifyOnInternApprovalDecision` (emails the candidate + hello@ried.co.in
  the moment an application is approved or rejected) and
  `notifyOnInternRequestReviewed` (emails the intern + hello@ried.co.in the
  moment a request is approved or rejected, with your optional note
  included). Everything else in this file is unchanged.
- **`js/firebase-init.js`** — added `arrayUnion` and `Timestamp` to the
  shared Firestore imports/exports (needed for Mentor comments on tasks).
- **`admin-dashboard.html`** — full rewrite of the page body: the Client
  Corner / Internship Corner split, plus all five new Internship Corner
  sections described above.
- **`style.css`** — a small new section appended at the end: the corner
  header styling (blue accent for Client Corner, orange for Internship
  Corner) and a couple of small layout helpers for the suggestion chips and
  export buttons.
- **`firestore.rules`** — included unchanged (see above), just for
  completeness.

## Deploy checklist

1. Copy every file in this folder over the matching path in your repo
   (note the `js/firebase-init.js` path), push to GitHub.
2. Redeploy Cloud Functions (fresh clone, as always):
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
   firebase deploy --only functions
   ```
   This adds `notifyOnInternApprovalDecision` and
   `notifyOnInternRequestReviewed` — it should NOT ask about deleting
   anything.
3. That's it — **no Firestore rules redeploy needed this round** (see
   above). No Storage rules changes either.

## Test checklist

Using the test account you approved manually back in the v19 round (or a
fresh one that's completed the skills check):
1. If you want to test the Approve flow itself rather than reusing an
   already-approved account, sign up a second test account and get it all
   the way through onboarding + the skills check, so it lands on
   "assessment_completed."
2. Sign in to the Admin Dashboard as Pramod or Neel — confirm you see the
   Client Corner / Internship Corner split, with that candidate showing up
   under Pending Internship Applications with their score.
3. Click Approve — confirm the item disappears from the list, the
   candidate gets an email, and hello@ried.co.in gets a copy. Sign in as
   that candidate and confirm their dashboard now shows "Approved" with the
   portal button.
4. In Assign a Daily Task, pick that intern from the dropdown — confirm
   suggested tasks show up based on their strongest category — click one,
   confirm it fills in the title/description, then assign it. Sign in as
   the intern and confirm the task shows up under My Tasks.
5. As the intern, Acknowledge then Mark Complete that task. Back in the
   Admin Dashboard, confirm it shows up under Tasks Awaiting Review — add a
   comment and try Reopen With Comment, then confirm the intern's portal
   shows it back with a Mark Complete button and your comment visible.
6. Have the intern clock in/out at least once (from the v19 round), then
   try the three attendance export buttons and confirm a CSV downloads with
   their name and times in it.
7. Have the intern submit a Leave Request from their Request Center.
   Approve it from the Admin Dashboard with a short note — confirm the
   intern gets an email with your note, hello@ried.co.in gets a copy, and
   their Request Center now shows it as "approved."

## The whole Internship Program, end to end

With this round, all four phases from your original request are built:
sign-up and onboarding (Phase 1), the skills check (Phase 2), the full
intern portal — attendance, tasks, requests (Phase 3), and now the Mentor
side to manage all of it (Phase 4). Everything is live once this round
deploys — the only outstanding item across all four rounds is running
through each phase's test checklist end-to-end, which the checklist above
finally makes possible without any manual Console edits standing in for
missing features.
