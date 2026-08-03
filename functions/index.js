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

const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
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

// Set once via: firebase functions:secrets:set RAZORPAY_WEBHOOK_SECRET
// This is a value YOU make up when creating the webhook in the Razorpay
// Dashboard (Settings -> Webhooks) — NOT the same as RAZORPAY_KEY_SECRET
// above. Razorpay signs every webhook request it sends us with this same
// value so razorpayWebhook (below) can verify the request genuinely came
// from Razorpay and wasn't forged.
const RAZORPAY_WEBHOOK_SECRET = defineSecret("RAZORPAY_WEBHOOK_SECRET");

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

// ---------------------------------------------------------------------------
// Scale-Up subscription renewal tracking — shared by verifyScaleUpSubscription
// (first charge), razorpayWebhook (every charge after that, plus failures),
// and checkOverdueRenewals (the daily reminder/escalation sweep). See the
// big comment above razorpayWebhook below for the full picture.
// ---------------------------------------------------------------------------
const REMINDER_INTERVAL_DAYS = 3; // how often the client gets re-reminded while a renewal is stuck pending
const RIED_ALERT_DAY_OF_MONTH = 5; // if a subscription still hasn't been charged by this day of the month, RIED gets an overdue alert

function monthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function daysBetween(a, b) {
  return Math.abs(a.getTime() - b.getTime()) / (1000 * 60 * 60 * 24);
}

// Shared admin check for onCall functions that should only ever be usable by
// RIED staff (mirrors the exact same "/users/{uid}.role === admin" check
// firestore.rules already uses for admin-only reads). Throws if the caller
// isn't signed in or isn't an admin — callers should let this propagate.
async function requireAdmin(uid) {
  if (!uid) {
    throw new HttpsError("unauthenticated", "Please sign in.");
  }
  const userSnap = await db.collection("users").doc(uid).get();
  if (!userSnap.exists || userSnap.data().role !== "admin") {
    throw new HttpsError("permission-denied", "Admin access required.");
  }
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
        verifiedAt: admin.firestore.FieldValue.serverTimestamp(),
        // Seed the renewal-tracking fields with this first charge, so
        // checkOverdueRenewals (below) doesn't mistake month 1 for an unpaid
        // month before razorpayWebhook has ever fired for this subscription.
        ...(verified
          ? {
              renewalStatus: "ok",
              lastChargeAt: admin.firestore.FieldValue.serverTimestamp(),
              lastChargeMonth: monthKey(new Date()),
              lastChargePaymentId: razorpay_payment_id
            }
          : {})
      },
      { merge: true }
    );

    if (!verified) {
      throw new HttpsError("permission-denied", "Payment signature could not be verified.");
    }

    // Notify hello@ried.co.in — best-effort, same as every other confirmation
    // email on this site. IMPORTANT: this only fires for the FIRST payment on
    // a new subscription. Every renewal charge after this one is handled by
    // razorpayWebhook below (subscription.charged), which is what actually
    // notifies RIED and the client of month 2, 3, etc.
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
        "Note: this email only covers the first charge. Every renewal after this sends its own \"Renewal Payment Received\" email (to you and the client), and a reminder/overdue-alert flow kicks in automatically if a renewal payment fails — see razorpayWebhook and checkOverdueRenewals in functions/index.js."
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
        lineTotal,
        // Every sale starts "owed" — only markSellerPayout (below) ever
        // flips this to "paid", once RIED has actually sent the seller
        // their share (payouts are collected centrally and paid out
        // manually, per the Marketplace payout model decided at Tier 9).
        payoutStatus: "pending"
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

    // Deduped list of every seller who has an item in this order — denormalized
    // onto the order doc so a seller can query "orders I sold into" directly
    // via where('sellerIds','array-contains',uid), without needing a
    // composite index or scanning every order's items array client-side.
    // Paired with the matching firestore.rules read clause on /orders.
    const sellerIds = [...new Set(lineItems.map((li) => li.sellerId).filter(Boolean))];

    await db.collection("orders").doc(order.id).set({
      type: "marketplace",
      uid,
      items: lineItems,
      sellerIds,
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
 * markSellerPayout
 *
 * The ONLY way a Marketplace order line item's payoutStatus ever becomes
 * "paid" — called from the Admin Dashboard's Marketplace Payouts section
 * once RIED has actually sent a seller their share (payments are collected
 * centrally and paid out manually, per the Tier 9 payout-model decision).
 * Admin-only (requireAdmin above); matches the same admin check already
 * used in firestore.rules, and firestore.rules itself still blocks every
 * client write to /orders unconditionally — this Cloud Function, via the
 * Admin SDK, is the only path that can ever change payoutStatus at all.
 */
exports.markSellerPayout = onCall(async (request) => {
  await requireAdmin(request.auth && request.auth.uid);

  const { orderId, itemIndex } = request.data || {};
  if (!orderId || itemIndex === undefined || itemIndex === null) {
    throw new HttpsError("invalid-argument", "Missing orderId or itemIndex.");
  }

  const orderRef = db.collection("orders").doc(String(orderId));
  const orderSnap = await orderRef.get();
  if (!orderSnap.exists) {
    throw new HttpsError("not-found", "That order no longer exists.");
  }

  const order = orderSnap.data();
  const items = Array.isArray(order.items) ? [...order.items] : [];
  const idx = Number(itemIndex);
  if (!items[idx]) {
    throw new HttpsError("invalid-argument", "That item doesn't exist on this order.");
  }

  // A concrete Timestamp, not FieldValue.serverTimestamp() — the sentinel
  // doesn't resolve correctly when nested inside an array element written
  // as part of a whole-array replace (which this is, since Firestore has no
  // way to update a single array element in place).
  items[idx] = {
    ...items[idx],
    payoutStatus: "paid",
    payoutPaidAt: admin.firestore.Timestamp.now(),
    payoutMarkedBy: request.auth.uid
  };

  await orderRef.update({ items });

  return { success: true };
});

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
function sendMail(transporter, { to, subject, text, replyTo, fromName }) {
  return transporter.sendMail({
    from: `"${fromName || "RIED Website — Founder Profile"}" <${GMAIL_SENDER}>`,
    to,
    replyTo: replyTo || undefined,
    subject,
    text
  });
}

/**
 * razorpayWebhook / checkOverdueRenewals
 *
 * Together these two functions are what makes Scale-Up & Grant Readiness
 * subscriptions behave like real recurring billing after the first month:
 *
 *   - razorpayWebhook is a plain HTTP endpoint (not onCall — Razorpay calls
 *     this directly, there's no signed-in Firebase user involved) that
 *     Razorpay pings every time something happens to a subscription. We
 *     listen for three events: subscription.charged (a renewal payment
 *     succeeded), subscription.pending (a renewal payment attempt failed and
 *     Razorpay is retrying), and subscription.halted (Razorpay has given up
 *     retrying entirely). You configure this URL + these three events once
 *     in the Razorpay Dashboard — see the deploy guide provided alongside
 *     this file for the exact steps.
 *
 *   - checkOverdueRenewals runs automatically once a day (no Dashboard setup
 *     needed — Firebase creates the Cloud Scheduler job for this on deploy).
 *     Razorpay's webhook only tells us ONCE that a payment is pending; this
 *     is what repeats the "please pay" reminder to the client every few days,
 *     and what escalates to RIED if a subscription is still unpaid on/after
 *     the 5th of the month.
 *
 * Every subscription's tracking state lives on its own /orders/{id} doc:
 *   renewalStatus      "ok" | "pending" | "halted"
 *   lastChargeAt        when the last successful charge happened
 *   lastChargeMonth      "YYYY-MM" of the last successful charge
 *   renewalPendingSince  when the current failed-payment streak started
 *   lastReminderAt       when the client was last emailed about it
 *   reminderCount        how many reminders have gone out this streak
 *   riedAlertMonth       "YYYY-MM" RIED was last alerted about, so the same
 *                        month never triggers two overdue alerts
 */
exports.razorpayWebhook = onRequest(
  { secrets: [RAZORPAY_WEBHOOK_SECRET, GMAIL_APP_PASSWORD] },
  async (req, res) => {
    const signature = req.headers["x-razorpay-signature"];
    const rawBody = req.rawBody; // Buffer — required for a byte-exact signature check

    if (!signature || !rawBody) {
      res.status(400).send("Missing signature or body.");
      return;
    }

    const expected = crypto
      .createHmac("sha256", RAZORPAY_WEBHOOK_SECRET.value())
      .update(rawBody)
      .digest("hex");

    if (expected !== signature) {
      logger.error("razorpayWebhook: signature mismatch — rejecting request.");
      res.status(400).send("Invalid signature.");
      return;
    }

    const event = req.body && req.body.event;
    const transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: { user: GMAIL_SENDER, pass: GMAIL_APP_PASSWORD.value() }
    });

    try {
      if (event === "subscription.charged") {
        await handleSubscriptionCharged(req.body, transporter);
      } else if (event === "subscription.pending") {
        await handleSubscriptionPending(req.body, transporter);
      } else if (event === "subscription.halted") {
        await handleSubscriptionHalted(req.body, transporter);
      } else {
        logger.info(`razorpayWebhook: ignoring unhandled event "${event}"`);
      }
    } catch (e) {
      // Acknowledge with 200 regardless (below) — an error on our side
      // shouldn't make Razorpay think this webhook URL itself is broken,
      // which after enough failures it will start disabling automatically.
      logger.error(`razorpayWebhook: error handling event "${event}"`, e);
    }

    res.status(200).send("ok");
  }
);

