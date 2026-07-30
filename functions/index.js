/**
 * Cloud Functions for the RIED website.
 *
 * These two functions are what make the Razorpay checkout on packages.html
 * actually secure:
 *   - createRazorpayOrder: looks up the REAL price for a package on the
 *     server (never trusts a price sent from the browser), and asks
 *     Razorpay to create an order for that exact amount.
 *   - verifyRazorpayPayment: after checkout completes in the browser,
 *     re-checks Razorpay's cryptographic signature server-side before we
 *     ever treat a payment as "successful". This is the step a pure
 *     front-end integration cannot safely do, because it requires the
 *     Key Secret, which must never be shipped to the browser.
 *
 * Deploy with: firebase deploy --only functions
 * (See the deployment guide provided alongside this file for exact steps.)
 */

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const Razorpay = require("razorpay");
const crypto = require("crypto");
const nodemailer = require("nodemailer");

admin.initializeApp();
const db = admin.firestore();

const IS_INDIVIDUAL_VALUE = "Individual / No Company Yet";

// Stored as Firebase Functions secrets (never in this source file, never in git).
// Set once via:
//   firebase functions:secrets:set RAZORPAY_KEY_ID
//   firebase functions:secrets:set RAZORPAY_KEY_SECRET
const RAZORPAY_KEY_ID = defineSecret("RAZORPAY_KEY_ID");
const RAZORPAY_KEY_SECRET = defineSecret("RAZORPAY_KEY_SECRET");

// Gmail App Password for riedprivatelimited@gmail.com, used only to send the
// founder-profile notification email (see notifyOnProfileSubmit below). Set
// once via:
//   firebase functions:secrets:set GMAIL_APP_PASSWORD
// This is a 16-character App Password generated from that Google account's
// Security settings (2-Step Verification must be on first) — NOT the actual
// Gmail account password, and revocable independently at any time.
const GMAIL_APP_PASSWORD = defineSecret("GMAIL_APP_PASSWORD");
const GMAIL_SENDER = "riedprivatelimited@gmail.com";

// ---------------------------------------------------------------------------
// PACKAGE CATALOG — server-side source of truth for RIED's real service
// pricing, finalized 2026-07-30 after the Legal/Compliance/Scale-Up/IT
// team review. When pricing changes, update ONLY this object (and
// packages.html's displayed copy to match) — the checkout logic below
// never needs to change. Amounts are whole INR rupees; Razorpay wants
// paise (rupees * 100).
//
// billingType:
//   "onetime"      — a single Razorpay Order/Payment (createRazorpayOrder).
//   "subscription" — a recurring Razorpay Subscription, billed monthly
//                    (createScaleUpSubscription). minCycles is RIED's
//                    minimum-commitment term. Razorpay itself has no
//                    "minimum term then cancel anytime" primitive, so the
//                    subscription is created with a long total_count
//                    (SUBSCRIPTION_TOTAL_CYCLES below) that just keeps it
//                    auto-renewing — the minimum term is enforced by RIED's
//                    service agreement/terms, not by Razorpay technically.
//   "quote"        — no fixed price. submitQuoteRequest below just emails a
//                    lead to hello@ried.co.in; there is no payment at all.
// ---------------------------------------------------------------------------
const SUBSCRIPTION_TOTAL_CYCLES = 120; // 10 years of monthly billing — a practical stand-in for "renews until cancelled," since Razorpay requires a finite total_count.

const PACKAGE_CATALOG = {
  "incorporation-basic": {
    name: "Incorporation — Basic",
    billingType: "onetime",
    amount: 45000
  },
  "incorporation-standard": {
    name: "Incorporation — Standard",
    billingType: "onetime",
    amount: 55000
  },
  "incorporation-premium": {
    name: "Incorporation — Premium",
    billingType: "onetime",
    amount: 100000
  },
  "legal-startup": {
    name: "Legal Services — Startup Package",
    billingType: "onetime",
    amount: 80000
  },
  "legal-retainer": {
    name: "Legal Services — Legal Retainer (3-Month Minimum)",
    billingType: "onetime",
    amount: 180000
  },
  "legal-investment": {
    name: "Legal Services — Investment Contract",
    billingType: "onetime",
    amount: 275000
  },
  "scaleup-basic": {
    name: "Scale-Up & Grant Readiness — Basic",
    billingType: "subscription",
    amount: 10000,
    minCycles: 3
  },
  "scaleup-standard": {
    name: "Scale-Up & Grant Readiness — Standard",
    billingType: "subscription",
    amount: 12000,
    minCycles: 6
  },
  "scaleup-premium": {
    name: "Scale-Up & Grant Readiness — Premium",
    billingType: "subscription",
    amount: 15000,
    minCycles: 12
  },
  "it-basic": {
    name: "IT & Infra Set-Up — Basic",
    billingType: "onetime",
    amount: 40000
  },
  "it-standard": {
    name: "IT & Infra Set-Up — Standard",
    billingType: "quote"
  },
  "it-premium": {
    name: "IT & Infra Set-Up — Premium",
    billingType: "quote"
  }
};

