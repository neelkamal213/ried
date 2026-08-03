# v16 — Internship Program, Phase 1: Sign-Up + Onboarding (2026-07-31)

This is Phase 1 of the 4-phase Internship Program build we agreed on: the
footer link, sign-up, and the onboarding form with document uploads. The
skills assessment (Phase 2), the full intern portal — attendance/tasks/
requests (Phase 3), and the Mentor/admin side (Phase 4) come in later
rounds.

## What's new

### Footer link (home page only, as requested)
`index.html`'s footer now has an "Internship Program" link right under
Terms & Conditions, not in the main menu. It goes to `intern-register.html`.

### `intern-register.html` (new) — sign-up
A dedicated sign-up page for internship candidates, completely separate
from the founder/client `register.html`. Email + password, same Terms
consent checkbox pattern as the rest of the site (plus a line about
consenting to the ID documents collected next). Creates a Firebase Auth
account and an `/interns/{uid}` record, then goes straight to onboarding.

### `intern-login.html` (new) — sign-in
For candidates coming back after their first session. Routes them to
onboarding if they haven't finished it yet, or to their dashboard if they
have. If someone tries this page with an account that isn't actually an
Internship Program applicant, it says so rather than guessing.

### `intern-onboarding.html` (new) — the onboarding wizard
A multi-step, game-like wizard (same proven pattern as the founder
onboarding wizard — progress bar, one thing at a time, a congratulations
screen at the end) collecting:
- Full Name, Father's/Mother's Name, Phone, Full Address
- College Name, Field of Study, Semester, and an optional Interests field
  (this one helps later when Mentors are suggesting tasks per intern)
- Three uploads: Photo, Aadhar Card, Latest Marksheet

On submit, everything — including the three documents — goes to
hello@ried.co.in automatically, then the candidate lands on their
dashboard.

### `intern-dashboard.html` (new) — Phase 1 stub
Right now this only ever shows one thing: "Application Submitted," with a
plain-English rundown of what happens next (skills check, then RIED
review). It's built so Phase 2/3 slot in new states cleanly rather than
needing a rewrite — the whole page hangs off one `renderStatus()` function
keyed by the application's status field.

## What changed under the hood
- **`functions/index.js`** — new function `notifyOnInternOnboarding`,
  modeled directly on the existing `notifyOnProfileSubmit` (the founder
  profile email). It fires once, the moment onboarding is actually
  submitted (not on every later write), and emails hello@ried.co.in a full
  summary plus secure links to the three uploaded documents.
- **`firestore.rules`** — new `/interns/{uid}` collection. A candidate can
  only read/write their own record, and — this is the important part —
  they can only ever move their own `status` from `signed_up` to
  `onboarded`. Anything past that (assessment results, approval, rejection)
  can only be set by an admin or a future Cloud Function, using the exact
  same self-escalation protection I just added to `/users` last round.
  Admins can read every application (needed for the approval dashboard
  coming in Phase 4).
- **`storage.rules`** — new `intern-documents/{uid}/...` path, strictly
  private (owner-only read/write, nothing public) since Aadhar cards and
  marksheets are sensitive documents — this is a deliberately different,
  stricter rule than the public Marketplace listing photos. Accepts images
  or PDFs, capped at 10MB per file.
- **`style.css`** — one genuinely new bit of UI, the rectangular document
  upload cards (`.doc-upload-grid`/`.doc-upload-box`) for the three
  uploads — everything else (the wizard, the buttons, the dashboard card)
  reuses CSS classes that already exist elsewhere on the site, so there's
  very little new styling surface to review.

## A quick note on the Aadhar/marksheet uploads
These are real government-ID-level documents. They're stored privately
(not public like Marketplace photos), and the notification email links to
them rather than attaching the raw files — same pattern already used for
founder profile logos on this site. One thing worth having on your radar,
not something I can fix in code: it might be worth a quick check with
whoever handles your legal/compliance side on how long you intend to keep
this data and who has access to it, given what's being collected.

## Deploy checklist
1. Copy every file in this folder over the matching path in your repo
   (`intern-register.html`, `intern-login.html`, `intern-onboarding.html`,
   `intern-dashboard.html` are all brand new; `index.html`, `style.css`,
   `firestore.rules`, `storage.rules`, and `functions/index.js` all replace
   existing files).
2. Push to GitHub.
3. **Redeploy Cloud Functions** — required, since `notifyOnInternOnboarding`
   is a brand-new function:
   ```
   cd ~
   rm -rf ~/ried
   git clone https://github.com/neelkamal213/ried.git ~/ried
   cd ~/ried/functions
   npm install
   ls node_modules | grep nodemailer
   ```
   (if that last line prints nothing, run `npm install nodemailer@6.9.14 --save`
   like the last few times), then:
   ```
   cd ~/ried
   firebase deploy --only functions
   ```
4. **Publish the updated Firestore rules and Storage rules** — required,
   since both changed this round:
   ```
   firebase deploy --only firestore:rules,firestore:indexes
   firebase deploy --only storage
   ```
   (same `~/ried` folder as step 3, no need to re-clone).
5. Test as a candidate:
   - From the home page, scroll to the footer and click "Internship
     Program" (confirm it's NOT in the main menu).
   - Sign up with a test email, confirm you land on the onboarding wizard.
   - Fill in the details, upload three test files (a photo and two PDFs or
     images work fine for testing), submit.
   - Confirm the notification email arrives at hello@ried.co.in with the
     details and three working document links.
   - Confirm you land on the dashboard showing "Application Submitted."
   - Sign out, sign back in via `intern-login.html`, confirm it takes you
     straight back to the dashboard (not onboarding again).

## Still open after this round
Phase 2 (the skills assessment — randomized, timed, auto-graded, no
pass/fail, just a skill score) is next. Phase 3 (the full intern portal —
attendance clock in/out, daily tasks, the request center for profile
edits/appointment letters/leave/experience letters/resignation) and Phase 4
(the Mentor/admin side — task assignment with suggestions based on
assessment results, review/reopen, attendance reports, leave approval)
follow after that. Per your note mid-build: Phase 4's admin dashboard will
keep a clear visual split between a "Client Corner" (the existing founder/
Marketplace/payout sections) and an "Internship Corner" (everything
intern-related) rather than mixing them into one list.
