# v10 — Marketplace: Browse Page, Cart, Checkout (2026-07-26)

This is Phase 2/3 of the Marketplace feature — the part that makes listings
(built in v8) actually sellable. Seller listing management (`my-listings.html`)
is unchanged; this round adds the buyer-facing side.

## What's new

### `marketplace.html` (new page)
The public browse page — reachable from the nav (added to every page) and
from a new "Browse Marketplace" button on the founder dashboard. Anyone,
signed in or not, can browse: search box, a Product/Service filter, a
category filter (built automatically from whatever categories sellers have
used), and a responsive grid of listing cards. Clicking a card opens a
detail view with the full description and a bigger photo. Only listings
marked **Active** on `my-listings.html` ever show up here — paused ones stay
hidden, same as before.

**Sign-in is required to actually buy**, not to browse — clicking "Add to
Cart" or "Proceed to Checkout" while signed out shows a message and sends
the visitor to `login.html`, same pattern as the Packages checkout gate from
v9. Once signed in, adding items to the cart is instant.

### Cart
Stored in Firestore at `/carts/{uid}` (the rules for this were already in
place since v8, unused until now). A cart icon in the toolbar shows a live
item count; clicking it opens a panel listing everything in the cart with
quantity +/- controls, a remove button per item, and a running total. If a
listing was paused or deleted after being added to a cart, it shows as "no
longer available" with just a remove option — it's automatically excluded
from the total and from checkout, so nothing broken can accidentally get
charged.

### Checkout — `createMarketplaceOrder` / `verifyMarketplacePayment` (new Cloud Functions)
Added to `functions/index.js`, right after the existing Packages checkout
functions, following the exact same security pattern:
- The server always reads the **signed-in caller's own cart** from
  Firestore — the client never sends item IDs or prices for the server to
  trust. Same principle as the Packages checkout: never trust a price (or
  a cart) coming from the browser.
- One combined Razorpay payment covers the whole cart, however many
  different sellers are in it — matching your decision that RIED collects
  all Marketplace payments centrally rather than splitting them per seller
  (no Razorpay Route). Each line item still records its own seller, so
  there's a clear paper trail for manual payouts later.
- On successful payment: the order is marked `paid` in `/orders`, the
  buyer's cart is automatically cleared, and an email goes to
  **hello@ried.co.in** with the buyer's name/email, every item purchased
  (with per-seller breakdown), the total paid, and the Razorpay IDs — same
  Gmail-SMTP setup already in place, no new secret needed.
- `createRazorpayOrder`/`verifyRazorpayPayment` (the Packages functions from
  before) are untouched.

### `firestore.indexes.json` — two composite indexes
- `listings` by `sellerId` + `createdAt` (added last round for My Listings).
- `listings` by `active` + `createdAt` (**new** — this is what
  `marketplace.html`'s browse query needs). Without this, the browse page
  will show the same "query requires an index" error My Listings hit —
  except this time it's expected and pre-empted rather than a surprise.

### Nav link added everywhere
Every page's header nav now includes a **Marketplace** link, positioned
right after Packages (same place it appears on `marketplace.html` itself).
This touched every HTML file in the site — that's the whole reason this
round's file list is so long, not because of hidden other changes.

### `style.css`
All-new CSS for the browse grid, cards, the listing-detail modal, and the
cart panel — appended after the existing My Listings styles, nothing
existing was changed or removed.

## What's still NOT built (next phase, whenever you're ready)
- Buyer order history ("My Orders" on the dashboard).
- Seller "my sales" view (so a founder can see what of THEIRS sold).
- Admin view of amounts owed per seller, for manual payout reconciliation.

## Deploy checklist
1. Copy every file in this folder over the matching path in your repo
   (`js/` had no changes this round — only `functions/` and the root HTML
   files + `style.css` + `firestore.indexes.json`).
2. Push to GitHub.
3. **Deploy the index**: either click the auto-generated link the first time
   `marketplace.html` throws the composite-index error in the console (same
   one-click fix as My Listings last time), or run
   `firebase deploy --only firestore:indexes` from Cloud Shell to apply
   `firestore.indexes.json` directly — either works, do whichever's easier.
4. **Redeploy Cloud Functions** — paste `functions/index.js` directly into
   Cloud Shell's own editor, then `firebase deploy --only functions`.
5. Test: browse `marketplace.html` signed out (should work, browsing only);
   try Add to Cart signed out (should redirect to sign in); sign in, add a
   couple of items, adjust quantities, remove one, then checkout with a
   real payment; confirm the order lands in Firestore `/orders` as `paid`,
   the cart empties afterward, and the confirmation email arrives at
   hello@ried.co.in.
