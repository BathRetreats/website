(() => {
  "use strict";

  // Single source of truth for booking rules.
  // TODO: swap `url` for the direct-booking page once it exists; dates and guests are appended as query params.
  const STAYS = {
    abbey: { name: "Abbey Views", max: 2, thumb: "images/abbey/window-view.jpg", url: "https://www.airbnb.co.uk/rooms/865962144112895502" },
    manor: { name: "Longscroft Manor", max: 12, thumb: "images/manor/exterior.jpg", url: "https://www.airbnb.co.uk/rooms/1252796993760210343" },
  };
  const MAX_GUESTS = Math.max(...Object.values(STAYS).map(s => s.max));
  // Property pages set <body data-stay="abbey|manor">; the home page leaves it unset.
  const PAGE_STAY = STAYS[document.body.dataset.stay] ? document.body.dataset.stay : null;

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const wide = matchMedia("(min-width: 981px)");
  const phone = matchMedia("(max-width: 640px)");
  document.documentElement.classList.add("js");

  /* =========================================================
     Booking widget: property + date range + guests
     ========================================================= */
  const form = $("#book"), search = $("#search"), hint = $("#hint"), scrim = $("#scrim");
  const fStay = $("#fStay"), fIn = $("#fIn"), fOut = $("#fOut"), fGuests = $("#fGuests");
  const pops = { stay: $("#pop-stay"), cal: $("#pop-cal"), guests: $("#pop-guests") };
  const calBody = $("#calBody"), guestCount = $("#guestCount"), opts = $$(".opt", pops.stay);

  const pad = n => String(n).padStart(2, "0");
  const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parse = s => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
  const addMonths = (d, n) => new Date(d.getFullYear(), d.getMonth() + n, 1);
  const nightsBetween = (a, b) => Math.round((parse(b) - parse(a)) / 864e5);
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const fmtShort = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short" });
  const fmtLong = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const fmtMonth = new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric" });

  const today = iso(new Date());
  const thisMonth = addMonths(new Date(), 0);
  const state = { stay: null, start: null, end: null, hover: null, guests: 2, view: thisMonth, pop: null, edge: "in" };

  const setVal = (field, text, empty) => {
    const v = $(".val", field);
    v.textContent = text;
    v.classList.toggle("is-empty", empty);
  };
  const setHint = (text = "", error = false) => {
    hint.textContent = text;
    hint.classList.toggle("hint--error", error);
  };

  /* ---- summary: fields, hint, mobile bar ---- */
  const mbarName = $("#mbarName"), mbarDates = $("#mbarDates"), stayThumb = $("#stayThumb");
  function sync() {
    const s = STAYS[state.stay];
    setVal(fStay, s ? s.name : "Choose a stay", !s);
    if (stayThumb.dataset.stay !== (state.stay || "")) {
      stayThumb.dataset.stay = state.stay || "";
      stayThumb.innerHTML = s ? `<img src="${s.thumb}" alt="">` : '<svg class="i"><use href="#i-home"/></svg>';
    }
    setVal(fIn, state.start ? fmtShort.format(parse(state.start)) : "Add date", !state.start);
    setVal(fOut, state.end ? fmtShort.format(parse(state.end)) : "Add date", !state.end);
    setVal(fGuests, plural(state.guests, "guest"), false);

    for (const [key, field] of [["stay", fStay], ["in", fIn], ["out", fOut], ["guests", fGuests]]) {
      const active = key === "in" || key === "out" ? state.pop === "cal" && state.edge === key : state.pop === key;
      field.classList.toggle("is-active", active);
      field.setAttribute("aria-expanded", active);
    }

    const dates = state.start && state.end
      ? `${fmtShort.format(parse(state.start))} – ${fmtShort.format(parse(state.end))} · ${plural(nightsBetween(state.start, state.end), "night")}`
      : "";
    if (!hint.classList.contains("hint--error")) setHint(dates);
    mbarName.textContent = s ? s.name : "Choose a stay";
    mbarDates.textContent = dates || "Add dates to check availability";
  }

  /* ---- popover open/close ---- */
  function openPop(name, edge) {
    if (state.pop && state.pop !== name) pops[state.pop].hidden = true;
    state.pop = name;
    if (name === "cal") {
      state.edge = edge || (state.start && !state.end ? "out" : "in");
      if (state.start) state.view = addMonths(parse(state.start), 0);
      renderCal();
    }
    if (name === "guests") renderGuests();
    const pop = pops[name];
    pop.hidden = false;
    place(pop, name === "cal" ? fIn : name === "stay" ? fStay : fGuests);
    const sheet = phone.matches;
    scrim.hidden = !sheet;
    document.body.classList.toggle("sheet-open", sheet);
    document.body.classList.toggle("no-scroll", sheet);
    sync();
  }
  function closePop() {
    if (!state.pop) return;
    pops[state.pop].hidden = true;
    state.pop = null;
    state.hover = null;
    scrim.hidden = true;
    document.body.classList.remove("sheet-open", "no-scroll");
    sync();
  }
  // desktop: align under the trigger field without overflowing the search box
  function place(pop, anchor) {
    pop.style.left = "";
    if (phone.matches || (!wide.matches && pop === pops.cal)) return;
    const max = search.clientWidth - pop.offsetWidth;
    pop.style.left = Math.max(0, Math.min(anchor.offsetLeft, max)) + "px";
  }

  // Figure out what the guest still needs to fill in, and open it.
  function nextStep() {
    if (!state.stay) return openPop("stay");
    if (!state.start || !state.end) return openPop("cal");
    closePop();
  }

  /* ---- property ---- */
  function setStay(id, advance) {
    if (!STAYS[id]) return;
    state.stay = id;
    const max = STAYS[id].max;
    if (state.guests > max) {
      state.guests = max;
      setHint(`${STAYS[id].name} sleeps up to ${max}, so we've set guests to ${max}.`, true);
    } else if (hint.classList.contains("hint--error")) setHint();
    opts.forEach(o => o.setAttribute("aria-selected", o.dataset.stay === id));
    fStay.classList.remove("is-invalid");
    advance ? nextStep() : sync();
  }

  /* ---- guests ---- */
  function renderGuests() {
    const max = state.stay ? STAYS[state.stay].max : MAX_GUESTS;
    guestCount.value = guestCount.textContent = state.guests;
    $('[data-step="-1"]', pops.guests).disabled = state.guests <= 1;
    $('[data-step="1"]', pops.guests).disabled = state.guests >= max;
    // grey out properties that can't take this many guests
    opts.forEach(o => { o.disabled = STAYS[o.dataset.stay].max < state.guests; });
    sync();
  }

  /* ---- calendar ---- */
  const icon = id => `<svg class="i"><use href="#i-${id}"/></svg>`;
  function monthHTML(first, idx, count) {
    const y = first.getFullYear(), m = first.getMonth();
    const lead = (first.getDay() + 6) % 7; // weeks start Monday
    const days = new Date(y, m + 1, 0).getDate();
    let cells = "<span></span>".repeat(lead);
    for (let d = 1; d <= days; d++) {
      const date = new Date(y, m, d), s = iso(date);
      cells += `<button type="button" class="day" data-date="${s}" aria-label="${fmtLong.format(date)}"${s < today ? " disabled" : ""}><span>${d}</span></button>`;
    }
    const prev = idx === 0 ? `<button type="button" class="cal__arrow" data-nav="-1" aria-label="Previous month"${state.view <= thisMonth ? " disabled" : ""}>${icon("chev-l")}</button>` : '<span class="cal__arrow cal__arrow--ghost"></span>';
    const next = idx === count - 1 ? `<button type="button" class="cal__arrow" data-nav="1" aria-label="Next month">${icon("chev-r")}</button>` : '<span class="cal__arrow cal__arrow--ghost"></span>';
    return `<div><div class="cal__head">${prev}<strong>${fmtMonth.format(first)}</strong>${next}</div><div class="cal__dow">${["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"].map(d => `<span>${d}</span>`).join("")}</div><div class="cal__grid">${cells}</div></div>`;
  }
  function renderCal() {
    const n = wide.matches ? 2 : 1;
    calBody.innerHTML =
      `<div class="cal__months" style="--n:${n}">${Array.from({ length: n }, (_, i) => monthHTML(addMonths(state.view, i), i, n)).join("")}</div>` +
      '<div class="cal__foot"><span class="cal__nights"></span><button type="button" class="linkbtn" data-clear>Clear dates</button></div>';
    paintCal();
  }
  function paintCal() {
    const { start, end, hover } = state;
    const effEnd = end || (start && hover > start ? hover : null); // preview range while choosing check-out
    for (const b of $$(".day", calBody)) {
      const s = b.dataset.date;
      b.classList.toggle("is-start", s === start);
      b.classList.toggle("is-end", s === effEnd);
      b.classList.toggle("has-range", !!effEnd && s === start);
      b.classList.toggle("in-range", !!effEnd && s > start && s < effEnd);
      b.classList.toggle("is-today", s === today);
    }
    const n = start && effEnd ? nightsBetween(start, effEnd) : 0;
    $(".cal__nights", calBody).textContent = n ? plural(n, "night") : state.edge === "out" && start ? "Now pick your check-out date" : "Pick your check-in date";
  }
  function pickDate(s) {
    if (state.edge === "in" || !state.start || s <= state.start) {
      state.start = s; state.end = null; state.edge = "out"; state.hover = null;
      fIn.classList.remove("is-invalid");
      paintCal(); sync();
    } else {
      state.end = s;
      fOut.classList.remove("is-invalid");
      if (hint.classList.contains("hint--error")) setHint();
      nextStep();
    }
  }

  /* ---- submit ---- */
  form.addEventListener("submit", e => {
    e.preventDefault();
    if (!state.stay) { fStay.classList.add("is-invalid"); setHint("Choose which stay you'd like to book.", true); return openPop("stay"); }
    if (!state.start || !state.end) { (state.start ? fOut : fIn).classList.add("is-invalid"); setHint("Choose your check-in and check-out dates.", true); return openPop("cal"); }
    const q = new URLSearchParams({ check_in: state.start, check_out: state.end, adults: state.guests, guests: state.guests });
    window.open(`${STAYS[state.stay].url}?${q}`, "_blank", "noopener");
  });

  // "Book" buttons anywhere on the page: preselect the property, bring the widget into view, open the next step.
  function goBook(stay) {
    if (stay) setStay(stay, false);
    closeMenu();
    const r = form.getBoundingClientRect();
    const inView = r.top >= 0 && r.bottom <= innerHeight;
    if (inView) return nextStep();
    let done = false;
    const run = () => { if (!done) { done = true; nextStep(); } };
    addEventListener("scrollend", run, { once: true });
    setTimeout(run, reduce ? 0 : 900);
    form.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: phone.matches ? "start" : "center" });
  }

  /* =========================================================
     One delegated click handler for the whole page
     ========================================================= */
  document.addEventListener("click", e => {
    const t = e.target;
    let el;
    // click outside the widget closes any open popover (composedPath survives calendar re-renders)
    if (state.pop && !e.composedPath().includes(search)) closePop();

    if ((el = t.closest("[data-book]"))) { e.preventDefault(); return goBook(el.dataset.book); }
    if ((el = t.closest(".field[data-pop]"))) {
      const { pop, edge } = el.dataset;
      const same = state.pop === pop && (pop !== "cal" || state.edge === edge);
      return same ? closePop() : openPop(pop, edge);
    }
    if ((el = t.closest(".opt"))) return setStay(el.dataset.stay, true);
    if ((el = t.closest("[data-step]"))) { state.guests += Number(el.dataset.step); return renderGuests(); }
    if (t.closest(".pop__done, .pop__close") || t === scrim) return closePop();
    if ((el = t.closest(".day[data-date]"))) return pickDate(el.dataset.date);
    if ((el = t.closest("[data-nav]"))) { state.view = addMonths(state.view, +el.dataset.nav); return renderCal(); }
    if (t.closest("[data-clear]")) { state.start = state.end = state.hover = null; state.edge = "in"; setHint(); renderCal(); return sync(); }

    if ((el = t.closest(".tab[data-filter]"))) return filterPlaces(el);
    if ((el = t.closest("[data-rtab]"))) return showReviews(el.dataset.rtab);
    if ((el = t.closest(".arrow[data-dir]"))) { showSlide(slideIdx + Number(el.dataset.dir)); return autoSlide(); }
    if ((el = t.closest(".mosaic figure, .mosaic__all"))) {
      const gallery = el.closest(".mosaic");
      return openLightbox(gallery, el.matches("figure") ? $$("figure", gallery).indexOf(el) : 0);
    }
    if (t.closest(".nav__toggle")) return toggleMenu();
    if (t.closest(".nav__links a")) return closeMenu();
  });

  // calendar hover preview
  pops.cal.addEventListener("mouseover", e => {
    const d = e.target.closest(".day[data-date]");
    if (!d || !state.start || state.end || state.edge !== "out" || state.hover === d.dataset.date) return;
    state.hover = d.dataset.date;
    paintCal();
  });
  pops.cal.addEventListener("mouseleave", () => { if (state.hover) { state.hover = null; paintCal(); } });

  const onViewportChange = () => { if (state.pop) openPop(state.pop, state.edge); };
  wide.addEventListener("change", onViewportChange);
  phone.addEventListener("change", onViewportChange);

  /* =========================================================
     Nav: solid on scroll, mobile menu, active section
     ========================================================= */
  const nav = $(".nav"), toggle = $(".nav__toggle");
  const toggleMenu = () => toggle.setAttribute("aria-expanded", nav.classList.toggle("is-open"));
  const closeMenu = () => { nav.classList.remove("is-open"); toggle.setAttribute("aria-expanded", "false"); };

  const navLinks = $$(".nav__links a");
  const linkFor = new Map(navLinks.map(a => [a.hash.slice(1), a]));
  const sectionIO = new IntersectionObserver(entries => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      navLinks.forEach(a => a.classList.toggle("is-active", a === linkFor.get(en.target.id)));
    }
  }, { rootMargin: "-45% 0px -50% 0px" });
  ["home", "stays", ...linkFor.keys()].forEach(id => { const el = document.getElementById(id); if (el) sectionIO.observe(el); });

  // Scroll-linked UI uses a sentinel observer instead of a scroll listener.
  const mbar = $("#mbar");
  new IntersectionObserver(([en]) => nav.classList.toggle("is-scrolled", !en.isIntersecting), { rootMargin: "-60px 0px 0px 0px", threshold: 0 })
    .observe($(".hero__content"));
  new IntersectionObserver(([en]) => {
    const past = !en.isIntersecting && en.boundingClientRect.top < 0;
    mbar.classList.toggle("is-on", past);
    mbar.setAttribute("aria-hidden", !past);
    $("a", mbar).tabIndex = past ? 0 : -1;
  }).observe(form);

  /* =========================================================
     Explore: filter tabs + missing-photo fallback
     ========================================================= */
  const tabs = $$(".tab[data-filter]"), places = $$(".place");
  function filterPlaces(tab) {
    const f = tab.dataset.filter;
    tabs.forEach(x => { const on = x === tab; x.classList.toggle("is-active", on); x.setAttribute("aria-selected", on); });
    places.forEach(p => { p.hidden = f !== "all" && !p.dataset.cat.split(" ").includes(f); });
  }
  // if a place photo doesn't exist yet, drop the <img> so the placeholder shows
  const dropBroken = img => img.remove();
  $$(".place__img img").forEach(img => {
    if (img.complete && !img.naturalWidth) dropBroken(img);
    else img.addEventListener("error", () => dropBroken(img), { once: true });
  });

  /* =========================================================
     Reviews: property tabs + slider
     ========================================================= */
  const scorePanels = $$(".scores"), allSlides = $$(".slide"), dotsWrap = $(".slider__dots");
  let slides = [], slideIdx = 0, timer;
  function showReviews(stay) {
    $$("[data-rtab]").forEach(b => b.setAttribute("aria-selected", b.dataset.rtab === stay));
    scorePanels.forEach(p => { p.hidden = p.dataset.stay !== stay; });
    slides = allSlides.filter(s => s.dataset.stay === stay);
    dotsWrap.innerHTML = "<i></i>".repeat(slides.length);
    showSlide(0);
    autoSlide();
  }
  function showSlide(n) {
    slideIdx = (n + slides.length) % slides.length;
    allSlides.forEach(s => s.classList.toggle("is-active", s === slides[slideIdx]));
    [...dotsWrap.children].forEach((d, i) => d.classList.toggle("is-active", i === slideIdx));
  }
  function autoSlide() {
    clearInterval(timer);
    if (!reduce) timer = setInterval(() => showSlide(slideIdx + 1), 7000);
  }
  showReviews(PAGE_STAY || "abbey");

  /* =========================================================
     Lightbox (per-property galleries, keyboard + swipe)
     ========================================================= */
  const lb = $("#lightbox"), lbImg = $("img", lb), lbCap = $(".lb__cap", lb), lbCount = $(".lb__count", lb);
  let lbFigs = [], lbIdx = 0, lbReturn = null;
  function openLightbox(gallery, i) {
    lbFigs = $$("figure", gallery);
    lbReturn = document.activeElement;
    showLb(i);
    lb.hidden = false;
    document.body.classList.add("no-scroll");
    $(".lb__close", lb).focus();
  }
  function showLb(i) {
    lbIdx = (i + lbFigs.length) % lbFigs.length;
    const img = $("img", lbFigs[lbIdx]);
    lbImg.src = img.currentSrc || img.src;
    lbImg.alt = img.alt;
    lbCap.textContent = $("figcaption", lbFigs[lbIdx]).textContent;
    lbCount.textContent = `${lbIdx + 1} / ${lbFigs.length}`;
    // warm the next photo so arrowing through feels instant
    new Image().src = $("img", lbFigs[(lbIdx + 1) % lbFigs.length]).src;
  }
  function closeLightbox() {
    lb.hidden = true;
    document.body.classList.remove("no-scroll");
    lbReturn?.focus();
  }
  lb.addEventListener("click", e => {
    if (e.target.closest(".lb__prev")) showLb(lbIdx - 1);
    else if (e.target.closest(".lb__next")) showLb(lbIdx + 1);
    else if (!e.target.closest("img")) closeLightbox();
  });
  let touchX = null;
  lb.addEventListener("touchstart", e => { touchX = e.touches[0].clientX; }, { passive: true });
  lb.addEventListener("touchend", e => {
    if (touchX === null) return;
    const dx = e.changedTouches[0].clientX - touchX;
    if (Math.abs(dx) > 50) showLb(lbIdx + (dx < 0 ? 1 : -1));
    touchX = null;
  });
  // make gallery photos keyboard-accessible
  $$(".mosaic figure").forEach(f => { f.tabIndex = 0; f.setAttribute("role", "button"); f.setAttribute("aria-label", `View photo: ${$("figcaption", f).textContent}`); });

  /* =========================================================
     Keyboard
     ========================================================= */
  document.addEventListener("keydown", e => {
    if (!lb.hidden) {
      if (e.key === "Escape") closeLightbox();
      else if (e.key === "ArrowLeft") showLb(lbIdx - 1);
      else if (e.key === "ArrowRight") showLb(lbIdx + 1);
      return;
    }
    if (e.key === "Escape") {
      if (state.pop) { const f = { stay: fStay, guests: fGuests, cal: state.edge === "out" ? fOut : fIn }[state.pop]; closePop(); f.focus(); }
      closeMenu();
      return;
    }
    const fig = e.target.closest?.(".mosaic figure");
    if (fig && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openLightbox(fig.closest(".mosaic"), $$("figure", fig.closest(".mosaic")).indexOf(fig)); }
  });

  /* =========================================================
     Motion: count-up + scroll reveal (one observer)
     ========================================================= */
  if (!reduce && "IntersectionObserver" in window) {
    const countUp = el => {
      const end = Number(el.dataset.count), t0 = performance.now();
      const tick = t => {
        const p = Math.min((t - t0) / 1400, 1);
        el.textContent = Math.round(end * (1 - (1 - p) ** 3));
        if (p < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    };
    const io = new IntersectionObserver(entries => {
      for (const { isIntersecting, target: el } of entries) {
        if (!isIntersecting) continue;
        io.unobserve(el);
        if (el.dataset.count) { countUp(el); continue; }
        el.classList.add("is-in");
        // drop reveal styles afterwards so the stagger delay doesn't slow hover transitions
        setTimeout(() => { el.classList.remove("reveal", "is-in"); el.style.transitionDelay = ""; }, 1200);
      }
    }, { threshold: 0.1, rootMargin: "0px 0px -6% 0px" });

    $$("[data-count]").forEach(el => io.observe(el));
    $$(".section__head, .stay, .stats > div, .property__head, .property__grid > *, .tabs, .place, .reviews > *, .faq__group, .cta__inner, .footer__top")
      .forEach((el, i) => { el.classList.add("reveal"); el.style.transitionDelay = `${(i % 3) * 80}ms`; io.observe(el); });
  }

  PAGE_STAY ? setStay(PAGE_STAY, false) : sync();
})();
