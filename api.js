"use strict";

(() => {
  const CFG = window.WTS_CONFIG;
  const STORE = "wts_notification_session";

  function auth() {
    try {
      const value = JSON.parse(sessionStorage.getItem(STORE) || "null");
      if (
        value?.code &&
        value?.secret &&
        (!value.expiresAt || Date.parse(value.expiresAt) > Date.now())
      ) {
        return value;
      }
      sessionStorage.removeItem(STORE);
    } catch {
      sessionStorage.removeItem(STORE);
    }
    throw new Error("Staff Portal authorization required.");
  }

  async function rpc(name, action, payload = {}) {
    const authorization = auth();
    const body =
      name === "school_notification_bulk_message_api"
        ? {
            p_client_code: authorization.code,
            p_client_secret: authorization.secret,
            p_payload: payload,
          }
        : {
            p_client_code: authorization.code,
            p_client_secret: authorization.secret,
            p_action: action,
            p_payload: payload,
          };
    const response = await fetch(`${CFG.supabaseUrl}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: CFG.publishableKey,
      },
      body: JSON.stringify(body),
    });
    let data;
    try {
      data = await response.json();
    } catch {
      throw new Error("Invalid server response.");
    }
    if (!response.ok || data?.ok === false) {
      throw new Error(
        data?.code || data?.error || "Notification request failed.",
      );
    }
    return data;
  }

  window.WTS_NOTIFY_API = Object.freeze({
    read: (action, payload = {}) =>
      rpc("school_notification_control_read_api", action, payload),
    write: (action, payload = {}) =>
      rpc("school_notification_control_write_api", action, payload),
    recipientRead: (action, payload = {}) =>
      rpc("school_notification_recipient_admin_read_api", action, payload),
    recipientWrite: (action, payload = {}) =>
      rpc("school_notification_recipient_admin_write_api", action, payload),
    guardianImportRead: (action, payload = {}) =>
      rpc("school_guardian_import_admin_read_api", action, payload),
    guardianImportWrite: (action, payload = {}) =>
      rpc("school_guardian_import_admin_write_api", action, payload),
    bulk: (payload) =>
      rpc("school_notification_bulk_message_api", null, payload),
    getAuth: auth,
    setAuth: (code, secret, expiresAt) =>
      sessionStorage.setItem(
        STORE,
        JSON.stringify({ code, secret, expiresAt: expiresAt || null }),
      ),
    clearAuth: () => sessionStorage.removeItem(STORE),
  });

  if (document.querySelector("#gateForm")) {
    const loadIdentity = () => {
      const script = document.createElement("script");
      script.src = "/identity-login.js";
      script.async = true;
      document.head.appendChild(script);
    };
    if (document.readyState === "complete") loadIdentity();
    else window.addEventListener("load", loadIdentity, { once: true });
  }
})();