async function handleSubscriptionCharged(body, transporter) {
  const sub = body.payload && body.payload.subscription && body.payload.subscription.entity;
  const payment = body.payload && body.payload.payment && body.payload.payment.entity;
  if (!sub || !sub.id) return;

  const orderRef = db.collection("orders").doc(sub.id);
  const orderSnap = await orderRef.get();
  if (!orderSnap.exists) {
    logger.error(`razorpayWebhook: subscription.charged for unknown subscription ${sub.id}`);
    return;
  }
  const order = orderSnap.data();

  // The very first charge on a brand-new subscription is already handled
  // and emailed by verifyScaleUpSubscription (called from the browser right
  // after checkout) — skip it here so RIED/the client never get two emails
  // for the same charge.
  if (payment && payment.id && payment.id === order.lastChargePaymentId) {
    return;
  }

  await orderRef.set(
    {
      renewalStatus: "ok",
      lastChargeAt: admin.firestore.FieldValue.serverTimestamp(),
      lastChargeMonth: monthKey(new Date()),
      lastChargePaymentId: payment ? payment.id : null,
      renewalPendingSince: admin.firestore.FieldValue.delete(),
      lastReminderAt: admin.firestore.FieldValue.delete(),
      reminderCount: 0
    },
    { merge: true }
  );

  const info = order.businessInfo || {};
  const amountPaid = payment ? payment.amount / 100 : order.amount;

  try {
    await sendMail(transporter, {
      to: "hello@ried.co.in",
      subject: `Renewal Payment Received — ${order.packageName || order.packageId || ""}`,
      text: [
        "A Scale-Up & Grant Readiness subscription renewal payment has been received.",
        "",
        `Package: ${order.packageName || order.packageId || ""}`,
        `Amount: Rs. ${amountPaid}`,
        `Client: ${info.name || ""} (${info.email || ""})`,
        `Company / Startup: ${info.companyName || "(not provided)"}`,
        `Razorpay Subscription ID: ${sub.id}`,
        `Razorpay Payment ID: ${payment ? payment.id : "unknown"}`
      ].join("\n")
    });
  } catch (e) {
    logger.error("handleSubscriptionCharged: failed to send RIED notification", e);
  }

  if (info.email) {
    try {
      await sendMail(transporter, {
        to: info.email,
        fromName: "RIED — Billing",
        subject: `Payment Received — ${order.packageName || "your RIED subscription"}`,
        text: [
          `Hi ${info.name || "there"},`,
          "",
          `We've received your monthly payment of Rs. ${amountPaid} for ${order.packageName || "your Scale-Up & Grant Readiness subscription"}.`,
          "",
          "Thank you for continuing with RIED.",
          "",
          "— Team RIED"
        ].join("\n")
      });
    } catch (e) {
      logger.error("handleSubscriptionCharged: failed to send client receipt", e);
    }
  }
}

