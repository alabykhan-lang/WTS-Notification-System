"use strict";

const { timingSafeEqual } = require("node:crypto");
const { rpc, sendJson } = require("./_meta");

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

function webhookTimestamp(value) {
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) {
    try {
      return new Date(seconds * 1000).toISOString();
    } catch {
      return new Date().toISOString();
    }
  }
  return new Date().toISOString();
}

module.exports = async function handler(req, res) {
  if (req.method === "GET") {
    const configuredToken =
      process.env.BAHASHA_WEBHOOK_VERIFICATION_TOKEN ||
      process.env.BAHASHA_WEBHOOK_VERIFY_TOKEN ||
      process.env.WEBHOOK_VERIFICATION_TOKEN;
    if (!configuredToken) {
      console.error("Bahasha webhook verification token is not configured");
      return res
        .status(503)
        .send("Webhook verification token is not configured");
    }
    const valid =
      req.query["hub.mode"] === "subscribe" &&
      safeEqual(req.query["hub.verify_token"], configuredToken);
    if (!valid) return res.status(403).send("Verification failed");
    return res.status(200).send(String(req.query["hub.challenge"] || ""));
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return sendJson(res, 405, { ok: false, code: "METHOD_NOT_ALLOWED" });
  }
  const body = req.body && typeof req.body === "object" ? req.body : {};
  if (body.object !== "whatsapp_business_account") {
    return res.status(200).send("OK");
  }
  let statuses = 0;
  let replies = 0;
  let recorded = 0;
  let recordFailures = 0;
  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      if (change.field !== "messages") continue;
      for (const status of change.value?.statuses || []) {
        statuses += 1;
        try {
          const result = await rpc("school_meta_whatsapp_webhook_status", {
            p_provider_reference: String(status.id || ""),
            p_status: String(status.status || "").toLowerCase(),
            p_timestamp: webhookTimestamp(status.timestamp),
            p_details: {
              code: status.errors?.[0]?.code ? String(status.errors[0].code) : null,
              title: status.errors?.[0]?.title || null,
              message: status.errors?.[0]?.message || null,
              details: status.errors?.[0]?.error_data?.details || null,
              provider: "bahasha",
            },
          });
          if (result?.ok) recorded += 1;
          else recordFailures += 1;
        } catch (error) {
          recordFailures += 1;
          console.error("Bahasha delivery status persistence failed", error.message || error);
        }
        console.log(
          JSON.stringify({
            event: "bahasha.delivery",
            id: status.id,
            status: status.status,
            recipient: status.recipient_id,
            timestamp: status.timestamp,
            error: status.errors?.[0] || null,
          }),
        );
      }
      for (const message of change.value?.messages || []) {
        replies += 1;
        console.log(
          JSON.stringify({
            event: "bahasha.reply",
            id: message.id,
            from: message.from,
            type: message.type,
            timestamp: message.timestamp,
          }),
        );
      }
    }
  }
  console.log(
    JSON.stringify({ event: "bahasha.webhook.accepted", statuses, replies, recorded, recordFailures }),
  );
  return res.status(200).send("OK");
};
