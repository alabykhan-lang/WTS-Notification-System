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
  return result;
}

async function readInternalTemplates(body) {
  try {
    const result = await rpc("school_notification_control_read_api", {
      p_client_code: String(body.clientCode || "").trim(),
      p_client_secret: String(body.clientSecret || ""),
      p_action: "templates",
      p_payload: {},
    });
    return Array.isArray(result?.templates) ? result.templates : [];
  } catch {
    return [];
  }
}

function asArray(value, keys = []) {
  if (Array.isArray(value)) return value;
  for (const key of keys) {
    if (Array.isArray(value?.[key])) return value[key];
  }
  return [];
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return sendJson(res, 405, { ok: false, code: "METHOD_NOT_ALLOWED" });
  }
  const body = readBody(req);
  try {
    const internalStatus = await authorize(body);
    const current = config();
    const internalTemplates = await readInternalTemplates(body);
    const delivery = internalStatus?.delivery || null;
    const provider = internalStatus?.provider || null;
    const liveReady = Boolean(
      current.configured &&
        current.environment === "production" &&
        delivery?.delivery_enabled &&
        !delivery?.dry_run &&
        delivery?.active_provider_code === "meta_whatsapp_cloud" &&
        String(provider?.status || "").toLowerCase() === "active",
    );
    if (!current.configured) {
      return sendJson(res, 200, {
        ok: true,
        connected: false,
        live_delivery_ready: false,
        environment: "unconfigured",
        approved_template_count: 0,
        templates: [],
        internal_templates: internalTemplates,
        template_mappings: current.templates,
        delivery,
        provider,
      });
    }
    if (body.action === "test") {
      const templatesResponse = await listTemplates();
      const templates = asArray(templatesResponse, ["templates", "data", "items"]);
      const mapping = current.templates.general_announcement;
      const template = templates.find(
        (item) => item.name === mapping.name && String(item.status || "").toUpperCase() === "APPROVED",
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
    const [phoneNumbersResponse, templatesResponse] = await Promise.all([
      listPhoneNumbers(),
      listTemplates(),
    ]);
    const phoneNumbers = asArray(phoneNumbersResponse, ["phone_numbers", "data", "items"]);
    const templates = asArray(templatesResponse, ["templates", "data", "items"]);
    const phone = (Array.isArray(phoneNumbers) ? phoneNumbers : []).find(
      (item) => String(item.id) === current.phoneNumberId,
    );
    const approved = (Array.isArray(templates) ? templates : []).filter(
      (item) => String(item.status || "").toUpperCase() === "APPROVED",
    );
    return sendJson(res, 200, {
      ok: true,
      connected: Boolean(phone),
      live_delivery_ready: liveReady && Boolean(phone),
      environment: current.environment,
      display_name: phone?.display_name || null,
      phone_number: phone?.phone_number || null,
      quality_rating: phone?.quality_rating || null,
      approved_template_count: approved.length,
      templates,
      internal_templates: internalTemplates,
      template_mappings: current.templates,
      delivery,
      provider,
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