async function handleSubscriptionPending(body, transporter) {
  const sub = body.payload && body.payload.subscription && body.payload.subscription.entity;
  if (!sub || !sub.id) return;

  const orderRef = db.collection("orders").doc(sub.id);
  const orderSnap = await orderRef.get();
  if (!orderSnap.exists) return;
  const order = orderSnap.data();

  // Only send the very first "your payment failed" email from here — every
  // reminder after this one (every few days) and the eventual RIED
  // escalation are handled by checkOverdueRenewals below, so this doesn't
  // fire again on every retry ping Razorpay sends while still pending.
  if (order.renewalStatus === "pending") return;

  await orderRef.set(
    {
      renewalStatus: "pending",
      renewalPendingSince: admin.firestore.FieldValue.serverTimestamp(),
      lastReminderAt: admin.firestore.FieldValue.serverTimestamp(),
      reminderCount: 1
    },
    { merge: true }
  );

  const info = order.businessInfo || {};
  if (info.email) {
    try {
      await sendMail(transporter, {
        to: info.email,
        fromName: "RIED — Billing",
        subject: `Action Needed — Payment Due for ${order.packageName || "your RIED subscription"}`,
        text: [
          `Hi ${info.name || "there"},`,
          "",
          `We weren't able to process this month's payment for ${order.packageName || "your Scale-Up & Grant Readiness subscription"}.`,
          "",
          "Please make sure your payment method is valid and has sufficient funds — Razorpay will keep retrying automatically. Reach out to hello@ried.co.in if you need help.",
          "",
          "— Team RIED"
        ].join("\n")
      });
    } catch (e) {
      logger.error("handleSubscriptionPending: failed to send client reminder", e);
    }
  }
}

async function handleSubscriptionHalted(body, transporter) {
  const sub = body.payload && body.payload.subscription && body.payload.subscription.entity;
  if (!sub || !sub.id) return;

  const orderRef = db.collection("orders").doc(sub.id);
  const orderSnap = await orderRef.get();
  if (!orderSnap.exists) return;
  const order = orderSnap.data();

  await orderRef.set(
    { renewalStatus: "halted", riedAlertMonth: monthKey(new Date()) },
    { merge: true }
  );

  const info = order.businessInfo || {};
  try {
    await sendMail(transporter, {
      to: "hello@ried.co.in",
      subject: `URGENT — Subscription Halted (Payment Failed) — ${order.packageName || ""}`,
      text: [
        "Razorpay has stopped retrying a Scale-Up & Grant Readiness subscription after repeated failed payments.",
        "",
        `Package: ${order.packageName || order.packageId || ""}`,
        `Client: ${info.name || ""} (${info.email || ""})`,
        `Phone: ${info.phone || ""}`,
        `Razorpay Subscription ID: ${sub.id}`,
        "",
        "This client needs to be contacted directly to resolve payment before the subscription can resume — there's no self-serve way for them to restart it from the website."
      ].join("\n")
    });
  } catch (e) {
    logger.error("handleSubscriptionHalted: failed to send RIED alert", e);
  }
}

