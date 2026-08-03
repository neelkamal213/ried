# v17 — Restore Marketplace Payouts + Push Everything Current (2026-08-03)

## What happened, plainly

While building today's Internship Program Phase 1 (v16), I discovered that
my own working copy of a few files had lost last week's Marketplace order-
history/seller-sales/payout work (Tier 20 / v14) — specifically the
`markSellerPayout` function, the `sellerIds`/`payoutStatus` tracking inside
`createMarketplaceOrder`, the Firestore rule that lets a seller read their
own sales, and the related CSS. I built the security fix (v15) and today's
Internship work (v16) on top of that incomplete base without re-checking
it first, which is on me.

**What's actually safe right now**: your live Cloud Functions were never
touched — we caught the problem mid-deploy and you cancelled before
anything applied, so `markSellerPayout` and everything else is exactly as
it was. **What's likely already affected**: the Firestore rules you
deployed last week as part of the security fix were built on the same
incomplete base, so the rule letting a seller read their own Marketplace
sales has probably been missing since then — meaning "My Sales" on My
Listings may have been throwing permission errors for sellers since that
deploy. If you'd already pushed today's v16 files to GitHub before this
came up, your live site's stylesheet may also be missing the styling for
the My Sales / My Orders / Payouts pages (they'd still work, just look
unstyled).

To fix this cleanly without needing to figure out exactly which partial
state you're currently in, this round is a **complete, current snapshot of
every file that could possibly be affected** — all of it now correctly
combined (Tier 20's Marketplace payouts + last week's security fix +
today's Internship Program Phase 1, all together, verified as one unit).
Pushing everything in this folder gets you to a known-good state
regardless of what you'd already pushed.

## What's in this folder
Everything from v16 (`intern-register.html`, `intern-login.html`,
`intern-onboarding.html`, `intern-dashboard.html`, `index.html`,
`storage.rules`) is unchanged and included only so this is a genuinely
complete snapshot. What actually changed this round:

- **`functions/index.js`** — `createMarketplaceOrder` now correctly stores
  `payoutStatus: "pending"` on each line item and a `sellerIds` array on
  the order again; `markSellerPayout` (admin-only, marks a sale paid) is
  back; `notifyOnInternOnboarding` from today is still there too.
- **`firestore.rules`** — the `/orders` read rule now correctly includes
  the seller's `sellerIds`-based read access again, alongside the
  Internship Program rules from today and last week's admin-role fix.
- **`style.css`** — the My Sales tabs, sales cards, order cards, and admin
  payout row styling are back, alongside today's document-upload card
  styling.
- **`my-orders.html`, `my-listings.html`, `admin-dashboard.html`,
  `dashboard.html`** — restored to include the buyer order history page,
  the My Sales tab, the Marketplace Payouts admin section, and the My
  Orders button, exactly as originally built and successfully deployed
  last week.

## Deploy checklist — please do all of these, in order

1. Copy every file in this folder over the matching path in your repo —
   yes, even ones you think you already have; this ensures nothing partial
   is left behind. Push to GitHub.
2. Redeploy Cloud Functions (fresh clone, as always):
   ```
   cd ~
   rm -rf ~/ried
   git clone https://github.com/neelkamal213/ried.git ~/ried
   cd ~/ried/functions
   npm install
   ls node_modules | grep nodemailer
   ```
   (if that prints nothing, `npm install nodemailer@6.9.14 --save` like
   before), then:
   ```
   cd ~/ried
   firebase deploy --only functions
   ```
   **This time it should NOT ask about deleting `markSellerPayout`** —
   if it does, something is still out of sync and you should stop and
   paste me the output before continuing.
3. Redeploy both rules files:
   ```
   firebase deploy --only firestore:rules,firestore:indexes
   firebase deploy --only storage
   ```
4. Test everything from Tier 20 that was never actually confirmed working
   (this got interrupted by the rules regression before you got to it):
   - As a buyer: buy something from Marketplace, check Dashboard → My
     Orders shows it.
   - As a seller: My Listings → My Sales tab shows the sale with buyer
     details and "Awaiting Payout."
   - As admin: Admin Dashboard → Marketplace Payouts → Mark as Paid, then
     confirm the seller's My Sales view now shows "Paid Out."
5. Then test today's Internship Program Phase 1 (footer link → sign up →
   onboarding → document uploads → email → dashboard), same as described
   in the v16 README.

## Going forward
I'm going to be more careful about verifying my working files actually
reflect what's live before building on top of them, especially across a
long session — this shouldn't have made it this far. Sorry for the extra
round of deploy steps this creates for you.
