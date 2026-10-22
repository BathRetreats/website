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

import http from "node:http";
import { readFileSync, existsSync, statSync, createReadStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { buildIndex, search } from "./retrieval.mjs";

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
function rateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter(t => now - t < RATE_LIMIT.windowMs);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > RATE_LIMIT.max;
}
setInterval(() => { // keep the rate-limit map from growing forever
  const now = Date.now();
  for (const [ip, ts] of hits) if (!ts.some(t => now - t < RATE_LIMIT.windowMs)) hits.delete(ip);
}, RATE_LIMIT.windowMs).unref();

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts = [];
    req.on("data", c => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { reject(Object.assign(new Error("Request too large"), { status: 413 })); req.destroy(); }
      else parts.push(c);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(parts).toString("utf8"))); }
      catch { reject(Object.assign(new Error("Invalid JSON"), { status: 400 })); }
    });
    req.on("error", reject);
  });
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
  const ip = req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.socket.remoteAddress;
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

function corsHeaders() {
  return ALLOWED_ORIGIN ? { "Access-Control-Allow-Origin": ALLOWED_ORIGIN, "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", Vary: "Origin" } : {};
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
  if (pathname === "/api/health") return json(res, 200, { ok: true, model: MODEL, mock: MOCK, keyConfigured: hasKey, chunks: chunks.length, builtAt });
  if (req.method === "GET" || req.method === "HEAD") return serveStatic(req, res);
  json(res, 405, { error: "Method not allowed" });
}).listen(PORT, () => {
  console.log(`Bath Retreats running at http://localhost:${PORT}  (${chunks.length} knowledge chunks, model ${MOCK ? "MOCK" : MODEL})`);
  if (!MOCK && !hasKey) console.warn("  ! ANTHROPIC_API_KEY is not set: the chat will reply with a configuration message. Use CHAT_MOCK=1 to demo the UI.");
});
