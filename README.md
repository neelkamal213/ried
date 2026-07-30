# v14 — Marketplace Buyer Order History + Seller Sales + Admin Payouts (2026-07-30)

This closes out the last item on Marketplace's original future-phases list
from all the way back at Tier 9: buyers can now see what they've bought,
sellers can see what they've sold (with what they need to fulfil it), and
you have a dedicated place to track and mark seller payouts.

I made a few judgment calls to keep this shippable in one round rather than
stopping to ask more questions — flagging them clearly here in case you'd
want any of them different:

1. **Buyer order history is for signed-in accounts only.** Marketplace
   still allows guest checkout with no account — a guest still only gets
   their confirmation email, there's no separate "look up my order" page.
   Building a secure guest-lookup page (email + order ID) is a reasonable
   follow-up if you want it, just extra scope I didn't take on unprompted.
2. **Sellers see the buyer's contact/shipping details** in their Sales
   view, since they need that to actually ship the product or deliver the
   service themselves.
3. **Payouts are tracked per item, not just a running total.** Each sale
   starts "Awaiting Payout"; you mark it "Paid Out" once you've actually
   sent that seller their money, so the owed amount stays accurate over
   time instead of just showing a lifetime total.

## What's new

### `my-orders.html` (new page) — buyer order history
Reachable via a new "My Orders" button on the dashboard's Marketplace card.
Shows every Marketplace purchase a signed-in account has made — date, order
ID, items, seller names, and the total paid.

### My Sales tab on `my-listings.html`
A second tab next to "My Listings" — every item a seller has sold, who
bought it, their delivery/contact details, and whether that sale has been
paid out to the seller yet. A summary at the top shows totals still owed
vs. already paid out.

### Marketplace Payouts on `admin-dashboard.html`
Every seller who's made a sale, grouped together, sorted so whoever's owed
the most is at the top. Each unpaid sale has a **Mark as Paid** button —
click it once you've actually transferred that seller their share, and it
moves from "owed" to "paid out" immediately.

## What changed under the hood
- **`functions/index.js`** — `createMarketplaceOrder` now also stores a
  `sellerIds` array on each order (so a seller's sales can be looked up
  directly) and a `payoutStatus: "pending"` flag on every line item. A
  brand-new function, `markSellerPayout`, is the ONLY way that ever changes
  to "paid" — it checks the caller is an actual admin (checks their
  `/users` doc's `role` field, the same check your Firestore rules already
  use) before touching anything, same as every other write to `/orders`
  being Cloud-Function-only.
- **`firestore.rules`** — one rule extended: a seller can now read an order
  if their uid appears in that order's `sellerIds` list (in addition to the
  existing buyer-owns-it and admin-reads-all rules). Nothing else changed —
  writes are still 100% blocked for every client, same as before.
- **No new Firestore indexes needed** — every new query in this round
  intentionally avoids Firestore's `orderBy` (which is what usually
  triggers the "query requires an index" error you've hit a few times
  before) and just sorts results in the browser instead, since the data
  per buyer/seller is small.
- **`dashboard.html`** — one new "My Orders" button.
- **`style.css`** — new styling for the tabs, sales cards, order cards, and
  the admin payout rows. Nothing existing was touched.

## Deploy checklist
1. Copy every file in this folder over the matching path in your repo
   (`my-orders.html` is brand new, the rest replace existing files).
2. Push to GitHub.
3. **Redeploy Cloud Functions** — required this time, since `markSellerPayout`
   is a new function and `createMarketplaceOrder` changed:
   ```
   rm -rf ~/ried
   git clone https://github.com/neelkamal213/ried.git ~/ried
   cd ~/ried/functions
   npm install
   ls node_modules | grep nodemailer
   ```
   (if that last command prints nothing, run `npm install nodemailer@6.9.14 --save`
   like before), then:
   ```
   cd ~/ried
   firebase deploy --only functions
   ```
4. **Publish the updated Firestore rules** — required this time too, since
   the `/orders` rule changed:
   ```
   firebase deploy --only firestore:rules,firestore:indexes
   ```
   (run this from the same `~/ried` folder as Step 3, no need to re-clone).
5. Test:
   - As a buyer with a real account: buy something from Marketplace, then
     go to Dashboard → My Orders and confirm it shows up.
   - As a seller: go to My Listings → My Sales and confirm a past sale
     shows up with the buyer's details and "Awaiting Payout".
   - As admin (Pramod/Neel account): go to the Admin Dashboard, find the
     Marketplace Payouts section, click "Mark as Paid" on a sale, and
     confirm it moves to paid — then check the seller's My Sales view
     again and confirm it now shows "Paid Out" there too.

## Still open after this round
Nothing else from Marketplace's original Tier 9 future-phases list remains
— buyer order history, seller sales view, and admin payout reconciliation
were the last three items on it.
