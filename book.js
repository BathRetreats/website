// Checkout: price the stay (Guesty quote), take the guest's details and payment (our Stripe account), confirm.
// book.html?stay=abbey|manor&in=YYYY-MM-DD&out=YYYY-MM-DD&guests=N, linked from the booking form in script.js.
//
// Paying only authorises the card; the server then reserves the dates in Guesty and captures
// the payment (chat/payments.mjs), so a guest is never charged for dates they can't have.
(() => {
  "use strict";

  const STAYS = {
    abbey: { name: "Abbey Views", page: "abbey.html", img: "images/abbey/window-view.jpg", airbnb: "https://www.airbnb.co.uk/rooms/865962144112895502" },
    manor: { name: "Longscroft Manor", page: "manor.html", img: "images/manor/exterior.jpg", airbnb: "https://www.airbnb.co.uk/rooms/1252796993760210343" },
  };
  // Same API host as the chat widget: set data-endpoint on this page's script tag when the API is hosted elsewhere.
  const API = (document.currentScript?.dataset.endpoint || "/api/chat").replace(/\/chat$/, "");

  const $ = s => document.querySelector(s);
  const params = new URLSearchParams(location.search);
  const req = { stay: params.get("stay"), checkIn: params.get("in"), checkOut: params.get("out"), guests: Number(params.get("guests")) || 1 };
  const stay = STAYS[req.stay];
  // Where Stripe returns the guest after a redirect-based check (e.g. some 3D Secure flows).
  const returnUrl = `${location.origin}${location.pathname}?${new URLSearchParams({ stay: req.stay, in: req.checkIn, out: req.checkOut, guests: req.guests })}`;

  const parse = s => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
  const fmtDay = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short" });
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const money = (n, currency) => new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(n);

  async function post(path, body) {
    const res = await fetch(`${API}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || "Something went wrong. Please try again."), { status: res.status });
    return data;
  }

  const setStatus = text => { $("#coStatus").textContent = text; $("#coStatus").hidden = !text; };
  const setError = text => { $("#coFormError").textContent = text; };

  function fail(text, { link = stay ? `${stay.page}#book` : "index.html#book", label = "Choose other dates" } = {}) {
    setStatus("");
    $("#coForm").hidden = true;
    $("#coErrorText").textContent = text;
    Object.assign($("#coErrorLink"), { href: link, textContent: label });
    $("#coError").hidden = false;
  }

  if (stay) $("#coBack").href = stay.page;

  let quote, stripe, elements, busy = false;

  async function start() {
    if (!stay || !/^\d{4}-\d{2}-\d{2}$/.test(req.checkIn || "") || !/^\d{4}-\d{2}-\d{2}$/.test(req.checkOut || "") || req.checkOut <= req.checkIn)
      return fail("This booking link is missing the property or dates.");

    // Back from a Stripe redirect: the card is authorised, so finish the booking.
    const returned = params.get("payment_intent");
    if (returned) {
      history.replaceState(null, "", returnUrl);
      return finish(returned);
    }

    const config = await fetch(`${API}/config`).then(r => r.json()).catch(() => ({}));
    if (!config.directBooking) {
      // Paid booking on the site isn't live: finish on Airbnb with the same dates.
      const q = new URLSearchParams({ check_in: req.checkIn, check_out: req.checkOut, adults: req.guests, guests: req.guests });
      return location.replace(`${stay.airbnb}?${q}`);
    }
    $("#coTest").hidden = !config.testMode;

    try {
      quote = await post("/quote", req);
    } catch (err) {
      return fail(err.message);
    }
    renderSummary();

    if (!window.Stripe) return fail("The secure payment form couldn't load. Please check your connection and reload the page.", { link: location.href, label: "Reload" });
    stripe = window.Stripe(config.stripeKey);
    elements = stripe.elements({
      mode: "payment",
      amount: Math.round(quote.total * 100),
      currency: quote.currency.toLowerCase(),
      captureMethod: "manual", // must match the PaymentIntent the server creates
      fonts: [{ cssSrc: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" }],
      appearance: {
        theme: "stripe",
        variables: { fontFamily: "Inter, system-ui, sans-serif", colorPrimary: "#0f1f19", colorText: "#0f1f19", colorDanger: "#c0392b", borderRadius: "14px", spacingUnit: "4px" },
      },
    });
    // Name, email and phone come from the form above, so Stripe doesn't ask again.
    elements.create("payment", { fields: { billingDetails: { name: "never", email: "never", phone: "never" } } }).mount("#coPayment");

    setStatus("");
    $("#coForm").hidden = false;
  }

  function renderSummary() {
    const nights = Math.round((parse(quote.checkOut) - parse(quote.checkIn)) / 864e5);
    const out = parse(quote.checkOut);
    $("#sumImg").src = stay.img;
    $("#sumName").textContent = stay.name;
    $("#sumDates").textContent = `${fmtDay.format(parse(quote.checkIn))} – ${fmtDay.format(out)} ${out.getFullYear()} · ${plural(nights, "night")}`;
    $("#sumGuests").textContent = plural(quote.guests, "guest");
    $("#sumLines").innerHTML = "";
    for (const line of quote.lines) {
      const dt = document.createElement("dt"), dd = document.createElement("dd");
      dt.textContent = line.title;
      dd.textContent = money(line.amount, quote.currency);
      if (line.amount < 0) dd.classList.add("is-discount");
      $("#sumLines").append(dt, dd);
    }
    $("#sumTotal").textContent = money(quote.total, quote.currency);
    const policy = (quote.cancellationPolicy || "").replace(/_/g, "-");
    $("#sumPolicy").textContent = policy
      ? `Cancellation policy: ${policy[0].toUpperCase()}${policy.slice(1)}. See the Terms & Conditions for details.`
      : "";
    $("#coPay").textContent = `Confirm and pay ${money(quote.total, quote.currency)}`;
  }

  // Card authorised: the server reserves the dates in Guesty, then takes the payment.
  async function finish(paymentIntentId) {
    $("#coForm").hidden = true;
    setStatus("Confirming your booking…");
    try {
      const booking = await post("/book", { paymentIntentId });
      setStatus("");
      $("#doneCode").textContent = booking.reference;
      $("#doneTest").hidden = !booking.test;
      $("#doneText").textContent = `Your stay at ${STAYS[booking.stay]?.name || stay.name} is confirmed, and a receipt is on its way to ${booking.email}. We can't wait to welcome you.`;
      $("#coDone").hidden = false;
      scrollTo({ top: 0 });
    } catch (err) {
      fail(err.message, err.status === 409 || err.status === 410 ? {} : { link: stay ? stay.page : "index.html", label: "Back to the property" });
    }
  }

  $("#coForm").addEventListener("submit", async e => {
    e.preventDefault();
    if (busy) return;
    const form = e.currentTarget;
    const f = Object.fromEntries(new FormData(form));
    const firstInvalid = form.querySelector("input:invalid");
    if (firstInvalid) {
      setError(firstInvalid.name === "terms" ? "Please accept the terms and privacy policy." : "Please fill in your name and a valid email address.");
      return firstInvalid.focus();
    }

    busy = true;
    const pay = $("#coPay"), label = pay.textContent;
    pay.disabled = true;
    pay.textContent = "Processing…";
    setError("");
    try {
      const { error: invalid } = await elements.submit(); // validates the payment fields
      if (invalid) throw new Error(invalid.message);

      const guest = { firstName: f.firstName.trim(), lastName: f.lastName.trim(), email: f.email.trim(), ...(f.phone.trim() ? { phone: f.phone.trim() } : {}) };
      const { clientSecret } = await post("/checkout", { quoteId: quote.quoteId, guest, acceptedTerms: true, marketing: f.marketing === "on" });

      const { error, paymentIntent } = await stripe.confirmPayment({
        elements, clientSecret,
        confirmParams: {
          return_url: returnUrl,
          payment_method_data: { billing_details: { name: `${guest.firstName} ${guest.lastName}`, email: guest.email, phone: guest.phone || "" } },
        },
        redirect: "if_required",
      });
      if (error) throw new Error(error.message); // e.g. card declined: the guest can fix it and try again
      if (paymentIntent.status !== "requires_capture") throw new Error("Your payment wasn't completed. Please try again.");
      busy = false;
      return finish(paymentIntent.id);
    } catch (err) {
      if (err.status === 409 || err.status === 410) return fail(err.message);
      setError(err.message);
      pay.disabled = false;
      pay.textContent = label;
    }
    busy = false;
  });

  start();
})();
