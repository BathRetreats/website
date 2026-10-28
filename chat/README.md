# Bath Retreats guest assistant (RAG chatbot)

Answers guest questions about Abbey Views and Longscroft Manor using the website itself as the knowledge base.

## Run locally

```bash
cd chat
npm install
export ANTHROPIC_API_KEY=sk-ant-...   # from console.anthropic.com
npm start                             # http://localhost:3000
```

No key yet? `CHAT_MOCK=1 npm start` runs the full pipeline and UI, answering with the top retrieved source instead of calling Claude.

## How it works

1. **Ingest** (`build-index.mjs`): parses `index.html`, `abbey.html` and `manor.html` into ~45 small chunks (one per FAQ, room list, amenity list, attraction...) and writes `knowledge.json`. Placeholder testimonials are deliberately excluded. `npm start` re-runs this, so editing the site and restarting is all it takes to update the bot.
2. **Retrieve** (`retrieval.mjs`): BM25 keyword ranking with a guest-wording synonym map, boosted toward the property on the current page or named in the question. Follow-ups use the previous question as context.
3. **Generate** (`server.mjs`): sends the top 6 chunks plus the conversation to Claude (`claude-opus-5`, low effort, refusal fallback enabled) with instructions to answer only from the sources, cite them as [n], and never guess prices or availability. Streams the answer to the browser over Server-Sent Events.
4. **Widget** (`../chat-widget.js`): the chat panel on every page; renders citations as links back to the right page section.

## Live availability (Guesty)

`GET /api/availability?stay=abbey|manor` returns the next 12 months from the property manager's Guesty account (Booking Engine API, read-only use). The booking calendar in `../script.js` uses it to cross out booked nights and enforce minimum/maximum stays and no-arrival/no-departure days, so guests can only pick dates that are free on Airbnb too.

- Credentials go in `chat/.env` (copy `.env.example`); `npm start` loads it. Listing ids are in `guesty.mjs`.
- Calendars are cached for 5 minutes, and the last good copy is served if Guesty is down. The access token is cached in `.guesty-token.json` (gitignored) because Guesty limits how many tokens can be requested per day.
- If the endpoint is unavailable, the calendar falls back to all future dates open; Airbnb still checks before booking.

## Direct booking with payment (our Stripe account)

With `DIRECT_BOOKING=1` and Stripe keys set, the booking form shows the Guesty price as soon as dates are picked, and "Continue to book" opens `../book.html`:

