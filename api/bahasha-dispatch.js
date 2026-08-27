"use strict";

const crypto = require("node:crypto");
const { rpc, readBody, sendJson } = require("./_meta");
const {
  config,
  listTemplates,
  templateFor,
  sendTemplate,
} = require("./_bahasha");

function workerHeaders(token) {
  return token ? { "x-wts-worker-secret": token } : {};
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return sendJson(res, 405, { ok: false, code: "METHOD_NOT_ALLOWED" });
  }
  const body = readBody(req);
  const workerToken = String(req.headers["x-wts-worker-secret"] || "").trim();
  const scheduledWorker = workerToken.length > 0;
  const clientCode = String(body.clientCode || "").trim();
  const clientSecret = String(body.clientSecret || "");
  const workerId = `${scheduledWorker ? "cron" : "bahasha"}-${crypto.randomUUID()}`;
  const limit = Math.min(
    Math.max(Number(body.limit || 25), 1),
    scheduledWorker ? 25 : 100,
  );
  if (!scheduledWorker && (!clientCode || !clientSecret)) {
    return sendJson(res, 401, {
      ok: false,
      code: "STAFF_PORTAL_AUTH_REQUIRED",
    });
  }

  try {
    if (!config().configured)
      return sendJson(res, 503, {
        ok: false,
        code: "BAHASHA_CONFIGURATION_REQUIRED",
        message: "Add the Bahasha API key and phone number ID in Vercel first.",
      });
    const headers = workerHeaders(workerToken);
    const claimName = scheduledWorker
      ? "school_meta_whatsapp_claim_worker"
      : "school_meta_whatsapp_claim_api";
    const completeName = scheduledWorker
      ? "school_meta_whatsapp_complete_worker"
      : "school_meta_whatsapp_complete_api";
    if (!scheduledWorker) {
      const authorized = await rpc("school_meta_whatsapp_status_api", {
        p_client_code: clientCode,
        p_client_secret: clientSecret,
      });
      if (!authorized?.ok) return sendJson(res, 401, authorized);
    }
    const claim = await rpc(
      claimName,
      scheduledWorker
        ? { p_worker_id: workerId, p_limit: limit }
        : {
            p_client_code: clientCode,
            p_client_secret: clientSecret,
            p_worker_id: workerId,
            p_limit: limit,
          },
      headers,
    );
    if (!claim?.ok)
      return sendJson(
        res,
        claim?.code === "WORKER_AUTH_FAILED" ? 403 : 409,
        claim,
      );

    const templates = await listTemplates();
    const results = [];
    for (const message of claim.messages || []) {
      if (message.recipient_type === "staff") {
        const completionArgs = {
          p_message_id: message.id,
          p_worker_id: workerId,
          p_success: false,
          p_provider_reference: null,
          p_response: { provider: "bahasha", blocked: true },
          p_error_code: "PARENT_RECIPIENTS_ONLY",
          p_error_message:
            "Staff recipients are outside the WTS Notification System audience.",
          p_retry_after_seconds: null,
        };
        await rpc(
          completeName,
          scheduledWorker
            ? completionArgs
            : {
                p_client_code: clientCode,
                p_client_secret: clientSecret,
                ...completionArgs,
              },
          headers,
        );
        results.push({
          id: message.id,
          status: "blocked",
          reason: "PARENT_RECIPIENTS_ONLY",
        });
        continue;
      }
      try {
        const template = templateFor(message, templates);
        const sent = await sendTemplate({
          to: message.destination,
          ...template,
        });
        const completionArgs = {
          p_message_id: message.id,
          p_worker_id: workerId,
          p_success: true,
          p_provider_reference: sent?.message_id || null,
          p_response: {
            accepted: true,
            provider: "bahasha",
            sandbox: Boolean(sent?.sandbox),
            template: template.name,
          },
          p_error_code: null,
          p_error_message: null,
          p_retry_after_seconds: null,
        };
        const completion = await rpc(
          completeName,
          scheduledWorker
            ? completionArgs
            : {
                p_client_code: clientCode,
                p_client_secret: clientSecret,
                ...completionArgs,
              },
          headers,
        );
        results.push({
          id: message.id,
          status: completion?.status || (sent?.sandbox ? "simulated" : "sent"),
          provider_reference: sent?.message_id || null,
        });
      } catch (error) {
        const completionArgs = {
          p_message_id: message.id,
          p_worker_id: workerId,
          p_success: false,
          p_provider_reference: null,
          p_response: error.details ? { provider_error: error.details } : {},
          p_error_code: error.code || "BAHASHA_DELIVERY_FAILED",
          p_error_message: String(error.message || error),
          p_retry_after_seconds: error.retryAfterSeconds ?? null,
        };
        const completion = await rpc(
          completeName,
          scheduledWorker
            ? completionArgs
            : {
                p_client_code: clientCode,
                p_client_secret: clientSecret,
                ...completionArgs,
              },
          headers,
        );
        results.push({
          id: message.id,
          status: completion?.status || "failed",
          error: String(error.message || error),
        });
      }
    }
    return sendJson(res, 200, {
      ok: true,
      code: "BAHASHA_DISPATCH_COMPLETED",
      mode: scheduledWorker ? "scheduled_worker" : "management",
      claimed: claim.messages?.length || 0,
      results,
    });
  } catch (error) {
    return sendJson(res, 500, {
      ok: false,
      code: error.code || "BAHASHA_DISPATCH_ERROR",
      message: String(error.message || error),
    });
  }
};
