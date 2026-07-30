# v11 — Real Packages Pricing + Live Checkout (2026-07-30)

This replaces every placeholder number on the Packages page with the real
pricing from your Legal, Compliance, Scale-Up, and IT teams, and builds real
checkout for all of it — including a new billing type the site has never
had before: true monthly subscriptions.

## What's live now

### Incorporation (one-time, includes govt. fees)
Basic ₹45,000 (authorised capital up to ₹10L) · Standard ₹55,000 · Premium
₹1,00,000 (up to 200 transactions/year).

### Legal Services (one-time)
Startup Package ₹80,000 · Legal Retainer ₹1,80,000 (3-month minimum, up to
40 hours of legal services + 5 free, with the carryover/lapse/overage rules
from your brief shown as footnotes on the card) · Investment Contract
₹2,75,000.

### Scale-Up & Grant Readiness (monthly subscription)
Basic ₹10,000/month (3-month minimum) · Standard ₹12,000/month (6-month
minimum) · Premium ₹15,000/month (12-month minimum). These are **real
recurring Razorpay Subscriptions** — see the important section below.

### IT & Infra Set-Up
Basic ₹40,000 one-time. Standard and Premium are both **Get a Quote** — no
listed price, so those buttons open a short lead form (name/email/phone/
company/notes) that emails hello@ried.co.in directly. No payment involved.

## How checkout works now
Every "Buy Now" / "Subscribe Now" button opens the same checkout-details
modal: Full Name, Email, Phone, Alternate Phone (optional), **Company /
Startup Name (optional)**, **GSTIN (optional)**, Address, Landmark
(optional), Pincode. Company Name and GSTIN are deliberately optional —
plenty of Incorporation buyers don't have either yet, since forming the
company is literally the service they're buying. All of this is captured
on the order record and included in the confirmation email to
hello@ried.co.in, same pattern as Marketplace.

Sign-in is still required for every action on this page — unchanged from
before. Marketplace remains the only page on the site that doesn't require
it.

## Important: real recurring subscriptions (Scale-Up & Grant Readiness)

This is a genuinely new kind of integration for this site, so a few things
worth understanding:

- **A Razorpay Plan is created automatically** the first time anyone
  subscribes to a given tier, and reused for every subscriber after that
  (cached in Firestore) — you don't need to set anything up manually in the
  Razorpay Dashboard beforehand, beyond the one prerequisite below.
- **The "minimum X months" is enforced by your service agreement, not by
  Razorpay technically.** Razorpay doesn't have a built-in "bill for a
  minimum term, then let the customer cancel anytime" feature — so these
  subscriptions are set up to keep auto-renewing indefinitely, and there's
  no self-serve cancel button anywhere on the site. A customer who wants to
  stop has to contact RIED, and cancelling happens from your side (Razorpay
  Dashboard → Subscriptions → find it → Cancel) — which is actually the
  natural way to enforce "you committed to X months" in practice.
- **Only the very first month's charge sends you an email.** After that,
  Razorpay auto-charges the customer every month on its own — those renewal
  charges show up in the Razorpay Dashboard's Subscriptions tab, but nothing
  emails hello@ried.co.in about them yet. If you want an email every time a
  renewal charge happens too, that needs a Razorpay webhook — a fairly
  contained follow-up build, just flagging it as a known gap rather than
  something silently missing.
- **One prerequisite to check before testing**: Razorpay Subscriptions may
  need to be explicitly turned on for your account (some Razorpay features
  need separate activation beyond basic Orders/Payments — similar to how
  "Route" would have needed activation if you'd gone that way for
  Marketplace payouts). If a Scale-Up subscription checkout fails
  immediately, this is the first thing to check in your Razorpay Dashboard.

## What changed under the hood
- **`functions/index.js`** — `PACKAGE_CATALOG` replaced entirely with the
  real pricing (server-side source of truth — this is what actually gets
  charged, never trust a price from the browser). `createRazorpayOrder`/
  `verifyRazorpayPayment` (one-time packages) now also capture and email the
  business/contact details. Two brand-new functions, `createScaleUpSubscription`
  and `verifyScaleUpSubscription`, handle the recurring Scale-Up billing.
  A third new function, `submitQuoteRequest`, handles the IT Get-a-Quote
  lead form.
- **`packages.html`** — fully rebuilt with the real copy, pricing, and
  feature lists for all 12 tiers, plus the new checkout-details modal and
  the separate Get-a-Quote modal.
- **`style.css`** — a small set of new classes for the checkout modal's
  package summary box and the footnote/sub-feature text under some cards,
  plus (important) a one-line fix so this page's "Cancel" buttons don't
  repeat a bug that's hit 3 times before on this site: an old, unscoped
  button style meant only for colored hero sections was overriding the
  normal button look. Caught and fixed proactively this time before it
  could show up as an invisible button.

## No Firestore rules or index changes needed
Every new record this round is stored in the same `/orders` collection
Marketplace already uses (just with new `type` values, `"package"` and
`"scaleup-subscription"`) — the existing security rules there already cover
this with zero changes. Nothing new to publish in the Firebase Console.

## Deploy checklist
1. Copy every file in this folder over the matching path in your repo.
2. Push to GitHub.
3. **Check Razorpay Subscriptions is enabled** on your Razorpay account
   (see above) — do this before testing a Scale-Up subscription.
4. **Redeploy Cloud Functions via Cloud Shell** — this is required this
   time, not optional, since three brand-new functions are being deployed
   for the first time (`createScaleUpSubscription`,
   `verifyScaleUpSubscription`, `submitQuoteRequest`) alongside the updated
   `createRazorpayOrder`/`verifyRazorpayPayment`. Paste `functions/index.js`
   into Cloud Shell's editor, then `firebase deploy --only functions`.
5. Test all three flows with real payments/submissions:
   - **One-time**: buy an Incorporation or Legal package, confirm the order
     in Firestore's `/orders` collection has your businessInfo and shows
     `status: "paid"`, and the confirmation email arrives.
   - **Subscription**: subscribe to a Scale-Up tier, confirm the first
     charge processes, check the Razorpay Dashboard's Subscriptions tab
     shows it as active with the right monthly amount, and confirm the
     "New Subscription Started" email arrives.
   - **Get a Quote**: submit a quote request for IT Standard or Premium,
     confirm no payment is attempted at all, and the lead email arrives.

## One more thing
`packages-coming-soon.html` is now fully unused — nothing on the site links
to it anymore (the nav always pointed straight at `packages.html`, which is
what this round replaces). You can delete it from your repo whenever you
like; it's not required, just tidy-up.
