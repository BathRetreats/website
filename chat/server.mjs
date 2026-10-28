// Bath Retreats guest assistant: RAG chat API + static file server for the site.
//
//   npm start            -> rebuilds knowledge.json, then serves http://localhost:3000
//
// Environment:
//   ANTHROPIC_API_KEY    required for real answers (never sent to the browser)
//   CHAT_MODEL           default claude-opus-5
//   CHAT_EFFORT          default low (short factual answers don't need deep reasoning)
//   PORT                 default 3000
//   ALLOWED_ORIGIN       set when the site is hosted on a different domain than this API
//   CHAT_MOCK=1          demo/UI testing without a key: answers with the top retrieved source
//   LOG_QUESTIONS=1      also log guest questions (off by default for privacy)
//   GUESTY_CLIENT_ID     Guesty Booking Engine API key, for live availability on the booking calendar
//   GUESTY_CLIENT_SECRET
//   STRIPE_SECRET_KEY / STRIPE_PUBLISHABLE_KEY  our Stripe account (sk_test_/pk_test_ for testing)
//   STRIPE_WEBHOOK_SECRET  whsec_... for /api/stripe-webhook (finishes bookings if the guest's browser drops)
//   DIRECT_BOOKING=1     take paid bookings on the site (otherwise guests are sent to Airbnb)
//   ADMIN_PASSWORD       password for admin.html (bookings and review approval)
//   GUESTY_GUEST_EMAIL   placeholder email on direct bookings' Guesty reservations (guest details stay in our database)
//   DATABASE_PATH        SQLite file (default chat/data/app.db); must be on a persistent, backed-up disk in production
//   PUBLIC_URL           the site's address, used in links sent by email/SMS (default http://localhost:PORT)
//   RESEND_API_KEY + EMAIL_FROM                        email for "continue on your phone" links
//   TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + TWILIO_FROM  SMS for the same links
//
// Locally these are read from chat/.env (gitignored); see .env.example.