// Shared by createRazorpayOrder and createScaleUpSubscription — the
// business/delivery details collected on packages.html right before
// payment. Validated for presence here (never trust the client alone),
// then stored on the order/subscription record and included in the
// confirmation email so RIED has what it needs to actually kick off the
// work. companyName/gstin are deliberately optional — many Incorporation
// buyers don't have a registered company or GSTIN yet, that's the whole
// point of the service.
function extractBusinessInfo(raw) {
  const r = raw || {};
  const info = {
    name: String(r.name || "").trim(),
    email: String(r.email || "").trim(),
    phone: String(r.phone || "").trim(),
    altPhone: String(r.altPhone || "").trim(),
    address: String(r.address || "").trim(),
    landmark: String(r.landmark || "").trim(),
    pincode: String(r.pincode || "").trim(),
    companyName: String(r.companyName || "").trim(),
    gstin: String(r.gstin || "").trim()
  };
  if (!info.name || !info.email || !info.phone || !info.address || !info.pincode) {
    throw new HttpsError("invalid-argument", "Please fill in Name, Email, Phone, Address and Pincode before continuing to payment.");
  }
  return info;
}

exports.createRazorpayOrder = onCall(
  { secrets: [RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET] },
  async (request) => {
    // Purchases require a signed-in RIED account. packages.html also checks
    // this client-side first (for a fast, friendly message), but that check
    // alone could be bypassed — this is the authoritative enforcement.
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Please sign in to purchase a package.");
    }

    const packageId = request.data && request.data.packageId;
    const pkg = PACKAGE_CATALOG[packageId];

    if (!pkg || pkg.billingType !== "onetime") {
      throw new HttpsError("invalid-argument", "Unknown package selected.");
    }

    const businessInfo = extractBusinessInfo(request.data && request.data.businessInfo);

    const razorpay = new Razorpay({
      key_id: RAZORPAY_KEY_ID.value(),
      key_secret: RAZORPAY_KEY_SECRET.value()
    });

    const order = await razorpay.orders.create({
      amount: pkg.amount * 100, // paise
      currency: "INR",
      notes: {
        packageId,
        packageName: pkg.name,
        uid: request.auth.uid
      }
    });

    // Record the attempt before payment completes, so we have a record even
    // if the user closes the tab mid-checkout.
    await db.collection("orders").doc(order.id).set({
      type: "package",
      packageId,
      packageName: pkg.name,
      amount: pkg.amount,
      status: "created",
      uid: request.auth.uid,
      businessInfo,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return {
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: RAZORPAY_KEY_ID.value(),
      packageName: pkg.name
    };
  }
);

exports.verifyRazorpayPayment = onCall(
  { secrets: [RAZORPAY_KEY_SECRET, GMAIL_APP_PASSWORD] },
  async (request) => {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = request.data || {};

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      throw new HttpsError("invalid-argument", "Missing payment verification fields.");
    }

    const expectedSignature = crypto
      .createHmac("sha256", RAZORPAY_KEY_SECRET.value())
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    const verified = expectedSignature === razorpay_signature;

    await db.collection("orders").doc(razorpay_order_id).set(
      {
        status: verified ? "paid" : "verification_failed",
        paymentId: razorpay_payment_id,
        verifiedAt: admin.firestore.FieldValue.serverTimestamp()
      },
      { merge: true }
    );

    if (!verified) {
      throw new HttpsError("permission-denied", "Payment signature could not be verified.");
    }

    // Notify hello@ried.co.in of the confirmed purchase — item, buyer, amount.
    // Best-effort: a failure here must never make an already-confirmed
    // payment look like it failed to the person who just paid.
    try {
      const orderSnap = await db.collection("orders").doc(razorpay_order_id).get();
      const order = orderSnap.exists ? orderSnap.data() : {};

      let buyerEmail = "unknown";
      let buyerName = "";
      if (order.uid) {
        try {
          const userRecord = await admin.auth().getUser(order.uid);
          buyerEmail = userRecord.email || buyerEmail;
          buyerName = userRecord.displayName || "";
        } catch (e) {
          logger.error("verifyRazorpayPayment: could not look up buyer for notification email", e);
        }
      }

      const info = order.businessInfo || {};
      const displayName = info.name || buyerName || "";
      const displayEmail = info.email || buyerEmail;

      const transporter = nodemailer.createTransport({
        host: "smtp.gmail.com",
        port: 465,
        secure: true,
        auth: {
          user: GMAIL_SENDER,
          pass: GMAIL_APP_PASSWORD.value()
        }
      });

      const lines = [
        "A payment has been confirmed on the RIED website.",
        "",
        `Item Purchased: ${order.packageName || order.packageId || "Unknown package"}`,
        `Amount Paid: Rs. ${order.amount != null ? order.amount : "?"}`,
        `Purchased By: ${displayName ? displayName + " " : ""}(${displayEmail})`,
        `User Account UID: ${order.uid || "unknown"}`,
        "",
        "--- Business / Contact Details ---",
        `Name: ${info.name || ""}`,
        `Company / Startup: ${info.companyName || "(not provided)"}`,
        `GSTIN: ${info.gstin || "(not provided)"}`,
        `Email: ${info.email || ""}`,
        `Phone: ${info.phone || ""}`,
        `Alternate Phone: ${info.altPhone || "(none)"}`,
        `Address: ${info.address || ""}`,
        `Landmark: ${info.landmark || "(none)"}`,
        `Pincode: ${info.pincode || ""}`,
        "",
        `Razorpay Order ID: ${razorpay_order_id}`,
        `Razorpay Payment ID: ${razorpay_payment_id}`
      ];

      await sendMail(transporter, {
        to: "hello@ried.co.in",
        replyTo: displayEmail !== "unknown" ? displayEmail : undefined,
        subject: `Purchase Confirmed — ${order.packageName || order.packageId || ""}`,
        text: lines.join("\n")
      });
    } catch (e) {
      logger.error("verifyRazorpayPayment: failed to send purchase notification email", e);
    }

    return { verified: true };
  }
);

