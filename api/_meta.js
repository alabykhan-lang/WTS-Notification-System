"use strict";

const SUPABASE_URL = "https://wuftzyeajmsxdrbwaawl.supabase.co";
const PUBLISHABLE_KEY = ["sb", "publishable", "7AKtP6jh9xg8CdrK8F53xA", "q4yZskPJ"].join("_");

async function rpc(name, args, extraHeaders = {}) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: PUBLISHABLE_KEY,
      Authorization: `Bearer ${PUBLISHABLE_KEY}`,
      ...extraHeaders,
    },
    body: JSON.stringify(args || {}),
    signal: AbortSignal.timeout(20000),
  });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; }
  catch { data = { raw: text.slice(0, 800) }; }
  if (!response.ok) {
    const error = new Error(data?.message || data?.error || `${name} failed`);
    error.code = `SUPABASE_${response.status}`;
    error.details = data;
    throw error;
  }
  return data;
}

function normalizePhone(value) {
  let phone = String(value || "").replace(/\D/g, "");
  if (phone.startsWith("0")) phone = `234${phone.slice(1)}`;
  return phone;
}

async function sendTemplate(config, destination, name, language, parameters = []) {
  if (!config?.access_token || !config?.phone_number_id || !config?.graph_version) {
    const error = new Error("META_CONFIGURATION_INCOMPLETE");
    error.code = "META_CONFIGURATION_INCOMPLETE";
    throw error;
  }
  if (!name) {
    const error = new Error("APPROVED_WHATSAPP_TEMPLATE_REQUIRED");
    error.code = "APPROVED_WHATSAPP_TEMPLATE_REQUIRED";
    throw error;
  }
  const to = normalizePhone(destination);
  if (to.length < 10) {
    const error = new Error("INVALID_WHATSAPP_DESTINATION");
    error.code = "INVALID_WHATSAPP_DESTINATION";
    throw error;
  }
  const template = { name, language: { code: language || "en_US" } };
  if (parameters.length) {
    template.components = [{
      type: "body",
      parameters: parameters.map((text) => ({ type: "text", text: String(text ?? "") })),
    }];
  }
  const response = await fetch(
    `https://graph.facebook.com/${config.graph_version}/${config.phone_number_id}/messages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.access_token}`,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "template",
        template,
      }),
      signal: AbortSignal.timeout(20000),
    },
  );
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; }
  catch { data = { raw: text.slice(0, 800) }; }
  if (!response.ok) {
    const error = new Error(data?.error?.message || `META_HTTP_${response.status}`);
    error.code = data?.error?.code ? `META_${data.error.code}` : `META_HTTP_${response.status}`;
    error.details = data?.error || data;
    error.retryAfterSeconds = response.status === 429 || response.status >= 500 ? 900 : null;
    throw error;
  }
  return data;
}

function sendJson(res, status, body) {
  res.status(status);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.send(JSON.stringify(body));
}

function readBody(req) {
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) return req.body;
  try {
    const value = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : req.body;
    return JSON.parse(value || "{}");
  } catch {
    return {};
  }
}

module.exports = { rpc, normalizePhone, sendTemplate, sendJson, readBody };
