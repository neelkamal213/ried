# v9 — Auth Nav Toggle + Session Timeout + Purchase Gating (2026-07-26)

This round touches almost every page, so here's a map before you copy things over.
**Every file in this folder replaces the same-named file in the real repo** —
this is still a PARTIAL snapshot (no images), just a large one this time.

## What changed and why

### 1. "Sign In" ↔ "Dashboard" nav link, site-wide
New shared file: **`js/auth-nav.js`**. Every page now loads it with:
```html
<script type="module" src="js/auth-nav.js"></script>
```
It watches Firebase's sign-in state. The moment someone is signed in, the nav
link that used to always say "Sign In" flips to "Dashboard" (pointing at
`admin-dashboard.html` for your two admin accounts, `dashboard.html` for
everyone else). The moment they sign out, it flips back to "Sign In". This
required adding `id="navAuthLink"` to that link on every page, and — on the
four pages that never had a Sign In link at all (`dashboard.html`,
`admin-dashboard.html`, `my-listings.html`, `account.html`) — adding one.

This is also the fix for "the Dashboard page never showed the menu items at
top" — `dashboard.html`'s nav was simply missing that link entirely before,
which is why it looked incomplete next to every other page.

### 2. 30-minute inactivity sign-out
Also inside `js/auth-nav.js`. Once someone is signed in, any mouse move,
click, keypress, scroll or tap resets a 30-minute timer. If the timer ever
runs out with zero activity, they're automatically signed out and sent to
`login.html?timeout=1`, which now shows "You were signed out after 30
minutes of inactivity. Please sign in again." — so it doesn't look like a
random error.

**Note on scope**: this is an *inactivity* timeout (resets on activity), not
a flat "log out 30 minutes after login no matter what." If you actually want
the latter, let me know and it's a small change.

### 3. Packages page nav order fixed
`packages.html` and `packages-coming-soon.html` both had "Packages" sitting
right after "Services" instead of after "Leadership" — out of step with
every other page. That's the "Menu items in Headers wrongly set" bug on the
purchases page you flagged. Both files now match the same Home / About /
Products / Services / Startup Sanctuary / Leadership / Packages / Sign
In-or-Dashboard / Contact order as everywhere else.

### 4. Purchases now require sign-in
This applies to `packages.html` — the real Razorpay-connected packages page
(currently not the live one; `packages-coming-soon.html` still is, per your
call to hold off until after Monday's Legal/Compliance meeting). Once you do
swap the real page back in, purchases on it are now gated two ways:
- **Client-side** (`packages.html`): clicking "Reserve This Package" while
  signed out shows "Please sign in..." and redirects to `login.html`,
  instead of opening checkout.
- **Server-side, the real enforcement** (`functions/index.js` →
  `createRazorpayOrder`): now rejects the request outright if there's no
  signed-in user attached to it. The client-side check alone could always be
  bypassed by anyone poking at the network request directly — this is what
  actually makes it impossible to purchase while signed out.

Every order already records which signed-in account (`uid`) made it — that
part was already in place from the original Razorpay build.

### 5. Purchase notification email to hello@ried.co.in
Also in `functions/index.js`, inside `verifyRazorpayPayment` (the function
that runs right after Razorpay confirms a payment). On every successful,
verified payment it now emails **hello@ried.co.in** with: the item/package
name, the amount paid, and the buyer's name + email (looked up from their
Firebase account via their `uid`). Uses the same Gmail-SMTP setup as your
existing founder-profile emails — no new secret needed, `GMAIL_APP_PASSWORD`
is just now also used by this function.

**Nothing to do here until Marketplace checkout exists** — this email only
fires from the Packages checkout flow for now, since that's the only live
payment flow. When Marketplace checkout is eventually built, the exact same
`orders` write pattern will be extended to trigger it too.

### 6. `firestore.rules` — small correctness fix, found while checking this
The existing `/orders` rule checked a field called `buyerId`, but the
Cloud Function has only ever written the field as `uid`. Since orders are
only ever created via the Admin SDK (which bypasses rules entirely), this
never caused a visible bug — but it meant a buyer trying to read back their
own order would have been silently denied, since the rule was comparing
against a field that doesn't exist. Fixed to check `uid` instead. **You do
need to re-publish this file** in the Firestore Rules console tab.

## Deploy checklist
1. Copy every file in this folder over the matching path in your repo,
   preserving the `js/` and `functions/` subfolders.
2. Push to GitHub as usual.
3. **Publish `firestore.rules`** in the Firebase Console (Firestore Database
   → Rules tab → paste → Publish) — same "actually click Publish and wait"
   step that caused trouble before. Use the Rules Playground afterward to
   sanity-check a simulated read on `/orders/{anyId}` as the buyer's own uid.
4. **Redeploy Cloud Functions** — paste the full `functions/index.js`
   directly into your Cloud Shell's own copy of the file (not just your
   local one — Cloud Shell's clone is a separate filesystem), then:
   ```
   firebase deploy --only functions
   ```
5. Test the nav toggle: sign in on any page, confirm "Sign In" becomes
   "Dashboard" in the header without a page reload; sign out, confirm it
   flips back.
6. Test the idle timeout by lowering `SESSION_TIMEOUT_MS` in `js/auth-nav.js`
   temporarily (e.g. to `20 * 1000` for 20 seconds) on a test copy, confirm
   it signs you out and redirects with the message — then make sure you
   deploy the REAL file (30 minutes) afterward, not your test copy.

## Not related to this round — still open
The second `FirebaseError: Missing or insufficient permissions` sign-in bug
(on `neel44244@gmail.com`) that we were mid-debugging before this round
started is **not fixed by anything here** and hasn't been re-tested yet.
Please try signing in again after deploying this round, since a fresh
`firestore.rules` publish is part of this deploy anyway — but if it's still
broken, we're back to the three outstanding checks: confirm that account's
UID in Authentication → Users matches `276Y4uyxzaRmZ8MkTooiRrJMJbR2`, confirm
a `/profiles` document with that exact ID exists with real data in the
Firestore Data tab, and if both check out, try signing in from a different
device/network.