/**
 * createScaleUpSubscription / verifyScaleUpSubscription
 *
 * The Scale-Up & Grant Readiness packages are billed monthly as real
 * recurring Razorpay Subscriptions (per RIED's explicit choice), not
 * one-time Orders like everything else on this page. A Razorpay "Plan"
 * (how much, how often) is created once per tier and cached in Firestore
 * at /config/razorpayPlans so repeat subscribers reuse the same Plan
 * rather than creating a new one every checkout; a fresh "Subscription"
 * (one specific customer's recurring commitment against that Plan) is
 * created per purchase.
 */
exports.createScaleUpSubscription = onCall(
  { secrets: [RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET] },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Please sign in to subscribe to a package.");
    }

    const packageId = request.data && request.data.packageId;
    const pkg = PACKAGE_CATALOG[packageId];

    if (!pkg || pkg.billingType !== "subscription") {
      throw new HttpsError("invalid-argument", "Unknown package selected.");
    }

    const businessInfo = extractBusinessInfo(request.data && request.data.businessInfo);

    const razorpay = new Razorpay({
      key_id: RAZORPAY_KEY_ID.value(),
      key_secret: RAZORPAY_KEY_SECRET.value()
    });

    const planConfigRef = db.collection("config").doc("razorpayPlans");
    const planConfigSnap = await planConfigRef.get();
    let planId = planConfigSnap.exists ? planConfigSnap.data()[packageId] : null;

    if (!planId) {
      const plan = await razorpay.plans.create({
        period: "monthly",
        interval: 1,
        item: {
          name: pkg.name,
          amount: pkg.amount * 100,
          currency: "INR"
        },
        notes: { packageId }
      });
      planId = plan.id;
      await planConfigRef.set({ [packageId]: planId }, { merge: true });
    }

    const subscription = await razorpay.subscriptions.create({
      plan_id: planId,
      customer_notify: 1,
      total_count: SUBSCRIPTION_TOTAL_CYCLES,
      notes: {
        packageId,
        packageName: pkg.name,
        uid: request.auth.uid,
        minCycles: String(pkg.minCycles)
      }
    });

    await db.collection("orders").doc(subscription.id).set({
      type: "scaleup-subscription",
      packageId,
      packageName: pkg.name,
      amount: pkg.amount,
      minCycles: pkg.minCycles,
      status: "created",
      uid: request.auth.uid,
      businessInfo,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return {
      subscriptionId: subscription.id,
      keyId: RAZORPAY_KEY_ID.value(),
      packageName: pkg.name,
      amount: pkg.amount,
      minCycles: pkg.minCycles
    };
  }
);

