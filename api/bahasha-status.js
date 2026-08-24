"use strict";

const { rpc, readBody, sendJson } = require("./_meta");
const {
  config,
  e164,
  listPhoneNumbers,
  listTemplates,
  sendTemplate,
} = require("./_bahasha");

async function authorize(body) {
  const result = await rpc("school_meta_whatsapp_status_api", {
    p_client_code: String(body.clientCode || "").trim(),
    p_client_secret: String(body.clientSecret || ""),
  });
  if (!result?.ok) {
    const error = new Error(
      result?.code || "NOTIFICATIONS_PERMISSION_REQUIRED",
    );
    error.status = 401;
    throw error;
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return sendJson(res, 405, { ok: false, code: "METHOD_NOT_ALLOWED" });
  }
  const body = readBody(req);
  try {
    await authorize(body);
    const current = config();
    if (!current.configured) {
      return sendJson(res, 200, {
        ok: true,
        connected: false,
        environment: "unconfigured",
        approved_template_count: 0,
      });
    }
    if (body.action === "test") {
      const templates = await listTemplates();
      const mapping = current.templates.general_announcement;
      const template = templates.find(
        (item) => item.name === mapping.name && item.status === "APPROVED",
      );
      if (!template)
        return sendJson(res, 400, {
          ok: false,
          code: "BAHASHA_TEST_TEMPLATE_REQUIRED",
          message: `Create and approve ${mapping.name} in Bahasha first.`,
        });
      const expected = template.expected_variables?.body || [];
      const bodyVariables = {};
      expected.forEach((variable, index) => {
        bodyVariables[String(variable.param_name)] =
          index === 0
            ? "WTS Parent"
            : "This is a WTS notification connection test.";
      });
      const result = await sendTemplate({
        to: e164(body.recipient),
        name: template.name,
        language: template.language,
        variables: expected.length ? { body: bodyVariables } : undefined,
      });
      return sendJson(res, 200, {
        ok: true,
        code: "BAHASHA_TEST_ACCEPTED",
        environment: current.environment,
        sandbox: Boolean(result.sandbox),
        message_id: result.message_id || null,
      });
    }
    const [phoneNumbers, templates] = await Promise.all([
      listPhoneNumbers(),
      listTemplates(),
    ]);
    const phone = (Array.isArray(phoneNumbers) ? phoneNumbers : []).find(
      (item) => String(item.id) === current.phoneNumberId,
    );
    const approved = (Array.isArray(templates) ? templates : []).filter(
      (item) => item.status === "APPROVED",
    );
    return sendJson(res, 200, {
      ok: true,
      connected: Boolean(phone),
      environment: current.environment,
      display_name: phone?.display_name || null,
      phone_number: phone?.phone_number || null,
      quality_rating: phone?.quality_rating || null,
      approved_template_count: approved.length,
      required_templates: Object.values(current.templates)
        .map((item) => item.name)
        .filter((name, index, all) => all.indexOf(name) === index),
      webhook_url:
        "https://wts-notification-system.vercel.app/api/bahasha-webhook",
    });
  } catch (error) {
    return sendJson(res, error.status || 400, {
      ok: false,
      code: error.code || "BAHASHA_STATUS_FAILED",
      message: String(error.message || error),
    });
  }
};
