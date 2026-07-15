"use strict";

const { rpc, sendTemplate, sendJson, readBody } = require("./_meta");

const parameterKeys = {
  check_in: ["guardian_name", "student_name", "time", "date"],
  late: ["student_name", "time", "late_minutes"],
  absence: ["student_name", "cutoff_time", "date"],
  check_out: ["student_name", "time", "date"],
  correction: ["student_name", "date", "correction_summary"],
  result_published: ["term", "student_name", "secure_link"],
  bulk: ["message"],
};

function templateFor(config, message) {
  const event = message.source_event_type || "bulk";
  const mapping = config?.template_map?.[event] || {};
  const parameters = (parameterKeys[event] || []).map((key) => (
    key === "message" ? message.message : message.payload?.[key] ?? ""
  ));
  return {
    name: message.payload?.whatsapp_template_name || mapping.name,
    language: message.payload?.whatsapp_template_language || mapping.language || "en_US",
    parameters,
  };
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return sendJson(res, 405, { ok: false, code: "METHOD_NOT_ALLOWED" });
  }

  const body = readBody(req);
  const clientCode = String(body.clientCode || "").trim();
  const clientSecret = String(body.clientSecret || "");
  const workerId = `meta-${crypto.randomUUID()}`;

  try {
    const config = await rpc("school_meta_whatsapp_runtime_config_api", {
      p_client_code: clientCode,
      p_client_secret: clientSecret,
    });
    if (!config?.ok) return sendJson(res, 401, config);

    const claim = await rpc("school_meta_whatsapp_claim_api", {
      p_client_code: clientCode,
      p_client_secret: clientSecret,
      p_worker_id: workerId,
      p_limit: Math.min(Math.max(Number(body.limit || 25), 1), 100),
    });
    if (!claim?.ok) return sendJson(res, 409, claim);

    const results = [];
    for (const message of claim.messages || []) {
      try {
        const template = templateFor(config, message);
        if (!template.name) {
          const error = new Error("APPROVED_WHATSAPP_TEMPLATE_REQUIRED");
          error.code = "APPROVED_WHATSAPP_TEMPLATE_REQUIRED";
          throw error;
        }
        const sent = await sendTemplate(
          config,
          message.destination,
          template.name,
          template.language,
          template.parameters,
        );
        const providerReference = sent?.messages?.[0]?.id || null;
        const completion = await rpc("school_meta_whatsapp_complete_api", {
          p_client_code: clientCode,
          p_client_secret: clientSecret,
          p_message_id: message.id,
          p_worker_id: workerId,
          p_success: true,
          p_provider_reference: providerReference,
          p_response: { accepted: true, template: template.name },
          p_error_code: null,
          p_error_message: null,
          p_retry_after_seconds: null,
        });
        results.push({
          id: message.id,
          status: completion?.status || "sent",
          provider_reference: providerReference,
        });
      } catch (error) {
        const completion = await rpc("school_meta_whatsapp_complete_api", {
          p_client_code: clientCode,
          p_client_secret: clientSecret,
          p_message_id: message.id,
          p_worker_id: workerId,
          p_success: false,
          p_provider_reference: null,
          p_response: {},
          p_error_code: error.code || "META_DELIVERY_FAILED",
          p_error_message: String(error.message || error),
          p_retry_after_seconds: null,
        });
        results.push({
          id: message.id,
          status: completion?.status || "failed",
          error: String(error.message || error),
        });
      }
    }

    return sendJson(res, 200, {
      ok: true,
      code: "META_DISPATCH_COMPLETED",
      claimed: claim.messages?.length || 0,
      results,
    });
  } catch (error) {
    return sendJson(res, 500, {
      ok: false,
      code: "META_DISPATCH_ERROR",
      message: String(error.message || error),
    });
  }
};
