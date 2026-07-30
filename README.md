# v12 — Subscription Renewal Webhook + Reminders (2026-07-30)

This closes the gap flagged in the v11 notes: until now, only the very
FIRST month of a Scale-Up & Grant Readiness subscription sent any email —
every renewal after that just happened quietly inside Razorpay. This adds:

1. **A "Renewal Payment Received" email every month** it succeeds — sent to
   both hello@ried.co.in and the client.
2. **Automatic reminder emails to the client** if a renewal payment fails —
   one immediately, then a repeat every 3 days until it's paid.
3. **An overdue alert to RIED** if a subscription is still unpaid on/after
   the 5th of the month, so someone can follow up with the client directly.

Only one file changed: `functions/index.js`. Nothing on the website itself
(`packages.html`, etc.) needs to change for this.

## Only one file changed, but there's real setup this time

Unlike past updates, this one needs two things beyond a normal deploy,
because it involves Razorpay contacting YOUR server automatically (a
"webhook") instead of only responding when a customer is on the checkout
page. Full steps are below — please follow them in order, exactly as
written, since a step skipped or done out of order is the most likely way
for this to not work on the first try.

## What's happening technically (short version)

- Razorpay will now call a new function, `razorpayWebhook`, every time
  something happens to a subscription — a renewal charge succeeds, a
  renewal charge fails, or (after enough failures) Razorpay gives up and
  "halts" the subscription.
- A second new function, `checkOverdueRenewals`, runs automatically once a
  day (no setup needed for this part — Firebase sets up its own daily
  schedule when you deploy). This is what repeats the reminder every 3 days
  and sends the "still not paid by the 5th" alert to you.
- A new secret, `RAZORPAY_WEBHOOK_SECRET`, is how your function proves an
  incoming request genuinely came from Razorpay and not someone else
  pretending to be Razorpay. You'll make up this value yourself in Step 1
  below, then enter the exact same value in two places (Firebase and
  Razorpay) so they can recognize each other.

## Step-by-step deploy

**Step 1 — Make up a secret value.** In Cloud Shell, run:
```
openssl rand -hex 32
```
This prints a long random string. Copy it somewhere safe (a notes app is
fine) — you'll paste this exact same value into two places in Steps 2 and 5.
It's not a password you need to remember, just a shared secret between
Firebase and Razorpay.

**Step 2 — Store it as a Firebase secret.** Still in Cloud Shell:
```
cd ~/ried
firebase functions:secrets:set RAZORPAY_WEBHOOK_SECRET
```
When it asks for the value, paste the string from Step 1 and press Enter.

**Step 3 — Update the code.**
1. Copy `functions/index.js` from this folder over the matching file in
   your GitHub repo (replace the whole file).
2. In Cloud Shell, make sure you're working from a fresh clone (same
   lesson as last time — don't reuse an old clone):
   ```
   rm -rf ~/ried
   git clone https://github.com/neelkamal213/ried.git ~/ried
   cd ~/ried/functions
   npm install
   ```
3. If `npm install` doesn't show `nodemailer` afterwards (run
   `ls node_modules | grep nodemailer` to check), run
   `npm install nodemailer@6.9.14 --save` directly, same as last time.

**Step 4 — Deploy.**
```
cd ~/ried
firebase deploy --only functions
```
This may take a few minutes since it's creating 2 brand-new functions
(`razorpayWebhook`, `checkOverdueRenewals`) alongside updating the existing
ones. If it asks you to enable an API (e.g. "Cloud Scheduler API" or
"Cloud Build API") or pick a Cloud Scheduler location/region, choose
**Yes/Enable** and pick the closest region to India (e.g. `asia-south1`) if
asked — this is normal and only happens the first time a scheduled
function like `checkOverdueRenewals` is deployed on this project.

When it finishes, look through the output for a line that looks like:
```
✔  functions[razorpayWebhook(us-central1)]: ... Function URL: https://us-central1-<your-project>.cloudfunctions.net/razorpayWebhook
```
**Copy that full URL** — you'll need it in Step 5. (If you don't see it in
the output, it's also on the Firebase Console: Build → Functions →
click `razorpayWebhook` → the URL is shown at the top.)

**Step 5 — Register the webhook in Razorpay.**
1. Go to the [Razorpay Dashboard](https://dashboard.razorpay.com).
2. Go to **Settings → Webhooks** (left sidebar).
3. Click **+ Add New Webhook**.
4. **Webhook URL**: paste the URL you copied at the end of Step 4.
5. **Secret**: paste the exact same random string from Step 1 (must match
   what you stored in Firebase in Step 2 — if these two don't match
   exactly, Razorpay's calls will get rejected).
6. **Active Events**: tick these three only:
   - `subscription.charged`
   - `subscription.pending`
   - `subscription.halted`
7. Click **Create Webhook** to save.

That's it — no code changes are needed on the Razorpay side beyond this.

## How to test it

Real subscription renewals only happen once a month, so you can't easily
wait for a natural test. Two options:
- **Easiest**: in the Razorpay Dashboard, most webhook entries have a
  "Test" or "Send Test Webhook" option once created — use that to send a
  sample `subscription.charged` event and confirm your function receives
  it (Firebase Console → Functions → `razorpayWebhook` → Logs tab should
  show it came in).
- **Realistic but slower**: subscribe to a Scale-Up tier yourself with a
  small test amount if you have Razorpay Test Mode set up, and use
  Razorpay's test-mode tools to simulate a renewal charge and a failure.

Either way, check the Firebase Console → Functions → `razorpayWebhook` →
Logs after triggering a test event — you should see it logged there within
a few seconds of Razorpay sending it.

## One assumption worth knowing about

Razorpay bills each subscription on its own "anchor date" — the day of the
month someone first subscribed — not on a fixed calendar date for everyone.
So the "alert RIED by the 5th" rule only fires for a subscription once we
already know (via the webhook) that a charge attempt actually failed — never
just because a charge hasn't happened yet that month. This avoids false
alarms for a subscriber whose renewal date is, say, the 20th, who is
completely on schedule and hasn't done anything wrong.

## Deploy checklist
1. Run `openssl rand -hex 32` in Cloud Shell, save the value.
2. `firebase functions:secrets:set RAZORPAY_WEBHOOK_SECRET` — paste that value.
3. Copy `functions/index.js` from this folder into your repo, push to GitHub.
4. Fresh clone in Cloud Shell, `npm install` in `functions/`, check nodemailer installed.
5. `firebase deploy --only functions` from `~/ried` — approve any API-enable prompts.
6. Copy the `razorpayWebhook` URL from the deploy output.
7. Razorpay Dashboard → Settings → Webhooks → Add New Webhook — paste URL,
   paste the same secret from Step 1, tick `subscription.charged` /
   `subscription.pending` / `subscription.halted`, save.
8. Send a test webhook event from the Razorpay Dashboard and confirm it
   shows up in Firebase Console → Functions → `razorpayWebhook` → Logs.
