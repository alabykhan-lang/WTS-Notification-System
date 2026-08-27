"use strict";

(() => {
  const API = window.WTS_NOTIFY_API;
  const UI = window.WTS_NOTIFY_UI;
  const state = window.WTS_NOTIFY_STATE;
  const $ = (selector) => document.querySelector(selector);

  function selectedParents() {
    return [...state.selected]
      .map((groupKey) => state.contacts.find((contact) => (contact.group_key || `guardian:${contact.recipient_id}`) === groupKey))
      .filter(Boolean)
      .map((contact) => ({
        type: "guardian_group",
        id: contact.group_key,
        memberIds: contact.member_ids || [],
      }));
  }

  function selectedContactIds(groups) {
    return groups.flatMap((group) => (Array.isArray(group.memberIds) ? group.memberIds : []));
  }

  function selectedTemplate() {
    const value = $("#templateSelect")?.value || "";
    if (!value) return {};
    const separator = value.indexOf("::");
    if (separator < 0) return {};
    try {
      return {
        whatsappTemplateName: decodeURIComponent(value.slice(0, separator)),
        whatsappTemplateLanguage: decodeURIComponent(value.slice(separator + 2)),
      };
    } catch {
      return {};
    }
  }

  async function createParentMessage(event) {
    event.preventDefault();
    const button = event.submitter || $("#composeForm button[type='submit']");
    if (button) {
      button.disabled = true;
      button.textContent = "Preparing…";
    }
    try {
      const audience = $("#audience").value;
      const selected = audience === "selected" ? selectedParents() : [];
      const message = $("#message").value.trim();
      if (!message) throw new Error("Write the information parents should receive.");
      if (audience === "selected" && !selected.length) throw new Error("Open Parents, select ready groups, then return here.");

      const result = await API.bulk({
        audience,
        recipientGroup: "guardian",
        channel: "whatsapp",
        languageCode: "en",
        purpose: $("#purpose").value,
        classKey: $("#composeClass").value,
        message,
        queueNow: $("#queueNow").checked,
        selectedRecipients: selected,
        contactIds: selectedContactIds(selected),
        ...selectedTemplate(),
      });

      const parentGroups = result.parent_groups ?? result.created ?? 0;
      $("#bulkResult").innerHTML = `<strong>Parent message batch prepared</strong><br>Parent groups: ${UI.escapeHtml(parentGroups)}<br>WhatsApp messages created: ${UI.escapeHtml(result.created || 0)}<br>Queued for delivery: ${UI.escapeHtml(result.queued || 0)}<br>Scope: ${UI.escapeHtml($("#composeClass").selectedOptions[0]?.textContent || "All active classes")}<br>Status: ${UI.escapeHtml(result.status || "draft")}${result.warning ? `<br><small>${UI.escapeHtml(result.warning)}</small>` : ""}`;
      UI.toast(`${parentGroups} parent group message(s) prepared.`, parentGroups ? "success" : "");
      $("#queueNow").checked = false;
      await Promise.all([UI.loadSummary(), UI.loadMessages()]);
    } catch (error) {
      UI.toast(error.message, "error");
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = "Prepare parent messages";
      }
    }
  }

  async function gatewayRequest(endpoint, action, extra = {}) {
    const auth = API.getAuth();
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, clientCode: auth.code, clientSecret: auth.secret, ...extra }),
    });
    const data = await response.json().catch(() => ({ ok: false, code: "INVALID_RESPONSE" }));
    if (!response.ok || data?.ok === false) throw new Error(data?.message || data?.code || "Bahasha request failed.");
    return data;
  }

  function renderProvider(data) {
    UI.setProviderData(data);
    const badge = $("#providerBadge");
    const text = $("#providerText");
    if (!badge || !text) return;
    badge.textContent = data.connected
      ? data.environment === "sandbox" ? "Sandbox ready" : "Live ready"
      : "Setup required";
    badge.classList.toggle("ready", Boolean(data.connected));
    badge.classList.toggle("warn", !data.connected && data.environment !== "unconfigured");
    text.textContent = data.connected
      ? `${data.display_name || "Bahasha"} is connected with ${data.approved_template_count || 0} approved template(s). ${data.environment === "sandbox" ? "Sandbox mode does not send to real parents." : "Production mode is enabled."}`
      : "Add the Bahasha API key and phone number ID in Vercel, then approve the required templates in Bahasha.";
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
      UI.toast(data?.connected ? "Bahasha connection is ready." : "Bahasha setup is not complete.", data?.connected ? "success" : "");
    } finally {
      if (button) button.disabled = false;
    }
  }

  async function syncContacts(button) {
    if (!confirm("Synchronize eligible WTS parent groups to Bahasha Contacts? This does not send messages.")) return;
    if (button) {
      button.disabled = true;
      button.textContent = "Syncing…";
    }
    try {
      const result = await gatewayRequest("/api/bahasha-contacts-sync", "sync", { classKey: "all", limit: 1000 });
      UI.toast(`Bahasha contacts synchronized: ${result.created || 0} created, ${result.updated || 0} updated.`, "success");
    } catch (error) {
      UI.toast(error.message, "error");
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = "Sync contacts";
      }
    }
  }

  async function dispatchQueued() {
    if (!confirm("Send the queued parent messages through Bahasha now?")) return;
    const button = $("#dispatchQueued");
    if (button) {
      button.disabled = true;
      button.textContent = "Sending…";
    }
    try {
      const result = await gatewayRequest("/api/bahasha-dispatch", "dispatch", { limit: 25 });
      UI.toast(`${result.claimed || 0} queued parent message(s) processed.`, "success");
      await Promise.all([UI.loadSummary(), UI.loadMessages()]);
    } catch (error) {
      UI.toast(error.message, "error");
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = "Send queued messages";
      }
    }
  }

  $("#composeForm").onsubmit = createParentMessage;
  $("#checkBahasha").onclick = checkBahasha;
  $("#syncBahashaContacts").onclick = () => syncContacts($("#syncBahashaContacts"));
  $("#syncContactsTemplates").onclick = () => syncContacts($("#syncContactsTemplates"));
  $("#dispatchQueued").onclick = dispatchQueued;

  window.WTS_NOTIFY_PROVIDER = Object.freeze({ loadStatus, syncContacts });
})();
