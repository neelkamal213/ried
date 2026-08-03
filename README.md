# v19 — Internship Program Phase 3: Intern Portal (2026-08-03)

## What this adds

The full intern-side portal from your original request, unlocked once an
application is approved:

- **Attendance** — Clock In / Start Break / End Break / Clock Out, with a
  live status card showing what's happening right now and a running log of
  today's breaks. All the actual timestamps are set on the server (not the
  browser), so a candidate can't fake their hours by editing anything on
  their end. A "Recent Days" table shows the last 10 completed days —
  clock-in/out times, break time, and total worked — with a small flag if a
  day's break ran long or the total time looks well short of a 9-hour day
  (this is just a heads-up marker for now; the full Mentor-side attendance
  report/anomaly view is Phase 4).
- **My Tasks** — a list of whatever's been assigned, each with an
  Acknowledge button, then a Mark Complete button once acknowledged, plus a
  spot for Mentor comments to show up once Phase 4 adds the ability to leave
  them.
- **Request Center** — Edit Profile, Appointment Letter, Leave Request,
  Experience Letter, and Resignation, all as one simple form that adjusts
  its fields per type, plus a history of everything submitted and its
  status. Every submission emails hello@ried.co.in immediately, same as
  everything else on this site.

## Important — this phase depends on Phase 4, which isn't built yet

The original flow is: intern applies → Mentor approves → intern gets portal
access. **The "Mentor approves" step is Phase 4**, which hasn't been built.
So right now, nothing will actually reach the `approved` status on its own
— which means the portal above has nothing to show yet, and no task exists
for anyone to acknowledge.

To actually test this round before Phase 4 exists, you'll need to do two
manual, one-time steps directly in the Firebase Console for a test account.
Full steps below — this is just for testing now; once Phase 4 ships, this
will all happen through a real Approve button instead.

### Step A — Manually approve a test intern account (to unlock the portal)

1. Go to the [Firebase Console](https://console.firebase.google.com) →
   your `ried-website` project → **Firestore Database**.
2. Click into the **`interns`** collection.
3. Find the document for your test intern account (the document ID is that
   account's Firebase Auth UID — if you're not sure which one, cross-check
   against the **Authentication** tab, or just use whichever test account
   you signed up with earlier).
4. Click on the `status` field's value (it'll currently say `onboarded` or
   `assessment_completed`) to edit it.
5. Change the value to exactly: `approved` (lowercase, no quotes needed —
   the Console field type stays "string").
6. Click the checkmark / hit Enter to save.

That account can now sign in and reach `intern-portal.html` (via the "Go To
My Intern Portal" button that now shows on their dashboard).

### Step B — Manually create one test task (to test the My Tasks tab)

1. Still in Firestore Database, click **Start collection** (or, if it
   already exists from testing, just **Add document** inside it) and name
   the collection **`internTasks`**.
2. Let Firestore auto-generate the Document ID.
3. Add these fields (use the **Add field** button for each):
   - `internUid` (string) — the SAME UID you used in Step A.
   - `title` (string) — e.g. `Update the FAQ section on the About page`
   - `description` (string) — e.g. `Review the current FAQ copy and suggest two improvements.`
   - `status` (string) — `assigned`
   - `dueDate` (string) — e.g. `2026-08-10`
   - `assignedAt` (timestamp) — click the clock icon and pick "now" (or any
     recent date/time)
4. Save.

That task will now show up under My Tasks for that intern, with an
Acknowledge button, then a Mark Complete button once acknowledged.

Requests don't need any manual setup — the Request Center's own Submit
button creates real `internRequests` documents.

## What's in this folder

- **`functions/index.js`** — full file, with `clockIn`, `startBreak`,
  `endBreak`, `clockOut`, and `notifyOnInternRequest` appended at the end.
  Attendance times are entirely server-set (never trusts a client-sent
  time) and the four functions enforce the state machine (can't clock in
  twice, can't clock out mid-break, etc.) so a day's record can't be gamed.
  Everything from before (Marketplace, Packages, subscriptions, Phase 1/2
  Internship) is unchanged.
- **`firestore.rules`** — three new collections added: `/attendance`
  (Cloud-Function-only writes, exactly like `/orders`), `/internTasks`
  (Mentor-only create, intern can only self-advance status one safe step at
  a time), `/internRequests` (intern can only create their own, starting at
  `pending` — only an admin can change it after that). The `internTasks`
  create-by-admin and `internRequests` update-by-admin rules are written
  now, ahead of Phase 4's actual admin UI, the same way `/carts`+`/orders`
  were pre-built ahead of Marketplace's checkout back at the very start of
  that feature — saves a second Console-publish round once Phase 4 ships.
- **`style.css`** — new section appended at the end for the attendance
  widget, task cards, and request center — nothing existing was touched.
- **`intern-portal.html`** — brand new page, the actual portal (three tabs:
  Attendance / My Tasks / Request Center).
- **`intern-dashboard.html`** — added the `approved` status branch with the
  "Go To My Intern Portal" button.

## Deploy checklist — please do these in order

1. Copy every file in this folder over the matching path in your repo, push
   to GitHub.
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
   This adds `clockIn`, `startBreak`, `endBreak`, `clockOut`, and
   `notifyOnInternRequest` as new functions — it should NOT ask about
   deleting anything.
3. Redeploy Firestore rules:
   ```
   firebase deploy --only firestore:rules,firestore:indexes
   ```
   (No Storage rules changes this round.)
4. Do Steps A and B above (manual Console edits) for one test intern
   account.

## Test checklist

Using the test account you approved in Step A:
- Sign in, dashboard should show "Approved" with a "Go To My Intern Portal"
  button — click it.
- **Attendance tab**: click Clock In, confirm the status card updates to
  "Working since [time]" and Start Break / Clock Out buttons appear. Click
  Start Break, confirm it switches to "On a break" with an End Break
  button. Click End Break, confirm it's back to "Working." Click Clock Out,
  confirm it shows "Shift complete" with a worked-time total. Refresh the
  page and confirm the status is remembered (it reads from Firestore, not
  just in-memory).
- **My Tasks tab**: after Step B's manual test task, confirm it shows up
  with an Acknowledge button. Click it, confirm it becomes Mark Complete.
  Click that, confirm the status badge shows "completed."
- **Request Center tab**: submit one of each type if you have time (at
  minimum, try Leave Request since it has the most fields), confirm it
  shows up in "My Requests" below with a "pending" badge, and confirm
  hello@ried.co.in gets an email for each one with the right details.

## Still to come

Phase 4 — the Mentor/admin side: task assignment (with suggestions based on
assessment results), reviewing/commenting/reopening tasks, attendance
anomaly review and exportable reports, and leave approval — plus the
Admin Dashboard's "Client Corner" / "Internship Corner" visual split you
asked for partway through Phase 1. Once Phase 4 ships, the manual Console
steps above go away entirely — a real Approve button and a real "assign a
task" form will do what Steps A and B are standing in for now.
