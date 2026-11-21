// Direct-booking payments through our own Stripe account.
//
// Order of operations, so a guest is never charged for dates they can't have:
//   1. startPayment: a PaymentIntent with manual capture for a pending booking in our database.
//      Confirming it in the browser (Stripe's Payment Element, including 3D Secure) only
//      authorises the card: a hold.
//   2. finalize: re-read the quote from Guesty, create the Reserved reservation (blocks the
//      calendar and Airbnb), then capture the payment and email the guest. If Guesty refuses
//      (dates just taken), the hold is cancelled and the guest isn't charged.
// finalize runs from the browser after payment and from the Stripe webhook as a backup
// (e.g. the guest closed the tab during 3D Secure), so it is idempotent: the Guesty
// reservation id is saved on the booking before capture, and concurrent calls share one run.
//
// Guest details stay in our database (bookings.mjs). Stripe gets only our booking id and
// reference; Guesty gets an anonymous placeholder guest named after the reference.
// Test keys (sk_test_/rk_test_) never create real Guesty reservations: finalize fakes that step.

import Stripe from "stripe";
import * as guesty from "./guesty.mjs";
import * as bookings from "./bookings.mjs";
import * as notify from "./notify.mjs";

const { STRIPE_SECRET_KEY: SECRET = "", STRIPE_PUBLISHABLE_KEY: PUBLISHABLE = "", STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET = "" } = process.env;
// A restricted key (rk_...) limited to PaymentIntents is recommended over the full secret key (sk_...).
export const testMode = /^(sk|rk)_test_/.test(SECRET);
// Both keys must come from the same Stripe account and the same mode.
export const configured = /^(sk|rk)_(test|live)_/.test(SECRET) && PUBLISHABLE.startsWith(testMode ? "pk_test_" : "pk_live_");
export const publishableKey = PUBLISHABLE;
export const webhookConfigured = Boolean(WEBHOOK_SECRET);
const stripe = configured ? new Stripe(SECRET) : null;

// The email on every direct booking's Guesty reservation, instead of the guest's own.
// Use a mailbox you control: Guesty may send its automatic messages there.
const GUESTY_GUEST_EMAIL = process.env.GUESTY_GUEST_EMAIL || "";
export const guestyPlaceholderConfigured = testMode || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(GUESTY_GUEST_EMAIL);

const fail = (status, message) => Object.assign(new Error(message), { status });

/** Start paying for a pending booking. The amount was set from Guesty's quote, never the browser. */
export async function startPayment(booking) {
  const pi = await stripe.paymentIntents.create({
    amount: booking.amount_pence,
    currency: booking.currency.toLowerCase(),
    capture_method: "manual",
    automatic_payment_methods: { enabled: true },
    description: `${guesty.NAMES[booking.stay]}, booking ${booking.reference}`,
    metadata: { bookingId: booking.id, reference: booking.reference }, // no personal data
  });
  bookings.setPayment(booking.id, pi.id);
  return { clientSecret: pi.client_secret };
}

const running = new Map(); // PaymentIntent id -> finalize promise

/** Reserve in Guesty and take the payment. Safe to call more than once for the same payment. */
export function finalize(paymentIntentId) {
  if (!running.has(paymentIntentId)) running.set(paymentIntentId, run(paymentIntentId).finally(() => running.delete(paymentIntentId)));
  return running.get(paymentIntentId);
}

const result = b => ({ reference: b.reference, test: Boolean(b.test), stay: b.stay, checkIn: b.check_in, checkOut: b.check_out, email: b.email });

