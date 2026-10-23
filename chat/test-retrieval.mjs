// Retrieval eval: does the right chunk come back for real guest-style questions?
// Free to run (no API calls). Run after any change to the site, synonyms or ranking:
//   npm test
import { readFileSync } from "node:fs";
import { buildIndex, search } from "./retrieval.mjs";

const { chunks } = JSON.parse(readFileSync(new URL("./knowledge.json", import.meta.url)));
const index = buildIndex(chunks);

// [question, expected title fragment (or predicate on the chunk), options]
const CASES = [
  ["What time is check-in?", "check-in and check-out"],
  ["Can I bring my dog to the manor?", "Can we bring our dog"],
  ["Is there parking at Abbey Views?", "Abbey Views): Where can I park"],
  ["Where do I park at Longscroft?", "Longscroft Manor): Is there parking"],
  ["How many people does the manor sleep?", "Longscroft Manor: key facts"],
  ["What beds are in the manor?", "Longscroft Manor: bedrooms"],
  ["Is the apartment suitable for a wheelchair?", "Are there stairs"],
  ["Does Abbey Views have wifi?", "Abbey Views: amenities"],
  ["Is there a BBQ?", "Longscroft Manor", { pageStay: "manor" }],
  ["How far is the Roman Baths?", "The Roman Baths"],
  ["Where can we get afternoon tea?", "The Pump Room"],
  ["What can we do near the manor?", c => c.stay === "manor-area", { pageStay: "manor" }],
  ["Is the manor good for kids?", "young children"],
  ["How do I book?", c => /How to book|How do I book/.test(c.title)], // either booking chunk answers it
  ["How do I pay?", "How do I book and pay"],
  ["Who manages the properties?", "Who looks after"],
  ["What is the rating of Longscroft Manor?", "Longscroft Manor: guest ratings"],
  ["How do I get the keys?", "How does check-in work"],
  ["Is there a station nearby?", "Abbey Views: location"],
  ["Can we arrive early?", "check in early"],
  ["Where's a good spa?", "Thermae Bath Spa"],
  // follow-up: the earlier question carries the property
  ["and is there parking?", "Longscroft Manor): Is there parking", { context: "Tell me about Longscroft Manor" }],
  // page context: same question, different page
  ["Is there parking?", "Abbey Views): Where can I park", { pageStay: "abbey" }],
];

let hit1 = 0, hit3 = 0;
for (const [q, want, opts = {}] of CASES) {
  const res = search(index, q, opts);
  const rank = res.findIndex(r => typeof want === "function" ? want(r.chunk) : r.chunk.title.includes(want));
  if (rank === 0) hit1++;
  if (rank >= 0 && rank < 3) hit3++;
  const mark = rank === 0 ? "ok " : rank > 0 && rank < 3 ? "top3" : "MISS";
  console.log(`${mark.padEnd(4)}  ${q.padEnd(46)} -> ${res[0]?.chunk.title ?? "(nothing)"}`);
}
const n = CASES.length;
console.log(`\nhit@1 ${hit1}/${n} (${Math.round(100 * hit1 / n)}%)   hit@3 ${hit3}/${n} (${Math.round(100 * hit3 / n)}%)`);
process.exit(hit3 === n ? 0 : 1);
