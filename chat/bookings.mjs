// Guests and their direct bookings, in our own database (db.mjs).
//
// A booking row is created when the guest starts paying (status pending_payment) and becomes
// confirmed once the dates are reserved in Guesty and the payment is captured (payments.mjs).
// Checkouts that are never paid (or fail because the dates went) are deleted after 7 days,
// so we don't keep personal data without a booking to justify it.

import { randomUUID, randomBytes } from "node:crypto";
import { db, tx, now } from "./db.mjs";

const REF_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no look-alikes (0/O, 1/I)
const newReference = () => [...randomBytes(8)].map(b => REF_CHARS[b % REF_CHARS.length]).join("");
const ABANDONED_AFTER_DAYS = 7;

const q = {
  findGuest: db.prepare("SELECT id, marketing_opt_in FROM guests WHERE email = ?"),
  insertGuest: db.prepare(`INSERT INTO guests (id, email, first_name, last_name, phone, marketing_opt_in, created_at, updated_at)
                           VALUES ($id, $email, $first, $last, $phone, $marketing, $now, $now)`),
  // Latest name/phone win. Marketing consent is only ever added here: an unticked box isn't a withdrawal.
  updateGuest: db.prepare(`UPDATE guests SET first_name = $first, last_name = $last, phone = coalesce($phone, phone),
                           marketing_opt_in = max(marketing_opt_in, $marketing), updated_at = $now WHERE id = $id`),
  insertBooking: db.prepare(`INSERT INTO bookings (id, reference, guest_id, stay, check_in, check_out, guest_count, amount_pence, currency,
                             status, quote_id, rate_plan_id, test, terms_accepted_at, created_at, updated_at)
                             VALUES ($id, $reference, $guest, $stay, $in, $out, $count, $amount, $currency,
                             'pending_payment', $quote, $ratePlan, $test, $now, $now, $now)`),
  get: db.prepare(`SELECT b.*, g.email, g.first_name, g.last_name, g.phone FROM bookings b JOIN guests g ON g.id = b.guest_id WHERE b.id = ?`),
  setPayment: db.prepare("UPDATE bookings SET payment_intent_id = ?, updated_at = ? WHERE id = ?"),
  setReservation: db.prepare("UPDATE bookings SET guesty_reservation_id = ?, updated_at = ? WHERE id = ?"),
  setStatus: db.prepare("UPDATE bookings SET status = ?, updated_at = ? WHERE id = ?"),
  list: db.prepare(`SELECT b.id, b.reference, b.stay, b.check_in, b.check_out, b.guest_count, b.amount_pence, b.currency, b.status,
                    b.test, b.created_at, g.first_name, g.last_name, g.email, g.phone, g.marketing_opt_in
                    FROM bookings b JOIN guests g ON g.id = b.guest_id
                    WHERE b.status != 'pending_payment' ORDER BY b.created_at DESC LIMIT 500`),
  // Never purge a booking that holds dates in Guesty (e.g. capture failed and needs follow-up).
  purgeBookings: db.prepare(`DELETE FROM bookings WHERE status IN ('pending_payment', 'failed')
                             AND guesty_reservation_id IS NULL AND created_at < ?`),
  purgeGuests: db.prepare("DELETE FROM guests WHERE id NOT IN (SELECT guest_id FROM bookings)"),
};

/** Save the guest (matched by email) and a pending booking for this quote. */
export function create({ quote, guest, marketing, test }) {
  return tx(() => {
    const t = now(), existing = q.findGuest.get(guest.email);
    const person = { $first: guest.firstName, $last: guest.lastName, $phone: guest.phone ?? null, $marketing: marketing ? 1 : 0, $now: t };
    const guestId = existing?.id ?? randomUUID();
    if (existing) q.updateGuest.run({ ...person, $id: guestId });
    else q.insertGuest.run({ ...person, $id: guestId, $email: guest.email });

    const booking = {
      $id: randomUUID(), $guest: guestId, $stay: quote.stay, $in: quote.checkIn, $out: quote.checkOut, $count: quote.guests,
      $amount: Math.round(quote.total * 100), $currency: quote.currency, $quote: quote.quoteId, $ratePlan: quote.ratePlanId,
      $test: test ? 1 : 0, $now: t,
    };
    for (let attempt = 0; ; attempt++) { // references are random: retry on the rare collision
      try {
        q.insertBooking.run({ ...booking, $reference: newReference() });
        break;
      } catch (err) {
        if (attempt > 3 || !/UNIQUE constraint failed: bookings.reference/.test(err.message)) throw err;
      }
    }
    return get(booking.$id);
  });
}

/** A booking with its guest's contact details, or undefined. */
export const get = id => q.get.get(id);
export const setPayment = (id, paymentIntentId) => q.setPayment.run(paymentIntentId, now(), id);
export const setReservation = (id, reservationId) => q.setReservation.run(reservationId, now(), id);
export const setStatus = (id, status) => q.setStatus.run(status, now(), id);

/** Bookings for the admin page (not abandoned checkouts), newest first. */
export const list = () => q.list.all();

/** Delete checkouts that were never paid, and guests left with no bookings. */
export function purgeAbandoned() {
  const cutoff = new Date(Date.now() - ABANDONED_AFTER_DAYS * 864e5).toISOString();
  tx(() => { q.purgeBookings.run(cutoff); q.purgeGuests.run(); });
}
purgeAbandoned();
setInterval(purgeAbandoned, 864e5).unref();