exports.verifyScaleUpSubscription = onCall(
  { secrets: [RAZORPAY_KEY_SECRET, GMAIL_APP_PASSWORD] },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Please sign in.");
    }

    const { razorpay_payment_id, razorpay_subscription_id, razorpay_signature } = request.data || {};
    if (!razorpay_payment_id || !razorpay_subscription_id || !razorpay_signature) {
      throw new HttpsError("invalid-argument", "Missing subscription verification fields.");
    }

    // Subscription signatures are computed differently from one-time Orders:
    // HMAC of "payment_id|subscription_id" (NOT "order_id|payment_id").
    const expectedSignature = crypto
      .createHmac("sha256", RAZORPAY_KEY_SECRET.value())
      .update(`${razorpay_payment_id}|${razorpay_subscription_id}`)
      .digest("hex");
    const verified = expectedSignature === razorpay_signature;

    const orderRef = db.collection("orders").doc(razorpay_subscription_id);
    const orderSnap = await orderRef.get();
    const order = orderSnap.exists ? orderSnap.data() : {};

    if (order.uid && order.uid !== request.auth.uid) {
      throw new HttpsError("permission-denied", "This subscription does not belong to your account.");
    }

    await orderRef.set(
      {
        status: verified ? "active" : "verification_failed",
        paymentId: razorpay_payment_id,
        verifiedAt: admin.firestore.FieldValue.serverTimestamp()
      },
      { merge: true }
    );

    if (!verified) {
      throw new HttpsError("permission-denied", "Payment signature could not be verified.");
    }

    // Notify hello@ried.co.in — best-effort, same as every other confirmation
    // email on this site. IMPORTANT: this only fires for the FIRST payment on
    // a new subscription. There is no webhook wired up yet to notify RIED of
    // the automatic monthly renewal charges Razorpay will keep making after
    // this — those show up in the Razorpay Dashboard's Subscriptions tab, but
    // not via email, until a webhook handler is added in a future round.
    try {
      const transporter = nodemailer.createTransport({
        host: "smtp.gmail.com",
        port: 465,
        secure: true,
        auth: { user: GMAIL_SENDER, pass: GMAIL_APP_PASSWORD.value() }
      });

      const info = order.businessInfo || {};
      const lines = [
        "A new Scale-Up & Grant Readiness subscription has started on the RIED website.",
        "",
        `Package: ${order.packageName || order.packageId || "Unknown package"}`,
        `Monthly Amount: Rs. ${order.amount != null ? order.amount : "?"} / month`,
        `Minimum Commitment: ${order.minCycles || "?"} months`,
        `User Account UID: ${request.auth.uid}`,
        "",
        "--- Business / Contact Details ---",
        `Name: ${info.name || ""}`,
        `Company / Startup: ${info.companyName || "(not provided)"}`,
        `GSTIN: ${info.gstin || "(not provided)"}`,
        `Email: ${info.email || ""}`,
        `Phone: ${info.phone || ""}`,
        `Alternate Phone: ${info.altPhone || "(none)"}`,
        `Address: ${info.address || ""}`,
        `Landmark: ${info.landmark || "(none)"}`,
        `Pincode: ${info.pincode || ""}`,
        "",
        `Razorpay Subscription ID: ${razorpay_subscription_id}`,
        `Razorpay Payment ID (first charge): ${razorpay_payment_id}`,
        "",
        "Note: only the FIRST monthly charge triggers this email. Subsequent auto-renewal charges are visible in the Razorpay Dashboard's Subscriptions tab, not emailed here yet — a webhook can be added in a future round if you'd like renewal notifications too."
      ];

      await sendMail(transporter, {
        to: "hello@ried.co.in",
        replyTo: info.email || undefined,
        subject: `New Subscription Started — ${order.packageName || order.packageId || ""}`,
        text: lines.join("\n")
      });
    } catch (e) {
      logger.error("verifyScaleUpSubscription: failed to send notification email", e);
    }

    return { verified: true };
  }
);

/**
 * submitQuoteRequest
 *
 * IT & Infra Set-Up's Standard/Premium tiers have no fixed price ("Get
 * Quote") — there's nothing for Razorpay to charge, so this just captures
 * a lead (name/email/phone/company/notes) and emails it straight to
 * hello@ried.co.in. Unlike the payment-confirmation emails above, this
 * email IS the entire point of the action, so unlike those (best-effort,
 * never fail an already-successful payment) a failure here is surfaced
 * back to the user as a real error rather than swallowed.
 */
