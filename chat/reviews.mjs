// Guest reviews submitted on the site. New reviews are "pending" and only appear on the site
// once approved on admin.html, so spam and fake reviews never go live. Stored in db.mjs.

import { randomUUID } from "node:crypto";
import { db, now } from "./db.mjs";

const MAX_PENDING = 500; // stop a flood of submissions from filling the disk

const q = {
  approved: db.prepare(`SELECT id, name, rating, text, substr(created_at, 1, 10) AS date FROM reviews
                        WHERE stay = ? AND status = 'approved' ORDER BY created_at DESC`),
  pendingCount: db.prepare("SELECT count(*) AS n FROM reviews WHERE status = 'pending'"),
  insert: db.prepare("INSERT INTO reviews (id, stay, name, rating, text, created_at) VALUES (?, ?, ?, ?, ?, ?)"),
  all: db.prepare("SELECT id, stay, name, rating, text, status, created_at AS createdAt FROM reviews ORDER BY created_at DESC"),
  setStatus: db.prepare("UPDATE reviews SET status = ? WHERE id = ?"),
  delete: db.prepare("DELETE FROM reviews WHERE id = ?"),
};

/** Approved reviews for one property, newest first. */
export const approved = stay => q.approved.all(stay);

export function add({ stay, name, rating, text }) {
  if (q.pendingCount.get().n >= MAX_PENDING) throw Object.assign(new Error("Too many reviews waiting for approval"), { status: 503 });
  q.insert.run(randomUUID(), stay, name, rating, text, now());
}

/** Everything, for the admin page. */
export const all = () => q.all.all();

/** approve | reject | delete. Returns false if the review doesn't exist. */
export function moderate(id, action) {
  const r = action === "delete" ? q.delete.run(id) : q.setStatus.run(action === "approve" ? "approved" : "rejected", id);
  return r.changes > 0;
}