exports.checkOverdueRenewals = onSchedule(
  { schedule: "every day 09:00", timeZone: "Asia/Kolkata", secrets: [GMAIL_APP_PASSWORD] },
  async () => {
    const now = new Date();
    const currentMonth = monthKey(now);
    const dayOfMonth = now.getDate();

    const transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: { user: GMAIL_SENDER, pass: GMAIL_APP_PASSWORD.value() }
    });

    const snap = await db.collection("orders").where("type", "==", "scaleup-subscription").get();

    for (const doc of snap.docs) {
      const order = doc.data();
      if (order.status !== "active") continue; // never completed a first charge, or was cancelled
      if (order.lastChargeMonth === currentMonth) continue; // already paid this month

      const info = order.businessInfo || {};

      if (dayOfMonth < RIED_ALERT_DAY_OF_MONTH && order.renewalStatus === "pending") {
        const lastReminder = order.lastReminderAt ? order.lastReminderAt.toDate() : null;
        if ((!lastReminder || daysBetween(now, lastReminder) >= REMINDER_INTERVAL_DAYS) && info.email) {
          try {
            await sendMail(transporter, {
              to: info.email,
              fromName: "RIED — Billing",
              subject: `Reminder — Payment Still Due for ${order.packageName || "your RIED subscription"}`,
              text: [
                `Hi ${info.name || "there"},`,
                "",
                `This month's payment for ${order.packageName || "your Scale-Up & Grant Readiness subscription"} is still pending.`,
                "",
                "Please update or confirm your payment method so we can process it — reach out to hello@ried.co.in if you're running into trouble.",
                "",
                "— Team RIED"
              ].join("\n")
            });
            await doc.ref.set(
              {
                lastReminderAt: admin.firestore.FieldValue.serverTimestamp(),
                reminderCount: (order.reminderCount || 0) + 1
              },
              { merge: true }
            );
          } catch (e) {
            logger.error(`checkOverdueRenewals: failed to send reminder for ${doc.id}`, e);
          }
        }
      }

      // Important: only escalate when we actually KNOW a charge attempt
      // failed (renewalStatus "pending" or "halted", set by razorpayWebhook
      // above) — not merely because no charge has landed yet this calendar
      // month. Razorpay bills each subscription on its own anchor date (the
      // day it was first subscribed), which won't always fall on or before
      // the 5th, so "no charge yet this month" alone is not the same as
      // "overdue" and would otherwise cause false alarms for subscribers
      // who are perfectly on schedule.
      if (
        dayOfMonth >= RIED_ALERT_DAY_OF_MONTH &&
        (order.renewalStatus === "pending" || order.renewalStatus === "halted") &&
        order.riedAlertMonth !== currentMonth
      ) {
        try {
          await sendMail(transporter, {
            to: "hello@ried.co.in",
            subject: `Overdue — Subscription Payment Not Received — ${order.packageName || ""}`,
            text: [
              `A Scale-Up & Grant Readiness subscription has not been paid for ${currentMonth}, and it's now on or past the ${RIED_ALERT_DAY_OF_MONTH}th of the month.`,
              "",
              `Package: ${order.packageName || order.packageId || ""}`,
              `Client: ${info.name || ""} (${info.email || ""})`,
              `Phone: ${info.phone || ""}`,
              `Status: ${order.renewalStatus || "unknown"}`,
              `Razorpay Subscription ID: ${doc.id}`,
              "",
              "This may need a manual follow-up with the client."
            ].join("\n")
          });
          await doc.ref.set({ riedAlertMonth: currentMonth }, { merge: true });
        } catch (e) {
          logger.error(`checkOverdueRenewals: failed to send RIED overdue alert for ${doc.id}`, e);
        }
      }
    }
  }
);

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

/**
 * notifyOnInternOnboarding
 *
 * Internship Program, Phase 1 (2026-07-31). Fires whenever an intern
 * candidate's onboarding document — /interns/{uid}, written by
 * intern-onboarding.html — is created OR resubmitted after an edit. Same
 * shape as notifyOnProfileSubmit above: emails a plain-text summary plus
 * secure links to the three uploaded documents (photo, Aadhar card, latest
 * marksheet) to hello@ried.co.in via Gmail SMTP.
 *
 * We only send when `onboardingSubmittedAt` changes between before/after —
 * that's the field intern-onboarding.html always refreshes with a fresh
 * server timestamp on submit, so it uniquely marks "the candidate just hit
 * Submit," the same way `submittedAt` does for founder profiles. This means
 * a later admin-side write (e.g. approving the application in a future
 * phase) never re-triggers this email.
 *
 * Documents are linked, not attached, for the same reason founder logos
 * are linked rather than attached in notifyOnProfileSubmit above — Gmail
 * SMTP attachment size/reliability isn't worth it when a link works fine
 * for an internal team inbox. Storage rules for intern-documents/{uid}/...
 * are owner-only read (see storage.rules) — same as profile-logos and
 * user-uploads elsewhere on this site — but the getDownloadURL() link
 * itself carries its own access token and works for whoever has the link,
 * which is fine here since it only ever goes to the trusted hello@ried.co.in
 * inbox (identical precedent to how founder profile logos are shared today).
 */
exports.notifyOnInternOnboarding = onDocumentWritten(
  { document: "interns/{uid}", secrets: [GMAIL_APP_PASSWORD] },
  async (event) => {
    const afterSnap = event.data.after;
    if (!afterSnap.exists) return; // intern doc deleted — nothing to notify

    const after = afterSnap.data();
    const beforeSnap = event.data.before;
    const before = beforeSnap.exists ? beforeSnap.data() : null;

    const afterTs = after.onboardingSubmittedAt ? after.onboardingSubmittedAt.toMillis() : null;
    const beforeTs = before && before.onboardingSubmittedAt ? before.onboardingSubmittedAt.toMillis() : null;
    const isNewSubmission = !!afterTs && afterTs !== beforeTs;
    if (!isNewSubmission) return;

    const uid = event.params.uid;
    const isEdit = !!(before && before.onboardingSubmittedAt);

    const lines = [];
    lines.push(`Internship Program — Candidate ${isEdit ? "Updated" : "Submitted"} Onboarding`);
    lines.push("");
    lines.push(`Full Name: ${after.fullName || ""}`);
    lines.push(`Father's/Mother's Name: ${after.parentName || ""}`);
    lines.push(`Email: ${after.email || ""}`);
    lines.push(`Phone: ${after.phone || ""}`);
    lines.push(`Address: ${after.address || ""}`);
    lines.push(`College: ${after.collegeName || ""}`);
    lines.push(`Field of Study: ${after.fieldOfStudy || ""}`);
    lines.push(`Semester: ${after.semester || ""}`);
    if (after.interests) lines.push(`Interests: ${after.interests}`);
    lines.push("");
    lines.push("--- Documents ---");
    lines.push(`Photo: ${after.photoURL || "(not uploaded)"}`);
    lines.push(`Aadhar Card: ${after.aadharURL || "(not uploaded)"}`);
    lines.push(`Latest Marksheet: ${after.marksheetURL || "(not uploaded)"}`);
    lines.push("");
    lines.push(`Status: ${after.status || ""}`);
    lines.push(`Candidate UID: ${uid}`);

    const transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: { user: GMAIL_SENDER, pass: GMAIL_APP_PASSWORD.value() }
    });

    try {
      await sendMail(transporter, {
        to: "hello@ried.co.in",
        replyTo: after.email,
        subject: `${isEdit ? "Updated" : "New"} Internship Application — ${after.fullName || after.email || uid}`,
        text: lines.join("\n"),
        fromName: "RIED Website — Internship Program"
      });
    } catch (e) {
      logger.error("notifyOnInternOnboarding: failed to send email", e);
    }
  }
);