exports.submitQuoteRequest = onCall(
  { secrets: [GMAIL_APP_PASSWORD] },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Please sign in to request a quote.");
    }

    const packageId = request.data && request.data.packageId;
    const pkg = PACKAGE_CATALOG[packageId];
    if (!pkg || pkg.billingType !== "quote") {
      throw new HttpsError("invalid-argument", "Unknown package selected.");
    }

    const raw = (request.data && request.data.lead) || {};
    const lead = {
      name: String(raw.name || "").trim(),
      email: String(raw.email || "").trim(),
      phone: String(raw.phone || "").trim(),
      companyName: String(raw.companyName || "").trim(),
      notes: String(raw.notes || "").trim()
    };
    if (!lead.name || !lead.email || !lead.phone) {
      throw new HttpsError("invalid-argument", "Please fill in Name, Email and Phone before requesting a quote.");
    }

    try {
      const transporter = nodemailer.createTransport({
        host: "smtp.gmail.com",
        port: 465,
        secure: true,
        auth: { user: GMAIL_SENDER, pass: GMAIL_APP_PASSWORD.value() }
      });

      const lines = [
        "A new quote request has been submitted on the RIED website.",
        "",
        `Package: ${pkg.name}`,
        `Name: ${lead.name}`,
        `Company / Startup: ${lead.companyName || "(not provided)"}`,
        `Email: ${lead.email}`,
        `Phone: ${lead.phone}`,
        `User Account UID: ${request.auth.uid}`,
        "",
        "--- Notes / Requirements ---",
        lead.notes || "(none provided)"
      ];

      await sendMail(transporter, {
        to: "hello@ried.co.in",
        replyTo: lead.email,
        subject: `Quote Request — ${pkg.name}`,
        text: lines.join("\n")
      });
    } catch (e) {
      logger.error("submitQuoteRequest: failed to send quote request email", e);
      throw new HttpsError("internal", "Could not send your quote request — please try again, or email hello@ried.co.in directly.");
    }

    return { submitted: true };
  }
);

/**
 * createMarketplaceOrder / verifyMarketplacePayment
 *
 * The Marketplace equivalent of createRazorpayOrder/verifyRazorpayPayment
 * above, for cart checkout on marketplace.html instead of a single package.
 * Same security pattern: the server always reads the CALLER's own cart
 * (/carts/{uid}) and each listing's REAL price from Firestore — it never
 * trusts a client-sent price or item list. Per the payout model on file
 * (RIED collects all Marketplace payments centrally, then pays sellers out
 * manually — no Razorpay Route/linked-account splitting), this is a single
 * combined payment for the whole cart regardless of how many sellers are
 * involved; each line item still records its own sellerId/sellerName/price
 * so RIED can reconcile who's owed what.
 */
