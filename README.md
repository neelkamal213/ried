# v21 — Admin Bug Fixes, Full Intern Roster, and Skills-Check Reapply (2026-08-03)

## What this fixes

**The Reject button and Attendance export buttons weren't just cosmetically
broken — they were invisible.** `style.css` defines `.btn-secondary` twice:
once early on with the orange/blue gradient look you see everywhere else,
and once later with a translucent look meant for buttons sitting on a dark
background (the homepage hero, nav, etc). Right after that second
definition there's a list of page types that get the readable style back —
but the Admin Dashboard's `<body>` tag wasn't on that list, so every
`.btn-secondary` button on that page fell through to the invisible version.

This wasn't just Reject and the Attendance export buttons — it was also
**Sign Out**, **Mark as Paid**, and **Reopen With Comment**. All of them are
fixed now with one small change: the Admin Dashboard's `<body>` tag now
carries a class, and that class was added to the same list that already
covers your other account pages.

## What this adds

### 1. Full Intern Roster (new section, top of Internship Corner)
Every intern who's ever applied, at any stage — not just the ones currently
waiting on an action. Search by name or email, filter by status, and for
anyone who's taken the skills check more than once, click **History** to
expand every past attempt with its score breakdown. This reuses the same
intern data your dashboard was already fetching once per admin session — no
new reads, no new Firestore rules.

### 2. Search/filter added to four existing sections
Pending Internship Applications, Tasks Awaiting Review, Attendance's
Flagged Days, and Intern Requests all got a search box at the top. None of
these needed new data — they just filter what was already being loaded.

### 3. Skills-check reapply (up to 3 attempts)
The actual gap: a rejected candidate — whether from a straightforward
rejection or from timing out and getting a low score that got rejected —
had no way back in. Now:

- A rejected candidate's dashboard shows a **Retake Your Skills Check**
  button, as long as they haven't used all 3 attempts.
- Retaking always starts a completely fresh, freshly-timed set of
  questions — never a resume of the old one.
- Every attempt's score is kept (not overwritten), so you can see the full
  history for anyone who's retaken — that's what the Roster's History
  button shows.
- Once someone's used all 3 attempts and is still rejected, the retake
  button is replaced with a note to reach out to hello@ried.co.in instead.
- The rejection email now mentions how many attempts are left (or that
  there are none), so the candidate isn't left guessing.

**Important — this applies automatically to your existing test account.**
The candidate you rejected during testing has no attempt-count on her
record yet, and a missing attempt-count is treated as zero used. The moment
this round deploys, her dashboard will show the Retake button with all 3
attempts available — nothing needs to be hand-edited in Firestore for her.

### Zero Firestore rules changes
Every write this feature needs (flipping status back to "onboarded",
tracking attempt count, recording attempt history) happens inside
`startAssessment`/`submitAssessment`, which run with Cloud Functions'
Admin SDK — that bypasses Firestore rules entirely, the same way grading
already did. `firestore.rules` is included in this folder unchanged, purely
so the folder is a complete snapshot — you don't need to redeploy it.

## What's in this folder

- **`functions/index.js`** — `startAssessment` now also accepts a rejected
  candidate with attempts remaining and starts them a fresh attempt;
  `submitAssessment` now also records the attempt into a history list; the
  rejection email in `notifyOnInternApprovalDecision` now mentions attempts
  remaining. Everything else in this file is unchanged.
- **`admin-dashboard.html`** — the Intern Roster section, search boxes on
  four existing sections, and the `admin-page` class on `<body>` (the CSS
  fix). All existing sections/behavior otherwise unchanged.
- **`style.css`** — the one-line fix extending the button-style override to
  the Admin Dashboard, plus a small new section for the roster/search
  styling.
- **`intern-test.html`** — the entry guard now lets a rejected candidate
  with attempts left through, and shows "Attempt X of 3" on the intro
  screen when retaking.
- **`intern-dashboard.html`** — a real "Not Selected This Time" state with
  the Retake button (or the out-of-attempts message), replacing what used
  to be a generic dead-end message.
- **`firestore.rules`** — included unchanged, for completeness (see above).

## Deploy checklist

1. Copy every file in this folder over the matching path in your repo, push
   to GitHub. (The static files — `admin-dashboard.html`, `style.css`,
   `intern-test.html`, `intern-dashboard.html` — go live on GitHub Pages as
   soon as you push; no Cloud Shell needed for those.)
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
   firebase deploy --only functions:startAssessment,functions:submitAssessment,functions:notifyOnInternApprovalDecision
   ```
   **Note the scoped `--only` list this time** — only these 3 functions
   actually changed this round, and scoping the deploy to just them (rather
   than a bare `--only functions` across all 22) avoids the Cloud Run CPU
   quota issue we hit during the v20 deploy. This is a general habit worth
   keeping going forward: as the function count grows, scope deploys to
   what actually changed rather than redeploying everything every time.
3. That's it — **no Firestore rules redeploy needed this round**, and no
   Storage rules changes either.

## Test checklist

1. **CSS fix**: sign in to the Admin Dashboard — confirm Sign Out, Reject
   (in Pending Internship Applications and Intern Requests), the 3
   Attendance export buttons, and Reopen With Comment are all now clearly
   visible with the same light-navy button style as everywhere else.
2. **Roster**: confirm the Intern Roster section shows every intern
   regardless of status. Try the search box and the status filter. Find
   your already-rejected test account and confirm it appears with status
   "Rejected."
3. **Reapply — the main feature**: sign in as that already-rejected test
   account (or reuse a fresh one you reject for this test) — confirm the
   dashboard now shows "Not Selected This Time" with a Retake Your Skills
   Check button. Click it, confirm the intro screen shows "Attempt 2 of 3",
   complete it, and confirm you land back on "Pending Review" like a normal
   first attempt.
4. Back in the Admin Dashboard, reject that account again — confirm the
   Roster's History button on their row now shows both attempts with their
   separate scores. Reject a 3rd time (their 3rd attempt) and confirm the
   dashboard now shows the "used all attempts, reach out to
   hello@ried.co.in" message instead of a Retake button, and that
   `intern-test.html` also refuses entry directly if visited by URL.
5. Search/filter: try the search boxes on Pending Internship Applications,
   Tasks Awaiting Review, Flagged Days, and Intern Requests — confirm each
   narrows the list as you type.
