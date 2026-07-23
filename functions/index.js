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

admin.initializeApp();
const db = admin.firestore();

// Same Web3Forms access key already used client-side on contact.html's Idea
// form. Web3Forms access keys are designed to be public (they work exactly
// like this in a browser, visible to anyone who views source) — the key
// itself doesn't grant access to anything, it just tells Web3Forms which
// inbox to deliver to, so there's nothing to protect by hiding it in a secret.
const WEB3FORMS_ACCESS_KEY = "ba854359-f604-44a8-8556-96657c5f5c4d";
const IS_INDIVIDUAL_VALUE = "Individual / No Company Yet";

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

/**
 * notifyOnProfileSubmit
 *
 * Fires whenever a founder's onboarding profile (profile-setup.html) is
 * created OR resubmitted after an edit — /profiles/{uid} in Firestore.
 * Builds a plain-text summary of everything the founder entered and emails
 * it to hello@ried.co.in via Web3Forms (the same service the Idea form on
 * contact.html already uses), attaching the founder's logo if one was
 * uploaded.
 *
 * We only actually send when `submittedAt` changes between before/after —
 * that's the field the wizard's submitProfile() always refreshes with a
 * fresh server timestamp, so it uniquely marks "the founder just hit
 * Submit," as opposed to some other future write to this same document
 * (e.g. a Flywheel stage update) that shouldn't re-trigger an email.
 */
exports.notifyOnProfileSubmit = onDocumentWritten("profiles/{uid}", async (event) => {
  const afterSnap = event.data.after;
  if (!afterSnap.exists) return; // profile deleted — nothing to notify

  const after = afterSnap.data();
  const beforeSnap = event.data.before;
  const before = beforeSnap.exists ? beforeSnap.data() : null;

  const afterTs = after.submittedAt ? after.submittedAt.toMillis() : null;
  const beforeTs = before && before.submittedAt ? before.submittedAt.toMillis() : null;
  if (!afterTs || afterTs === beforeTs) return;

  const uid = event.params.uid;
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

  lines.push(`Flywheel Stage: ${after.flywheelStage || "founder-discovery"}`);
  lines.push(`Profile UID: ${uid}`);

  const message = lines.join("\n");

  const formData = new FormData();
  formData.append("access_key", WEB3FORMS_ACCESS_KEY);
  formData.append("subject", `${isEdit ? "Updated" : "New"} Founder Profile — ${after.fullName || after.email || uid}`);
  formData.append("from_name", "RIED Website — Founder Profile");
  formData.append("name", after.fullName || after.email || "RIED Founder");
  formData.append("email", after.email || "hello@ried.co.in");
  formData.append("message", message);

  // Attach the logo, if one was uploaded. logoURL is a Firebase Storage
  // download URL — it carries its own access token, so a plain fetch works
  // here without needing the Admin SDK to read Storage directly.
  if (after.logoURL) {
    try {
      const res = await fetch(after.logoURL);
      if (res.ok) {
        const arrayBuffer = await res.arrayBuffer();
        const contentType = res.headers.get("content-type") || "image/png";
        const ext = contentType.split("/")[1] || "png";
        formData.append("attachment", new Blob([arrayBuffer], { type: contentType }), `logo.${ext}`);
      }
    } catch (e) {
      logger.warn("notifyOnProfileSubmit: could not fetch logo for email attachment", e);
    }
  }

  try {
    const res = await fetch("https://api.web3forms.com/submit", {
      method: "POST",
      headers: { Accept: "application/json" },
      body: formData
    });
    const result = await res.json();
    if (!result.success) {
      logger.error("notifyOnProfileSubmit: Web3Forms reported failure", result);
    }
  } catch (e) {
    logger.error("notifyOnProfileSubmit: failed to send email", e);
  }
});
