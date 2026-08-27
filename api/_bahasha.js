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

async function listContacts({ page = 1, limit = 500, search = "" } = {}) {
  const query = new URLSearchParams({
    page: String(page),
    limit: String(Math.min(Math.max(Number(limit) || 500, 1), 500)),
  });
  if (search) query.set("search", String(search));
  return request(`/v1/organization/contacts?${query.toString()}`);
}

async function createContact(payload) {
  return request("/v1/organization/contacts", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

async function updateContact(id, payload) {
  return request(`/v1/organization/contacts/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

function childrenSummary(message) {
  const payload = message?.payload || {};
  if (payload.children_summary) return String(payload.children_summary);
  if (Array.isArray(payload.children) && payload.children.length) {
    return payload.children
      .map((child) => `${child.name || "Student"}${child.class_name ? ` (${child.class_name})` : ""}`)
      .join(", ");
  }
  return "";
}

function mergedMessage(message) {
  const base = String(message?.message || message?.payload?.message || "");
  const children = childrenSummary(message);
  if (!children || base.toLowerCase().includes(children.toLowerCase())) return base;
  return `${base}\n\nChildren in this message: ${children}`;
}

function displayDate(value) {
  const raw = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const date = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return raw;
  return new Intl.DateTimeFormat("en-NG", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Africa/Lagos",
  }).format(date);
}

function messageValue(message, key) {
  const payload = message.payload || {};
  const templateVariables = payload.template_variables || payload.templateVariables || {};
  const children = childrenSummary(message);
  const childList =
    children || payload.student_name || message.associated_name || "your child";
  const className = payload.class_name || payload.group_name || "";
  const schoolName =
    payload.school_name || "Way to Success Standard Schools, Ejigbo";
  const values = {
    parent_name: message.recipient_name || payload.guardian_name || "Parent",
    guardian_name: message.recipient_name || payload.guardian_name || "Parent",
    student_name: childList,
    student_list: childList,
    student_names: childList,
    children: childList,
    children_summary: children,
    children_list: childList,
    ward_list: childList,
    ward_name: childList,
    ward_names: childList,
    wards: childList,
    child_count: payload.child_count || (Array.isArray(payload.children) ? payload.children.length : ""),
    class_name: className,
    class: className,
    class_list: className,
    school: schoolName,
    school_name: schoolName,
    resumption_date: displayDate(
      templateVariables.resumption_date ||
        payload.resumption_date ||
        payload.next_term_resumption ||
        payload.session_resumption_date,
    ),
    term: templateVariables.term || payload.term || "",
    academic_session: templateVariables.academic_session || payload.academic_session || "",
    date: new Intl.DateTimeFormat("en-NG", { dateStyle: "medium", timeZone: "Africa/Lagos" }).format(new Date()),
    time: new Intl.DateTimeFormat("en-NG", { timeStyle: "short", timeZone: "Africa/Lagos" }).format(new Date()),
    message: payload.template_only ? String(payload.custom_message || "") : mergedMessage(message),
  };
  return values[key] ?? payload[key] ?? "";
}

function variablesFor(template, message, purpose) {
  const expected = template?.expected_variables || {};
  const bodyVariables = expected.body || [];
  if (!bodyVariables.length) return undefined;
  const orderedKeys = positionalKeys[purpose] || positionalKeys.bulk;
  const body = {};
  const templateOnly = Boolean(message?.payload?.template_only);
  const unsupportedTemplateOnlyKeys = new Set([
    "message",
    "correction_summary",
    "secure_link",
    "late_minutes",
    "cutoff_time",
  ]);
  bodyVariables.forEach((variable, index) => {
    const parameterName = String(variable.param_name);
    const sourceKey =
      typeof variable.param_name === "number" || /^\d+$/.test(parameterName)
        ? orderedKeys[index]
        : parameterName;
    const value = String(messageValue(message, sourceKey));
    if (templateOnly && (unsupportedTemplateOnlyKeys.has(sourceKey) || !value)) {
      const error = new Error(
        `The selected template needs a value for ${sourceKey}. Use a fixed approved template for direct sending.`,
      );
      error.code = "BAHASHA_TEMPLATE_VARIABLE_INPUT_REQUIRED";
      throw error;
    }
    body[parameterName] = value;
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
      (item) => item.name === name && (item.language || item.language_code) === language,
    ) || templates.find((item) => item.name === name);
  if (!template || String(template.status || "").toUpperCase() !== "APPROVED") {
    const error = new Error(
      `Approved Bahasha template not found for ${purpose}: ${name || "not mapped"}`,
    );
    error.code = "BAHASHA_APPROVED_TEMPLATE_REQUIRED";
    throw error;
  }
  return {
    name: template.name,
    language: template.language || template.language_code || language,
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
  request,
  listContacts,
  createContact,
  updateContact,
  listPhoneNumbers,
  listTemplates,
  templateFor,
  sendTemplate,
};
