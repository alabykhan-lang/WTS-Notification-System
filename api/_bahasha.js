"use strict";

const { normalizePhone } = require("./_meta");

const DEFAULT_API_ORIGIN = "https://api.bahasha.app";
const DEFAULT_TEMPLATE_MAP = Object.freeze({
  general_announcement: { name: "wts_parent_notice", language: "en_US" },
  bulk: { name: "wts_parent_notice", language: "en_US" },
  attendance: { name: "wts_attendance_notice", language: "en_US" },
  check_in: { name: "wts_attendance_notice", language: "en_US" },
  check_out: { name: "wts_attendance_notice", language: "en_US" },
  late: { name: "wts_attendance_notice", language: "en_US" },
  absence: { name: "wts_attendance_notice", language: "en_US" },
  fees: { name: "wts_fee_notice", language: "en_US" },
  academic_result: { name: "wts_result_notice", language: "en_US" },
  result_published: { name: "wts_result_notice", language: "en_US" },
  emergency: { name: "wts_emergency_notice", language: "en_US" },
});

const positionalKeys = Object.freeze({
  general_announcement: ["parent_name", "message"],
  bulk: ["parent_name", "message"],
  attendance: ["parent_name", "student_name", "message"],
  check_in: ["parent_name", "student_name", "time", "date"],
  check_out: ["parent_name", "student_name", "time", "date"],
  late: ["parent_name", "student_name", "time", "late_minutes"],
  absence: ["parent_name", "student_name", "cutoff_time", "date"],
  fees: ["parent_name", "student_name", "message"],
  academic_result: ["parent_name", "student_name", "term", "message"],
  result_published: ["parent_name", "student_name", "term", "secure_link"],
  emergency: ["parent_name", "message"],
});

function templateMap() {
  try {
    return {
      ...DEFAULT_TEMPLATE_MAP,
      ...JSON.parse(process.env.BAHASHA_TEMPLATE_MAP || "{}"),
    };
  } catch {
    return { ...DEFAULT_TEMPLATE_MAP };
  }
}

function config() {
  const apiKey = String(
    process.env.BAHASHA_API_TOKEN || process.env.BAHASHA_API_KEY || "",
  ).trim();
  const phoneNumberId = String(
    process.env.BAHASHA_PHONE_NUMBER_ID || "",
  ).trim();
  const apiOrigin = String(
    process.env.BAHASHA_API_BASE_URL || DEFAULT_API_ORIGIN,
  ).trim().replace(/\/+$/, "");
  return {
    apiKey,
    phoneNumberId,
    apiOrigin,
    environment: apiKey.startsWith("bh_test_")
      ? "sandbox"
      : apiKey.startsWith("bh_live_")
        ? "production"
        : "unconfigured",
    configured: Boolean(apiKey && phoneNumberId),
    templates: templateMap(),
  };
}

function e164(value) {
  const normalized = normalizePhone(value);
  if (normalized.length < 10) {
    const error = new Error("INVALID_WHATSAPP_DESTINATION");
    error.code = "INVALID_WHATSAPP_DESTINATION";
    throw error;
  }
  return `+${normalized}`;
}

async function request(path, options = {}) {
  const current = config();
  if (!current.configured) {
    const error = new Error(
      "Bahasha API key and phone number ID are not configured in Vercel.",
    );
    error.code = "BAHASHA_CONFIGURATION_REQUIRED";
    throw error;
  }
  const response = await fetch(`${current.apiOrigin}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${current.apiKey}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(20000),
  });
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text.slice(0, 800) };
  }
  if (!response.ok) {
    const error = new Error(
      data?.message || data?.error || `BAHASHA_HTTP_${response.status}`,
    );
    error.code = data?.code || `BAHASHA_HTTP_${response.status}`;
    error.details = data;
    error.retryAfterSeconds =
      response.status === 429 || response.status >= 500 ? 900 : null;
    throw error;
  }
  return data;
}

async function listPhoneNumbers() {
  return request("/v1/whatsapp/phone_numbers");
}

async function listTemplates(phoneNumberId = config().phoneNumberId) {
  return request(
    `/v1/whatsapp/phone_numbers/${encodeURIComponent(phoneNumberId)}/templates`,
  );
}

function messageValue(message, key) {
  const payload = message.payload || {};
  const values = {
    parent_name: message.recipient_name || payload.guardian_name || "Parent",
    guardian_name: message.recipient_name || payload.guardian_name || "Parent",
    student_name:
      payload.student_name || message.associated_name || "your child",
    message: message.message || payload.message || "",
  };
  return values[key] ?? payload[key] ?? "";
}

function variablesFor(template, message, purpose) {
  const expected = template?.expected_variables || {};
  const bodyVariables = expected.body || [];
  if (!bodyVariables.length) return undefined;
  const orderedKeys = positionalKeys[purpose] || positionalKeys.bulk;
  const body = {};
  bodyVariables.forEach((variable, index) => {
    const parameterName = String(variable.param_name);
    const sourceKey =
      typeof variable.param_name === "number"
        ? orderedKeys[index]
        : parameterName;
    body[parameterName] = String(messageValue(message, sourceKey));
  });
  return { body };
}

function templateFor(message, templates) {
  const purpose =
    message.payload?.purpose || message.source_event_type || "bulk";
  const mapping = config().templates[purpose] || config().templates.bulk;
  const name = message.payload?.whatsapp_template_name || mapping?.name;
  const language =
    message.payload?.whatsapp_template_language || mapping?.language || "en_US";
  const template =
    templates.find(
      (item) => item.name === name && item.language === language,
    ) || templates.find((item) => item.name === name);
  if (!template || template.status !== "APPROVED") {
    const error = new Error(
      `Approved Bahasha template not found for ${purpose}: ${name || "not mapped"}`,
    );
    error.code = "BAHASHA_APPROVED_TEMPLATE_REQUIRED";
    throw error;
  }
  return {
    name: template.name,
    language: template.language,
    variables: variablesFor(template, message, purpose),
  };
}

async function sendTemplate({ to, name, language, variables }) {
  const current = config();
  const payload = {
    to: e164(to),
    phone_number_id: current.phoneNumberId,
    template_name: name,
    language_code: language,
  };
  if (variables && Object.keys(variables.body || {}).length)
    payload.variables = variables;
  return request("/v1/whatsapp/send", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

module.exports = {
  config,
  e164,
  listPhoneNumbers,
  listTemplates,
  templateFor,
  sendTemplate,
};
