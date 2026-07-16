import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const TARGET = "https://wts-notification-system.vercel.app/api/meta-dispatch";
const allowedOrigins = new Set([
  "https://wts-notification-system.vercel.app",
  "https://wts-central-registry.vercel.app",
  "http://localhost:3000",
]);

function headers(origin: string | null) {
  return {
    "Access-Control-Allow-Origin": origin && allowedOrigins.has(origin)
      ? origin
      : "https://wts-notification-system.vercel.app",
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type, x-wts-admin-code, x-wts-admin-secret",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Vary": "Origin",
  };
}

function json(body: unknown, status = 200, origin: string | null = null) {
  return new Response(JSON.stringify(body), { status, headers: headers(origin) });
}

Deno.serve(async (request: Request) => {
  const origin = request.headers.get("origin");
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: headers(origin) });
  }

  if (request.method === "GET") {
    return json({
      ok: true,
      code: "WTS_NOTIFICATION_DISPATCH_PROXY_READY",
      target: TARGET,
      sends_directly: false,
      gateway: "vercel_vault",
    }, 200, origin);
  }

  if (request.method !== "POST") {
    return json({ ok: false, code: "METHOD_NOT_ALLOWED" }, 405, origin);
  }

  const adminCode = request.headers.get("x-wts-admin-code")?.trim() || "";
  const adminSecret = request.headers.get("x-wts-admin-secret") || "";
  if (!adminCode || !adminSecret) {
    return json({ ok: false, code: "ADMIN_AUTH_REQUIRED" }, 401, origin);
  }

  let body: Record<string, unknown> = {};
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, code: "INVALID_JSON" }, 400, origin);
  }

  const action = String(body.action || "dispatch");
  if (action === "status") {
    return json({
      ok: true,
      code: "DISPATCH_PROXY_STATUS",
      target: TARGET,
      sends_directly: false,
      gateway: "vercel_vault",
    }, 200, origin);
  }
  if (action === "dryRun") {
    return json({
      ok: true,
      code: "DISPATCH_PROXY_DRY_RUN_READY",
      message: "No messages were claimed or sent.",
      sends_directly: false,
    }, 200, origin);
  }
  if (action !== "dispatch") {
    return json({ ok: false, code: "UNKNOWN_ACTION" }, 400, origin);
  }

  const limit = Math.max(1, Math.min(Number(body.limit || 20), 100));

  try {
    const response = await fetch(TARGET, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientCode: adminCode,
        clientSecret: adminSecret,
        limit,
      }),
      signal: AbortSignal.timeout(55000),
    });

    const text = await response.text();
    return new Response(text, {
      status: response.status,
      headers: headers(origin),
    });
  } catch (error) {
    return json({
      ok: false,
      code: "VERCEL_DISPATCH_PROXY_FAILED",
      message: error instanceof Error ? error.message : String(error),
    }, 502, origin);
  }
});
