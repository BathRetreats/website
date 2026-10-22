// Ingestion: turn the website's HTML pages into retrieval chunks (knowledge.json).
//
// Run this whenever the site content changes:  npm run build:index
// (`npm start` runs it automatically before starting the server.)
//
// Each chunk is one self-contained fact group a guest might ask about (one FAQ,
// one room list, one attraction...), titled with the property it belongs to so
// retrieval and the model never confuse Abbey Views with Longscroft Manor.
//
// Deliberately NOT ingested: the testimonial slides. They are placeholder quotes,
// and the assistant must never repeat them to guests as real reviews.

import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "node-html-parser";

const here = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.resolve(here, "..");
const OUT = path.join(here, "knowledge.json");

const PAGES = [
  { file: "index.html", stay: null },
  { file: "abbey.html", stay: "abbey" },
  { file: "manor.html", stay: "manor" },
];
const NAMES = { abbey: "Abbey Views", manor: "Longscroft Manor" };

const clean = s => (s || "").replace(/\s+/g, " ").replace(/\s+([.,;:!?])/g, "$1").replace(/\.{2,}/g, ".").trim();
const txt = el => clean(el?.text);
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
const stayFromName = s => (/longscroft|manor/i.test(s) ? "manor" : /abbey views/i.test(s) ? "abbey" : "both");

const chunks = [];
const seen = new Map();
function add({ page, anchor = "", title, text, stay, link }) {
  text = clean(text);
  if (!text) return;
  const url = anchor ? `${page}#${anchor}` : page;
  // The shared FAQ and rating blocks appear on more than one page; keep one copy,
  // linked to the property's own page when the fact belongs to that property.
  const key = createHash("sha1").update(text).digest("hex");
  const existing = seen.get(key);
  if (existing) {
    const pageStay = PAGES.find(p => p.file === page)?.stay;
    if (pageStay && pageStay === existing.stay) existing.url = url;
    return;
  }
  const chunk = {
    id: `${page}#${slug(title)}`,
    title,
    text,
    stay: stay ?? "both",
    url,
    ...(link ? { link } : {}),
  };
  seen.set(key, chunk);
  chunks.push(chunk);
}

