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
  assert.match(html, /Staff Portal session/);
});

test("the WhatsApp setup reuses the authorized Notifications session", async () => {
  const html = await read("whatsapp.html");
  const script = await read("whatsapp.js");
  assert.doesNotMatch(html, /Administrator login/i);
  assert.doesNotMatch(html, />\s*Administrator code/i);
  assert.match(html, /Connect Bahasha/);
  assert.match(script, /WTS_NOTIFY_API\.getAuth/);
  assert.doesNotMatch(script, /#adminCode|#adminSecret/);
});

test("the product targets parents and does not offer staff recipients", async () => {
  const html = await read("index.html");
  const app = await read("app.js");
  const bulk = await read("bulk.js");
  assert.match(html, /Parents only/);
  assert.doesNotMatch(
    html,
    /<option[^>]*value="staff"|Parents and staff|Staff only/,
  );
  assert.match(html, /Import saves contacts in WTS/);
  assert.match(app, /recipientType: "guardian"/);
  assert.match(bulk, /recipientGroup: "guardian"/);
  assert.doesNotMatch(bulk, /recipientGroup: \$\(/);
});

test("Bahasha credentials stay server-side and use the official API", async () => {
  const helper = await read("api/_bahasha.js");
  const html = await read("index.html");
  assert.match(helper, /https:\/\/api\.bahasha\.app/);
  assert.match(helper, /process\.env\.BAHASHA_API_TOKEN/);
  assert.match(helper, /process\.env\.BAHASHA_API_KEY/);
  assert.match(helper, /process\.env\.BAHASHA_API_BASE_URL/);
  assert.match(helper, /Authorization: `Bearer \$\{current\.apiKey\}`/);
  assert.doesNotMatch(html, /bh_(?:test|live)_/);
});

test("Bahasha config uses the token alias and configurable API origin", async () => {
  const previous = {
    token: process.env.BAHASHA_API_TOKEN,
    key: process.env.BAHASHA_API_KEY,
    phone: process.env.BAHASHA_PHONE_NUMBER_ID,
    origin: process.env.BAHASHA_API_BASE_URL,
  };
  process.env.BAHASHA_API_TOKEN = "bh_test_sandbox";
  delete process.env.BAHASHA_API_KEY;
  process.env.BAHASHA_PHONE_NUMBER_ID = "+2348079780804";
  process.env.BAHASHA_API_BASE_URL = "https://sandbox.example.test/";
  const helper = require("../api/_bahasha.js");
  assert.deepEqual(helper.config(), {
    apiKey: "bh_test_sandbox",
    phoneNumberId: "+2348079780804",
    apiOrigin: "https://sandbox.example.test",
    environment: "sandbox",
    configured: true,
    templates: helper.config().templates,
  });
  if (previous.token === undefined) delete process.env.BAHASHA_API_TOKEN;
  else process.env.BAHASHA_API_TOKEN = previous.token;
  if (previous.key === undefined) delete process.env.BAHASHA_API_KEY;
  else process.env.BAHASHA_API_KEY = previous.key;
  if (previous.phone === undefined) delete process.env.BAHASHA_PHONE_NUMBER_ID;
  else process.env.BAHASHA_PHONE_NUMBER_ID = previous.phone;
  if (previous.origin === undefined) delete process.env.BAHASHA_API_BASE_URL;
  else process.env.BAHASHA_API_BASE_URL = previous.origin;
});

test("Bahasha webhook supports the documented verification challenge", async () => {
  const previous = process.env.BAHASHA_WEBHOOK_VERIFICATION_TOKEN;
  process.env.BAHASHA_WEBHOOK_VERIFICATION_TOKEN = "verification-secret";
  const webhook = require("../api/bahasha-webhook.js");
  const response = responseRecorder();
  response.status = function status(code) {
    this.statusCode = code;
    return this;
  };
  response.send = function send(value = "") {
    this.body = String(value);
  };
  await webhook(
    {
      method: "GET",
      query: {
        "hub.mode": "subscribe",
        "hub.verify_token": "verification-secret",
        "hub.challenge": "challenge-value",
      },
    },
    response,
  );
  assert.equal(response.statusCode, 200);
  assert.equal(response.body, "challenge-value");
  if (previous === undefined)
    delete process.env.BAHASHA_WEBHOOK_VERIFICATION_TOKEN;
  else process.env.BAHASHA_WEBHOOK_VERIFICATION_TOKEN = previous;
});

test("Bahasha webhook identifies a missing verification token", async () => {
  const previousConfigured = process.env.BAHASHA_WEBHOOK_VERIFICATION_TOKEN;
  const previousPrimary = process.env.BAHASHA_WEBHOOK_VERIFY_TOKEN;
  const previousFallback = process.env.WEBHOOK_VERIFICATION_TOKEN;
  delete process.env.BAHASHA_WEBHOOK_VERIFICATION_TOKEN;
  delete process.env.BAHASHA_WEBHOOK_VERIFY_TOKEN;
  delete process.env.WEBHOOK_VERIFICATION_TOKEN;
  const webhook = require("../api/bahasha-webhook.js");
  const response = responseRecorder();
  response.status = function status(code) {
    this.statusCode = code;
    return this;
  };
  response.send = function send(value = "") {
    this.body = String(value);
  };
  await webhook(
    {
      method: "GET",
      query: {
        "hub.mode": "subscribe",
        "hub.verify_token": "any-token",
        "hub.challenge": "challenge-value",
      },
    },
    response,
  );
  assert.equal(response.statusCode, 503);
  assert.equal(response.body, "Webhook verification token is not configured");
  if (previousPrimary === undefined)
    delete process.env.BAHASHA_WEBHOOK_VERIFY_TOKEN;
  else process.env.BAHASHA_WEBHOOK_VERIFY_TOKEN = previousPrimary;
  if (previousConfigured === undefined)
    delete process.env.BAHASHA_WEBHOOK_VERIFICATION_TOKEN;
  else process.env.BAHASHA_WEBHOOK_VERIFICATION_TOKEN = previousConfigured;
  if (previousFallback === undefined)
    delete process.env.WEBHOOK_VERIFICATION_TOKEN;
  else process.env.WEBHOOK_VERIFICATION_TOKEN = previousFallback;
});

test("Bahasha webhook acknowledges POST requests with plain OK", async () => {
  const webhook = require("../api/bahasha-webhook.js");
  const response = responseRecorder();
  response.status = function status(code) {
    this.statusCode = code;
    return this;
  };
  response.send = function send(value = "") {
    this.body = String(value);
  };
  await webhook({ method: "POST", body: {} }, response);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body, "OK");
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
