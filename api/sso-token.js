'use strict';

const SUPABASE_URL = process.env.WTS_SUPABASE_URL || 'https://wuftzyeajmsxdrbwaawl.supabase.co';
const SUPABASE_KEY = process.env.WTS_SUPABASE_PUBLISHABLE_KEY
  || process.env.SUPABASE_PUBLISHABLE_KEY
  || process.env.SUPABASE_ANON_KEY
  || 'sb_publishable_7AKtP6jh9xg8CdrK8F53xA_q4yZskPJ';
const CLIENT_ID = 'notifications';
const NOTIFICATION_ORIGIN = (process.env.WTS_NOTIFICATION_ORIGIN || 'https://wts-notification-system.vercel.app').replace(/\/$/, '');
const REDIRECT_URI = `${NOTIFICATION_ORIGIN}/`;

function setSecurityHeaders(res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
}

function sendJson(res, status, payload) {
  setSecurityHeaders(res);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

function requestOriginAllowed(req) {
  const origin = String(req.headers.origin || '').trim();
  if (!origin) return true;
  if (origin === NOTIFICATION_ORIGIN) return true;
  return String(process.env.WTS_NOTIFICATION_ALLOWED_ORIGINS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .includes(origin);
}

function isUrlSafe(value, min, max) {
  return typeof value === 'string'
    && value.length >= min
    && value.length <= max
    && /^[A-Za-z0-9._~-]+$/.test(value);
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return null; }
}

async function supabaseRpc(name, body) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({ ok: false, code: 'IDENTITY_SERVICE_INVALID_RESPONSE' }));
  if (!response.ok && !payload?.code) return { ok: false, code: 'IDENTITY_SERVICE_UNAVAILABLE' };
  return payload;
}

module.exports = async function notificationSsoToken(req, res) {
  if (!requestOriginAllowed(req)) {
    sendJson(res, 403, { ok: false, code: 'ORIGIN_NOT_ALLOWED' });
    return;
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    sendJson(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED' });
    return;
  }

  const body = await readJsonBody(req);
  if (!body || typeof body !== 'object') {
    sendJson(res, 400, { ok: false, code: 'INVALID_JSON' });
    return;
  }

  const grantType = typeof body.grant_type === 'string' ? body.grant_type : '';
  const clientId = typeof body.client_id === 'string' ? body.client_id : '';
  const redirectUri = typeof body.redirect_uri === 'string' ? body.redirect_uri : '';
  const code = typeof body.code === 'string' ? body.code : '';
  const codeVerifier = typeof body.code_verifier === 'string' ? body.code_verifier : '';
  const state = typeof body.state === 'string' ? body.state : '';
  const nonce = typeof body.nonce === 'string' ? body.nonce : '';

  if (
    grantType !== 'authorization_code'
    || clientId !== CLIENT_ID
    || redirectUri !== REDIRECT_URI
    || !isUrlSafe(code, 43, 512)
    || !isUrlSafe(codeVerifier, 43, 128)
    || !isUrlSafe(state, 16, 512)
    || !isUrlSafe(nonce, 16, 512)
  ) {
    sendJson(res, 400, { ok: false, code: 'SSO_REQUEST_INVALID' });
    return;
  }

  const payload = await supabaseRpc('school_sso_authorization_code_exchange', {
    p_code: code,
    p_client_id: clientId,
    p_redirect_uri: redirectUri,
    p_code_verifier: codeVerifier,
    p_state: state,
    p_nonce: nonce,
  });
  if (!payload?.ok) {
    const codeValue = typeof payload?.code === 'string' ? payload.code : 'NOTIFICATION_SSO_EXCHANGE_FAILED';
    sendJson(res, codeValue === 'NOTIFICATIONS_ACCESS_NOT_GRANTED' ? 403 : 401, { ok: false, code: codeValue });
    return;
  }
  if (typeof payload.attendance_client_code !== 'string' || typeof payload.attendance_client_secret !== 'string') {
    sendJson(res, 503, { ok: false, code: 'NOTIFICATION_SESSION_SERVICE_UNAVAILABLE' });
    return;
  }

  sendJson(res, 200, {
    ok: true,
    code: 'NOTIFICATION_SSO_SESSION_ISSUED',
    client_code: payload.attendance_client_code,
    client_secret: payload.attendance_client_secret,
    expires_at: payload.expires_at,
    person_id: payload.person_id,
    identity_account_id: payload.identity_account_id,
    access_role: payload.access_role,
    permissions: Array.isArray(payload.permissions) ? payload.permissions : [],
  });
};
