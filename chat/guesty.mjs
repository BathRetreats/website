// Guesty Booking Engine API: live availability for the booking calendar.
//
// Guesty (run by the property manager) is the source of truth: it syncs with Airbnb,
// so showing its calendar on the site means guests only ever pick dates that are free.
//
// Two limits shape this module:
//   - Access tokens last 24h and Guesty caps how many can be requested per day, so the
//     token is cached in memory and in .guesty-token.json (gitignored) across restarts.
//   - The API is rate-limited (5 req/s), so each calendar is cached for a few minutes and
//     every visitor is served from that cache. If Guesty is down, the last copy is served.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const BASE = "https://booking.guesty.com";
const TOKEN_FILE = path.join(here, ".guesty-token.json");
const CALENDAR_TTL_MS = 5 * 60 * 1000;
const DAYS_AHEAD = 365;

// Guesty listing ids (not secret). Keys match the site's STAYS in script.js.
export const LISTINGS = {
  abbey: "66fbdfb84a4fa60013712b53",
  manor: "66fbdc7b90b597001137646f",
};
export const NAMES = { abbey: "Abbey Views", manor: "Longscroft Manor" };

const { GUESTY_CLIENT_ID: CLIENT_ID, GUESTY_CLIENT_SECRET: CLIENT_SECRET } = process.env;
export const configured = Boolean(CLIENT_ID && CLIENT_SECRET);

/* ---------- auth ---------- */
let token = null;      // { value, expiresAt }
let tokenRequest = null; // shared in-flight request, so concurrent visitors don't each ask for a token

try { token = JSON.parse(readFileSync(TOKEN_FILE, "utf8")); } catch { /* no cached token yet */ }

