"use strict";

(() => {
  const $ = (s) => document.querySelector(s);
  const SESSION_KEY = "wts_notification_session";

  function toast(message, type = "") {
    const node = document.createElement("div");
    node.className = `toast ${type}`;
    node.textContent = String(message || "Request failed.");
    $("#toasts").appendChild(node);
    setTimeout(() => node.remove(), 4500);
  }

  function credentials() {
    const code = $("#adminCode").value.trim();
    const secret = $("#adminSecret").value;
    if (!code || !secret) throw new Error("Administrator code and secret are required.");
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({ code, secret }));
    return { code, secret };
  }

  async function call(action, extra = {}) {
    const { code, secret } = credentials();
    const response = await fetch("/api/meta-setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action,
        clientCode: code,
        clientSecret: secret,
        ...extra,
      }),
    });
    const data = await response.json().catch(() => ({ ok: false, code: "INVALID_RESPONSE" }));
    if (!response.ok || data?.ok === false) {
      throw new Error(data?.message || data?.code || "WhatsApp setup request failed.");
    }
    return data;
  }

  const stateText = (id, good, yes, no) => {
    const node = $(id);
    node.textContent = good ? yes : no;
    node.className = good ? "good" : "bad";
  };

  async function loadStatus() {
    try {
      const data = await call("status");
      stateText("#tokenStatus", data.access_token_configured, "Configured", "Missing");
      stateText("#phoneStatus", Boolean(data.phone_number_id), data.phone_number_id || "Configured", "Missing");
      stateText("#webhookStatus", data.app_secret_configured && data.verify_token_configured, "Configured", "Incomplete");
      stateText("#testStatus", data.last_test_status === "passed", data.last_test_status || "Not tested", data.last_test_status || "Not tested");
      stateText("#providerStatus", data.provider?.status === "active", data.provider?.status || "Disabled", data.provider?.status || "Disabled");
      stateText("#deliveryStatus", data.delivery?.delivery_enabled === true, "Live", "Disabled");
      $("#phoneNumberId").value = data.phone_number_id || "";
      $("#businessAccountId").value = data.business_account_id || "";
      $("#graphVersion").value = data.graph_version || "";
      $("#webhookUrl").textContent = data.webhook_url || "https://wts-notification-system.vercel.app/api/meta-webhook";
      toast("WhatsApp status loaded.", "success");
      return data;
    } catch (error) {
      toast(error.message, "error");
      throw error;
    }
  }

  async function saveConfiguration() {
    const configuration = {
      phoneNumberId: $("#phoneNumberId").value.trim(),
      businessAccountId: $("#businessAccountId").value.trim(),
      graphVersion: $("#graphVersion").value.trim(),
      accessToken: $("#accessToken").value.trim(),
      appSecret: $("#appSecret").value.trim(),
      verifyToken: $("#verifyToken").value.trim(),
    };
    try {
      await call("configure", { configuration });
      $("#accessToken").value = "";
      $("#appSecret").value = "";
      $("#verifyToken").value = "";
      toast("Meta configuration saved securely.", "success");
      await loadStatus();
    } catch (error) {
      toast(error.message, "error");
    }
  }

  async function sendTest() {
    const recipient = $("#testRecipient").value.trim();
    if (!recipient) return toast("Enter the WhatsApp number that should receive the test.", "error");
    try {
      const data = await call("test", {
        recipient,
        templateName: "hello_world",
        language: "en_US",
      });
      $("#testResult").classList.remove("hidden");
      $("#testResult").textContent = `Meta accepted the test for the number ending ${data.recipient_last4}. Check WhatsApp now.`;
      toast("Real WhatsApp test accepted by Meta.", "success");
      await loadStatus();
    } catch (error) {
      toast(error.message, "error");
    }
  }

  async function activateLive() {
    if (!confirm("Activate real WhatsApp delivery and automatic queueing? Use this only after the test message arrives successfully.")) return;
    try {
      await call("activate");
      toast("Real WhatsApp delivery activated.", "success");
      await loadStatus();
    } catch (error) {
      toast(error.message, "error");
    }
  }

  function generateToken() {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    $("#verifyToken").value = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }

  try {
    const saved = JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null");
    if (saved?.code) $("#adminCode").value = saved.code;
    if (saved?.secret) $("#adminSecret").value = saved.secret;
  } catch {}

  $("#loadStatus").onclick = loadStatus;
  $("#saveConfiguration").onclick = saveConfiguration;
  $("#sendTest").onclick = sendTest;
  $("#activateLive").onclick = activateLive;
  $("#generateToken").onclick = generateToken;
})();
