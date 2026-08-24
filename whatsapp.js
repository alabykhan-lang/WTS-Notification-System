"use strict";

(() => {
  const $ = (selector) => document.querySelector(selector);

  function toast(message, type = "") {
    const node = document.createElement("div");
    node.className = `toast ${type}`;
    node.textContent = String(message || "Request failed.");
    $("#toasts").appendChild(node);
    setTimeout(() => node.remove(), 4300);
  }

  function authorization() {
    try {
      return window.WTS_NOTIFY_API.getAuth();
    } catch {
      window.location.replace("/");
      throw new Error("Staff Portal authorization required.");
    }
  }

  async function call(action, extra = {}) {
    const auth = authorization();
    const response = await fetch("/api/bahasha-status", {
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
    if (!response.ok || data?.ok === false)
      throw new Error(data?.message || data?.code || "Bahasha request failed.");
    return data;
  }

  function state(node, good, positive, negative) {
    node.textContent = good ? positive : negative;
    node.className = good ? "good" : "bad";
  }

  async function loadStatus() {
    const button = $("#loadStatus");
    button.disabled = true;
    try {
      const data = await call("status");
      state(
        $("#apiStatus"),
        data.connected,
        data.display_name || "Connected",
        "Setup required",
      );
      state(
        $("#environmentStatus"),
        data.environment !== "unconfigured",
        data.environment || "Unknown",
        "Unconfigured",
      );
      state(
        $("#templateStatus"),
        data.approved_template_count > 0,
        `${data.approved_template_count || 0} approved`,
        "None approved",
      );
      $("#connectionMessage").textContent = data.connected
        ? `${data.phone_number || "The configured WhatsApp number"} is available through Bahasha${data.quality_rating ? ` with ${data.quality_rating} quality` : ""}.`
        : "Add BAHASHA_API_KEY and BAHASHA_PHONE_NUMBER_ID in Vercel, then redeploy.";
      toast(
        data.connected
          ? "Bahasha connection is ready."
          : "Bahasha setup is incomplete.",
        data.connected ? "success" : "",
      );
    } catch (error) {
      toast(error.message, "error");
    } finally {
      button.disabled = false;
    }
  }

  async function sendTest() {
    const recipient = $("#testRecipient").value.trim();
    if (!recipient) return toast("Enter a test parent number.", "error");
    const button = $("#sendTest");
    button.disabled = true;
    button.textContent = "Testing…";
    try {
      const data = await call("test", { recipient });
      $("#testResult").textContent = data.sandbox
        ? `Sandbox passed. Simulated message ID: ${data.message_id || "accepted"}. No real message was sent.`
        : `Bahasha accepted the live test. Message ID: ${data.message_id || "accepted"}.`;
      toast("Bahasha test accepted.", "success");
    } catch (error) {
      $("#testResult").textContent = error.message;
      toast(error.message, "error");
    } finally {
      button.disabled = false;
      button.textContent = "Run sandbox test";
    }
  }

  $("#loadStatus").onclick = loadStatus;
  $("#sendTest").onclick = sendTest;
  void loadStatus();
})();
