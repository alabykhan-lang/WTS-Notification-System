import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (file) => readFile(new URL(file, root), "utf8");
const require = createRequire(import.meta.url);

function responseRecorder() {
  const headers = new Map();
  return {
    headers,
    statusCode: 200,
    body: "",
    setHeader(name, value) {
      headers.set(name.toLowerCase(), value);
    },
    end(value = "") {
      this.body = String(value);
    },
  };
}

test("the main screen no longer requests administrator credentials", async () => {
  const html = await read("index.html");
  assert.doesNotMatch(html, />\s*Administrator code\s*</i);
  assert.doesNotMatch(html, />\s*Administrator secret\s*</i);
  assert.match(html, /Continue with Staff Portal/);
  assert.match(html, /authorized Notifications access/);
});

test("the WhatsApp setup reuses the authorized Notifications session", async () => {
  const html = await read("whatsapp.html");
  const script = await read("whatsapp.js");
  assert.doesNotMatch(html, /Administrator login/i);
  assert.doesNotMatch(html, />\s*Administrator code/i);
  assert.match(html, /same authorized Notifications session/);
  assert.match(script, /WTS_NOTIFY_API\.getAuth/);
  assert.doesNotMatch(script, /#adminCode|#adminSecret/);
});

test("the notification entry point always starts Staff Portal SSO", async () => {
  const source = await read("identity-login.js");
  assert.match(source, /location\.assign\("\/api\/sso-start"\)/);
  assert.match(source, /exchangeCallback/);
  assert.doesNotMatch(source, /school_identity_portal_login/);
  assert.doesNotMatch(source, /new password|current_password/i);
});

test("the SSO start route creates a server-side PKCE transaction", async () => {
  const start = require("../api/sso-start.js");
  const response = responseRecorder();
  await start({ method: "GET", headers: {} }, response);

  assert.equal(response.statusCode, 302);
  const location = new URL(response.headers.get("location"));
  assert.equal(location.origin, "https://wts-school-platform.vercel.app");
  assert.equal(location.pathname, "/api/sso/authorize");
  assert.equal(location.searchParams.get("client_id"), "notifications");
  assert.equal(location.searchParams.get("scope"), "notifications");
  assert.equal(location.searchParams.get("code_challenge_method"), "S256");
  assert.equal(
    location.searchParams.get("redirect_uri"),
    "https://wts-notification-system.vercel.app/",
  );
  assert.match(
    response.headers.get("set-cookie"),
    /wts_notification_pkce=.*HttpOnly; Secure; SameSite=Lax/,
  );
});

test("the token route refuses callbacks without its PKCE cookie", async () => {
  const exchange = require("../api/sso-token.js");
  const response = responseRecorder();
  await exchange(
    {
      method: "POST",
      headers: {},
      body: {
        grant_type: "authorization_code",
        client_id: "notifications",
        redirect_uri: "https://wts-notification-system.vercel.app/",
        code: "a".repeat(43),
        state: "b".repeat(32),
        nonce: "c".repeat(32),
      },
    },
    response,
  );

  assert.equal(response.statusCode, 400);
  assert.deepEqual(JSON.parse(response.body), {
    ok: false,
    code: "SSO_TRANSACTION_REQUIRED",
  });
  assert.match(response.headers.get("set-cookie"), /Max-Age=0/);
});
