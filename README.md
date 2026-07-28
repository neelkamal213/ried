# v10.3 — Marketplace: No Sign-In Required (2026-07-26)

This makes exactly the change you asked for: the Marketplace no longer asks
anyone to sign in. Add to Cart, view the cart, and check out all work for
any visitor — sign-in is now required **only** on the Packages page, same
as before.

## Why sign-in existed at all, and how it's removed

The cart and the checkout Cloud Functions need *some* stable ID to know
whose cart is whose, and to stop one buyer from reading or messing with
someone else's order. Up to now that ID was a real signed-in account's uid.

Instead of removing that identifier, this round swaps it for a **Firebase
Anonymous Auth** session — the same security mechanism, just invisible.
The moment a visitor clicks **Add to Cart** for the first time, they're
silently given an anonymous session in the background (no form, no popup,
nothing they'd notice). That gives the cart and checkout Cloud Functions
the exact same stable ID to work with as before, so nothing about the
security model changed — the server still always reads the real cart and
real prices from Firestore, never trusts the browser. A visitor who never
adds anything to their cart never gets any kind of account created for
them at all — it's created lazily, only when actually needed.

Since there's no real account behind an anonymous session, all the contact
information now comes entirely from the Delivery & Contact Details form
already added last round (name, email, phone, etc.) — which is exactly
right, since that's the only way to know who a guest buyer actually is.

## What changed

- **`marketplace.html`** — removed every "please sign in" prompt/redirect
  for Add to Cart, Cart, and Checkout. Added a small `ensureAuth()` helper
  that transparently starts an anonymous session on first cart use. Hero
  text now says "No account required."
- **`js/firebase-init.js`** — now also exports Firebase's `signInAnonymously`
  function (needed by `marketplace.html`).
- **`js/auth-nav.js`** — updated so an anonymous session is treated the same
  as being signed out everywhere else on the site: the header nav still
  shows "Sign In" (not "Dashboard") for a Marketplace guest, and the
  30-minute inactivity auto-sign-out timer never runs for them (that timer
  exists to protect real account sessions — there's nothing sensitive to
  protect in an anonymous cart session).
- **`dashboard.html`, `admin-dashboard.html`, `account.html`,
  `my-listings.html`, `profile-setup.html`** — small safety fix needed
  because anonymous sessions now exist on the site: each of these
  founder-only pages now treats an anonymous visitor exactly like a signed-out
  one (redirects to Sign In) instead of trying to treat them as a real
  account, which would have crashed on a missing email address if a guest
  ever wandered onto one of these pages directly.
- **`functions/index.js`** — no security changes needed (`createMarketplaceOrder`
  / `verifyMarketplacePayment` already just check "is *someone*
  authenticated," which an anonymous session satisfies). Updated the
  hello@ried.co.in confirmation email to pull the buyer's name/email from
  the Delivery & Contact Details form first (reliable for every checkout,
  guest or not), falling back to the real account's name/email only if one
  exists — since an anonymous account has no email of its own. Also added
  an "Account Type: Guest checkout / Signed-in RIED account" line so you
  can tell the two apart at a glance in the email.

## One required one-time setup step

Firebase's **Anonymous** sign-in provider needs to be turned on for this to
work at all (it's off by default on every Firebase project):

1. Firebase Console → **Authentication** → **Sign-in method**.
2. Enable **Anonymous** (it's in the provider list alongside Email/Password).
3. Save.

If this isn't enabled, Add to Cart / Checkout will show a "Something went
wrong setting up your cart/checkout — please refresh and try again" message
instead of working — that's the signal to check this setting first.

## Deploy checklist
1. Copy every file in this folder over the matching path in your repo.
2. Push to GitHub.
3. **Enable Anonymous Auth** in the Firebase Console (one-time, see above).
4. **Redeploy Cloud Functions** via Cloud Shell — paste `functions/index.js`
   in, then `firebase deploy --only functions` (needed for the updated
   confirmation-email logic; the actual checkout functions' security logic
   is unchanged so this step is about the email content, not a hard
   requirement for checkout itself to keep working).
5. Test as a signed-out visitor, in a fresh/incognito window: browse the
   Marketplace, Add to Cart (no sign-in prompt should appear), open Cart,
   Continue to Delivery Details, fill the form, complete a real payment —
   confirm the order lands in Firestore and the email arrives correctly
   labeled "Guest checkout." Then separately confirm Packages still
   requires sign-in exactly as before (unaffected by this round).
