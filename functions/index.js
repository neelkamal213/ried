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