async function getToken() {
  if (token && token.expiresAt > Date.now() + 5 * 60 * 1000) return token.value;
  tokenRequest ??= (async () => {
    const res = await fetch(`${BASE}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ grant_type: "client_credentials", scope: "booking_engine:api", client_id: CLIENT_ID, client_secret: CLIENT_SECRET }),
    });
    if (!res.ok) throw new Error(`Guesty token request failed (HTTP ${res.status})`);
    const body = await res.json();
    token = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
    try { writeFileSync(TOKEN_FILE, JSON.stringify(token), { mode: 0o600 }); } catch { /* read-only disk: memory cache still works */ }
    return token.value;
  })().finally(() => { tokenRequest = null; });
  return tokenRequest;
}

async function api(pathname, body) {
  const res = await fetch(`${BASE}${pathname}`, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${await getToken()}`, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (res.status === 401) token = null; // revoked or expired early: fetch a fresh one next time
  if (!res.ok) {
    const { error } = await res.json().catch(() => ({}));
    throw Object.assign(new Error(`Guesty ${pathname.split("?")[0]} failed (HTTP ${res.status}${error?.code ? ` ${error.code}` : ""})`),
      { guestyStatus: res.status, guestyCode: error?.code, guestyMessage: error?.message, requestId: error?.data?.requestId });
  }
  return res.json();
}

/* ---------- calendar ---------- */
const iso = d => d.toISOString().slice(0, 10);
const calendars = new Map(); // stay -> { at, data, pending }

/**
 * Availability for the next year, one entry per night:
 *   { date, ok, min, max, cta?, ctd? }
 * ok = the night is free; min/max = stay length rules when arriving that day;
 * cta/ctd = closed to arrival/departure on that day.
 */
export async function getCalendar(stay) {
  const listingId = LISTINGS[stay];
  if (!listingId) throw Object.assign(new Error("Unknown stay"), { status: 400 });

  const cached = calendars.get(stay);
  if (cached?.data && Date.now() - cached.at < CALENDAR_TTL_MS) return cached.data;
  if (cached?.pending) return cached.pending;

  const from = new Date(), to = new Date(Date.now() + DAYS_AHEAD * 864e5);
  const pending = api(`/api/listings/${listingId}/calendar?from=${iso(from)}&to=${iso(to)}`)
    .then(days => {
      const data = {
        stay,
        updatedAt: new Date().toISOString(),
        days: days.map(d => ({
          date: d.date,
          ok: d.status === "available",
          min: d.minNights,
          max: d.maxNights,
          ...(d.cta ? { cta: true } : {}),
          ...(d.ctd ? { ctd: true } : {}),
        })),
      };
      calendars.set(stay, { at: Date.now(), data });
      return data;
    })
    .catch(err => {
      // Keep serving the last good copy rather than showing every date as free.
      // Retry in a minute, not on every visitor's request.
      if (cached?.data) {
        calendars.set(stay, { at: Date.now() - CALENDAR_TTL_MS + 60_000, data: cached.data });
        console.error(`[guesty] ${err.message}; serving cached calendar`);
        return cached.data;
      }
      calendars.delete(stay);
      throw err;
    });
  calendars.set(stay, { ...cached, pending });
  return pending;
}

/* ---------- quotes and reservations ---------- */
// A quote locks Guesty's price for 24h. Payment is taken by our own Stripe account (stripe.mjs);
// once the card is authorised, the quote becomes a "Reserved" reservation in Guesty, which
// blocks the calendar (and so Airbnb) until the manager confirms it. Prices always come from
// Guesty, never the browser.

const QUOTE_REUSE_MS = 30 * 60 * 1000; // the booking form and checkout page share one quote
const quotes = new Map(); // "stay|in|out|guests" -> { at, quote }

const toQuote = (q, stay) => {
  const plan = q.rates.ratePlans[0].ratePlan;
  const { currency, invoiceItems, subTotalPrice, totalTaxes } = plan.money;
  return {
    quoteId: q._id,
    ratePlanId: plan._id,
    expiresAt: q.expiresAt,
    stay,
    checkIn: q.checkInDateLocalized,
    checkOut: q.checkOutDateLocalized,
    guests: q.guestsCount,
    currency,
    lines: invoiceItems.map(i => ({ title: i.title, amount: i.amount })),
    total: Math.round((subTotalPrice + (totalTaxes || 0)) * 100) / 100,
    cancellationPolicy: plan.cancellationPolicy,
  };
};

/** Price a stay. Returns only what the booking pages need. */
export async function createQuote({ stay, checkIn, checkOut, guests }) {
  const key = `${stay}|${checkIn}|${checkOut}|${guests}`;
  const hit = quotes.get(key);
  if (hit && Date.now() - hit.at < QUOTE_REUSE_MS) return hit.quote;
  const q = await api("/api/reservations/quotes", {
    listingId: LISTINGS[stay], checkInDateLocalized: checkIn, checkOutDateLocalized: checkOut, guestsCount: guests,
  });
  const quote = toQuote(q, stay);
  quotes.set(key, { at: Date.now(), quote });
  for (const [k, v] of quotes) if (Date.now() - v.at > QUOTE_REUSE_MS) quotes.delete(k);
  return quote;
}

/** Re-read a quote from Guesty, so the amount charged never depends on what the browser sends. */
export async function getQuote(quoteId) {
  const q = await api(`/api/reservations/quotes/${quoteId}`);
  const stay = Object.keys(LISTINGS).find(k => LISTINGS[k] === q.unitTypeId);
  if (!stay) throw new Error("Quote is for an unknown listing");
  return toQuote(q, stay);
}

/** Turn a paid-for quote into a Reserved reservation (blocks the dates; no card is given to Guesty). */
export async function reserveQuote({ quoteId, ratePlanId, guest, policy }) {
  const r = await api(`/api/reservations/quotes/${quoteId}/inquiry`, { ratePlanId, guest, policy, reservedUntil: -1 });
  calendars.clear(); // the booked nights must disappear from every visitor's calendar now
  for (const [k, v] of quotes) if (v.quote.quoteId === quoteId) quotes.delete(k);
  return { reservationId: r._id, status: r.status };
}