import http from "node:http";
import { readFileSync, existsSync, statSync, createReadStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { buildIndex, search } from "./retrieval.mjs";
import * as guesty from "./guesty.mjs";
import * as payments from "./payments.mjs";
import * as reviews from "./reviews.mjs";
import * as bookings from "./bookings.mjs";
import * as handoffs from "./handoffs.mjs";
import * as notify from "./notify.mjs";
import { createHash, timingSafeEqual } from "node:crypto";

const here = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.resolve(here, "..");
const PORT = Number(process.env.PORT) || 3000;
const MODEL = process.env.CHAT_MODEL || "claude-opus-5";
const EFFORT = process.env.CHAT_EFFORT || "low";
const MOCK = process.env.CHAT_MOCK === "1";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "";

// Limits for a public endpoint: keep requests small and cheap.
const MAX_TURNS = 12;            // messages of history accepted per request
const MAX_USER_CHARS = 800;
const MAX_ASSISTANT_CHARS = 4000;
const MAX_BODY_BYTES = 48 * 1024;
const RATE_LIMIT = { max: 20, windowMs: 10 * 60 * 1000 }; // per IP

/* ---------- knowledge base ---------- */
const KB_PATH = path.join(here, "knowledge.json");
if (!existsSync(KB_PATH)) {
  console.error("knowledge.json is missing. Run `npm run build:index` first.");
  process.exit(1);
}
const { chunks, builtAt } = JSON.parse(readFileSync(KB_PATH, "utf8"));
const index = buildIndex(chunks);

/* ---------- model ---------- */
const client = MOCK ? null : new Anthropic(); // reads ANTHROPIC_API_KEY from the environment
const hasKey = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

const SYSTEM_PROMPT = `You are the guest assistant on the Bath Retreats website. Bath Retreats looks after two holiday rentals: Abbey Views, a one-bedroom apartment for two facing Bath Abbey in Bath city centre, and Longscroft Manor, a five-bedroom manor near Bradford-on-Avon in Wiltshire that sleeps 12. Visitors ask you about the properties, booking, and things to do nearby.

Answer from the <sources> in the latest message, which are excerpts retrieved from the website. If they don't contain the answer, say you don't have that detail and suggest contacting the host or using "Check availability" on the site, rather than guessing. This matters most for prices, availability, house rules and accessibility, where a confident wrong answer could mislead a guest. You never have live prices or availability, so point those questions to the booking form.

Cite the sources you use with their number in square brackets, like [2], placed after the sentence they support. Keep answers short and warm: usually two to four sentences of plain text, with a short "- " list only when listing several items, and no headings. If it's unclear which property a question is about, answer for both or ask. Politely decline requests that have nothing to do with the properties, staying with us, or the Bath area.`;

/* ---------- helpers ---------- */
const hits = new Map();
function rateLimited(ip, bucket = "chat", max = RATE_LIMIT.max) {
  const key = `${bucket}:${ip}`;
  const now = Date.now();
  const recent = (hits.get(key) || []).filter(t => now - t < RATE_LIMIT.windowMs);
  recent.push(now);
  hits.set(key, recent);
  return recent.length > max;
}
const clientIp = req => req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.socket.remoteAddress;
setInterval(() => { // keep the rate-limit map from growing forever
  const now = Date.now();
  for (const [ip, ts] of hits) if (!ts.some(t => now - t < RATE_LIMIT.windowMs)) hits.delete(ip);
}, RATE_LIMIT.windowMs).unref();

function readBody(req, max = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts = [];
    req.on("data", c => {
      size += c.length;
      if (size > max) { reject(Object.assign(new Error("Request too large"), { status: 413 })); req.destroy(); }
      else parts.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(parts)));
    req.on("error", reject);
  });
}
async function readJson(req) {
  const raw = await readBody(req);
  try { return JSON.parse(raw.toString("utf8")); }
  catch { throw Object.assign(new Error("Invalid JSON"), { status: 400 }); }
}

// Accept only a well-formed, alternating user/assistant history ending on the user.
function validate(body) {
  const msgs = Array.isArray(body?.messages) ? body.messages.slice(-MAX_TURNS) : null;
  if (!msgs?.length) return "messages must be a non-empty array";
  if (msgs[0]?.role !== "user") msgs.shift();
  if (!msgs.length) return "messages must include a user message";
  for (const [i, m] of msgs.entries()) {
    const want = i % 2 === 0 ? "user" : "assistant";
    if (m?.role !== want || typeof m.content !== "string" || !m.content.trim()) return "messages must alternate user/assistant text";
    const max = m.role === "user" ? MAX_USER_CHARS : MAX_ASSISTANT_CHARS;
    if (m.content.length > max) return `message too long (max ${max} characters)`;
  }
  if (msgs.at(-1).role !== "user") return "last message must be from the user";
  const page = ["abbey", "manor"].includes(body.page) ? body.page : null;
  return { msgs, page };
}

const escapeXml = s => s.replace(/[<>&]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]);

function sourcesBlock(results) {
  if (!results.length) return "<sources>\n(no matching content on the website)\n</sources>";
  return "<sources>\n" + results.map((r, i) =>
    `<source id="${i + 1}" title="${escapeXml(r.chunk.title)}">\n${escapeXml(r.chunk.text)}${r.chunk.link ? `\nGoogle Maps: ${r.chunk.link}` : ""}\n</source>`
  ).join("\n") + "\n</sources>";
}