exports.createMarketplaceOrder = onCall(
  { secrets: [RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET] },
  async (request) => {
    // Marketplace checkout never requires a real RIED account — the client
    // (marketplace.html) transparently signs every buyer in anonymously
    // (Firebase Anonymous Auth) before ever calling this function, purely so
    // there's a stable uid to key the cart/order off of. So request.auth
    // should always be present by the time we get here; if it's genuinely
    // missing, something client-side went wrong (e.g. anonymous sign-in
    // failed or Anonymous Auth isn't enabled in the Firebase Console yet).
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Could not start checkout — please refresh the page and try again.");
    }
    const uid = request.auth.uid;

    const cartSnap = await db.collection("carts").doc(uid).get();
    const cartItems = (cartSnap.exists && Array.isArray(cartSnap.data().items)) ? cartSnap.data().items : [];
    if (!cartItems.length) {
      throw new HttpsError("failed-precondition", "Your cart is empty.");
    }

    // Delivery/contact details, collected on marketplace.html right before
    // payment. Validated for presence here (never trust the client alone),
    // then stored on the order and included in the confirmation email so
    // RIED/sellers have what they need to actually fulfil the order.
    const shippingInfoRaw = (request.data && request.data.shippingInfo) || {};
    const shippingInfo = {
      name: String(shippingInfoRaw.name || "").trim(),
      email: String(shippingInfoRaw.email || "").trim(),
      phone: String(shippingInfoRaw.phone || "").trim(),
      altPhone: String(shippingInfoRaw.altPhone || "").trim(),
      address: String(shippingInfoRaw.address || "").trim(),
      landmark: String(shippingInfoRaw.landmark || "").trim(),
      pincode: String(shippingInfoRaw.pincode || "").trim()
    };
    if (!shippingInfo.name || !shippingInfo.email || !shippingInfo.phone || !shippingInfo.address || !shippingInfo.pincode) {
      throw new HttpsError("invalid-argument", "Please fill in Name, Email, Phone, Address and Pincode before checking out.");
    }

    const lineItems = [];
    let total = 0;
    for (const ci of cartItems) {
      const qty = Math.max(1, Math.floor(Number(ci.qty) || 1));
      const listingSnap = await db.collection("listings").doc(String(ci.listingId)).get();
      // Skip anything deleted or paused since it was added to the cart —
      // never trust the cart's own snapshot of price/availability.
      if (!listingSnap.exists || listingSnap.data().active !== true) continue;

      const listing = listingSnap.data();
      const price = Number(listing.price) || 0;
      const lineTotal = price * qty;
      total += lineTotal;
      lineItems.push({
        listingId: ci.listingId,
        sellerId: listing.sellerId || null,
        sellerName: listing.sellerName || "",
        title: listing.title || "",
        price,
        qty,
        lineTotal
      });
    }

    if (!lineItems.length) {
      throw new HttpsError("failed-precondition", "None of the items in your cart are available anymore. Please refresh the Marketplace page.");
    }

    const razorpay = new Razorpay({
      key_id: RAZORPAY_KEY_ID.value(),
      key_secret: RAZORPAY_KEY_SECRET.value()
    });

    const order = await razorpay.orders.create({
      amount: total * 100, // paise
      currency: "INR",
      notes: { uid, kind: "marketplace" }
    });

    await db.collection("orders").doc(order.id).set({
      type: "marketplace",
      uid,
      items: lineItems,
      amount: total,
      status: "created",
      shippingInfo,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return {
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: RAZORPAY_KEY_ID.value(),
      items: lineItems,
      total
    };
  }
);

exports.verifyMarketplacePayment = onCall(
  { secrets: [RAZORPAY_KEY_SECRET, GMAIL_APP_PASSWORD] },
  async (request) => {
    // Same note as createMarketplaceOrder above — Marketplace buyers are
    // always at least anonymously authenticated by this point, real account
    // or not, so this should only ever fire on a genuine client-side error.
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Could not confirm your payment — please refresh the page and try again.");
    }

    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = request.data || {};
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      throw new HttpsError("invalid-argument", "Missing payment verification fields.");
    }

    const expectedSignature = crypto
      .createHmac("sha256", RAZORPAY_KEY_SECRET.value())
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");
    const verified = expectedSignature === razorpay_signature;

    const orderRef = db.collection("orders").doc(razorpay_order_id);
    const orderSnap = await orderRef.get();
    const order = orderSnap.exists ? orderSnap.data() : {};

    // Extra check specific to Marketplace orders (multiple sellers/buyers
    // involved, so worth being stricter here): only the buyer who actually
    // created this order may verify/finalize it.
    if (order.uid && order.uid !== request.auth.uid) {
      throw new HttpsError("permission-denied", "This order does not belong to your account.");
    }

    await orderRef.set(
      {
        status: verified ? "paid" : "verification_failed",
        paymentId: razorpay_payment_id,
        verifiedAt: admin.firestore.FieldValue.serverTimestamp()
      },
      { merge: true }
    );

    if (!verified) {
      throw new HttpsError("permission-denied", "Payment signature could not be verified.");
    }

    // Checkout succeeded — clear the buyer's cart so they don't see a stale
    // one next visit or accidentally re-buy the same items.
    await db.collection("carts").doc(request.auth.uid).set(
      { items: [], updatedAt: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );

    // Notify hello@ried.co.in — best-effort, same Gmail-SMTP pattern as
    // verifyRazorpayPayment above. A failure here must never make an
    // already-confirmed payment look like it failed to the buyer.
    try {
      // Marketplace buyers are now usually anonymous guests (no code, name,
      // or email on the Auth account itself) — so the delivery/contact
      // details collected at checkout (order.shippingInfo) are the reliable
      // source of the buyer's real name/email, not the Auth account lookup
      // below. Still attempt the Auth lookup for the (now less common) case
      // of a buyer who was actually signed in to a real RIED account.
      let buyerEmail = "unknown";
      let buyerName = "";
      let buyerIsGuest = true;
      try {
        const userRecord = await admin.auth().getUser(request.auth.uid);
        buyerIsGuest = !userRecord.email; // anonymous accounts never have an email
        buyerEmail = userRecord.email || buyerEmail;
        buyerName = userRecord.displayName || "";
      } catch (e) {
        logger.error("verifyMarketplacePayment: could not look up buyer for notification email", e);
      }

      const ship = order.shippingInfo || {};
      const displayName = ship.name || buyerName || "";
      const displayEmail = ship.email || buyerEmail;

      const transporter = nodemailer.createTransport({
        host: "smtp.gmail.com",
        port: 465,
        secure: true,
        auth: {
          user: GMAIL_SENDER,
          pass: GMAIL_APP_PASSWORD.value()
        }
      });

      const items = Array.isArray(order.items) ? order.items : [];
      const lines = [
        "A Marketplace payment has been confirmed on the RIED website.",
        "",
        `Purchased By: ${displayName ? displayName + " " : ""}(${displayEmail})`,
        `Account Type: ${buyerIsGuest ? "Guest checkout (no RIED account)" : "Signed-in RIED account"}`,
        `User Account UID: ${request.auth.uid}`,
        `Total Paid: Rs. ${order.amount != null ? order.amount : "?"}`,
        "",
        "--- Items ---"
      ];
      items.forEach((it) => {
        lines.push(`${it.title} — Qty ${it.qty} x Rs.${it.price} = Rs.${it.lineTotal} (Seller: ${it.sellerName || it.sellerId || "unknown"})`);
      });

      lines.push("");
      lines.push("--- Delivery / Contact Details ---");
      lines.push(`Name: ${ship.name || ""}`);
      lines.push(`Email: ${ship.email || ""}`);
      lines.push(`Phone: ${ship.phone || ""}`);
      lines.push(`Alternate Phone: ${ship.altPhone || "(none)"}`);
      lines.push(`Address: ${ship.address || ""}`);
      lines.push(`Landmark: ${ship.landmark || "(none)"}`);
      lines.push(`Pincode: ${ship.pincode || ""}`);

      lines.push("");
      lines.push(`Razorpay Order ID: ${razorpay_order_id}`);
      lines.push(`Razorpay Payment ID: ${razorpay_payment_id}`);
      lines.push("");
      lines.push("Reminder: RIED collects Marketplace payments centrally — sellers still need to be paid out manually per the payout model on file.");

      await sendMail(transporter, {
        to: "hello@ried.co.in",
        replyTo: displayEmail !== "unknown" ? displayEmail : undefined,
        subject: `Marketplace Purchase Confirmed — ${displayName || displayEmail}`,
        text: lines.join("\n")
      });
    } catch (e) {
      logger.error("verifyMarketplacePayment: failed to send purchase notification email", e);
    }

    return { verified: true };
  }
);

