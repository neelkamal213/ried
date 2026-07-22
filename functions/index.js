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
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const Razorpay = require("razorpay");
const crypto = require("crypto");

admin.initializeApp();
const db = admin.firestore();

// Stored as Firebase Functions secrets (never in this source file, never in git).
// Set once via:
//   firebase functions:secrets:set RAZORPAY_KEY_ID
//   firebase functions:secrets:set RAZORPAY_KEY_SECRET
const RAZORPAY_KEY_ID = defineSecret("RAZORPAY_KEY_ID");
const RAZORPAY_KEY_SECRET = defineSecret("RAZORPAY_KEY_SECRET");

// ---------------------------------------------------------------------------
// PLACEHOLDER CATALOG — mirrors packages.html's placeholder pricing exactly.
// This is the server-side source of truth for prices. When RIED's real
// services/pricing list is ready, update ONLY this object (and packages.html's
// displayed copy) — the checkout logic below never needs to change.
// Amounts are in whole INR rupees; Razorpay wants paise (rupees * 100).
// ---------------------------------------------------------------------------
const PACKAGE_CATALOG = {
  "incorporation-basic":     { name: "Incorporation — Basic",     amount: 15000 },
  "incorporation-standard":  { name: "Incorporation — Standard",  amount: 25000 },
  "incorporation-premium":   { name: "Incorporation — Premium",   amount: 45000 },
  "grant-basic":             { name: "Grant Readiness — Basic",    amount: 20000 },
  "grant-standard":          { name: "Grant Readiness — Standard", amount: 35000 },
  "grant-premium":           { name: "Grant Readiness — Premium",  amount: 60000 },
  "scaleup-basic":           { name: "Scale-Up — Basic",          amount: 30000 },
  "scaleup-standard":        { name: "Scale-Up — Standard",       amount: 55000 },
  "scaleup-premium":         { name: "Scale-Up — Premium",        amount: 95000 },
  "legal-basic":             { name: "Legal Services — Basic",    amount: 12000 },
  "legal-standard":          { name: "Legal Services — Standard", amount: 25000 },
  "legal-premium":           { name: "Legal Services — Premium",  amount: 50000 }
};

exports.createRazorpayOrder = onCall(
  { secrets: [RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET] },
  async (request) => {
    const packageId = request.data && request.data.packageId;
    const pkg = PACKAGE_CATALOG[packageId];

    if (!pkg) {
      throw new HttpsError("invalid-argument", "Unknown package selected.");
    }

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
        uid: request.auth ? request.auth.uid : "guest"
      }
    });

    // Record the attempt before payment completes, so we have a record even
    // if the user closes the tab mid-checkout.
    await db.collection("orders").doc(order.id).set({
      packageId,
      packageName: pkg.name,
      amount: pkg.amount,
      status: "created",
      uid: request.auth ? request.auth.uid : null,
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
  { secrets: [RAZORPAY_KEY_SECRET] },
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

    return { verified: true };
  }
);