/* ---------- /api/chat ---------- */
async function handleChat(req, res) {
  const ip = clientIp(req);
  if (rateLimited(ip)) return json(res, 429, { error: "You're sending messages quickly. Please wait a few minutes and try again." });

  let body;
  try { body = await readJson(req); } catch (e) { return json(res, e.status || 400, { error: e.message }); }
  const v = validate(body);
  if (typeof v === "string") return json(res, 400, { error: v });
  const { msgs, page } = v;

  if (!MOCK && !hasKey) return json(res, 503, { error: "The assistant isn't configured yet (missing ANTHROPIC_API_KEY on the server)." });

  // Retrieve with the latest question, plus the previous guest turns as lower-weighted
  // context so follow-ups ("and parking?") stay on the property being discussed.
  const question = msgs.at(-1).content.trim();
  const earlier = msgs.slice(0, -1).filter(m => m.role === "user").slice(-2).map(m => m.content).join(" ");
  const results = search(index, question, { context: earlier, pageStay: page, k: 6 });

  // Server-Sent Events: sources first (so the UI can show them), then text deltas.
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    ...corsHeaders(),
  });
  const send = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  send({ type: "sources", sources: results.map((r, i) => ({ n: i + 1, title: r.chunk.title, url: r.chunk.url, link: r.chunk.link })) });

  const started = Date.now();
  if (MOCK) {
    const top = results[0]?.chunk;
    const answer = top ? `${top.text} [1]` : "I don't have that detail on the website. Please contact the host or use Check availability.";
    for (const word of answer.split(/(?<= )/)) { send({ type: "text", text: word }); await new Promise(r => setTimeout(r, 12)); }
    send({ type: "done" });
    return res.end();
  }

  // History goes in as plain text; old [n] citations referred to old source sets, so strip them.
  const messages = msgs.map((m, i) => i === msgs.length - 1
    ? { role: "user", content: `${sourcesBlock(results)}\n\nGuest question: ${question}` }
    : { role: m.role, content: m.role === "assistant" ? m.content.replace(/\s*\[\d+\]/g, "") : m.content });

  let stream;
  // Guest closed the chat mid-answer: stop generating. (Listen on `res`: in current Node,
  // `req` emits "close" as soon as the body has been read.)
  res.on("close", () => { if (!res.writableEnded) stream?.abort(); });
  try {
    stream = client.beta.messages.stream({
      model: MODEL,
      max_tokens: 2048,                 // answers are a few sentences; caps cost on a public endpoint
      system: SYSTEM_PROMPT,
      messages,
      output_config: { effort: EFFORT },
      // If a safety classifier declines, re-run on Anthropic's recommended fallback model
      // instead of failing the guest's question.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") send({ type: "text", text: event.delta.text });
    }
    const final = await stream.finalMessage();
    if (final.stop_reason === "refusal") send({ type: "text", text: "Sorry, I can't help with that one. For anything about the properties, I'm happy to help." });
    send({ type: "done", stop_reason: final.stop_reason });
    log({ ip, page, question, results, usage: final.usage, ms: Date.now() - started, stop: final.stop_reason });
  } catch (err) {
    if (res.writableEnded || res.destroyed) return;
    let message = "Sorry, something went wrong on our side. Please try again in a moment.";
    if (err instanceof Anthropic.RateLimitError) message = "The assistant is busy right now. Please try again in a minute.";
    else if (err instanceof Anthropic.AuthenticationError) message = "The assistant isn't configured correctly (invalid API key).";
    console.error("[chat] error", err instanceof Anthropic.APIError ? `${err.status} ${err.message}` : err);
    send({ type: "error", message });
  }
  res.end();
}

function log({ ip, page, question, results, usage, ms, stop }) {
  const q = process.env.LOG_QUESTIONS === "1" ? ` q="${question.slice(0, 120)}"` : "";
  console.log(`[chat] ${new Date().toISOString()} page=${page ?? "-"} ${ms}ms stop=${stop} in=${usage?.input_tokens} out=${usage?.output_tokens}${q} sources=[${results.map(r => r.chunk.id).join(", ")}]`);
}

