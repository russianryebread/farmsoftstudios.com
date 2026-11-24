const MAILGUN_API_BASE = "https://api.mailgun.net/v3";
export default {
  async fetch(request, env) {
    const origin = env.CORS_ORIGIN ?? "*";
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== "POST") {
      return json({ error: "Method not allowed" }, 405, origin);
    }
    let fields;
    try {
      const contentType = request.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) {
        fields = await request.json();
      } else {
        const formData = await request.formData();
        fields = Object.fromEntries(formData.entries());
      }
    } catch {
      return json({ error: "Invalid request body" }, 400, origin);
    }
    if (!env.TURNSTILE_SECRET) {
      console.error("Missing Turnstile secret");
      return json({ error: "Server configuration error" }, 500, origin);
    }
    const token = fields?.["cf-turnstile-response"];
    if (!(await verifyTurnstile(token, env.TURNSTILE_SECRET, request.headers.get("CF-Connecting-IP")))) {
      return json({ error: "Verification failed. Please try again." }, 403, origin);
    }
    const required = ["name", "business", "email", "location", "biztype", "message"];
    const missing = required.filter((k) => !fields[k]?.trim());
    if (missing.length) {
      return json({ error: `Missing required fields: ${missing.join(", ")}` }, 422, origin);
    }
    const { name, business, email, phone, location, biztype, message } = fields;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return json({ error: "Invalid email address" }, 422, origin);
    }
    const MAILGUN_API_KEY = env.MAILGUN_API_KEY;
    const MAILGUN_DOMAIN = env.MAILGUN_DOMAIN;
    const TO_EMAIL = env.TO_EMAIL;
    const FROM_EMAIL = env.FROM_EMAIL;
    const FROM_NAME = env.FROM_NAME ?? "Consultation Form";
    const CALENDAR_URL = env.CALENDAR_URL ?? "https://calendly.com/";
    if (!MAILGUN_API_KEY || !MAILGUN_DOMAIN || !TO_EMAIL || !FROM_EMAIL) {
      console.error("Missing required environment variables");
      return json({ error: "Server configuration error" }, 500, origin);
    }
    const sender = `${FROM_NAME} <${FROM_EMAIL}>`;
    const notifyResult = await sendMailgun({
      apiKey: MAILGUN_API_KEY,
      domain: MAILGUN_DOMAIN,
      from: sender,
      to: TO_EMAIL,
      replyTo: `${name} <${email}>`,
      subject: `New Consultation Request \u2014 ${name} @ ${business}`,
      html: buildNotificationHtml({ name, email, business, phone, location, biztype, message }),
      text: buildNotificationText({ name, email, business, phone, location, biztype, message })
    });
    if (!notifyResult.ok) {
      console.error("Mailgun notify error:", notifyResult.error);
      return json({ error: "Failed to send notification email" }, 502, origin);
    }
    const replyResult = await sendMailgun({
      apiKey: MAILGUN_API_KEY,
      domain: MAILGUN_DOMAIN,
      from: sender,
      to: `${name} <${email}>`,
      subject: `Let's get your consultation scheduled, ${name.split(" ")[0]}!`,
      html: buildReplyHtml({ name, calendarUrl: CALENDAR_URL }),
      text: buildReplyText({ name, calendarUrl: CALENDAR_URL })
    });
    if (!replyResult.ok) {
      console.error("Mailgun reply error:", replyResult.error);
    }
    return json({ success: true, message: "Form submitted successfully" }, 200, origin);
  }
};
async function verifyTurnstile(token, secret, clientIp) {
  if (typeof token !== "string" || token.length === 0 || token.length > 2048) {
    return false;
  }

  const body = new URLSearchParams({ secret, response: token });
  if (clientIp) body.set("remoteip", clientIp);

  try {
    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body,
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return false;

    const result = await response.json();
    return result?.success === true &&
      result.action === "contact" &&
      result.hostname === "farmsoftstudios.com";
  } catch {
    return false;
  }
}

