// "Continue on your phone" links: the checkout details a guest entered, kept for 24 hours
// under a short random id so the link fits in an SMS. Expired links are deleted, so this
// never becomes a second store of guest data. Stored in db.mjs.

import { randomBytes } from "node:crypto";
import { db } from "./db.mjs";

export const TTL_MS = 24 * 60 * 60 * 1000;
const ID_CHARS = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no look-alikes (0/O, 1/l/I)

const q = {
  insert: db.prepare("INSERT INTO handoffs (id, data, expires_at) VALUES (?, ?, ?)"),
  get: db.prepare("SELECT data FROM handoffs WHERE id = ? AND expires_at > ?"),
  purge: db.prepare("DELETE FROM handoffs WHERE expires_at <= ?"),
};

// 12 characters from a 56-letter alphabet ≈ 70 bits: not guessable, and short enough for SMS.
const newId = () => [...randomBytes(12)].map(b => ID_CHARS[b % ID_CHARS.length]).join("");

/** Save checkout details; returns the id for the link. */
export function create(data) {
  q.purge.run(Date.now());
  const id = newId();
  q.insert.run(id, JSON.stringify(data), Date.now() + TTL_MS);
  return id;
}

/** The saved details, or null if the link is unknown or expired. */
export function get(id) {
  const row = q.get.get(id, Date.now());
  return row ? JSON.parse(row.data) : null;
}