/* ---------- /api/availability ---------- */
async function handleAvailability(req, res) {
  if (!guesty.configured) return json(res, 503, { error: "Live availability isn't configured (missing Guesty credentials)." });
  const stay = new URL(req.url, "http://x").searchParams.get("stay");
  if (!guesty.LISTINGS[stay]) return json(res, 400, { error: "stay must be abbey or manor" });
  try {
    const data = await guesty.getCalendar(stay);
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=60", ...corsHeaders("GET") });
    res.end(JSON.stringify(data));
  } catch (err) {
    console.error("[availability]", err.message);
    json(res, err.status || 502, { error: "Couldn't load availability right now." });
  }
}

/* ---------- direct booking: /api/config, /api/quote, /api/checkout, /api/book ---------- */
// Off until DIRECT_BOOKING=1 with Stripe keys set; until then the booking form sends guests
// to Airbnb. The site also needs its Terms and Privacy pages before going live.
const DIRECT_BOOKING = process.env.DIRECT_BOOKING === "1" && guesty.configured && payments.configured && payments.guestyPlaceholderConfigured;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const QUOTE_ID = /^[a-f0-9]{24}$/;

function handleConfig(req, res) {
  json(res, 200, { directBooking: DIRECT_BOOKING, ...(DIRECT_BOOKING ? { stripeKey: payments.publishableKey, testMode: payments.testMode, handoff: HANDOFF } : {}) });
}

// Errors worth telling the guest about; anything else gets the fallback message.
function bookingError(res, err, fallback) {
  console.error("[booking]", err.message, err.guestyMessage || "", err.requestId ? `requestId=${err.requestId}` : "");
  if (err.guestyCode === "LISTING_IS_NOT_AVAILABLE") return json(res, 409, { error: "Sorry, those dates are no longer available. You haven't been charged. Please choose different dates." });
  if (err.guestyStatus === 404) return json(res, 410, { error: "This price has expired. Please start again to get an up-to-date price." });
  if (err.status && err.status < 600) return json(res, err.status, { error: err.message }); // our own messages (payments.mjs)
  json(res, 502, { error: fallback });
}

async function handleQuote(req, res) {
  if (!DIRECT_BOOKING) return json(res, 503, { error: "Direct booking isn't available yet." });
  if (rateLimited(clientIp(req), "quote", 60)) return json(res, 429, { error: "Too many requests. Please wait a few minutes and try again." });
  let b;
  try { b = await readJson(req); } catch (e) { return json(res, e.status || 400, { error: e.message }); }
  const guests = Number(b.guests);
  if (!guesty.LISTINGS[b.stay] || !DATE.test(b.checkIn) || !DATE.test(b.checkOut) || b.checkOut <= b.checkIn || !Number.isInteger(guests) || guests < 1 || guests > 16)
    return json(res, 400, { error: "Invalid stay, dates or guests." });
  try {
    json(res, 200, await guesty.createQuote({ stay: b.stay, checkIn: b.checkIn, checkOut: b.checkOut, guests }));
  } catch (err) {
    bookingError(res, err, "We couldn't get a price for those dates right now. Please try again.");
  }
}

// The guest's name, email and phone from a checkout form, trimmed; null if invalid.
function parseGuest(g = {}) {
  const text = (v, max) => typeof v === "string" && v.trim().length > 0 && v.length <= max;
  if (!text(g.firstName, 60) || !text(g.lastName, 60) || !text(g.email, 120) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(g.email.trim()) || (g.phone && !text(g.phone, 30))) return null;
  return { firstName: g.firstName.trim(), lastName: g.lastName.trim(), email: g.email.trim(), ...(g.phone?.trim() ? { phone: g.phone.trim() } : {}) };
}

