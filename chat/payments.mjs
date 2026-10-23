// Direct-booking payments through our own Stripe account.
//
// Order of operations, so a guest is never charged for dates they can't have:
//   1. startPayment: a PaymentIntent with manual capture. Confirming it in the browser
//      (Stripe's Payment Element, including 3D Secure) only authorises the card: a hold.
//   2. finalize: re-read the quote from Guesty, create the Reserved reservation (blocks the
//      calendar and Airbnb), then capture the payment. If Guesty refuses (dates just taken),
//      the hold is cancelled and the guest isn't charged.
// finalize runs from the browser after payment and from the Stripe webhook as a backup
// (e.g. the guest closed the tab during 3D Secure), so it is idempotent: the reservation id
// is saved on the PaymentIntent before capture, and concurrent calls share one run.
//
// Test keys (sk_test_) never create real Guesty reservations: finalize fakes that step.

import Stripe from "stripe";
import * as guesty from "./guesty.mjs";

const { STRIPE_SECRET_KEY: SECRET = "", STRIPE_PUBLISHABLE_KEY: PUBLISHABLE = "", STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET = "" } = process.env;
export const testMode = SECRET.startsWith("sk_test_");
// Both keys must come from the same Stripe account and the same mode.
export const configured = /^sk_(test|live)_/.test(SECRET) && PUBLISHABLE.startsWith(testMode ? "pk_test_" : "pk_live_");
export const publishableKey = PUBLISHABLE;
export const webhookConfigured = Boolean(WEBHOOK_SECRET);
const stripe = configured ? new Stripe(SECRET) : null;

const pence = n => Math.round(n * 100);
const fail = (status, message) => Object.assign(new Error(message), { status });

/** Create the payment for a Guesty quote. The amount comes from Guesty, never the browser. */
export async function startPayment(quote, guest, { marketing }) {
  const pi = await stripe.paymentIntents.create({
    amount: pence(quote.total),
    currency: quote.currency.toLowerCase(),
    capture_method: "manual",
    automatic_payment_methods: { enabled: true },
    receipt_email: guest.email,
    description: `${guesty.NAMES[quote.stay]}: ${quote.checkIn} to ${quote.checkOut}, ${quote.guests} guests`,
    metadata: {
      quoteId: quote.quoteId, ratePlanId: quote.ratePlanId,
      stay: quote.stay, checkIn: quote.checkIn, checkOut: quote.checkOut, guests: String(quote.guests),
      firstName: guest.firstName, lastName: guest.lastName, email: guest.email, phone: guest.phone || "",
      marketing: marketing ? "yes" : "no", termsAcceptedAt: new Date().toISOString(),
    },
  });
  return { clientSecret: pi.client_secret };
}

const running = new Map(); // PaymentIntent id -> finalize promise

/** Reserve in Guesty and take the payment. Safe to call more than once for the same payment. */
export function finalize(paymentIntentId) {
  if (!running.has(paymentIntentId)) running.set(paymentIntentId, run(paymentIntentId).finally(() => running.delete(paymentIntentId)));
  return running.get(paymentIntentId);
}

async function run(id) {
  let pi = await stripe.paymentIntents.retrieve(id);
  const m = pi.metadata;
  const done = () => ({ reference: pi.metadata.reference, test: testMode, stay: m.stay, checkIn: m.checkIn, checkOut: m.checkOut, email: m.email });

  if (pi.status === "succeeded" && m.reservationId) return done();
  if (pi.status !== "requires_capture") throw fail(402, "Your payment wasn't completed, so nothing has been booked. Please try again.");

  if (!m.reservationId) {
    const release = async () => { await stripe.paymentIntents.cancel(id).catch(e => console.error("[booking] couldn't release hold", id, e.message)); };

    let quote;
    try { quote = await guesty.getQuote(m.quoteId); } catch (err) {
      await release();
      throw err.guestyStatus === 404 ? fail(410, "This price has expired. You haven't been charged; please start again to get an up-to-date price.") : err;
    }
    if (pence(quote.total) !== pi.amount || quote.checkIn !== m.checkIn || quote.checkOut !== m.checkOut) {
      await release();
      throw fail(409, "The price for these dates has changed. You haven't been charged; please start again.");
    }

    let reservation;
    try {
      reservation = testMode
        ? { reservationId: `test_${id.slice(-12)}` }
        : await guesty.reserveQuote({
            quoteId: m.quoteId,
            ratePlanId: m.ratePlanId,
            guest: { firstName: m.firstName, lastName: m.lastName, email: m.email, ...(m.phone ? { phone: m.phone } : {}) },
            policy: {
              termsAndConditions: { isAccepted: true, dateOfAcceptance: m.termsAcceptedAt },
              privacy: { isAccepted: true, dateOfAcceptance: m.termsAcceptedAt, version: 1 },
              marketing: { isAccepted: m.marketing === "yes" },
            },
          });
    } catch (err) {
      await release();
      throw err;
    }
    // Save before capturing: a retry must never create a second reservation.
    pi = await stripe.paymentIntents.update(id, {
      metadata: { reservationId: reservation.reservationId, reference: reservation.reservationId.slice(-8).toUpperCase() },
    });
  }

  try {
    pi = await stripe.paymentIntents.capture(id);
  } catch (err) {
    // The dates are reserved but the money wasn't taken: needs a person to follow up.
    console.error(`[booking] ACTION NEEDED: reservation ${pi.metadata.reservationId} is held but capturing ${id} failed: ${err.message}`);
    throw fail(502, `Your dates are held but we couldn't complete the payment. Please contact us quoting ${pi.metadata.reference}.`);
  }
  console.log(`[booking] ${testMode ? "TEST " : ""}confirmed ${pi.metadata.reference}: ${m.stay} ${m.checkIn}..${m.checkOut}, reservation ${pi.metadata.reservationId}, payment ${id}`);
  return done();
}

/** Stripe webhook: finish bookings whose browser never came back after paying. */
export async function handleWebhook(rawBody, signature) {
  const event = stripe.webhooks.constructEvent(rawBody, signature, WEBHOOK_SECRET); // throws if not from Stripe
  if (event.type === "payment_intent.amount_capturable_updated") {
    finalize(event.data.object.id).catch(err => console.error("[webhook] finalize failed", event.data.object.id, err.message));
  }
}
