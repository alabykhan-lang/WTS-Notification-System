"use strict";

const crypto = require("node:crypto");

const PKCE_COOKIE = "wts_notification_pkce";
const PKCE_MAX_AGE = 5 * 60;
const PORTAL_ORIGIN = String(
  process.env.WTS_PORTAL_ORIGIN || "https://wts-school-platform.vercel.app",
).replace(/\/$/, "");
const NOTIFICATION_ORIGIN = String(
  process.env.WTS_NOTIFICATION_ORIGIN ||
    "https://wts-notification-system.vercel.app",
).replace(/\/$/, "");
const REDIRECT_URI = `${NOTIFICATION_ORIGIN}/`;

function setSecurityHeaders(res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
}

function cookieHeader(value, maxAge) {
  return `${PKCE_COOKIE}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

function clearPkceCookie(res) {
  res.setHeader("Set-Cookie", cookieHeader("", 0));
}

function parseCookies(req) {
  const result = {};
  String(req.headers.cookie || "")
    .split(";")
    .forEach((part) => {
      const separator = part.indexOf("=");
      if (separator < 0) return;
      const name = part.slice(0, separator).trim();
      if (!name) return;
      try {
        result[name] = decodeURIComponent(part.slice(separator + 1).trim());
      } catch {
        result[name] = "";
      }
    });
  return result;
}

function encodeTransaction(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function readTransaction(req) {
  const value = parseCookies(req)[PKCE_COOKIE];
  if (!value || value.length > 4096) return null;
  try {
    const transaction = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    );
    if (
      !transaction?.verifier ||
      !transaction?.state ||
      !transaction?.nonce ||
      !transaction?.expiresAt ||
      Date.now() > Number(transaction.expiresAt)
    ) {
      return null;
    }
    return transaction;
  } catch {
    return null;
  }
}

function requestOriginAllowed(req) {
  const origin = String(req.headers.origin || "").trim();
  if (!origin || origin === NOTIFICATION_ORIGIN) return true;
  return String(process.env.WTS_NOTIFICATION_ALLOWED_ORIGINS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .includes(origin);
}

function sendJson(res, status, payload, { clearPkce = false } = {}) {
  setSecurityHeaders(res);
  if (clearPkce) clearPkceCookie(res);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

module.exports = {
  NOTIFICATION_ORIGIN,
  PKCE_COOKIE,
  PKCE_MAX_AGE,
  PORTAL_ORIGIN,
  REDIRECT_URI,
  clearPkceCookie,
  cookieHeader,
  encodeTransaction,
  readTransaction,
  requestOriginAllowed,
  sendJson,
  setSecurityHeaders,
};