// Guest details + quote -> a Stripe payment to confirm in the browser.
async function handleCheckout(req, res) {
  if (!DIRECT_BOOKING) return json(res, 503, { error: "Direct booking isn't available yet." });
  if (rateLimited(clientIp(req), "checkout", 10)) return json(res, 429, { error: "Too many booking attempts. Please wait a few minutes and try again." });
  let b;
  try { b = await readJson(req); } catch (e) { return json(res, e.status || 400, { error: e.message }); }
  if (!QUOTE_ID.test(b.quoteId)) return json(res, 400, { error: "Invalid booking request." });
  const guest = parseGuest(b.guest);
  if (!guest) return json(res, 400, { error: "Please check your name, email and phone number." });
  if (b.acceptedTerms !== true) return json(res, 400, { error: "Please accept the terms and privacy policy." });
  try {
    const quote = await guesty.getQuote(b.quoteId); // the price comes from Guesty, not the request
    const booking = bookings.create({ quote, guest, marketing: b.marketing === true, test: payments.testMode });
    json(res, 200, await payments.startPayment(booking));
  } catch (err) {
    bookingError(res, err, "We couldn't start the payment. Please try again.");
  }
}

// After the browser confirms the payment (card authorised): reserve in Guesty, then charge.
async function handleBook(req, res) {
  if (!DIRECT_BOOKING) return json(res, 503, { error: "Direct booking isn't available yet." });
  if (rateLimited(clientIp(req), "book", 10)) return json(res, 429, { error: "Too many requests. Please wait a few minutes and try again." });
  let b;
  try { b = await readJson(req); } catch (e) { return json(res, e.status || 400, { error: e.message }); }
  if (!/^pi_\w{10,}$/.test(b.paymentIntentId)) return json(res, 400, { error: "Invalid booking request." });
  try {
    json(res, 200, await payments.finalize(b.paymentIntentId));
  } catch (err) {
    bookingError(res, err, "Something went wrong and your booking wasn't completed. If you've been charged, please contact us.");
  }
}

async function handleStripeWebhook(req, res) {
  if (!payments.configured || !payments.webhookConfigured) return json(res, 503, { error: "Webhook not configured" });
  try {
    await payments.handleWebhook(await readBody(req, 512 * 1024), req.headers["stripe-signature"]);
    json(res, 200, { received: true });
  } catch (err) {
    console.error("[webhook]", err.message);
    json(res, 400, { error: "Invalid webhook" });
  }
}

