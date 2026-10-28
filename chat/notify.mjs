// Outgoing email (Resend) and SMS (Twilio), used for "continue on your phone" links.
// Both are plain HTTPS APIs, so no SDKs. Without keys, and only in Stripe test mode,
// messages are printed to the server console instead, so the flow can be tried locally.

const env = process.env;
const EMAIL = env.RESEND_API_KEY && env.EMAIL_FROM ? { key: env.RESEND_API_KEY, from: env.EMAIL_FROM } : null;
const SMS = env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM
  ? { sid: env.TWILIO_ACCOUNT_SID, token: env.TWILIO_AUTH_TOKEN, from: env.TWILIO_FROM } : null;

export const emailEnabled = Boolean(EMAIL);
export const smsEnabled = Boolean(SMS);

/**
 * UK mobiles only, in E.164 (+447...). Texting only UK mobiles blocks "SMS pumping" fraud,
 * where bots trigger texts to premium international numbers at our expense.
 */
export function ukMobile(raw) {
  const digits = String(raw || "").replace(/[\s()-]/g, "");
  const e164 = digits.startsWith("+44") ? digits : digits.startsWith("0044") ? `+${digits.slice(2)}` : digits.startsWith("07") ? `+44${digits.slice(1)}` : null;
  return e164 && /^\+447\d{9}$/.test(e164) ? e164 : null;
}

// Per-recipient cap, so the form can't be used to flood someone's inbox or phone.
const sent = new Map(); // recipient -> timestamps
const PER_RECIPIENT_PER_DAY = 3;
export function recipientLimited(to) {
  const now = Date.now(), day = 864e5;
  const recent = (sent.get(to) || []).filter(t => now - t < day);
  if (recent.length >= PER_RECIPIENT_PER_DAY) return true;
  recent.push(now);
  sent.set(to, recent);
  return false;
}

export async function sendEmail({ to, subject, text, html }, { logOnly = false } = {}) {
  if (!EMAIL) {
    if (logOnly) return console.log(`[notify] (test, not sent) email to ${to}: ${subject}\n${text}`);
    throw new Error("Email isn't configured");
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${EMAIL.key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: EMAIL.from, to: [to], subject, text, html }),
  });
  if (!res.ok) throw new Error(`Resend HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

export async function sendSms({ to, body }, { logOnly = false } = {}) {
  if (!SMS) {
    if (logOnly) return console.log(`[notify] (test, not sent) SMS to ${to}: ${body}`);
    throw new Error("SMS isn't configured");
  }
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${SMS.sid}/Messages.json`, {
    method: "POST",
    headers: { Authorization: `Basic ${Buffer.from(`${SMS.sid}:${SMS.token}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ To: to, From: SMS.from, Body: body }),
  });
  if (!res.ok) throw new Error(`Twilio HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
}
