# v18 — Internship Program Phase 2: Skills Assessment (2026-08-03)

## What this adds

The "Take Test" step from your original request — a short, timed, randomized,
auto-graded skills check that candidates take right after onboarding. No
pass/fail anywhere, just a 0-100 score per area so Neel and Pramod can see
where each candidate is strongest before assigning tasks later.

- **20 questions per attempt** (4 each, randomly drawn from a larger pool, so
  no two candidates get quite the same test): HTML basics, CSS basics, Core
  Java fundamentals, logical reasoning, and short task-based scenarios
  ("what does this render", "spot the bug", "pick the right fix" — real code
  execution isn't feasible on this stack safely, so these are all
  scenario/multiple-choice, per what we discussed).
- **15-minute timer**, enforced server-side (a candidate editing browser JS
  can't extend it) — auto-submits whatever's answered when time runs out.
- **Answers are graded entirely on the server** — the question bank and
  correct answers live only in Cloud Functions source, never sent to the
  browser, and never stored anywhere a client can read them. Each
  candidate's specific question set and shuffled answer order is locked into
  a private session document only the Cloud Function itself can touch.
- **Fun, GenZ-friendly tone** — score reveal with emoji, encouraging copy at
  every score range, category bars instead of a plain number.
- New dashboard state: once onboarded, the dashboard shows a "Take Your
  Skills Check" button; once the test is submitted, it shows the score
  breakdown and a "your Mentors are reviewing this" message — matching your
  original flow (onboarding → test → dashboard pending approval).
- An email to hello@ried.co.in the moment someone finishes, with their score
  breakdown, same pattern as the existing onboarding-submitted email.

## What's in this folder

- **`functions/index.js`** — full file, with the new question bank,
  `startAssessment`, `submitAssessment`, and `notifyOnInternAssessmentComplete`
  appended at the end. Everything from before (Marketplace, Packages,
  subscriptions, Phase 1 onboarding) is unchanged.
- **`firestore.rules`** — only the Internship Program comment block was
  updated (documentation only — the actual rules didn't need to change,
  since the new assessment-session data is only ever touched by Cloud
  Functions using the Admin SDK, which bypasses these rules entirely).
- **`style.css`** — new styles appended at the end for the quiz screen, the
  countdown timer, and the results score bars. Nothing existing was touched.
- **`intern-test.html`** — brand new page, the actual test-taking screen.
- **`intern-dashboard.html`** — updated to add the "Take Your Skills Check"
  button and the post-test score summary.

`intern-onboarding.html` did **not** need any changes — its existing
"Go To My Dashboard" button and copy already pointed candidates to the
dashboard, which now surfaces the test as their next step from there.

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
   This adds `startAssessment`, `submitAssessment`, and
   `notifyOnInternAssessmentComplete` as new functions — it should NOT ask
   about deleting anything this time, since nothing existing was removed.
3. Redeploy Firestore rules (documentation-only change, but keeps everything
   in sync):
   ```
   firebase deploy --only firestore:rules,firestore:indexes
   ```
   (No Storage rules changes this round, so no need to redeploy those.)

## Test checklist

Using a test intern account that's already completed onboarding (status
`onboarded`):
- Sign in, go to the dashboard, confirm you see "Skills Check Pending" with
  a "Take Your Skills Check" button.
- Click it, read the intro screen, click "Start My Skills Check" — confirm
  the timer starts at 15:00 and counts down, and the first question shows a
  category chip (HTML/CSS/Core Java/Logical Reasoning/Task-Based).
- Click through a few answers, use Back to confirm your previous picks are
  still highlighted, then go to the last question and click "Submit My
  Test".
- Confirm the results screen shows an overall score and a bar per category,
  with an encouraging message (not "pass" or "fail" wording anywhere).
- Confirm hello@ried.co.in receives an email with the candidate's name and
  full score breakdown.
- Go to the dashboard again — confirm it now shows "Pending Review" with the
  same score breakdown, and there's no way to retake the test from here.
- Optional: try letting the timer run all the way to zero on a fresh
  attempt, and confirm it auto-submits without any extra click.

## Still to come

Phase 3 (intern attendance, daily tasks, request center) and Phase 4 (Mentor
side — task assignment, review, attendance reports, leave approval, with the
Admin Dashboard's "Client Corner" kept visually separate from the
"Internship Corner" per your instruction) are next, once you've had a chance
to try this round out.