/* ---------- continue on your phone: /api/handoff ---------- */
// Saves the checkout details for 24h and sends a short link by email and SMS. In Stripe test
// mode without email/SMS keys, the messages are printed to this console instead.
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const HANDOFF_LOG_ONLY = payments.testMode;
const HANDOFF = DIRECT_BOOKING && (notify.emailEnabled || notify.smsEnabled || HANDOFF_LOG_ONLY);
const HANDOFF_ID = /^[A-Za-z0-9]{12}$/;
const maskEmail = e => e.replace(/^(.)[^@]*(@.*)$/, "$1•••$2");
const shortDate = s => new Date(`${s}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

async function handleHandoffCreate(req, res) {
  if (!HANDOFF) return json(res, 503, { error: "Sending a payment link isn't available right now." });
  if (rateLimited(clientIp(req), "handoff", 3)) return json(res, 429, { error: "You've requested a few links already. Please wait a few minutes." });
  let b;
  try { b = await readJson(req); } catch (e) { return json(res, e.status || 400, { error: e.message }); }
  if (!QUOTE_ID.test(b.quoteId)) return json(res, 400, { error: "Invalid request." });
  const guest = parseGuest(b.guest);
  if (!guest) return json(res, 400, { error: "Please fill in your name and a valid email address first." });
  const mobile = guest.phone ? notify.ukMobile(guest.phone) : null;
  if (guest.phone && !mobile) return json(res, 400, { error: "We can only text UK mobile numbers (07…). Clear the phone field to get the link by email only." });
  const canEmail = notify.emailEnabled || HANDOFF_LOG_ONLY, canSms = Boolean(mobile) && (notify.smsEnabled || HANDOFF_LOG_ONLY);
  if (!canEmail && !canSms) return json(res, 400, { error: "Add your UK mobile number and we'll text you the link." });
  if (notify.recipientLimited(guest.email.toLowerCase()) || (mobile && notify.recipientLimited(mobile)))
    return json(res, 429, { error: "We've already sent a few links to these details today. Please check your email or messages." });

  try {
    const quote = await guesty.getQuote(b.quoteId);
    const id = handoffs.create({ stay: quote.stay, checkIn: quote.checkIn, checkOut: quote.checkOut, guests: quote.guests, guest, marketing: b.marketing === true });
    const link = `${PUBLIC_URL}/book.html?resume=${id}`;
    const stayName = guesty.NAMES[quote.stay];
    const when = `${shortDate(quote.checkIn)} – ${shortDate(quote.checkOut)}`;
    const total = new Intl.NumberFormat("en-GB", { style: "currency", currency: quote.currency }).format(quote.total);
    const sentTo = {};
    const log = { logOnly: HANDOFF_LOG_ONLY };

    if (canEmail) {
      const text = `Hi ${guest.firstName},\n\nHere's your link to finish booking ${stayName} (${when}, ${total}):\n${link}\n\nYour details are filled in, so you only need to pay. The link works for 24 hours; dates aren't held until you've paid.\n\nBath Retreats`;
      const esc = v => v.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
      const html = `<p>Hi ${esc(guest.firstName)},</p><p>Here's your link to finish booking <b>${stayName}</b> (${when}, ${total}).</p><p><a href="${link}" style="display:inline-block;padding:12px 20px;border-radius:999px;background:#0f1f19;color:#fff;text-decoration:none;font-weight:600">Continue to payment</a></p><p>Your details are filled in, so you only need to pay. The link works for 24 hours; dates aren't held until you've paid.</p><p>Bath Retreats</p>`;
      await notify.sendEmail({ to: guest.email, subject: `Finish booking ${stayName}`, text, html }, log);
      sentTo.email = maskEmail(guest.email);
    }
    if (canSms) {
      await notify.sendSms({ to: mobile, body: `Bath Retreats: finish booking ${stayName} (${when}, ${total}) here: ${link}` }, log)
        .then(() => { sentTo.sms = `•••• ${mobile.slice(-4)}`; })
        .catch(err => console.error("[handoff] SMS failed:", err.message)); // the email still got through
    }
    json(res, 200, { sentTo });
  } catch (err) {
    console.error("[handoff]", err.message);
    if (err.guestyStatus === 404) return json(res, 410, { error: "This price has expired. Please reload the page." });
    json(res, 502, { error: "We couldn't send the link right now. Please try again or pay here instead." });
  }
}

function handleHandoffGet(req, res, id) {
  if (rateLimited(clientIp(req), "handoff-get", 30)) return json(res, 429, { error: "Too many requests." });
  const h = HANDOFF_ID.test(id) ? handoffs.get(id) : null;
  if (!h) return json(res, 404, { error: "This link has expired. Please choose your dates again." });
  const { stay, checkIn, checkOut, guests, guest, marketing } = h;
  json(res, 200, { stay, checkIn, checkOut, guests, guest, marketing });
}

/* ---------- guest reviews: /api/reviews, /api/admin/reviews ---------- */
const STAYS = Object.keys(guesty.LISTINGS);

function handleReviewList(req, res) {
  const stay = new URL(req.url, "http://x").searchParams.get("stay");
  if (!STAYS.includes(stay)) return json(res, 400, { error: "stay must be abbey or manor" });
  json(res, 200, { reviews: reviews.approved(stay) });
}

