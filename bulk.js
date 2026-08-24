"use strict";

(() => {
  const API = window.WTS_NOTIFY_API;
  const UI = window.WTS_NOTIFY_UI;
  const state = window.WTS_NOTIFY_STATE;
  const $ = (selector) => document.querySelector(selector);

  function selectedParents() {
    return [...state.selected]
      .map((value) => ({
        type: "guardian",
        id: value.replace(/^guardian:/, ""),
      }))
      .filter((recipient) => recipient.id);
  }

  async function createParentMessage(event) {
    event.preventDefault();
    const button = event.submitter || $("#composeForm button[type='submit']");
    button.disabled = true;
    button.textContent = "Preparing…";
    try {
      const audience = $("#audience").value;
      const selected = audience === "selected" ? selectedParents() : [];
      const message = $("#message").value.trim();
      if (!message)
        throw new Error("Write the information parents should receive.");
      if (audience === "selected" && !selected.length) {
        throw new Error("Open Parents and select at least one parent first.");
      }

      const result = await API.bulk({
        audience,
        recipientGroup: "guardian",
        channel: "whatsapp",
        languageCode: "en",
        purpose: $("#purpose").value,
        message,
        queueNow: $("#queueNow").checked,
        selectedRecipients: selected,
        contactIds: selected.map((recipient) => recipient.id),
      });

      $("#bulkResult").innerHTML =
        `<strong>Parent message prepared</strong><br>Recipients: ${result.created || 0}<br>Queued for WhatsApp: ${result.queued || 0}<br>Status: ${UI.escapeHtml(result.status || "draft")}${result.warning ? `<br><small>${UI.escapeHtml(result.warning)}</small>` : ""}`;
      UI.toast(
        `${result.created || 0} parent message(s) prepared.`,
        result.created ? "success" : "",
      );
      $("#message").value = "";
      $("#queueNow").checked = false;
      await Promise.all([UI.loadSummary(), UI.loadMessages()]);
    } catch (error) {
      UI.toast(error.message, "error");
    } finally {
      button.disabled = false;
      button.textContent = "Prepare parent message";
    }
  }

  async function gatewayRequest(endpoint, action, extra = {}) {
    const auth = API.getAuth();
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action,
        clientCode: auth.code,
        clientSecret: auth.secret,
        ...extra,
      }),
    });
    const data = await response
      .json()
      .catch(() => ({ ok: false, code: "INVALID_RESPONSE" }));
    if (!response.ok || data?.ok === false) {
      throw new Error(data?.message || data?.code || "Bahasha request failed.");
    }
    return data;
  }

  function renderProvider(data) {
    const badge = $("#providerBadge");
    const text = $("#providerText");
    if (!badge || !text) return;
    badge.textContent = data.connected
      ? data.environment === "sandbox"
        ? "Sandbox ready"
        : "Live ready"
      : "Setup required";
    badge.classList.toggle("ready", Boolean(data.connected));
    text.textContent = data.connected
      ? `${data.display_name || "Bahasha"} is connected with ${data.approved_template_count || 0} approved template(s).`
      : "Add the Bahasha API key and phone number ID in Vercel to finish the connection.";
  }

  async function checkBahasha() {
    const button = $("#checkBahasha");
    button.disabled = true;
    try {
      const data = await gatewayRequest("/api/bahasha-status", "status");
      renderProvider(data);
      UI.toast(
        data.connected
          ? "Bahasha connection is ready."
          : "Bahasha setup is not complete.",
        data.connected ? "success" : "",
      );
    } catch (error) {
      renderProvider({ connected: false });
      UI.toast(error.message, "error");
    } finally {
      button.disabled = false;
    }
  }

  async function dispatchQueued() {
    if (!confirm("Send the queued parent messages through Bahasha now?"))
      return;
    const button = $("#dispatchQueued");
    button.disabled = true;
    button.textContent = "Sending…";
    try {
      const result = await gatewayRequest("/api/bahasha-dispatch", "dispatch", {
        limit: 25,
      });
      UI.toast(
        `${result.claimed || 0} queued parent message(s) processed.`,
        "success",
      );
      await Promise.all([UI.loadSummary(), UI.loadMessages()]);
    } catch (error) {
      UI.toast(error.message, "error");
    } finally {
      button.disabled = false;
      button.textContent = "Send queued messages";
    }
  }

  $("#composeForm").onsubmit = createParentMessage;
  $("#checkBahasha").onclick = checkBahasha;
  $("#dispatchQueued").onclick = dispatchQueued;
})();
