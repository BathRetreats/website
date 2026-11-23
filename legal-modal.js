// Opens Terms & Conditions and Privacy Policy links in a pop-up instead of a new page.
// The text comes from terms.html / privacy.html themselves, so there is one copy to keep up to date.
// Without JavaScript (or if loading fails) the links open the pages as normal.
(() => {
  const PAGES = /(^|\/)(terms|privacy)\.html(#.*)?$/;
  const cache = new Map();
  let dialog, body, lastFocus;

  function build() {
    dialog = document.createElement("dialog");
    dialog.className = "lmodal";
    dialog.setAttribute("aria-labelledby", "lmodalTitle");
    dialog.innerHTML = `
      <div class="lmodal__bar">
        <a class="lmodal__full" target="_blank" rel="noopener">Open as page</a>
        <button type="button" class="lmodal__close" aria-label="Close">&times;</button>
      </div>
      <div class="lmodal__body legal" tabindex="-1"></div>`;
    body = dialog.querySelector(".lmodal__body");
    dialog.querySelector(".lmodal__close").addEventListener("click", () => dialog.close());
    // Click on the dimmed backdrop closes it.
    dialog.addEventListener("click", e => { if (e.target === dialog) dialog.close(); });
    dialog.addEventListener("close", () => {
      document.documentElement.classList.remove("lmodal-open");
      lastFocus?.focus();
    });
    // Links between the two policies swap the content in place.
    body.addEventListener("click", e => {
      const a = e.target.closest("a[href]");
      if (a && PAGES.test(a.getAttribute("href"))) { e.preventDefault(); show(a.getAttribute("href")); }
    });
    document.body.append(dialog);
  }

  async function load(page) {
    if (!cache.has(page)) {
      cache.set(page, fetch(page).then(r => {
        if (!r.ok) throw new Error(r.status);
        return r.text();
      }).then(html => new DOMParser().parseFromString(html, "text/html").querySelector("main.legal")?.innerHTML || Promise.reject(new Error("no content")))
        .catch(err => { cache.delete(page); throw err; }));
    }
    return cache.get(page);
  }

  async function show(href) {
    const [page, hash] = href.split("#");
    const html = await load(page);
    if (!dialog) build();
    body.innerHTML = html;
    body.querySelector("h1")?.setAttribute("id", "lmodalTitle");
    dialog.querySelector(".lmodal__full").href = href;
    if (!dialog.open) {
      lastFocus = document.activeElement;
      document.documentElement.classList.add("lmodal-open");
      dialog.showModal();
    }
    const target = hash && body.querySelector(`#${CSS.escape(hash)}`);
    if (target) target.scrollIntoView({ block: "start" });
    else body.scrollTop = 0;
    body.focus({ preventScroll: true });
  }

  document.addEventListener("click", e => {
    const a = e.target.closest("a[href]");
    if (!a || dialog?.contains(a) || e.metaKey || e.ctrlKey || e.shiftKey || e.button) return;
    const href = a.getAttribute("href");
    if (!PAGES.test(href) || typeof HTMLDialogElement !== "function") return;
    e.preventDefault(); // also stops a link inside a label from ticking the checkbox
    show(href).catch(() => { location.href = href; });
  });
})();