async function handleReviewSubmit(req, res) {
  if (rateLimited(clientIp(req), "review", 3)) return json(res, 429, { error: "You've sent a few reviews already. Please try again later." });
  let b;
  try { b = await readJson(req); } catch (e) { return json(res, e.status || 400, { error: e.message }); }
  if (b.website) return json(res, 200, { ok: true }); // honeypot field: bots fill it in, people never see it
  const name = typeof b.name === "string" ? b.name.trim() : "";
  const text = typeof b.text === "string" ? b.text.trim() : "";
  const rating = Number(b.rating);
  if (!STAYS.includes(b.stay) || !Number.isInteger(rating) || rating < 1 || rating > 5) return json(res, 400, { error: "Please choose a star rating." });
  if (name.length < 1 || name.length > 40) return json(res, 400, { error: "Please add your first name." });
  if (text.length < 20 || text.length > 1000) return json(res, 400, { error: "Please write between 20 and 1,000 characters." });
  if (b.consent !== true) return json(res, 400, { error: "Please agree to your review being shown on the website." });
  try {
    reviews.add({ stay: b.stay, name, rating, text });
    json(res, 200, { ok: true });
  } catch (err) {
    json(res, err.status || 500, { error: "We couldn't save your review right now. Please try again later." });
  }
}

// admin.html sends the password as a bearer token. Compare hashes in constant time.
const ADMIN_HASH = process.env.ADMIN_PASSWORD ? createHash("sha256").update(process.env.ADMIN_PASSWORD).digest() : null;
function isAdmin(req) {
  const given = (req.headers.authorization || "").replace(/^Bearer /, "");
  return Boolean(ADMIN_HASH && given) && timingSafeEqual(createHash("sha256").update(given).digest(), ADMIN_HASH);
}

// Shared gate for /api/admin/*: returns true if the request may continue.
function adminGate(req, res) {
  if (!ADMIN_HASH) { json(res, 503, { error: "Set ADMIN_PASSWORD in chat/.env to use the admin page." }); return false; }
  if (rateLimited(clientIp(req), "admin", 60)) { json(res, 429, { error: "Too many requests. Wait a few minutes." }); return false; }
  if (!isAdmin(req)) { json(res, 401, { error: "Wrong password." }); return false; }
  return true;
}

function handleAdminBookings(req, res) {
  if (!adminGate(req, res)) return;
  json(res, 200, { bookings: bookings.list() });
}

async function handleAdminReviews(req, res, pathname) {
  if (!adminGate(req, res)) return;
  if (req.method === "GET") return json(res, 200, { reviews: reviews.all() });
  const id = pathname.split("/")[4];
  let b;
  try { b = await readJson(req); } catch (e) { return json(res, e.status || 400, { error: e.message }); }
  if (!["approve", "reject", "delete"].includes(b.action)) return json(res, 400, { error: "action must be approve, reject or delete" });
  if (!reviews.moderate(id, b.action)) return json(res, 404, { error: "Review not found" });
  json(res, 200, { ok: true });
}

/* ---------- static site ---------- */
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".svg": "image/svg+xml", ".ico": "image/x-icon" };
const PRIVATE = [path.join(SITE, "chat") + path.sep, path.join(SITE, "_originals") + path.sep];

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const file = path.normalize(path.join(SITE, urlPath === "/" ? "index.html" : urlPath));
  if (!file.startsWith(SITE + path.sep) || PRIVATE.some(p => file.startsWith(p)) || path.basename(file).startsWith(".")) return json(res, 404, { error: "Not found" });
  if (!existsSync(file) || !statSync(file).isFile() || !MIME[path.extname(file).toLowerCase()]) return json(res, 404, { error: "Not found" });
  res.writeHead(200, { "Content-Type": MIME[path.extname(file).toLowerCase()], "Cache-Control": "public, max-age=300" });
  createReadStream(file).pipe(res);
}

function corsHeaders(methods = "POST, OPTIONS") {
  return ALLOWED_ORIGIN ? { "Access-Control-Allow-Origin": ALLOWED_ORIGIN, "Access-Control-Allow-Methods": methods, "Access-Control-Allow-Headers": "Content-Type", Vary: "Origin" } : {};
}
function json(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...corsHeaders() });
  res.end(JSON.stringify(obj));
}