async function run(id) {
  let pi = await stripe.paymentIntents.retrieve(id);
  const booking = bookings.get(pi.metadata.bookingId);
  if (!booking || booking.payment_intent_id !== id) throw fail(404, "We couldn't find this booking. If you've been charged, please contact us.");

  if (pi.status === "succeeded" && booking.status === "confirmed") return result(booking);
  if (pi.status !== "requires_capture") throw fail(402, "Your payment wasn't completed, so nothing has been booked. Please try again.");

  if (!booking.guesty_reservation_id) {
    const release = async () => {
      bookings.setStatus(booking.id, "failed");
      await stripe.paymentIntents.cancel(id).catch(e => console.error("[booking] couldn't release hold", id, e.message));
    };

    let quote;
    try { quote = await guesty.getQuote(booking.quote_id); } catch (err) {
      await release();
      throw err.guestyStatus === 404 ? fail(410, "This price has expired. You haven't been charged; please start again to get an up-to-date price.") : err;
    }
    if (Math.round(quote.total * 100) !== pi.amount || pi.amount !== booking.amount_pence || quote.checkIn !== booking.check_in || quote.checkOut !== booking.check_out) {
      await release();
      throw fail(409, "The price for these dates has changed. You haven't been charged; please start again.");
    }

    let reservationId;
    try {
      reservationId = testMode
        ? `test_${booking.reference}`
        : (await guesty.reserveQuote({
            quoteId: booking.quote_id,
            ratePlanId: booking.rate_plan_id,
            // Anonymous on purpose: Guesty only needs to block the dates.
            guest: { firstName: "Direct booking", lastName: booking.reference, email: GUESTY_GUEST_EMAIL },
            policy: { termsAndConditions: { isAccepted: true, dateOfAcceptance: booking.terms_accepted_at } },
          })).reservationId;
    } catch (err) {
      await release();
      throw err;
    }
    // Save before capturing: a retry must never create a second reservation.
    bookings.setReservation(booking.id, reservationId);
  }

  try {
    pi = await stripe.paymentIntents.capture(id);
  } catch (err) {
    // The dates are reserved but the money wasn't taken: needs a person to follow up.
    console.error(`[booking] ACTION NEEDED: booking ${booking.reference} holds dates in Guesty but capturing ${id} failed: ${err.message}`);
    throw fail(502, `Your dates are held but we couldn't complete the payment. Please contact us quoting ${booking.reference}.`);
  }
  bookings.setStatus(booking.id, "confirmed");
  console.log(`[booking] ${testMode ? "TEST " : ""}confirmed ${booking.reference}: ${booking.stay} ${booking.check_in}..${booking.check_out}, payment ${id}`);
  sendConfirmation(booking).catch(err => console.error(`[booking] confirmation email for ${booking.reference} failed:`, err.message));
  return result(booking);
}

// Our own confirmation email (Stripe receipts are off: Stripe doesn't get the guest's email).
async function sendConfirmation(b) {
  const name = guesty.NAMES[b.stay];
  const day = s => new Date(`${s}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  const total = new Intl.NumberFormat("en-GB", { style: "currency", currency: b.currency }).format(b.amount_pence / 100);
  const lines = [
    `Hi ${b.first_name},`, "",
    `Your stay at ${name} is confirmed.`, "",
    `Booking reference: ${b.reference}`,
    `Check-in: ${day(b.check_in)}, after 16:00`,
    `Check-out: ${day(b.check_out)}, before 10:00`,
    `Guests: ${b.guest_count}`,
    `Paid: ${total}`, "",
    "We'll send check-in instructions before you arrive. Reply to this email if you have any questions.", "",
    "Bath Retreats",
  ];
  const esc = v => String(v).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  await notify.sendEmail({
    to: b.email,
    subject: `Booking confirmed: ${name}, ${b.reference}`,
    text: lines.join("\n"),
    html: lines.map(l => (l ? `<p style="margin:0 0 4px">${esc(l)}</p>` : "<br>")).join(""),
  }, { logOnly: testMode });
}

/** Stripe webhook: finish bookings whose browser never came back after paying. */
export async function handleWebhook(rawBody, signature) {
  const event = stripe.webhooks.constructEvent(rawBody, signature, WEBHOOK_SECRET); // throws if not from Stripe
  if (event.type === "payment_intent.amount_capturable_updated") {
    finalize(event.data.object.id).catch(err => console.error("[webhook] finalize failed", event.data.object.id, err.message));
  }
}