async function sendMailgun({ apiKey, domain, from, to, replyTo, subject, html, text }) {
  const body = new URLSearchParams({ from, to, subject, html, text });
  if (replyTo) body.set("h:Reply-To", replyTo);
  const response = await fetch(`${MAILGUN_API_BASE}/${domain}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`api:${apiKey}`)}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: body.toString()
  });
  if (response.ok) return { ok: true };
  let error = `HTTP ${response.status}`;
  try {
    const data = await response.json();
    error = data.message ?? error;
  } catch {
  }
  return { ok: false, error };
}
function buildNotificationHtml({ name, email, business, phone, location, biztype, message }) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#1a1a1a">
  <h2 style="margin-top:0;color:#6a8f4b">New Consultation Request</h2>
  <table style="width:100%;border-collapse:collapse">
    <tr><td style="padding:8px 0;font-weight:600;width:160px;vertical-align:top">Name</td><td style="padding:8px 0">${esc(name)}</td></tr>
    <tr><td style="padding:8px 0;font-weight:600;vertical-align:top">Email</td><td style="padding:8px 0"><a href="mailto:${esc(email)}">${esc(email)}</a></td></tr>
    <tr><td style="padding:8px 0;font-weight:600;vertical-align:top">Business</td><td style="padding:8px 0">${esc(business)}</td></tr>
    <tr><td style="padding:8px 0;font-weight:600;vertical-align:top">Phone</td><td style="padding:8px 0">${esc(phone || "\u2014")}</td></tr>
    <tr><td style="padding:8px 0;font-weight:600;vertical-align:top">Location</td><td style="padding:8px 0">${esc(location)}</td></tr>
    <tr><td style="padding:8px 0;font-weight:600;vertical-align:top">Business Type</td><td style="padding:8px 0">${esc(biztype)}</td></tr>
  </table>
  <hr style="margin:16px 0;border:none;border-top:1px solid #e0e0e0">
  <p style="font-weight:600;margin-bottom:6px">What's taking up time?</p>
  <p style="white-space:pre-wrap;background:#f5f5f5;padding:12px;border-radius:6px;margin:0">${esc(message)}</p>
</body>
</html>`;
}
function buildNotificationText({ name, email, business, phone, location, biztype, message }) {
  return `New Consultation Request
=========================
Name:          ${name}
Email:         ${email}
Business:      ${business}
Phone:         ${phone || "\u2014"}
Location:      ${location}
Business Type: ${biztype}

What's taking up time?
----------------------
${message}`;
}
function buildReplyHtml({ name, calendarUrl }) {
  const firstName = name.split(" ")[0];
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#1a1a1a">
  <h2 style="margin-top:0;color:#6a8f4b">Thanks, ${esc(firstName)}!</h2>
  <p>We received your consultation request and appreciate you taking the time to share what's on your mind.</p>
  <p>We'll review your submission and reach out within one business day \u2014 but if you'd like to get something on the calendar right away, you can pick a time that works for you:</p>
  <p style="text-align:center;margin:32px 0">
    <a href="${esc(calendarUrl)}"
       style="background:#6a8f4b;color:#fff;text-decoration:none;padding:14px 28px;border-radius:6px;font-weight:600;display:inline-block">
      Schedule Your Free 30-Minute Call \u2192
    </a>
  </p>
  <p style="color:#555;font-size:14px">No sales pitch. No pressure. Just a real conversation to see if there's a fit.</p>
  <hr style="margin:24px 0;border:none;border-top:1px solid #e0e0e0">
  <p style="color:#999;font-size:12px">Your information stays private. We never share or sell contact details.</p>
</body>
</html>`;
}
function buildReplyText({ name, calendarUrl }) {
  const firstName = name.split(" ")[0];
  return `Thanks, ${firstName}!

We received your consultation request and appreciate you taking the time to share what's on your mind.

We'll review your submission and reach out within one business day \u2014 but if you'd like to get something on the calendar right away, you can pick a time here:

${calendarUrl}

No sales pitch. No pressure. Just a real conversation to see if there's a fit.

---
Your information stays private. We never share or sell contact details.`;
}
function esc(str) {
  return String(str ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}
function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) }
  });
}