http.createServer((req, res) => {
  const { pathname } = new URL(req.url, "http://x");
  if (pathname === "/api/chat") {
    if (req.method === "OPTIONS") { res.writeHead(204, corsHeaders()); return res.end(); }
    if (req.method === "POST") return handleChat(req, res).catch(e => { console.error(e); if (!res.headersSent) json(res, 500, { error: "Server error" }); else res.end(); });
    return json(res, 405, { error: "Use POST" });
  }
  if (pathname === "/api/availability") {
    if (req.method === "GET") return handleAvailability(req, res);
    return json(res, 405, { error: "Use GET" });
  }
  if (pathname === "/api/config") return handleConfig(req, res);
  if (pathname === "/api/handoff" && req.method === "POST") return handleHandoffCreate(req, res).catch(e => { console.error(e); if (!res.headersSent) json(res, 500, { error: "Server error" }); });
  if (pathname.startsWith("/api/handoff/") && req.method === "GET") return handleHandoffGet(req, res, pathname.split("/")[3]);
  if (pathname === "/api/reviews") {
    if (req.method === "GET") return handleReviewList(req, res);
    if (req.method === "POST") return handleReviewSubmit(req, res).catch(e => { console.error(e); if (!res.headersSent) json(res, 500, { error: "Server error" }); });
    return json(res, 405, { error: "Use GET or POST" });
  }
  if (pathname === "/api/admin/bookings" && req.method === "GET") return handleAdminBookings(req, res);
  if (pathname === "/api/admin/reviews" || pathname.startsWith("/api/admin/reviews/")) {
    if (req.method !== "GET" && req.method !== "POST") return json(res, 405, { error: "Use GET or POST" });
    return handleAdminReviews(req, res, pathname).catch(e => { console.error(e); if (!res.headersSent) json(res, 500, { error: "Server error" }); });
  }
  const bookingRoutes = { "/api/quote": handleQuote, "/api/checkout": handleCheckout, "/api/book": handleBook, "/api/stripe-webhook": handleStripeWebhook };
  if (bookingRoutes[pathname]) {
    if (req.method === "OPTIONS") { res.writeHead(204, corsHeaders()); return res.end(); }
    if (req.method !== "POST") return json(res, 405, { error: "Use POST" });
    return bookingRoutes[pathname](req, res).catch(e => { console.error(e); if (!res.headersSent) json(res, 500, { error: "Server error" }); else res.end(); });
  }
  if (pathname === "/api/health") return json(res, 200, { ok: true, model: MODEL, mock: MOCK, keyConfigured: hasKey, guestyConfigured: guesty.configured, chunks: chunks.length, builtAt });
  if (req.method === "GET" || req.method === "HEAD") return serveStatic(req, res);
  json(res, 405, { error: "Method not allowed" });
}).listen(PORT, () => {
  console.log(`Bath Retreats running at http://localhost:${PORT}  (${chunks.length} knowledge chunks, model ${MOCK ? "MOCK" : MODEL})`);
  if (!MOCK && !hasKey) console.warn("  ! ANTHROPIC_API_KEY is not set: the chat will reply with a configuration message. Use CHAT_MOCK=1 to demo the UI.");
  if (DIRECT_BOOKING) console.log(`  Direct booking ON (Stripe ${payments.testMode ? "TEST mode: no real Guesty reservations" : "LIVE"})${payments.webhookConfigured ? "" : "; no STRIPE_WEBHOOK_SECRET, so the backup webhook is off"}`);
  else {
    const missing = [
      !guesty.configured && "GUESTY_CLIENT_ID/GUESTY_CLIENT_SECRET",
      !payments.configured && "STRIPE_SECRET_KEY + STRIPE_PUBLISHABLE_KEY (same account and mode)",
      !payments.guestyPlaceholderConfigured && "GUESTY_GUEST_EMAIL (needed with live Stripe keys)",
      process.env.DIRECT_BOOKING !== "1" && 'DIRECT_BOOKING="1"',
    ].filter(Boolean);
    console.log(`  Direct booking OFF (guests are sent to Airbnb). Missing in chat/.env: ${missing.join(", ")}`);
  }
});
