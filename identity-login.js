"use strict";

(() => {
  const STORE = "wts_notification_session";
  const CFG = window.WTS_CONFIG || {};
  const $ = (selector) => document.querySelector(selector);

  function friendly(code) {
    return (
      {
        ACCOUNT_NOT_ACTIVE: "This staff account is not active.",
        PORTAL_ACCESS_NOT_GRANTED:
          "Your Staff Portal account does not have access to Notifications.",
        NOTIFICATIONS_ACCESS_NOT_GRANTED:
          "Your Staff Portal account does not have access to Notifications.",
        PORTAL_PERMISSION_SYNC_FAILED:
          "The Staff Portal could not prepare Notifications access for this account.",
        NOTIFICATION_SESSION_SERVICE_UNAVAILABLE:
          "The secure Notifications session could not be created. Try again.",
        SSO_CALLBACK_INVALID:
          "The secure Notifications response could not be verified. Start again from the Staff Portal.",
        SSO_REQUEST_INVALID:
          "The Notifications sign-in request was not accepted by the Staff Portal.",
      }[code] ||
      String(code || "Staff Portal authorization failed.").replaceAll("_", " ")
    );
  }

  function setGate(message, { error = false, busy = false } = {}) {
    const output = $("#authError");
    const button = $("#portalContinue");
    if (output) {
      output.textContent = message;
      output.classList.toggle("error-copy", error);
    }
    if (button) {
      button.disabled = busy;
      button.textContent = busy
        ? "Opening Staff Portal…"
        : "Continue with Staff Portal";
    }
  }

  function clearCallbackUrl() {
    window.history.replaceState(
      {},
      document.title,
      window.location.pathname + window.location.hash,
    );
  }

  async function beginSso() {
    if (window.__WTS_NOTIFICATION_SSO_PENDING) return;
    window.__WTS_NOTIFICATION_SSO_PENDING = true;
    setGate("Opening your Staff Portal session…", { busy: true });
    window.location.assign("/api/sso-start");
  }

  async function loadConnectedView() {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (window.WTS_NOTIFY_UI?.loadSummary) {
        await window.WTS_NOTIFY_UI.loadSummary();
        const back = $("#login");
        if (back) {
          back.textContent = "Back to Staff Portal";
          back.onclick = returnToPortal;
        }
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw Object.assign(new Error("Notification interface is not ready."), {
      code: "NOTIFICATION_SERVICE_UNAVAILABLE",
    });
  }

  async function exchangeCallback() {
    const query = new URLSearchParams(window.location.search);
    const errorCode = query.get("error") || query.get("code_error");
    if (errorCode) {
      clearCallbackUrl();
      throw Object.assign(new Error(friendly(errorCode)), { code: errorCode });
    }

    const code = query.get("code");
    const state = query.get("state");
    const nonce = query.get("nonce");
    if (!code && !state && !nonce) return false;
    if (!code || !state || !nonce) {
      clearCallbackUrl();
      throw Object.assign(
        new Error(
          "The Notifications sign-in response was incomplete. Start again from the Staff Portal.",
        ),
        { code: "SSO_CALLBACK_INVALID" },
      );
    }

    setGate("Verifying your authorized Staff Portal session…", {
      busy: true,
    });
    const response = await fetch("/api/sso-token", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        grant_type: "authorization_code",
        client_id: "notifications",
        redirect_uri: CFG.redirectUri,
        code,
        state,
        nonce,
      }),
      cache: "no-store",
    });
    const result = await response
      .json()
      .catch(() => ({ ok: false, code: "NOTIFICATION_SSO_EXCHANGE_FAILED" }));
    clearCallbackUrl();
    if (!response.ok || !result?.ok) {
      throw Object.assign(new Error(friendly(result?.code)), {
        code: result?.code,
      });
    }
    if (!result.client_code || !result.client_secret) {
      throw Object.assign(
        new Error("The Staff Portal did not issue a Notifications session."),
        { code: "NOTIFICATION_SESSION_SERVICE_UNAVAILABLE" },
      );
    }
    window.WTS_NOTIFY_API.setAuth(
      result.client_code,
      result.client_secret,
      result.expires_at,
    );
    return true;
  }

  async function restoreSession() {
    try {
      window.WTS_NOTIFY_API.getAuth();
      await loadConnectedView();
      return true;
    } catch {
      window.WTS_NOTIFY_API.clearAuth();
      return false;
    }
  }

  function returnToPortal() {
    window.WTS_NOTIFY_API.clearAuth();
    window.location.assign(`${CFG.portalOrigin}/workspace`);
  }

  async function start() {
    try {
      if (await exchangeCallback()) {
        await loadConnectedView();
        return;
      }
      if (await restoreSession()) return;
      await beginSso();
    } catch (error) {
      window.__WTS_NOTIFICATION_SSO_PENDING = false;
      setGate(friendly(error.code || error.message), { error: true });
    }
  }

  function install() {
    const form = $("#gateForm");
    if (!form || !window.WTS_NOTIFY_API) {
      setTimeout(install, 40);
      return;
    }

    form.onsubmit = (event) => {
      event.preventDefault();
      void beginSso();
    };
    const back = $("#login");
    if (back) back.onclick = returnToPortal;
    window.WTS_NOTIFICATION_IDENTITY = Object.freeze({
      beginSso,
      returnToPortal,
    });
    void start();
  }

  install();
})();