1. `POST /api/quote`: Guesty quote (price locked 24h, including the manager's Direct Discount). Reused for 30 minutes, so the form and checkout share one quote.
2. `POST /api/checkout`: the server re-reads the quote from Guesty and creates a Stripe PaymentIntent for that amount with **manual capture**. The browser never sets the price.
3. The guest pays in Stripe's Payment Element (cards, Apple Pay, Google Pay, 3D Secure). This only **authorises** the card.
4. `POST /api/book` (`payments.mjs#finalize`): checks the quote again, creates a **Reserved** reservation in Guesty (blocks the calendar and Airbnb), then **captures** the payment. If Guesty refuses (dates just taken), the hold is released and the guest isn't charged.
5. `POST /api/stripe-webhook` runs the same step if the guest's browser never comes back (e.g. closed during 3D Secure). It's idempotent: the reservation id is saved on the PaymentIntent before capture.

**Test mode:** with `sk_test_`/`pk_test_` keys the whole flow runs with Stripe test cards (4242 4242 4242 4242), but step 4 never creates a real Guesty reservation; the page shows a test banner.

**Before going live:** live Stripe keys; a webhook endpoint in Stripe for `payment_intent.amount_capturable_updated` with its `whsec_` secret; the manager sets the Booking Engine API instance to accept inquiries ("Only inquiries" or "Both") and confirms each Reserved direct booking in Guesty; `terms.html` and `privacy.html` exist. Money goes to our Stripe account, so settling the manager's share happens outside Guesty.

## Our database: guest details stay here

Guest details never go to Guesty. `db.mjs` opens a SQLite database (Node's built-in `node:sqlite`, file `chat/data/app.db`, gitignored, mode 600) with versioned migrations:

| Table | Holds | Kept |
|---|---|---|
| `guests` | name, email, mobile, marketing opt-in (one row per email) | while they have bookings |
| `bookings` | reference, stay, dates, amount, status, Stripe payment id, Guesty reservation id | 6 years (accounting); unpaid or failed checkouts deleted after 7 days |
| `reviews` | guest reviews and their approval status | until deleted in admin |
| `handoffs` | "continue on your phone" details | 24 hours |

What the other systems receive:
- **Guesty:** a Reserved reservation for the dates with an anonymous guest, "Direct booking <reference>", and `GUESTY_GUEST_EMAIL`. Enough to block the calendar and Airbnb; nothing personal.
- **Stripe:** the amount, the booking id and reference, and the cardholder name (needed for card checks). No email, phone or receipts; we send the confirmation email ourselves (`payments.mjs`, via Resend).

`admin.html` shows bookings with guest details (search by name, email, phone or reference) and the review queue.

**Production:** set `DATABASE_PATH` to a persistent disk and back the file up (e.g. a daily copy, or Litestream to object storage). Because Guesty has no contact details for direct bookings, check-in instructions for these guests must come from us or be sent by the manager using the admin page.

## Continue on your phone

On the checkout, between "Your details" and "Payment", guests can tap **Send me a link**. The details they entered are saved for 24 hours under a 12-character random id (`handoffs.mjs`) and the link `PUBLIC_URL/book.html?resume=<id>` is sent by email (Resend) and, for UK mobiles, SMS (Twilio). Opening it restores the stay and fills the form, so the guest only pays.

- Abuse limits: 3 links per visitor per 10 minutes, 3 per email or phone number per day, SMS to UK mobiles (+447) only to block SMS-pumping fraud.
- In Stripe test mode without Resend/Twilio keys, the email and SMS are printed to the server console instead of sent.

## Guest reviews

The Reviews section keeps the rating charts and replaces the old placeholder quotes with a "Write a review" form (star rating, first name, review, consent).

- `POST /api/reviews` saves a review as **pending** in the database. Limits: 3 per visitor per 10 minutes, a hidden honeypot field for bots, 20 to 1,000 characters.
- `admin.html` (password: `ADMIN_PASSWORD`) lists pending, approved and rejected reviews with Approve / Reject / Delete.
- `GET /api/reviews?stay=` returns approved reviews only; the newest three show beside the chart.

## Test

`npm test`: retrieval eval of 22 guest-style questions (free, no API calls). Run it after changing site content or `retrieval.mjs`.

## Deploy

The site and API need to be served by this Node server (or the API hosted separately):

- **One host (simplest):** deploy the whole `real-estate/` folder to any Node host (Render, Railway, Fly.io, a VPS). Start command `cd chat && npm install && npm start`; set `ANTHROPIC_API_KEY` (and `PORT` if the host requires it) as environment variables.
- **Static site elsewhere:** host the API as above, set `ALLOWED_ORIGIN=https://your-site.com`, and change `data-endpoint` on the `chat-widget.js` script tag in all three pages to `https://your-api-host/api/chat`.

Never put the API key in the HTML or JavaScript files; it stays on the server.

## Settings (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | (required) | Claude API key |
| `CHAT_MODEL` | `claude-opus-5` | Model |
| `CHAT_EFFORT` | `low` | `low`/`medium`/`high`; low suits short factual answers |
| `PORT` | `3000` | Server port |
| `ALLOWED_ORIGIN` | (none) | CORS origin when the site is on another domain |
| `LOG_QUESTIONS` | off | `1` logs guest questions (privacy: off by default) |
| `GUESTY_CLIENT_ID` / `GUESTY_CLIENT_SECRET` | (none) | Guesty Booking Engine API key for live availability |
| `STRIPE_SECRET_KEY` / `STRIPE_PUBLISHABLE_KEY` | (none) | Our Stripe account; test keys never create real Guesty reservations |
| `STRIPE_WEBHOOK_SECRET` | (none) | `whsec_...` for `/api/stripe-webhook` |
| `PUBLIC_URL` | `http://localhost:PORT` | Site address used in emailed/texted links |
| `RESEND_API_KEY` / `EMAIL_FROM` | (none) | Email for "continue on your phone" links |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_FROM` | (none) | SMS for the same links |
| `ADMIN_PASSWORD` | (none) | Password for `admin.html` (bookings and review approval) |
| `GUESTY_GUEST_EMAIL` | (none) | Placeholder email on direct bookings' Guesty reservations; required with live Stripe keys |
| `DATABASE_PATH` | `chat/data/app.db` | SQLite file; on a persistent, backed-up disk in production |
| `DIRECT_BOOKING` | off | `1` takes paid bookings on the site instead of sending guests to Airbnb |

Limits: 20 messages per IP per 10 minutes, 800 characters per question, 12 turns of history, 2,048 output tokens per answer.