/**
 * notifyOnProfileSubmit
 *
 * Fires whenever a founder's onboarding profile (profile-setup.html) is
 * created OR resubmitted after an edit — /profiles/{uid} in Firestore.
 * Builds a plain-text summary of everything the founder entered and emails
 * it to hello@ried.co.in via Gmail SMTP (riedprivatelimited@gmail.com,
 * authenticated with an App Password stored as a secret — see
 * GMAIL_APP_PASSWORD above), using nodemailer. The logo (if one was
 * uploaded) is included as a link in the email body.
 *
 * NOTE: this originally tried Web3Forms (same service contact.html's Idea
 * form uses) since that was already wired up elsewhere on the site. That
 * doesn't work here: Web3Forms's API is explicitly designed to be called
 * from a browser only — server-to-server calls (like this Cloud Function)
 * get blocked by a Cloudflare bot-challenge in front of their endpoint,
 * confirmed in their own docs ("you must add your server IP to our
 * Safelist AND have an active Paid subscription" for server-side use).
 * Gmail SMTP has no such restriction for a real Google account.
 *
 * We only actually send when `submittedAt` changes between before/after —
 * that's the field the wizard's submitProfile() always refreshes with a
 * fresh server timestamp, so it uniquely marks "the founder just hit
 * Submit," as opposed to some other future write to this same document
 * (e.g. a Flywheel stage update) that shouldn't re-trigger an email.
 *
 * This same trigger ALSO watches for `advancementRequestedAt` changing —
 * that's the field dashboard.html's "Request to Advance" button always
 * refreshes with a fresh server timestamp when a founder asks to move to
 * the next Flywheel stage (Problem Discovery → Research Translation →
 * Enterprise Build → Complete). When that happens we send RIED a separate,
 * shorter email so Pramod/Neel know to review it in the admin dashboard —
 * reusing the same Eventarc trigger/transporter rather than standing up a
 * second 2nd-gen Firestore trigger (each first-ever trigger of a given kind
 * needs its own Eventarc warm-up, so it's simplest to keep this to one).
 */
function sendMail(transporter, { to, subject, text, replyTo }) {
  return transporter.sendMail({
    from: `"RIED Website — Founder Profile" <${GMAIL_SENDER}>`,
    to,
    replyTo: replyTo || undefined,
    subject,
    text
  });
}

