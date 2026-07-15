"use strict";

const { rpc, sendJson } = require("./_meta");

async function readRaw(req) {
  if (typeof req.body === "string") return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString("utf8");
  if (req.body && typeof req.body === "object") return JSON.stringify(req.body);
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

module.exports = async function handler(req, res) {
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    try {
      const verified = await rpc("school_meta_whatsapp_verify_webhook_token", {
        p_token: String(token || ""),
      });
      if (mode === "subscribe" && verified === true) {
        res.status(200).send(String(challenge || ""));
        return;
      }
      res.status(403).send("Verification failed");
      return;
    } catch {
      res.status(503).send("Webhook configuration unavailable");
      return;
    }
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return sendJson(res, 405, { ok: false, code: "METHOD_NOT_ALLOWED" });
  }

  const raw = await readRaw(req);
  let body = {};
  try { body = raw ? JSON.parse(raw) : {}; }
  catch { return sendJson(res, 400, { ok: false, code: "INVALID_JSON" }); }

  if (body?.object !== "whatsapp_business_account") {
    return sendJson(res, 200, { ok: true, code: "WEBHOOK_IGNORED" });
  }

  const signature = String(req.headers["x-hub-signature-256"] || "");
  let recorded = 0;
  try {
    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        for (const status of change?.value?.statuses || []) {
          const error = status?.errors?.[0] || {};
          const result = await rpc("school_meta_whatsapp_webhook_status_secure", {
            p_raw_body: raw,
            p_signature: signature,
            p_provider_reference: status.id,
            p_status: status.status,
            p_timestamp: status.timestamp
              ? new Date(Number(status.timestamp) * 1000).toISOString()
              : new Date().toISOString(),
            p_details: {
              code: error.code ? String(error.code) : null,
              message: error.title || error.message || null,
            },
          });
          if (!result?.ok && result?.code === "INVALID_WEBHOOK_SIGNATURE") {
            return sendJson(res, 401, result);
          }
          if (result?.ok) recorded += 1;
        }
      }
    }
    return sendJson(res, 200, {
      ok: true,
      code: "WEBHOOK_ACCEPTED",
      recorded,
    });
  } catch (error) {
    return sendJson(res, 500, {
      ok: false,
      code: "WEBHOOK_PROCESSING_FAILED",
      message: String(error.message || error),
    });
  }
};
