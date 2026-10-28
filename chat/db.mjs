// The site's own database: guests, bookings, reviews and "continue on your phone" links.
//
// SQLite via Node's built-in node:sqlite: no server to run and nothing to install, and far
// more than enough for two properties. It's one file (chat/data/app.db, gitignored), so in
// production it must live on a persistent disk (set DATABASE_PATH) and be backed up.
// Plain SQL throughout, so moving to Postgres later is a contained change.
//
// Guest details are stored only here. Guesty receives an anonymous placeholder per booking
// (to block the dates) and Stripe receives only our booking id.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const FILE = process.env.DATABASE_PATH || path.join(here, "data", "app.db");

mkdirSync(path.dirname(FILE), { recursive: true });
const isNew = !existsSync(FILE);
export const db = new DatabaseSync(FILE);
if (isNew) chmodSync(FILE, 0o600); // personal data: readable by the server's user only
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");

// Append-only: each entry upgrades the schema by one version (tracked in PRAGMA user_version).
const MIGRATIONS = [
  `CREATE TABLE guests (
     id               TEXT PRIMARY KEY,
     email            TEXT NOT NULL UNIQUE COLLATE NOCASE,
     first_name       TEXT NOT NULL,
     last_name        TEXT NOT NULL,
     phone            TEXT,
     marketing_opt_in INTEGER NOT NULL DEFAULT 0,
     created_at       TEXT NOT NULL,
     updated_at       TEXT NOT NULL
   );
   CREATE TABLE bookings (
     id                    TEXT PRIMARY KEY,
     reference             TEXT NOT NULL UNIQUE,
     guest_id              TEXT NOT NULL REFERENCES guests(id),
     stay                  TEXT NOT NULL,
     check_in              TEXT NOT NULL,
     check_out             TEXT NOT NULL,
     guest_count           INTEGER NOT NULL,
     amount_pence          INTEGER NOT NULL,
     currency              TEXT NOT NULL,
     status                TEXT NOT NULL CHECK (status IN ('pending_payment', 'confirmed', 'failed', 'cancelled')),
     quote_id              TEXT NOT NULL,
     rate_plan_id          TEXT NOT NULL,
     payment_intent_id     TEXT UNIQUE,
     guesty_reservation_id TEXT,
     test                  INTEGER NOT NULL DEFAULT 0,
     terms_accepted_at     TEXT NOT NULL,
     created_at            TEXT NOT NULL,
     updated_at            TEXT NOT NULL
   );
   CREATE INDEX bookings_guest ON bookings (guest_id);
   CREATE INDEX bookings_status_created ON bookings (status, created_at);
   CREATE TABLE reviews (
     id         TEXT PRIMARY KEY,
     stay       TEXT NOT NULL,
     name       TEXT NOT NULL,
     rating     INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
     text       TEXT NOT NULL,
     status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
     created_at TEXT NOT NULL
   );
   CREATE INDEX reviews_stay_status ON reviews (stay, status, created_at);
   CREATE TABLE handoffs (
     id         TEXT PRIMARY KEY,
     data       TEXT NOT NULL,
     expires_at INTEGER NOT NULL
   );`,
];

/** Run fn inside a transaction; rolls back if it throws. */
export function tx(fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

for (let v = db.prepare("PRAGMA user_version").get().user_version; v < MIGRATIONS.length; v++) {
  tx(() => {
    db.exec(MIGRATIONS[v]);
    db.exec(`PRAGMA user_version = ${v + 1}`);
  });
}

export const now = () => new Date().toISOString();