/**
 * ===========================================================================
 * INTERNSHIP PROGRAM — PHASE 2: SKILLS ASSESSMENT (2026-08-03)
 * ===========================================================================
 *
 * Design note (feasibility, discussed with RIED before building): true
 * live/arbitrary code-execution grading for HTML/CSS/Java isn't feasible on
 * this stack without real sandboxed execution infrastructure, which would
 * also be a security risk. So every question here — including the
 * "task-based evaluation" ones — is scenario/multiple-choice ("what does
 * this render", "spot the bug", "pick the fix"), auto-graded server-side.
 * No pass/fail anywhere — just a 0-100 score per category, purely
 * descriptive, meant to help Mentors decide what tasks to hand out later.
 *
 * ANTI-CHEATING / SECURITY, mirroring the site's existing "never trust the
 * client" pattern (same spirit as Razorpay pricing above):
 *   - The question bank (with correct answers) lives ONLY in this file —
 *     never in Firestore, never sent to the client. A client only ever sees
 *     question text + answer options, never which option is correct.
 *   - Each candidate gets a random subset per category (not the same fixed
 *     set for everyone) with each question's own options shuffled too, both
 *     picked fresh in startAssessment and locked into a private
 *     /assessmentSessions/{uid} document that only this Cloud Function's
 *     Admin SDK ever reads or writes (no Firestore rule grants a client
 *     access to that collection at all — it falls through to the
 *     catch-all "deny everything" rule at the bottom of firestore.rules).
 *   - Grading in submitAssessment re-derives the right answer from the
 *     bank + the session's stored option-shuffle mapping — the client's
 *     answers are just "which position did you click", never trusted as
 *     "which answer is correct".
 *   - The timer is enforced by a server-set deadline stored at session
 *     start, not just a countdown in the browser — a candidate can't get
 *     more time by editing client-side JS.
 */
const ASSESSMENT_CATEGORIES = ["html", "css", "java", "logical", "task"];
const QUESTIONS_PER_CATEGORY = 4; // 20 questions total per candidate
const ASSESSMENT_TIME_LIMIT_SECONDS = 15 * 60; // 15 minutes — generous for a fresher on easy questions

