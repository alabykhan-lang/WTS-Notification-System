"use strict";

const crypto = require("node:crypto");
const {
  PKCE_MAX_AGE,
  PORTAL_ORIGIN,
  REDIRECT_URI,
  cookieHeader,
  encodeTransaction,
  requestOriginAllowed,
  sendJson,
  setSecurityHeaders,
} = require("./_sso");

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("base64url");
}

module.exports = async function notificationSsoStart(req, res) {
  if (!requestOriginAllowed(req)) {
    sendJson(res, 403, { ok: false, code: "ORIGIN_NOT_ALLOWED" });
    return;
  }
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    sendJson(res, 405, { ok: false, code: "METHOD_NOT_ALLOWED" });
    return;
  }

  const verifier = crypto.randomBytes(48).toString("base64url");
  const state = crypto.randomBytes(32).toString("base64url");
  const nonce = crypto.randomBytes(32).toString("base64url");
  const transaction = encodeTransaction({
    verifier,
    state,
    nonce,
    expiresAt: Date.now() + PKCE_MAX_AGE * 1000,
  });
  const authorize = new URL("/api/sso/authorize", `${PORTAL_ORIGIN}/`);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("client_id", "notifications");
  authorize.searchParams.set("redirect_uri", REDIRECT_URI);
  authorize.searchParams.set("scope", "notifications");
  authorize.searchParams.set("code_challenge", sha256(verifier));
  authorize.searchParams.set("code_challenge_method", "S256");
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("nonce", nonce);

  setSecurityHeaders(res);
  res.setHeader("Set-Cookie", cookieHeader(transaction, PKCE_MAX_AGE));
  res.statusCode = 302;
  res.setHeader("Location", authorize.toString());
  res.end();
};
