# v10.2 — Cart Button Fix + Working Checkout + Delivery Details (2026-07-26)

Three fixes/additions on top of v10's Marketplace, all reported from your
last test pass.

## 1. Cart button was invisible

Same recurring CSS bug as before (first hit on the dashboard/account pages
back in v7): a global, unscoped `.btn-secondary` style meant only for
colored hero sections was quietly overriding the normal-looking button on
any page that didn't opt out of it. `marketplace.html`'s `<body>` never
opted out, so the Cart button (and the "Remove" / "Back to Cart" buttons,
same style) rendered as white-on-white — technically there, just invisible.

**Fixed** by adding `class="marketplace-page"` to `marketplace.html`'s
`<body>` tag and adding that class to the same repair rule in `style.css`
that already protects the dashboard and account pages. No visual changes
anywhere else.

## 2. Checkout button "not working"

The previous checkout code had no error logging at all, so a failure just
sat there silently with nothing to go on. Added `console.error(...)` in
both the checkout step and the payment-verification step, including the
Firebase error code, so if it fails again the browser console (F12) will
show exactly why.

**My best guess at the actual cause**: the v10 Cloud Functions
(`createMarketplaceOrder` / `verifyMarketplacePayment`) may not have been
redeployed yet — the v10 checklist's step 4 ("redeploy Cloud Functions via
Cloud Shell") is easy to miss since the index-link fix (step 3) is the one
that throws an obvious on-page error, while a missing function deploy just
looks like "the button doesn't do anything." **Please redeploy functions
from this folder** (see checklist below) — that alone may resolve it. If it
still fails after that, open the browser console during checkout and send
me what it logs.

## 3. Delivery & contact details, collected and emailed

Checkout is now a two-step flow inside the same Cart panel:

1. **Cart** — same as before (items, quantities, total).
2. **Delivery & Contact Details** (new) — Full Name, Email, Phone,
   Alternate Phone (optional), Address, Landmark (optional), and Pincode.
   Name/Email pre-fill from the signed-in account if left blank. The five
   required fields (name, email, phone, address, pincode) are checked
   before payment can proceed, both in the browser and again on the server
   (the server never trusts client-side validation alone).

This information is now:
- **Stored on the order** — every document in Firestore's `/orders`
  collection gets a `shippingInfo` field once checkout completes.
- **Emailed to hello@ried.co.in** — the existing purchase-confirmation
  email (sent the moment payment is verified) now has a
  "Delivery / Contact Details" section with all seven fields, right
  alongside the item list and totals that were already in there.

## Files in this delivery
- `marketplace.html` — `.marketplace-page` body class; restructured Cart
  modal (two-step: items → shipping details); checkout button now sends
  `shippingInfo` to the server and prefills Razorpay's contact fields;
  added console-error logging for diagnosability.
- `style.css` — one small addition: `.marketplace-page .btn-secondary`
  added to the existing scoped button-repair rule (and its `:hover`).
- `functions/index.js` — `createMarketplaceOrder` now accepts, validates,
  and stores `shippingInfo` on the order; `verifyMarketplacePayment`'s
  confirmation email now includes it.

## Deploy checklist
1. Copy `marketplace.html` and `style.css` over the matching files at the
   root of your repo, and `functions/index.js` over `functions/index.js`.
2. Push to GitHub (covers the two static files).
3. **Redeploy Cloud Functions** — paste `functions/index.js` into Cloud
   Shell's editor, then `firebase deploy --only functions`. This step is
   required for both the shipping-details capture and (possibly) the
   checkout-button issue — don't skip it even if you did it for v10,
   since this is a newer version of the same file.
4. Test end-to-end: open Marketplace, add an item to cart (Cart button
   should now be clearly visible), click it, click "Continue to Delivery
   Details," fill in the form, click "Continue to Payment," complete a
   real payment. Afterwards, check that the order in Firestore's `/orders`
   collection has a `shippingInfo` field with everything you entered, and
   that the confirmation email at hello@ried.co.in includes the same
   details under "Delivery / Contact Details."