// Easy, fresher-friendly questions only, per RIED's explicit instruction —
// this is meant to gauge baseline skill level and keep things fun, not to
// filter anyone out. Every category has more questions than
// QUESTIONS_PER_CATEGORY needs, so each candidate's actual test differs.
const ASSESSMENT_QUESTION_BANK = {
  html: [
    { id: "html-1", text: "Which tag is used to create a hyperlink in HTML?", options: ["<link>", "<a>", "<href>", "<nav>"], correctIndex: 1 },
    { id: "html-2", text: "Which tag is used to insert an image?", options: ["<img>", "<src>", "<picture>", "<image>"], correctIndex: 0 },
    { id: "html-3", text: "What does HTML stand for?", options: ["HyperText Markup Language", "Home Tool Markup Language", "Hyperlinks Text Markup Language", "HighText Machine Language"], correctIndex: 0 },
    { id: "html-4", text: "Which attribute on <a> specifies where the link goes?", options: ["src", "href", "link", "url"], correctIndex: 1 },
    { id: "html-5", text: "Which tag creates the largest heading?", options: ["<h6>", "<heading>", "<h1>", "<head>"], correctIndex: 2 },
    { id: "html-6", text: "Which tag creates an unordered (bulleted) list?", options: ["<ul>", "<ol>", "<li>", "<list>"], correctIndex: 0 },
    { id: "html-7", text: "What's the correct HTML for a checkbox input?", options: ["<input type=\"checkbox\">", "<checkbox>", "<input type=\"check\">", "<select type=\"checkbox\">"], correctIndex: 0 },
    { id: "html-8", text: "Which tag defines a row inside a table?", options: ["<td>", "<tr>", "<th>", "<row>"], correctIndex: 1 },
    { id: "html-9", text: "Which element is meant to hold a document's footer content?", options: ["<bottom>", "<footer>", "<section>", "<below>"], correctIndex: 1 },
    { id: "html-10", text: "What's the correct syntax for an HTML comment?", options: ["<!-- comment -->", "// comment", "/* comment */", "<comment>"], correctIndex: 0 }
  ],
  css: [
    { id: "css-1", text: "Which CSS property changes text color?", options: ["color", "text-color", "font-color", "foreground-color"], correctIndex: 0 },
    { id: "css-2", text: "Which property controls the spacing between lines of text?", options: ["line-height", "letter-spacing", "word-spacing", "text-indent"], correctIndex: 0 },
    { id: "css-3", text: "Which symbol selects a class in CSS?", options: ["#", ".", "*", "&"], correctIndex: 1 },
    { id: "css-4", text: "Which property changes an element's background color?", options: ["bgcolor", "background-color", "color-background", "bg-color"], correctIndex: 1 },
    { id: "css-5", text: "How do you make text bold in CSS?", options: ["font-weight: bold;", "text-style: bold;", "font: bold;", "style: bold;"], correctIndex: 0 },
    { id: "css-6", text: "Which property controls the space between an element's border and its content?", options: ["margin", "padding", "spacing", "gap"], correctIndex: 1 },
    { id: "css-7", text: "What does \"display: flex\" mainly enable?", options: ["A flexible box layout for arranging child elements", "A rigid grid layout only", "Hiding an element", "Rounding corners"], correctIndex: 0 },
    { id: "css-8", text: "Which unit is relative to the root element's font size?", options: ["px", "em", "rem", "%"], correctIndex: 2 },
    { id: "css-9", text: "Which property changes the font used by an element?", options: ["font-style", "font-family", "text-font", "font-type"], correctIndex: 1 },
    { id: "css-10", text: "What does CSS stand for?", options: ["Cascading Style Sheets", "Colorful Style Sheets", "Creative Style System", "Computer Style Sheets"], correctIndex: 0 }
  ],
  java: [
    { id: "java-1", text: "Which keyword creates a class in Java?", options: ["class", "Class", "struct", "object"], correctIndex: 0 },
    { id: "java-2", text: "Which method is the entry point of a Java program?", options: ["start()", "main()", "run()", "init()"], correctIndex: 1 },
    { id: "java-3", text: "Which of these is a primitive data type in Java?", options: ["String", "Integer", "int", "Object"], correctIndex: 2 },
    { id: "java-4", text: "What's the correct way to declare a variable named age holding 20?", options: ["int age = 20;", "var age = 20;", "age int = 20;", "integer age = 20;"], correctIndex: 0 },
    { id: "java-5", text: "Which keyword is used for a class to inherit another class?", options: ["implements", "extends", "inherits", "super"], correctIndex: 1 },
    { id: "java-6", text: "Which loop is guaranteed to run its body at least once?", options: ["for", "while", "do-while", "foreach"], correctIndex: 2 },
    { id: "java-7", text: "What is the size of an int in Java?", options: ["16 bit", "32 bit", "64 bit", "8 bit"], correctIndex: 1 },
    { id: "java-8", text: "Which symbol starts a single-line comment in Java?", options: ["//", "/* */", "#", "--"], correctIndex: 0 },
    { id: "java-9", text: "Which keyword stops a class from being inherited?", options: ["static", "private", "final", "const"], correctIndex: 2 },
    { id: "java-10", text: "What does System.out.println(\"5\" + 3); print?", options: ["8", "53", "Error", "35"], correctIndex: 1 }
  ],
  logical: [
    { id: "logical-1", text: "All cats are animals. Tom is a cat. So Tom is:", options: ["A plant", "An animal", "A dog", "Unknown"], correctIndex: 1 },
    { id: "logical-2", text: "Find the odd one out: Apple, Banana, Carrot, Mango", options: ["Apple", "Banana", "Carrot", "Mango"], correctIndex: 2 },
    { id: "logical-3", text: "What comes next: 2, 4, 6, 8, ?", options: ["9", "10", "12", "11"], correctIndex: 1 },
    { id: "logical-4", text: "A is taller than B. B is taller than C. Who is shortest?", options: ["A", "B", "C", "Cannot say"], correctIndex: 2 },
    { id: "logical-5", text: "Complete the pattern: 1, 1, 2, 3, 5, 8, ?", options: ["11", "13", "10", "12"], correctIndex: 1 },
    { id: "logical-6", text: "If today is Monday, what day is it 3 days later?", options: ["Wednesday", "Thursday", "Friday", "Tuesday"], correctIndex: 1 },
    { id: "logical-7", text: "Which number is the odd one out: 3, 5, 10, 7", options: ["3", "5", "10", "7"], correctIndex: 2 },
    { id: "logical-8", text: "A task starts at 10:00 AM and takes 2 hours 30 minutes. When does it finish?", options: ["12:00 PM", "12:30 PM", "1:00 PM", "12:45 PM"], correctIndex: 1 },
    { id: "logical-9", text: "Priya is left of Raj, and Raj is left of Simran. Who's in the middle?", options: ["Priya", "Raj", "Simran", "Cannot say"], correctIndex: 1 },
    { id: "logical-10", text: "Which word doesn't belong: Circle, Square, Triangle, Blue", options: ["Circle", "Square", "Triangle", "Blue"], correctIndex: 3 }
  ],
  task: [
    { id: "task-1", text: "What does this render as visible text? <p>Hello <b>World</b></p>", options: ["\"Hello World\", with World in bold", "Just \"Hello\"", "An error", "The literal text \"Hello <b>World</b>\""], correctIndex: 0 },
    { id: "task-2", text: "A button isn't clickable because its CSS has \"pointer-events: none;\". What's the fix?", options: ["Change pointer-events to auto (or remove it)", "Add more padding", "Change the button's color", "Add a border"], correctIndex: 0 },
    { id: "task-3", text: "This code should check if x equals 5, but has a bug: if (x = 5) { ... }. What's the fix?", options: ["Change = to ==", "Change if to while", "Remove the parentheses", "Add a semicolon"], correctIndex: 0 },
    { id: "task-4", text: "\".card { color: red }\" isn't applying because \".sidebar .card { color: blue }\" also matches and wins. What CSS concept is this?", options: ["Specificity", "Inheritance", "Flexbox", "Animation"], correctIndex: 0 },
    { id: "task-5", text: "You need a list of steps where the ORDER matters (Step 1, Step 2, Step 3). Which HTML tag fits best?", options: ["<ul>", "<ol>", "<div>", "<table>"], correctIndex: 1 },
    { id: "task-6", text: "An intern's daily task should be \"acknowledged\" then later \"marked complete\". What's the correct order?", options: ["Complete first, then acknowledge", "Acknowledge first, then complete", "Both at the same time only", "Neither step is needed"], correctIndex: 1 },
    { id: "task-7", text: "A form's submit button reloads the page unexpectedly. What's most likely missing in the JS handler?", options: ["event.preventDefault()", "console.log()", "a CSS class", "an <img> tag"], correctIndex: 0 },
    { id: "task-8", text: "What's the best practice for handling sensitive uploads like an ID proof document?", options: ["Send them over email only", "Upload to private, access-controlled storage", "Post them publicly for verification", "Save them as plain text files"], correctIndex: 1 },
    { id: "task-9", text: "A mentor's review comment says \"reopen this — the button color doesn't match the brand.\" What should you do next?", options: ["Ignore the comment", "Mark the task complete anyway", "Fix the button color and resubmit", "Delete the task"], correctIndex: 2 },
    { id: "task-10", text: "Which is the most professional way to tell your mentor you'll be a little late clocking in?", options: ["\"not my fault, whatever\"", "\"Running a bit late today, will clock in by 9:30 — sorry for the delay!\"", "Just show up late with no message", "\"idk why it matters\""], correctIndex: 1 }
  ]
};

