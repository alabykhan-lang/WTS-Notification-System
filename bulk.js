"use strict";

(() => {
  const API = window.WTS_NOTIFY_API;
  const UI = window.WTS_NOTIFY_UI;
  const state = window.WTS_NOTIFY_STATE;
  const $ = (selector) => document.querySelector(selector);

  function selectedParents() {
    return [...state.selected]
      .map((groupKey) => state.contacts.find((contact) => UI.keyOf(contact) === groupKey))
      .filter(Boolean)
      .map((contact) => ({
        type: "guardian_group",
        id: UI.keyOf(contact),
        memberIds: Array.isArray(contact.member_ids) ? contact.member_ids : [],
      }));
  }

  function selectedContactIds(groups) {
    return groups.flatMap((group) => (Array.isArray(group.memberIds) ? group.memberIds : []));
  }

  async function gatewayRequest(endpoint, action, extra = {}) {
    const auth = API.getAuth();
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, clientCode: auth.code, clientSecret: auth.secret, ...extra }),
    });
    const data = await response.json().catch(() => ({ ok: false, code: "INVALID_RESPONSE" }));
    if (!response.ok || data?.ok === false) {
      const error = new Error(data?.message || data?.code || "Bahasha request failed.");
      error.code = data?.code || "BAHASHA_REQUEST_FAILED";
      throw error;
    }
    return data;
  }

  function renderProvider(data) {
    UI.setProviderData(data);
    const badge = $("#providerBadge");
    const text = $("#providerText");
    const dot = $("#composeProviderDot");
    const composeText = $("#composeProviderText");
    const connected = Boolean(data?.connected);
    const sandbox = data?.environment === "sandbox";
    if (badge) {
      badge.textContent = connected ? (sandbox ? "Sandbox" : "Live ready") : "Needs setup";
      badge.classList.toggle("ready", connected && !sandbox);
      badge.classList.toggle("warn", connected && sandbox);
      badge.classList.toggle("bad", !connected);
    }
    if (text) {
      text.textContent = connected
        ? `${data.display_name || "Bahasha"} · ${data.approved_template_count || 0} approved template(s). ${sandbox ? "Sandbox mode does not send to real parents." : "Live connection is ready."}`
        : "Connect Bahasha and approve a template before sending.";
    }
    if (dot) dot.classList.toggle("on", connected);
    if (composeText) {
      composeText.textContent = connected
        ? sandbox
          ? "Bahasha sandbox connected — no real delivery"
          : "Bahasha live connection ready"
        : "Bahasha connection needs setup";
    }
    UI.renderTemplateSelect();
  }

  async function loadStatus({ silent = false } = {}) {
    try {
      const data = await gatewayRequest("/api/bahasha-status", "status");
      renderProvider(data);
      return data;
    } catch (error) {
      renderProvider({ ok: true, connected: false, environment: "unconfigured", templates: [] });
      if (!silent) UI.toast(error.message, "error");
      return null;
    }
  }

  async function checkBahasha() {
    const button = $("#checkBahasha");
    if (button) button.disabled = true;
    try {
      const data = await loadStatus();
      UI.toast(data?.connected ? "Bahasha connection checked." : "Bahasha still needs setup.", data?.connected ? "success" : "error");
    } finally {
      if (button) button.disabled = false;
    }
  }

  function outcomeSummary(dispatch) {
    const results = Array.isArray(dispatch?.results) ? dispatch.results : [];
    const sent = results.filter((item) => ["sent", "delivered", "read", "simulated"].includes(String(item.status).toLowerCase())).length;
    const failed = results.filter((item) => ["failed", "blocked"].includes(String(item.status).toLowerCase())).length;
    return { sent, failed, processed: results.length };
  }

  async function createParentMessage(event) {
    event.preventDefault();
    const button = $("#sendButton");
    const template = UI.selectedTemplate();
    const classKey = $("#composeClass")?.value || "";
    const audience = $("input[name=audience]:checked")?.value || "all";
    const selected = audience === "selected" ? selectedParents() : [];
    const ready = state.contacts.filter((contact) => contact.eligible === true || contact.eligible === 1 || contact.eligible === "true");
    const count = audience === "selected" ? selected.length : ready.length;
    if (!template?.name) return UI.toast("Choose an approved Bahasha template first.", "error");
    if (!classKey) return UI.toast("Choose a class first.", "error");
    if (!count) return UI.toast("There are no ready parent contacts to send to.", "error");
    const scope = UI.classNameFor(classKey);
    if (!confirm(`Send "${template.name}" to ${count} parent${count === 1 ? "" : "s"} in ${scope}?`)) return;
    if (button) {
      button.disabled = true;
      button.textContent = "Sending…";
    }
    try {
      const result = await API.templateSend({
        audience,
        recipientGroup: "guardian",
        classKey,
        whatsappTemplateName: template.name,
        whatsappTemplateLanguage: template.language || template.language_code || "en_US",
        selectedRecipients: selected,
        contactIds: selectedContactIds(selected),
      });
      let dispatch = null;
      if (result.queued) dispatch = await gatewayRequest("/api/bahasha-dispatch", "dispatch", { limit: result.queued });
      const outcomes = outcomeSummary(dispatch);
      const remaining = Math.max(0, Number(result.queued || 0) - outcomes.processed);
      $("#bulkResult").hidden = false;
      $("#bulkResult").innerHTML = `<strong>Message sent</strong><br>Template: ${UI.escapeHtml(template.name)}<br>Parent groups: ${UI.escapeHtml(result.created || count)}<br>Sent now: ${UI.escapeHtml(outcomes.sent)}${outcomes.failed ? `<br>Failed: ${UI.escapeHtml(outcomes.failed)}` : ""}${remaining ? `<br>Still queued: ${UI.escapeHtml(remaining)}` : ""}`;
      UI.toast(outcomes.sent ? `${outcomes.sent} parent message(s) sent.` : "Message queued for delivery.", outcomes.failed ? "error" : "success");
      await Promise.all([UI.loadSummary(), UI.loadMessages()]);
    } catch (error) {
      UI.toast(error.message, "error");
      $("#bulkResult").hidden = false;
      $("#bulkResult").textContent = error.message;
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = "Send message";
      }
      UI.renderTemplatePreview();
    }
  }

  async function syncContacts(button, classKey = "") {
    const selectedClass = classKey || $("#importClass")?.value || $("#composeClass")?.value || "";
    if (!selectedClass) return UI.toast("Choose a class before syncing contacts.", "error");
    if (!confirm(`Sync eligible ${UI.classNameFor(selectedClass)} parent contacts to Bahasha? This does not send messages.`)) return;
    if (button) {
      button.disabled = true;
      button.textContent = "Syncing…";
    }
    try {
      const result = await gatewayRequest("/api/bahasha-contacts-sync", "sync", { classKey: selectedClass, limit: 1000 });
      const output = `Bahasha contacts updated: ${result.created || 0} created, ${result.updated || 0} updated${result.failed ? `, ${result.failed} failed` : ""}.`;
      if ($("#syncResult")) {
        $("#syncResult").hidden = false;
        $("#syncResult").textContent = output;
      }
      UI.toast(output, result.failed ? "error" : "success");
    } catch (error) {
      if ($("#syncResult")) {
        $("#syncResult").hidden = false;
        $("#syncResult").textContent = error.message;
      }
      UI.toast(error.message, "error");
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = "Sync this class to Bahasha";
      }
    }
  }

  $("#composeForm").onsubmit = createParentMessage;
  $("#checkBahasha").onclick = checkBahasha;
  $("#syncClassContacts").onclick = () => syncContacts($("#syncClassContacts"));

  window.WTS_NOTIFY_PROVIDER = Object.freeze({ loadStatus, syncContacts });
})();
