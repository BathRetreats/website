// Lexical retrieval (BM25) over the website chunks in knowledge.json.
//
// Why BM25 and not embeddings: the knowledge base is a few dozen short, factual
// chunks written in the same vocabulary guests use ("parking", "dogs", "check-in"),
// so keyword ranking with a small synonym map retrieves the right chunk reliably,
// needs no second API vendor or vector store, and runs in microseconds in-process.
// If the site grows to hundreds of pages, swap `search()` for an embedding index;
// the server only depends on its { chunk, score } return shape.

const STOPWORDS = new Set(`a an and are as at be by can could do does for from has have how i
if in into is it its me my of on or our so than that the their them then there these they this
to us was we were what when where which who will with would you your yours about any also just
there's what's it's i'm please tell know like want get got`.split(/\s+/));

// Query-side expansions: guest wording -> words the site actually uses.
const SYNONYMS = {
  park: ["parking", "car"], parking: ["car", "park"], car: ["parking"],
  dog: ["dogs", "pet"], dogs: ["dog", "pet"], pet: ["dog", "dogs"], pets: ["dog", "dogs"],
  kid: ["children", "child", "family"], kids: ["children", "child", "family"], baby: ["cot", "children"],
  child: ["children", "family"], children: ["child", "family"], toddler: ["cot", "children"],
  wifi: ["internet"], internet: ["wifi"],
  sleep: ["bed", "bedroom", "sleeps", "guests"], sleeps: ["guests", "sleep"],
  people: ["guests", "sleeps"], person: ["guests"], guest: ["guests"],
  bed: ["bedroom"], bedroom: ["bed"], rooms: ["bedroom"],
  arrive: ["checkin"], arrival: ["checkin"], leave: ["checkout"], depart: ["checkout"],
  key: ["checkin", "lockbox", "safe"], lockbox: ["checkin", "key"],
  stairs: ["lift", "floor", "access"], lift: ["stairs", "floor"], elevator: ["lift", "stairs"],
  wheelchair: ["stairs", "lift", "access", "mobility"], accessible: ["stairs", "lift", "mobility"],
  station: ["railway", "train"], train: ["railway", "station"],
  kitchen: ["cook", "oven", "hob"], cook: ["kitchen"],
  bbq: ["barbecue", "garden"], barbecue: ["bbq"], garden: ["gardens", "outdoor"],
  view: ["views"], views: ["view"], spa: ["thermae", "wellness"], eat: ["food", "restaurant"],
  restaurant: ["food", "eating"], food: ["eating", "restaurant"],
  walk: ["walking", "walks"], walking: ["walk"], things: ["explore", "attractions"],
  host: ["managed", "manage", "contact"], contact: ["host", "managed"],
};

// Light stemmer: enough to match "views"/"view", "walking"/"walk", "parks"/"park".
function stem(w) {
  if (w.length > 5 && w.endsWith("ing")) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

export function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/check[\s-]?in/g, "checkin")
    .replace(/check[\s-]?out/g, "checkout")
    .replace(/wi-?fi/g, "wifi")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter(w => w && !STOPWORDS.has(w))
    .map(stem);
}

function expand(tokens) {
  const out = [...tokens];
  for (const t of tokens) for (const s of SYNONYMS[t] || []) out.push(stem(s));
  return out;
}

// Which property does a piece of text point at? Used to boost matching chunks.
export function detectStay(text) {
  const t = text.toLowerCase();
  const abbey = /abbey views|apartment|\bflat\b|city centre/.test(t);
  const manor = /manor|longscroft|bradford|wiltshire|\bhouse\b|\bgroup\b|countryside/.test(t);
  if (abbey && !manor) return "abbey";
  if (manor && !abbey) return "manor";
  return null;
}

export function buildIndex(chunks, { k1 = 1.4, b = 0.75 } = {}) {
  const docs = chunks.map(c => {
    // Titles carry the property + section name, so weight them twice.
    const tokens = tokenize(`${c.title} ${c.title} ${c.text}`);
    const tf = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
    return { chunk: c, tf, len: tokens.length };
  });
  const df = new Map();
  for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) || 0) + 1);
  const avgLen = docs.reduce((s, d) => s + d.len, 0) / Math.max(docs.length, 1);
  const idf = t => {
    const n = df.get(t) || 0;
    return Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
  };
  return { docs, idf, avgLen, k1, b };
}

/**
 * Rank chunks for a guest question.
 * @param index    result of buildIndex()
 * @param query    the latest guest message
 * @param opts.context   earlier guest message(s), weighted lower, so follow-ups like
 *                       "and is there parking?" keep the property they were about
 * @param opts.pageStay  "abbey" | "manor" when the guest is on a property page
 */
export function search(index, query, { context = "", pageStay = null, k = 6, minScore = 0.5 } = {}) {
  const terms = new Map();
  for (const t of expand(tokenize(query))) terms.set(t, (terms.get(t) || 0) + 1);
  for (const t of tokenize(context)) if (!terms.has(t)) terms.set(t, 0.35);
  if (!terms.size) return [];

  // Explicit mention in the question beats the page the guest happens to be on.
  const focus = detectStay(query) || detectStay(context) || pageStay;
  const { docs, idf, avgLen, k1, b } = index;

  const scored = [];
  for (const d of docs) {
    let score = 0;
    for (const [t, w] of terms) {
      const f = d.tf.get(t);
      if (!f) continue;
      score += w * idf(t) * (f * (k1 + 1)) / (f + k1 * (1 - b + b * d.len / avgLen));
    }
    if (!score) continue;
    const stay = d.chunk.stay;
    if (focus && (stay === focus || stay === `${focus}-area`)) score *= 1.6;
    else if (focus && stay && stay !== "both" && !stay.startsWith(focus)) score *= 0.6;
    scored.push({ chunk: d.chunk, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const top = scored[0]?.score || 0;
  // Keep chunks that are reasonably close to the best match; drop the long tail.
  return scored.filter(s => s.score >= Math.max(minScore, top * 0.2)).slice(0, k);
}