function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Builds one candidate's private question set: QUESTIONS_PER_CATEGORY random
// questions per category, each with its OWN options shuffled, then the whole
// set shuffled together so categories aren't even grouped in a predictable
// order. Returned objects still carry optionOrder/correctIndex-derivable
// data — callers in this file only ever send the client-safe subset
// (id/category/text/options) onward, never this raw object.
function pickAssessmentQuestions() {
  const selected = [];
  ASSESSMENT_CATEGORIES.forEach((cat) => {
    const pool = ASSESSMENT_QUESTION_BANK[cat];
    const chosen = shuffleArray(pool).slice(0, QUESTIONS_PER_CATEGORY);
    chosen.forEach((q) => {
      const optionOrder = shuffleArray(q.options.map((_, i) => i)); // shuffled original indices
      const options = optionOrder.map((origIdx) => q.options[origIdx]);
      selected.push({ id: q.id, category: cat, text: q.text, options, optionOrder });
    });
  });
  return shuffleArray(selected);
}

function clientSafeQuestions(questions) {
  return questions.map((q) => ({ id: q.id, category: q.category, text: q.text, options: q.options }));
}

/**
 * startAssessment
 *
 * Called when a candidate clicks "Start Test" on intern-test.html. Requires
 * an onboarded (but not yet assessed) /interns/{uid} doc. Idempotent by
 * design: if a session is already in progress and hasn't expired, it
 * returns the SAME question set and deadline rather than rerolling — this
 * means refreshing the test page mid-attempt doesn't hand the candidate a
 * fresh, easier random draw, but also doesn't unfairly restart their clock.
 */
exports.startAssessment = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Please sign in.");
  }
  const uid = request.auth.uid;

  const internSnap = await db.collection("interns").doc(uid).get();
  if (!internSnap.exists) {
    throw new HttpsError("failed-precondition", "No internship application found for this account.");
  }
  const intern = internSnap.data();
  if (intern.status === "signed_up") {
    throw new HttpsError("failed-precondition", "Please finish onboarding before taking the skills check.");
  }
  if (intern.status && intern.status !== "onboarded") {
    throw new HttpsError("failed-precondition", "You've already completed the skills check.");
  }

  const sessionRef = db.collection("assessmentSessions").doc(uid);
  const sessionSnap = await sessionRef.get();
  const now = Date.now();

  if (sessionSnap.exists) {
    const session = sessionSnap.data();
    if (session.submitted) {
      throw new HttpsError("failed-precondition", "You've already completed the skills check.");
    }
    const deadlineMs = session.deadline ? session.deadline.toMillis() : 0;
    if (deadlineMs > now) {
      return {
        questions: clientSafeQuestions(session.questions || []),
        deadlineMillis: deadlineMs,
        timeLimitSeconds: ASSESSMENT_TIME_LIMIT_SECONDS
      };
    }
    // Expired without ever being submitted — fall through and start fresh.
  }

  const questions = pickAssessmentQuestions();
  const deadline = admin.firestore.Timestamp.fromMillis(now + ASSESSMENT_TIME_LIMIT_SECONDS * 1000);

  await sessionRef.set({
    uid,
    questions,
    startedAt: admin.firestore.Timestamp.now(),
    deadline,
    submitted: false
  });

  return {
    questions: clientSafeQuestions(questions),
    deadlineMillis: deadline.toMillis(),
    timeLimitSeconds: ASSESSMENT_TIME_LIMIT_SECONDS
  };
});

/**
 * submitAssessment
 *
 * Grades entirely server-side against the exact question set + per-question
 * option-shuffle mapping locked in at startAssessment, then writes a 0-100
 * overall score plus a per-category breakdown onto /interns/{uid} (no
 * pass/fail field anywhere, by design) and flips status to
 * "assessment_completed" so the candidate's dashboard and the future Mentor
 * approval queue both pick it up.
 */
