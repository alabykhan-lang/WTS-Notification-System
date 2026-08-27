"use strict";

const { rpc, readBody, sendJson, normalizePhone } = require("./_meta");
const {
  config,
  listContacts,
  createContact,
  updateContact,
} = require("./_bahasha");

async function authorize(body) {
  const result = await rpc("school_meta_whatsapp_status_api", {
    p_client_code: String(body.clientCode || "").trim(),
    p_client_secret: String(body.clientSecret || ""),
  });
  if (!result?.ok) {
    const error = new Error(result?.code || "NOTIFICATIONS_PERMISSION_REQUIRED");
    error.status = 401;
    throw error;
  }
}

function asArray(value, keys = []) {
  if (Array.isArray(value)) return value;
  for (const key of keys) {
    if (Array.isArray(value?.[key])) return value[key];
  }
  return [];
}

function numberKey(value) {
  const digits = normalizePhone(value);
  return digits.length >= 10 ? `+${digits}` : null;
}

function contactNumber(contact) {
  return contact?.number || contact?.phone_number || contact?.whatsapp_number || contact?.phone || contact?.phoneNumber || "";
}

function contactId(contact) {
  return contact?.id || contact?.contact_id || contact?.contactId || null;
}

function slug(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 70);
}

function groupTags(group) {
  const classes = Array.isArray(group.classes) ? group.classes : [];
  return ["wts-parent", ...classes.map((value) => `wts-class-${slug(value)}`)];
}

function contactPayload(group, existing = null) {
  const existingTags = Array.isArray(existing?.tags) ? existing.tags : [];
  const preservedTags = existingTags.filter(
    (tag) => !/^wts-parent$|^wts-class-/i.test(String(tag)),
  );
  const children = Array.isArray(group.children) ? group.children : [];
  const attributes = {
    ...(existing?.attributes && typeof existing.attributes === "object" ? existing.attributes : {}),
    wts_source: "wts-notification-system",
    wts_group_key: String(group.group_key || ""),
    wts_child_count: String(group.child_count || children.length || 0),
    wts_classes: (Array.isArray(group.classes) ? group.classes : []).join(", "),
    wts_student_ids: children.map((child) => child.student_id).filter(Boolean).join(","),
    wts_consent_status: String(group.consent_status || "pending"),
    wts_last_synced_at: new Date().toISOString(),
  };
  return {
    number: group.whatsapp_number,
    full_name: group.display_name || "WTS Parent",
    tags: [...new Set([...preservedTags, ...groupTags(group)])],
    attributes,
  };
}

async function allBahashaContacts() {
  const result = [];
  const limit = 500;
  for (let page = 1; page <= 20; page += 1) {
    const response = await listContacts({ page, limit });
    const batch = asArray(response, ["contacts", "data", "items", "results"]);
    result.push(...batch);
    const pagination = response?.pagination || response?.meta || {};
    const hasNext = Boolean(
      pagination.next_page ||
        pagination.nextPage ||
        pagination.has_next ||
        pagination.hasNext ||
        (pagination.current_page && pagination.total_pages && pagination.current_page < pagination.total_pages),
    );
    if (batch.length < limit && !hasNext) break;
  }
  return result;
}

async function runWithConcurrency(items, worker, concurrency = 4) {
  const results = new Array(items.length);
  let cursor = 0;
  async function consume() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length || 1) }, consume));
  return results;
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
      return sendJson(res, 503, {
        ok: false,
        code: "BAHASHA_CONFIGURATION_REQUIRED",
        message: "Add the Bahasha API key and phone number ID in Vercel first.",
      });
    }
    if (body.action !== "sync") {
      return sendJson(res, 400, { ok: false, code: "UNKNOWN_ACTION" });
    }

    const classKey = String(body.classKey || "all").trim() || "all";
    const limit = Math.min(Math.max(Number(body.limit || 1000), 1), 1000);
    const groupsResult = await rpc("school_notification_recipient_admin_read_api", {
      p_client_code: String(body.clientCode || "").trim(),
      p_client_secret: String(body.clientSecret || ""),
      p_action: "recipients",
      p_payload: {
        recipientType: "guardian",
        classKey,
        // The recipient API must group all child links before calculating
        // effective consent; filtering individual rows would hide pending
        // siblings from a parent group.
        status: "",
        pilotOnly: false,
        limit,
      },
    });
    const groups = asArray(groupsResult, ["recipients"]).filter(
      (group) => group.recipient_type === "guardian" && group.eligible && group.whatsapp_number,
    );
    const existingContacts = await allBahashaContacts();
    const byNumber = new Map();
    existingContacts.forEach((contact) => {
      const key = numberKey(contactNumber(contact));
      if (key && !byNumber.has(key)) byNumber.set(key, contact);
    });

    const dryRun = Boolean(body.dryRun);
    const results = await runWithConcurrency(groups, async (group) => {
      const key = numberKey(group.whatsapp_number);
      const existing = key ? byNumber.get(key) : null;
      const existingId = contactId(existing);
      const payload = contactPayload(group, existing);
      if (dryRun) return { group_key: group.group_key, action: existingId ? "update" : "create" };
      try {
        const result = existingId
          ? await updateContact(existingId, payload)
          : await createContact(payload);
        if (!existingId) {
          const created = asArray(result, ["contacts", "data"])[0] || result?.contact || result;
          if (created) byNumber.set(key, created);
        }
        return { group_key: group.group_key, action: existingId ? "updated" : "created" };
      } catch (error) {
        return {
          group_key: group.group_key,
          action: "failed",
          code: error.code || "BAHASHA_CONTACT_SYNC_FAILED",
          message: String(error.message || error),
        };
      }
    });

    const created = results.filter((item) => item.action === "created").length;
    const updated = results.filter((item) => item.action === "updated" || item.action === "update").length;
    const failed = results.filter((item) => item.action === "failed");
    return sendJson(res, 200, {
      ok: true,
      code: dryRun ? "BAHASHA_CONTACT_SYNC_PREVIEW" : "BAHASHA_CONTACT_SYNC_COMPLETED",
      scope: classKey,
      dry_run: dryRun,
      wts_groups: groups.length,
      remote_contacts: existingContacts.length,
      created,
      updated,
      failed: failed.length,
      errors: failed.slice(0, 25),
    });
  } catch (error) {
    return sendJson(res, error.status || 400, {
      ok: false,
      code: error.code || "BAHASHA_CONTACT_SYNC_FAILED",
      message: String(error.message || error),
    });
  }
};