exports.notifyOnProfileSubmit = onDocumentWritten(
  { document: "profiles/{uid}", secrets: [GMAIL_APP_PASSWORD] },
  async (event) => {
    const afterSnap = event.data.after;
    if (!afterSnap.exists) return; // profile deleted — nothing to notify

    const after = afterSnap.data();
    const beforeSnap = event.data.before;
    const before = beforeSnap.exists ? beforeSnap.data() : null;

    const afterTs = after.submittedAt ? after.submittedAt.toMillis() : null;
    const beforeTs = before && before.submittedAt ? before.submittedAt.toMillis() : null;
    const isNewSubmission = !!afterTs && afterTs !== beforeTs;

    const afterAdvTs = after.advancementRequestedAt ? after.advancementRequestedAt.toMillis() : null;
    const beforeAdvTs = before && before.advancementRequestedAt ? before.advancementRequestedAt.toMillis() : null;
    const isNewAdvancementRequest = !!afterAdvTs && afterAdvTs !== beforeAdvTs && after.pendingAdvancement === true;

    if (!isNewSubmission && !isNewAdvancementRequest) return;

    const uid = event.params.uid;

    const transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: {
        user: GMAIL_SENDER,
        pass: GMAIL_APP_PASSWORD.value()
      }
    });

    if (isNewAdvancementRequest) {
      const stageKey = after.advancementRequestedStage || "";
      const stageProgress = (after.stageProgress && after.stageProgress[stageKey]) || {};
      const answers = Array.isArray(stageProgress.answers) ? stageProgress.answers : [];
      const advLines = [];
      advLines.push(`A founder has requested to advance past the "${stageKey}" Flywheel stage.`);
      advLines.push("");
      advLines.push(`Name: ${after.fullName || ""}`);
      advLines.push(`Brand Name: ${after.brandName || ""}`);
      advLines.push(`Email: ${after.email || ""}`);
      advLines.push(`Stage: ${stageKey}`);
      advLines.push("");
      if (answers.length) {
        advLines.push(`--- ${stageKey} Answers ---`);
        answers.forEach((qa, i) => {
          advLines.push(`${i + 1}. ${qa.question}`);
          advLines.push(`   ${qa.answer || "(no answer)"}`);
          advLines.push("");
        });
      }
      advLines.push("Review and approve in the RIED admin dashboard (admin-dashboard.html).");
      advLines.push(`Profile UID: ${uid}`);

      try {
        await sendMail(transporter, {
          to: "hello@ried.co.in",
          replyTo: after.email,
          subject: `Advancement Requested (${stageKey}) — ${after.fullName || after.email || uid}`,
          text: advLines.join("\n")
        });
      } catch (e) {
        logger.error("notifyOnProfileSubmit: failed to send advancement-request email", e);
      }
    }

    if (!isNewSubmission) return;
    const isEdit = !!before;
    const isIndividual = after.entityType === IS_INDIVIDUAL_VALUE;

    const lines = [];
    lines.push(`Founder Profile ${isEdit ? "Updated" : "Submitted"} — RIED Website`);
    lines.push("");
    lines.push(`Name: ${after.fullName || ""}`);
    lines.push(`Brand Name: ${after.brandName || ""}`);
    lines.push(`Email: ${after.email || ""}`);
    lines.push(`Entity Type: ${after.entityType === "Others" ? after.entityTypeOther : after.entityType || ""}`);
    lines.push(`Phase: ${after.companyPhase || ""}`);
    lines.push(`Domain: ${after.domain === "Something else..." ? after.domainOther : after.domain || ""}`);

    if (!isIndividual) {
      lines.push("");
      lines.push("--- Company Details ---");
      lines.push(`Registered Address: ${after.registeredAddress || ""}`);
      lines.push(`Total Shareholders: ${after.totalShareholders || ""}`);
      lines.push(`CIN: ${after.cin || ""}`);
      lines.push(`GST No.: ${after.gstNo || ""}`);
      lines.push("");
      lines.push("--- Authorised Signatory ---");
      lines.push(`Name: ${after.signatoryName || ""}`);
      lines.push(`Designation: ${after.signatoryDesignation || ""}`);
      lines.push(`Phone: ${after.signatoryPhone || ""}`);
      lines.push(`Email: ${after.signatoryEmail || ""}`);
      lines.push("");
      lines.push("--- Point of Contact ---");
      lines.push(`Name: ${after.pocName || ""}`);
      lines.push(`Designation: ${after.pocDesignation || ""}`);
      lines.push(`Phone: ${after.pocPhone || ""}`);
      lines.push(`Email: ${after.pocEmail || ""}`);
    } else if (Array.isArray(after.founderAnswers)) {
      lines.push("");
      lines.push("--- Founder Discovery Answers ---");
      after.founderAnswers.forEach((qa, i) => {
        lines.push(`${i + 1}. ${qa.question}`);
        lines.push(`   ${qa.answer || "(no answer)"}`);
        lines.push("");
      });
    }

    if (after.additionalInfo) {
      lines.push("--- Anything Else ---");
      lines.push(after.additionalInfo);
      lines.push("");
    }

    // Link the logo rather than attaching it as a file — keeps the email
    // simple and avoids any attachment-size/type edge cases.
    if (after.logoURL) {
      lines.push(`Logo: ${after.logoURL}`);
    }

    lines.push(`Flywheel Stage: ${after.flywheelStage || "founder-discovery"}`);
    lines.push(`Profile UID: ${uid}`);

    const message = lines.join("\n");
    const subject = `${isEdit ? "Updated" : "New"} Founder Profile — ${after.fullName || after.email || uid}`;

    try {
      await sendMail(transporter, {
        to: "hello@ried.co.in",
        replyTo: after.email,
        subject,
        text: message
      });
    } catch (e) {
      logger.error("notifyOnProfileSubmit: failed to send email", e);
    }
  }
);
