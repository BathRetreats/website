// Guest assistant chat widget. Include once per page:
//   <script src="chat-widget.js" defer data-endpoint="/api/chat"></script>
// It builds its own markup, streams answers from chat/server.mjs, and keeps the
// conversation in sessionStorage so it follows the guest between pages.
(() => {
  "use strict";
  const script = document.currentScript;
  const ENDPOINT = script?.dataset.endpoint || "/api/chat";
  const STORE = "br-chat-v1";
  const MAX_CHARS = 800;
  const page = document.body.dataset.stay || null; // "abbey" | "manor" on property pages

  const SUGGESTIONS = {
    abbey: ["Is there parking nearby?", "Are there stairs to the apartment?", "What's within walking distance?"],
    manor: ["How are the five bedrooms set up?", "Can we bring our dog?", "Is it good for young children?"],
    home: ["Which stay suits a family of six?", "What time is check-in?", "What is there to do in Bath?"],
  };

  /* ---------- markup ---------- */
  const icon = id => `<svg class="i" aria-hidden="true"><use href="#i-${id}"/></svg>`;
  const wrap = document.createElement("div");
  wrap.className = "chatw";
  wrap.innerHTML = `
    <button type="button" class="chat-launch" aria-expanded="false" aria-controls="chatPanel">
      <svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z"/><path d="M8 9.5h8M8 12.5h5"/></svg>
      <span>Ask a question</span>
    </button>
    <section class="chat" id="chatPanel" role="dialog" aria-label="Guest assistant" hidden>
      <header class="chat__head">
        <span class="chat__avatar" aria-hidden="true">BR</span>
        <div class="chat__title"><b>Bath Retreats assistant</b><span>Answers from our website</span></div>
        <button type="button" class="chat__icon" data-act="reset" aria-label="Start a new chat" title="New chat">
          <svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12a8 8 0 1 0 2.3-5.6M4 4v4h4"/></svg>
        </button>
        <button type="button" class="chat__icon" data-act="close" aria-label="Close chat">${icon("x")}</button>
      </header>
      <div class="chat__log" aria-live="polite"></div>
      <form class="chat__form">
        <textarea rows="1" maxlength="${MAX_CHARS}" placeholder="Ask about the stays, check-in, parking…" aria-label="Your question" required></textarea>
        <button type="submit" class="chat__send" aria-label="Send">
          <svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
        </button>
      </form>
      <p class="chat__note">AI answers based on this website. Please confirm details before booking.</p>
    </section>`;
  document.body.appendChild(wrap);

  const launch = wrap.querySelector(".chat-launch");
  const panel = wrap.querySelector(".chat");
  const log = wrap.querySelector(".chat__log");
  const form = wrap.querySelector(".chat__form");
  const input = form.querySelector("textarea");
  const sendBtn = form.querySelector(".chat__send");

  /* ---------- state ---------- */
  // history: [{ role: "user"|"assistant", content, sources? }]
  let history = [];
  try { history = JSON.parse(sessionStorage.getItem(STORE)) || []; } catch { /* storage blocked */ }
  const save = () => { try { sessionStorage.setItem(STORE, JSON.stringify(history.slice(-20))); } catch { /* ignore */ } };
  let busy = false;

  /* ---------- rendering ---------- */
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // Safe mini-renderer: paragraphs, "- " lists, **bold**, [n] citation links. No innerHTML.
  function renderAnswer(target, text, sources = []) {
    const byN = new Map(sources.map(s => [s.n, s]));
    const inline = (parent, str) => {
      for (const part of str.split(/(\*\*[^*]+\*\*|\[\d+\])/g)) {
        if (!part) continue;
        const cite = part.match(/^\[(\d+)\]$/);
        if (cite && byN.has(+cite[1])) {
          const s = byN.get(+cite[1]);
          const a = el("a", "chat__cite", cite[1]);
          a.href = s.url;
          a.title = s.title;
          parent.appendChild(a);
        } else if (cite) {
          // citation number with no matching source: drop it rather than show a dead marker
        } else if (part.startsWith("**")) {
          parent.appendChild(el("strong", null, part.slice(2, -2)));
        } else parent.appendChild(document.createTextNode(part));
      }
    };
    target.replaceChildren();
    for (const block of text.trim().split(/\n{2,}/)) {
      const lines = block.split("\n");
      if (lines.every(l => /^\s*[-•]\s+/.test(l))) {
        const ul = el("ul");
        for (const l of lines) inline(ul.appendChild(el("li")), l.replace(/^\s*[-•]\s+/, ""));
        target.appendChild(ul);
      } else {
        const p = el("p");
        lines.forEach((l, i) => { if (i) p.appendChild(el("br")); inline(p, l); });
        target.appendChild(p);
      }
    }
  }

  function sourceChips(sources, text) {
    const cited = [...new Set([...text.matchAll(/\[(\d+)\]/g)].map(m => +m[1]))];
    const list = sources.filter(s => cited.includes(s.n));
    if (!list.length) return null;
    const row = el("div", "chat__sources");
    row.appendChild(el("span", null, "Sources"));
    for (const s of list) {
      const a = el("a", null, `${s.n}. ${s.title.replace(/^FAQ \([^)]*\): /, "")}`);
      a.href = s.link || s.url;
      if (s.link) { a.target = "_blank"; a.rel = "noopener"; }
      row.appendChild(a);
    }
    return row;
  }

  function bubble(role, text, sources) {
    const b = el("div", `chat__msg chat__msg--${role}`);
    if (role === "assistant") {
      const body = el("div", "chat__body");
      renderAnswer(body, text, sources);
      b.appendChild(body);
      const chips = sources && sourceChips(sources, text);
      if (chips) b.appendChild(chips);
    } else b.textContent = text;
    log.appendChild(b);
    return b;
  }

  function renderAll() {
    log.replaceChildren();
    bubble("assistant", "Hi! Ask me anything about Abbey Views, Longscroft Manor, booking, or things to do nearby.");
    for (const m of history) bubble(m.role, m.content, m.sources);
    if (!history.length) {
      const chips = el("div", "chat__suggest");
      for (const q of SUGGESTIONS[page || "home"]) {
        const btn = el("button", null, q);
        btn.type = "button";
        btn.addEventListener("click", () => ask(q));
        chips.appendChild(btn);
      }
      log.appendChild(chips);
    }
    scrollDown();
  }
  const scrollDown = () => { log.scrollTop = log.scrollHeight; };

  /* ---------- open / close ---------- */
  function open() {
    panel.hidden = false;
    launch.setAttribute("aria-expanded", "true");
    wrap.classList.add("is-open");
    if (!log.childElementCount) renderAll();
    scrollDown();
    input.focus({ preventScroll: true });
  }
  function close() {
    panel.hidden = true;
    launch.setAttribute("aria-expanded", "false");
    wrap.classList.remove("is-open");
    launch.focus({ preventScroll: true });
  }
  launch.addEventListener("click", () => (panel.hidden ? open() : close()));
  panel.addEventListener("click", e => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "close") close();
    if (act === "reset" && !busy) { history = []; save(); renderAll(); input.focus(); }
  });
  document.addEventListener("keydown", e => { if (e.key === "Escape" && !panel.hidden) close(); });

  /* ---------- input ---------- */
  const autosize = () => { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 120) + "px"; };
  input.addEventListener("input", autosize);
  input.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); }
  });
  form.addEventListener("submit", e => {
    e.preventDefault();
    const q = input.value.trim();
    if (q && !busy) ask(q);
  });

  /* ---------- ask: POST + read the Server-Sent Events stream ---------- */
  async function ask(question) {
    busy = true;
    sendBtn.disabled = true;
    input.value = "";
    autosize();
    log.querySelector(".chat__suggest")?.remove();

    history.push({ role: "user", content: question.slice(0, MAX_CHARS) });
    bubble("user", question);
    const reply = el("div", "chat__msg chat__msg--assistant");
    const body = el("div", "chat__body");
    body.appendChild(el("span", "chat__typing", "")).setAttribute("aria-label", "Assistant is typing");
    reply.appendChild(body);
    log.appendChild(reply);
    scrollDown();

    let text = "", sources = [], frame = 0;
    const paint = () => { frame = 0; renderAnswer(body, text, sources); scrollDown(); };

    try {
      if (location.protocol === "file:") throw new Error("Open the site through the chat server (cd chat && npm start), not as a file.");
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ page, messages: history.map(({ role, content }) => ({ role, content })) }),
      });
      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `The assistant is unavailable (${res.status}).`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let cut;
        while ((cut = buf.indexOf("\n\n")) !== -1) {
          const line = buf.slice(0, cut).trim();
          buf = buf.slice(cut + 2);
          if (!line.startsWith("data:")) continue;
          const evt = JSON.parse(line.slice(5));
          if (evt.type === "sources") sources = evt.sources;
          else if (evt.type === "text") { text += evt.text; if (!frame) frame = requestAnimationFrame(paint); }
          else if (evt.type === "error") throw new Error(evt.message);
        }
      }
      if (!text.trim()) throw new Error("No answer came back. Please try again.");
      cancelAnimationFrame(frame);
      paint();
      const chips = sourceChips(sources, text);
      if (chips) reply.appendChild(chips);
      history.push({ role: "assistant", content: text, sources });
      save();
    } catch (err) {
      // Drop the unanswered question from the history the server sees, so turns stay alternating.
      history.pop();
      cancelAnimationFrame(frame);
      reply.classList.add("chat__msg--error");
      body.replaceChildren(el("p", null, err.message || "Something went wrong. Please try again."));
    } finally {
      busy = false;
      sendBtn.disabled = false;
      scrollDown();
      input.focus({ preventScroll: true });
    }
  }
})();
