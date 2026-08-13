"use strict";
(() => {
  const APP = "notifications";
  const STORE = "wts_notification_session";
  const META = "wts_notification_identity_meta";
  const TRANSACTION_KEY = "wts_notification_pkce_transaction";
  const CFG = window.WTS_CONFIG || {};
  const $ = (selector) => document.querySelector(selector);

  async function call(name, args) {
    const response = await fetch(`${CFG.supabaseUrl}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: CFG.publishableKey },
      body: JSON.stringify(args),
    });
    const payload = await response.json().catch(() => ({ ok: false, code: "INVALID_SERVER_RESPONSE" }));
    if (!response.ok || payload?.ok === false) throw Object.assign(new Error(payload?.code || "LOGIN_FAILED"), { code: payload?.code || "LOGIN_FAILED" });
    return payload;
  }

  function friendly(code) {
    return ({
      INVALID_LOGIN: "Invalid staff number, email or password.",
      ACCOUNT_NOT_ACTIVE: "This staff account is not active.",
      ACCOUNT_TEMPORARILY_LOCKED: "Too many failed attempts. Try again later or ask management to unlock the account.",
      PORTAL_ACCESS_NOT_GRANTED: "Notification access has not been granted to this staff account.",
      NOTIFICATIONS_ACCESS_NOT_GRANTED: "Notification access has not been granted to this staff account.",
      PORTAL_PERMISSION_SYNC_FAILED: "Central Registry could not prepare this identity for Notifications.",
      NOTIFICATION_SESSION_SERVICE_UNAVAILABLE: "The secure Notification session could not be created. Try again.",
      SSO_CALLBACK_INVALID: "The secure Notification response could not be verified. Start again from the Staff Portal.",
      SSO_REQUEST_INVALID: "The Notification sign-in request was not accepted.",
    })[code] || String(code || "Login failed.").replaceAll("_", " ");
  }

  async function changeRequired(login, current) {
    const next = prompt("Create a new password. Use at least 10 characters with uppercase, lowercase and a number.");
    if (!next) throw Object.assign(new Error("Password change is required before first login."), { code: "PASSWORD_CHANGE_REQUIRED" });
    const confirmPassword = prompt("Enter the new password again.");
    if (next !== confirmPassword) throw Object.assign(new Error("The new passwords do not match."), { code: "PASSWORD_MISMATCH" });
    await call("school_identity_change_password", { p_login: login, p_current_password: current, p_new_password: next });
    alert("Password changed successfully. Sign in again with the new password.");
  }

  function base64Url(bytes) {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }

  function randomToken() {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return base64Url(bytes);
  }

  async function codeChallenge(verifier) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    return base64Url(new Uint8Array(digest));
  }

  function saveTransaction(transaction) { sessionStorage.setItem(TRANSACTION_KEY, JSON.stringify(transaction)); }
  function loadTransaction() {
    try {
      const transaction = JSON.parse(sessionStorage.getItem(TRANSACTION_KEY) || "null");
      if (!transaction || !transaction.verifier || !transaction.state || !transaction.nonce || Number(transaction.expires_at) <= Date.now()) return null;
      return transaction;
    } catch { return null; }
  }
  function clearTransaction() { sessionStorage.removeItem(TRANSACTION_KEY); }

  async function beginSso() {
    if (window.__WTS_NOTIFICATION_SSO_PENDING) return;
    window.__WTS_NOTIFICATION_SSO_PENDING = true;
    $("#authError").textContent = "Opening your School Portal session…";
    const verifier = randomToken();
    const state = randomToken();
    const nonce = randomToken();
    const challenge = await codeChallenge(verifier);
    saveTransaction({ verifier, state, nonce, expires_at: Date.now() + 5 * 60 * 1000 });
    const authorize = new URL(CFG.authorizeUri);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("client_id", "notifications");
    authorize.searchParams.set("redirect_uri", CFG.redirectUri);
    authorize.searchParams.set("scope", "notifications");
    authorize.searchParams.set("code_challenge", challenge);
    authorize.searchParams.set("code_challenge_method", "S256");
    authorize.searchParams.set("state", state);
    authorize.searchParams.set("nonce", nonce);
    window.location.assign(authorize.toString());
  }

  async function loadConnectedView() {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (window.WTS_NOTIFY_UI?.loadSummary) return window.WTS_NOTIFY_UI.loadSummary();
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw Object.assign(new Error("Notification interface is not ready."), { code: "NOTIFICATION_SERVICE_UNAVAILABLE" });
  }

  async function exchangeCallback() {
    const query = new URLSearchParams(window.location.search);
    const errorCode = query.get("error") || query.get("code_error");
    if (errorCode) throw Object.assign(new Error(friendly(errorCode)), { code: errorCode });
    const code = query.get("code");
    const returnedState = query.get("state");
    const returnedNonce = query.get("nonce");
    if (!code && !returnedState && !returnedNonce) return false;
    const transaction = loadTransaction();
    if (!code || !returnedState || !returnedNonce || !transaction || returnedState !== transaction.state || returnedNonce !== transaction.nonce) {
      clearTransaction();
      throw Object.assign(new Error("The Notification sign-in response could not be verified. Start again from the Staff Portal."), { code: "SSO_CALLBACK_INVALID" });
    }
    const response = await fetch("/api/sso-token", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ grant_type: "authorization_code", client_id: "notifications", redirect_uri: CFG.redirectUri, code, state: returnedState, nonce: returnedNonce, code_verifier: transaction.verifier }),
      cache: "no-store",
    });
    const result = await response.json().catch(() => ({ ok: false, code: "NOTIFICATION_SSO_EXCHANGE_FAILED" }));
    clearTransaction();
    if (!response.ok || !result?.ok) throw Object.assign(new Error(friendly(result?.code)), { code: result?.code });
    window.WTS_NOTIFY_API.setAuth(result.client_code, result.client_secret);
    window.history.replaceState({}, document.title, window.location.pathname + window.location.hash);
    return true;
  }

  async function startRequestedSso() {
    try {
      if (await exchangeCallback()) { await loadConnectedView(); return; }
      if (new URLSearchParams(window.location.search).get("sso") === "1") await beginSso();
    } catch (error) {
      clearTransaction();
      $("#authError").textContent = friendly(error.code || error.message);
    }
  }

  function install() {
    const form = $("#gateForm");
    const login = $("#adminCode");
    const password = $("#adminSecret");
    const error = $("#authError");
    if (!form || typeof form.onsubmit !== "function") return setTimeout(install, 40);
    const legacy = form.onsubmit;
    form.onsubmit = async (event) => {
      event.preventDefault();
      if (new URLSearchParams(window.location.search).get("sso") === "1") {
        error.textContent = "Use the Staff Portal to complete this sign-in.";
        return;
      }
      const enteredLogin = login.value.trim();
      const enteredPassword = password.value;
      error.textContent = "Checking central access…";
      try {
        const result = await call("school_identity_portal_login", { p_login: enteredLogin, p_password: enteredPassword, p_app_code: APP });
        if (result.must_change_password) {
          await changeRequired(enteredLogin, enteredPassword);
          error.textContent = "Password changed. Sign in again.";
          password.value = "";
          return;
        }
        sessionStorage.setItem(META, JSON.stringify({ mode: "central", loginName: enteredLogin, appCode: APP, expiresAt: result.expires_at, person: result.person, accessRole: result.access_role }));
        login.value = result.client_code;
        password.value = result.client_secret;
        legacy.call(form, event);
        setTimeout(() => { login.value = enteredLogin; password.value = ""; }, 0);
      } catch (centralError) {
        login.value = enteredLogin;
        password.value = enteredPassword;
        legacy.call(form, event);
        setTimeout(() => { if (document.body.classList.contains("locked")) { error.textContent = friendly(centralError.code || centralError.message); password.value = ""; } }, 650);
      }
    };
    void startRequestedSso();
  }

  install();
})();
