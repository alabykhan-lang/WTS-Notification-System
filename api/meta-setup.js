"use strict";

const { rpc, normalizePhone, sendTemplate, sendJson, readBody } = require("./_meta");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return sendJson(res, 405, { ok: false, code: "METHOD_NOT_ALLOWED" });
  }

  const body = readBody(req);
  const clientCode = String(body.clientCode || "").trim();
  const clientSecret = String(body.clientSecret || "");
  const action = String(body.action || "status");

  try {
    if (action === "status") {
      const result = await rpc("school_meta_whatsapp_status_api", {
        p_client_code: clientCode,
        p_client_secret: clientSecret,
      });
      return sendJson(res, result?.ok ? 200 : 401, result);
    }

    if (action === "configure") {
      const result = await rpc("school_meta_whatsapp_configure_api", {
        p_client_code: clientCode,
        p_client_secret: clientSecret,
        p_payload: body.configuration || {},
      });
      return sendJson(res, result?.ok ? 200 : 400, result);
    }

    if (action === "test") {
      const config = await rpc("school_meta_whatsapp_runtime_config_api", {
        p_client_code: clientCode,
        p_client_secret: clientSecret,
      });
      if (!config?.ok) return sendJson(res, 401, config);

      const recipient = normalizePhone(body.recipient || "");
      if (!recipient) {
        return sendJson(res, 400, { ok: false, code: "TEST_RECIPIENT_REQUIRED" });
      }

      try {
        const result = await sendTemplate(
          config,
          recipient,
          String(body.templateName || "hello_world"),
          String(body.language || "en_US"),
          [],
        );
        const providerReference = result?.messages?.[0]?.id || null;
        await rpc("school_meta_whatsapp_mark_test_api", {
          p_client_code: clientCode,
          p_client_secret: clientSecret,
          p_success: true,
          p_details: {
            recipient_last4: recipient.slice(-4),
            provider_reference: providerReference,
            template: body.templateName || "hello_world",
          },
        });
        return sendJson(res, 200, {
          ok: true,
          code: "META_TEST_MESSAGE_ACCEPTED",
          recipient_last4: recipient.slice(-4),
          provider_reference: providerReference,
        });
      } catch (error) {
        await rpc("school_meta_whatsapp_mark_test_api", {
          p_client_code: clientCode,
          p_client_secret: clientSecret,
          p_success: false,
          p_details: {
            code: error.code || "META_TEST_FAILED",
            message: String(error.message || error),
          },
        });
        return sendJson(res, 400, {
          ok: false,
          code: error.code || "META_TEST_FAILED",
          message: String(error.message || error),
        });
      }
    }

    if (action === "activate") {
      const result = await rpc("school_meta_whatsapp_activate_api", {
        p_client_code: clientCode,
        p_client_secret: clientSecret,
      });
      return sendJson(res, result?.ok ? 200 : 400, result);
    }

    return sendJson(res, 400, { ok: false, code: "UNKNOWN_ACTION" });
  } catch (error) {
    return sendJson(res, 500, {
      ok: false,
      code: "META_SETUP_ERROR",
      message: String(error.message || error),
    });
  }
};