for (const { file, stay } of PAGES) {
  const root = parse(readFileSync(path.join(SITE, file), "utf8"));
  const name = stay && NAMES[stay];

  /* ---------- property pages ---------- */
  const prop = root.querySelector(".property");
  if (prop && name) {
    const tags = root.querySelectorAll(".hero .tags span").map(txt).join(", ");
    const highlights = prop.querySelectorAll(".highlights li")
      .map(li => `${txt(li.querySelector("b"))}: ${txt(li.querySelector("span"))}`).join(". ");
    add({ page: file, stay, title: `${name}: overview`,
      text: `${txt(prop.querySelector(".eyebrow"))}. ${txt(prop.querySelector(".property__meta"))}. ${tags}. ${txt(prop.querySelector(".property__lead"))} Highlights: ${highlights}.` });

    const rooms = prop.querySelectorAll(".rooms .room")
      .map(r => `${txt(r.querySelector("b"))}: ${txt(r.querySelector("span"))}`).join("; ");
    const roomNote = txt(prop.querySelector(".rooms + .small"));
    add({ page: file, stay, title: `${name}: bedrooms and where you'll sleep`, text: `${rooms}. ${roomNote}` });

    add({ page: file, stay, title: `${name}: amenities, what's included`,
      text: prop.querySelectorAll(".amenities li").map(txt).join("; ") + "." });

    add({ page: file, stay, title: `${name}: location and getting there`,
      text: prop.querySelectorAll(".property__main .ticks li").map(txt).join(". ") + "." });

    const facts = prop.querySelectorAll(".book-card dl div")
      .map(d => `${txt(d.querySelector("dt"))}: ${txt(d.querySelector("dd"))}`).join("; ");
    add({ page: file, stay, title: `${name}: key facts (check-in, check-out, capacity)`,
      text: `${facts}. Rating ${txt(prop.querySelector(".book-card__rating"))}.` });

    add({ page: file, stay, title: `${name}: photo gallery`,
      text: `The photo gallery shows: ${prop.querySelectorAll(".mosaic figcaption").map(txt).join(", ")}.` });
  }

  /* ---------- home page: overview cards, key figures, things to do ---------- */
  for (const card of root.querySelectorAll(".stay")) {
    const h = txt(card.querySelector("h3"));
    add({ page: file, anchor: "stays", stay: stayFromName(h), title: `${h}: summary card`,
      text: `${h}. ${txt(card.querySelector(".stay__badge"))}. Location: ${txt(card.querySelector(".stay__type"))}. Rating ${txt(card.querySelector(".rating"))}. ${txt(card.querySelector("p"))} ${card.querySelectorAll(".chips li").map(txt).join(", ")}.` });
  }

  const stats = root.querySelectorAll(".stats > div");
  if (stats.length) {
    add({ page: file, stay: "both", title: "Bath Retreats: key figures for both stays",
      text: stats.map(d => `${txt(d.querySelector("strong"))} ${txt(d.querySelector("span"))}`).join("; ") + "." });
  }

  const places = root.querySelectorAll(".place");
  for (const p of places) {
    const nm = txt(p.querySelector("h3"));
    const nearManor = (p.getAttribute("data-cat") || "").includes("manor");
    const distance = nearManor ? "Near Longscroft Manor (a short drive)" : `${txt(p.querySelector(".place__walk"))} from Abbey Views`;
    add({ page: file, anchor: "explore", stay: nearManor ? "manor-area" : "abbey-area",
      title: `Things to do: ${nm}`, link: p.getAttribute("href"),
      text: `${nm}. ${distance}. ${txt(p.querySelector(".place__body p"))} Category: ${(p.getAttribute("data-cat") || "").replace("manor", "near the manor")}.` });
  }
  if (places.length) {
    add({ page: file, anchor: "explore", stay: "both", title: "Things to do in and around Bath: overview",
      text: `Attractions listed on the site: ${places.map(p => txt(p.querySelector("h3"))).join(", ")}. ${txt(root.querySelector("#explore .lede"))} ${txt(root.querySelector("#explore .note"))}` });
  }

  /* ---------- guest ratings (scores only, never the placeholder quotes) ---------- */
  for (const s of root.querySelectorAll(".scores")) {
    const st = s.getAttribute("data-stay");
    const bars = s.querySelectorAll(".bars li")
      .map(li => `${txt(li.querySelector("span"))} ${txt(li.querySelector("b"))}`).join(", ");
    add({ page: file, anchor: "reviews", stay: st, title: `${NAMES[st]}: guest ratings and review scores`,
      text: `${NAMES[st]} overall rating ${txt(s.querySelector(".scores__top strong"))} out of 5, ${txt(s.querySelector(".scores__top small"))}. Category scores: ${bars}. ${txt(s.querySelector(".mentions"))}.` });
  }

  /* ---------- FAQs ---------- */
  for (const group of root.querySelectorAll(".faq__group")) {
    const heading = txt(group.querySelector("h3"));
    const st = stayFromName(heading);
    for (const d of group.querySelectorAll("details")) {
      const q = txt(d.querySelector("summary"));
      add({ page: file, anchor: "faq", stay: st, title: `FAQ (${heading}): ${q}`, text: `${q} ${txt(d.querySelector("p"))}` });
    }
  }

  /* ---------- booking + who runs it (same on every page) ---------- */
  add({ page: file, anchor: "book", stay: "both", title: "How to book and check availability",
    text: `To check dates and book, use the "Plan your stay" form at the top of any page: choose a property, check-in and check-out dates and the number of guests, then press "Check availability". ${txt(root.querySelector(".pop__note"))}` });
  add({ page: file, stay: "both", title: "About Bath Retreats and who manages the properties",
    text: `${txt(root.querySelector(".footer address"))}.` });
}

writeFileSync(OUT, JSON.stringify({ builtAt: new Date().toISOString(), pages: PAGES.map(p => p.file), chunks }, null, 2));

const chars = chunks.reduce((n, c) => n + c.title.length + c.text.length, 0);
const byStay = chunks.reduce((m, c) => ((m[c.stay] = (m[c.stay] || 0) + 1), m), {});
console.log(`knowledge.json: ${chunks.length} chunks, ~${Math.round(chars / 4)} tokens`, byStay);