exports.submitAssessment = onCall(
  { secrets: [GMAIL_APP_PASSWORD] },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Please sign in.");
    }
    const uid = request.auth.uid;

    const sessionRef = db.collection("assessmentSessions").doc(uid);
    const sessionSnap = await sessionRef.get();
    if (!sessionSnap.exists) {
      throw new HttpsError("failed-precondition", "No skills check in progress — please start one first.");
    }
    const session = sessionSnap.data();
    if (session.submitted) {
      throw new HttpsError("failed-precondition", "You've already submitted your skills check.");
    }

    const answersRaw = (request.data && request.data.answers) || [];
    const answerMap = {};
    answersRaw.forEach((a) => {
      if (a && a.questionId) answerMap[a.questionId] = a.selectedIndex;
    });

    const categoryTotals = {};
    const categoryCorrect = {};
    let totalCorrect = 0;
    const sessionQuestions = session.questions || [];

    sessionQuestions.forEach((q) => {
      categoryTotals[q.category] = (categoryTotals[q.category] || 0) + 1;
      const bank = ASSESSMENT_QUESTION_BANK[q.category] || [];
      const bankQ = bank.find((x) => x.id === q.id);
      if (!bankQ) return;

      const shownIndex = answerMap[q.id]; // index into the SHUFFLED options the client displayed
      let isCorrect = false;
      if (typeof shownIndex === "number" && Array.isArray(q.optionOrder) && q.optionOrder[shownIndex] !== undefined) {
        isCorrect = q.optionOrder[shownIndex] === bankQ.correctIndex;
      }
      if (isCorrect) {
        categoryCorrect[q.category] = (categoryCorrect[q.category] || 0) + 1;
        totalCorrect++;
      }
    });

    const categoryScores = {};
    ASSESSMENT_CATEGORIES.forEach((cat) => {
      const total = categoryTotals[cat] || 0;
      const correct = categoryCorrect[cat] || 0;
      categoryScores[cat] = total ? Math.round((correct / total) * 100) : null;
    });
    const overallScore = sessionQuestions.length
      ? Math.round((totalCorrect / sessionQuestions.length) * 100)
      : 0;

    const now = admin.firestore.Timestamp.now();
    const deadlineMs = session.deadline ? session.deadline.toMillis() : now.toMillis();
    const submittedLate = now.toMillis() > deadlineMs + 5000; // 5s grace for network lag, not a penalty either way

    await sessionRef.set(
      { submitted: true, submittedAt: now, overallScore, categoryScores, submittedLate },
      { merge: true }
    );

    await db.collection("interns").doc(uid).set(
      {
        status: "assessment_completed",
        assessmentScore: overallScore,
        assessmentCategoryScores: categoryScores,
        assessmentCompletedAt: now
      },
      { merge: true }
    );

    return { overallScore, categoryScores };
  }
);

/**
 * notifyOnInternAssessmentComplete
 *
 * Same trigger shape as notifyOnInternOnboarding above, watching the same
 * /interns/{uid} document for a different marker field
 * (assessmentCompletedAt, set only by submitAssessment) so Neel/Pramod get a
 * heads-up the moment a candidate finishes their skills check, with the
 * score breakdown to help decide what to assign them once approved.
 */
exports.notifyOnInternAssessmentComplete = onDocumentWritten(
  { document: "interns/{uid}", secrets: [GMAIL_APP_PASSWORD] },
  async (event) => {
    const afterSnap = event.data.after;
    if (!afterSnap.exists) return;

    const after = afterSnap.data();
    const beforeSnap = event.data.before;
    const before = beforeSnap.exists ? beforeSnap.data() : null;

    const afterTs = after.assessmentCompletedAt ? after.assessmentCompletedAt.toMillis() : null;
    const beforeTs = before && before.assessmentCompletedAt ? before.assessmentCompletedAt.toMillis() : null;
    if (!afterTs || afterTs === beforeTs) return;

    const uid = event.params.uid;
    const cat = after.assessmentCategoryScores || {};
    const lines = [
      `${after.fullName || after.email || uid} just completed their Internship Program skills check.`,
      "",
      `Overall Score: ${after.assessmentScore != null ? after.assessmentScore : "?"} / 100 (descriptive only — no pass/fail)`,
      "",
      "--- Category Breakdown (out of 100) ---",
      `HTML: ${cat.html != null ? cat.html : "-"}`,
      `CSS: ${cat.css != null ? cat.css : "-"}`,
      `Core Java: ${cat.java != null ? cat.java : "-"}`,
      `Logical Reasoning: ${cat.logical != null ? cat.logical : "-"}`,
      `Task-Based Evaluation: ${cat.task != null ? cat.task : "-"}`,
      "",
      "This candidate now shows as pending review in the Internship Corner of the admin dashboard.",
      `Candidate Email: ${after.email || ""}`,
      `Candidate UID: ${uid}`
    ];

    const transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: { user: GMAIL_SENDER, pass: GMAIL_APP_PASSWORD.value() }
    });

    try {
      await sendMail(transporter, {
        to: "hello@ried.co.in",
        replyTo: after.email,
        subject: `Skills Check Complete — ${after.fullName || after.email || uid} (Score: ${after.assessmentScore != null ? after.assessmentScore : "?"})`,
        text: lines.join("\n"),
        fromName: "RIED Website — Internship Program"
      });
    } catch (e) {
      logger.error("notifyOnInternAssessmentComplete: failed to send email", e);
    }
  }
);
