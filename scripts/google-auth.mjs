import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const DEFAULT_ADMIN_EMAIL = "marek.krejpsky@gmail.com";
const SESSION_COOKIE = "mcp_session";
const OAUTH_STATE_COOKIE = "oauth_state";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function parseEmailList(value) {
  if (!value?.trim()) return [];
  return [...new Set(value.split(",").map(normalizeEmail).filter(Boolean))];
}

export function getAuthConfig(env = process.env) {
  const clientId = env.GOOGLE_CLIENT_ID?.trim() || "";
  const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim() || "";
  const sessionSecret = env.SESSION_SECRET?.trim()
    || env.CREDENTIALS_ENCRYPTION_KEY?.trim()
    || "";
  const adminEmails = new Set([
    normalizeEmail(DEFAULT_ADMIN_EMAIL),
    ...parseEmailList(env.GOOGLE_ADMIN_EMAILS || DEFAULT_ADMIN_EMAIL),
  ]);
  const allowedEmails = new Set([
    ...adminEmails,
    ...parseEmailList(env.GOOGLE_ALLOWED_EMAILS),
  ]);

  return {
    clientId,
    clientSecret,
    sessionSecret,
    adminEmails,
    allowedEmails,
    publicBaseUrl: env.PUBLIC_BASE_URL?.trim().replace(/\/$/, "") || "",
    configured: Boolean(clientId && clientSecret && sessionSecret),
  };
}

export function resolvePublicOrigin(request, env = process.env) {
  const configured = env.PUBLIC_BASE_URL?.trim().replace(/\/$/, "");
  if (configured) return configured;

  const host = request.headers["x-forwarded-host"] || request.headers.host;
  if (!host) throw new Error("Unable to resolve public origin for OAuth redirect.");
  const forwarded = String(request.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const proto = forwarded || (String(host).includes("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

function signPayload(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${signature}`;
}

function verifySignedValue(value, secret, maxAgeMs) {
  if (typeof value !== "string" || !value.includes(".")) return null;
  const [body, signature] = value.split(".");
  if (!body || !signature) return null;
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object" || typeof payload.exp !== "number") return null;
  if (Date.now() > payload.exp) return null;
  if (maxAgeMs && payload.iat && Date.now() - payload.iat > maxAgeMs) return null;
  return payload;
}

export function parseCookies(headerValue) {
  const cookies = {};
  for (const part of String(headerValue || "").split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

function cookieAttributes({ maxAgeSeconds, httpOnly = true, secure = true }) {
  const parts = [
    "Path=/",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (httpOnly) parts.push("HttpOnly");
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function createOAuthState(secret) {
  const now = Date.now();
  const nonce = randomBytes(16).toString("hex");
  const token = signPayload({ nonce, iat: now, exp: now + OAUTH_STATE_TTL_MS }, secret);
  return { nonce, token };
}

export function verifyOAuthState(token, secret) {
  const payload = verifySignedValue(token, secret, OAUTH_STATE_TTL_MS);
  return typeof payload?.nonce === "string" ? payload.nonce : null;
}

export function createSessionToken(user, secret) {
  const now = Date.now();
  return signPayload({
    email: normalizeEmail(user.email),
    name: user.name || "",
    role: user.role,
    iat: now,
    exp: now + SESSION_TTL_MS,
  }, secret);
}

export function readSession(request, config) {
  if (!config.sessionSecret) return null;
  const cookies = parseCookies(request.headers.cookie);
  const payload = verifySignedValue(cookies[SESSION_COOKIE], config.sessionSecret, SESSION_TTL_MS);
  if (!payload?.email) return null;
  const email = normalizeEmail(payload.email);
  if (!config.allowedEmails.has(email)) return null;
  return {
    email,
    name: typeof payload.name === "string" ? payload.name : "",
    role: config.adminEmails.has(email) ? "admin" : "user",
  };
}

export function sessionCookieHeader(token, { secure }) {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; ${cookieAttributes({
    maxAgeSeconds: Math.floor(SESSION_TTL_MS / 1000),
    secure,
  })}`;
}

export function clearSessionCookieHeader({ secure }) {
  return `${SESSION_COOKIE}=; ${cookieAttributes({ maxAgeSeconds: 0, secure })}`;
}

export function oauthStateCookieHeader(token, { secure }) {
  return `${OAUTH_STATE_COOKIE}=${encodeURIComponent(token)}; ${cookieAttributes({
    maxAgeSeconds: Math.floor(OAUTH_STATE_TTL_MS / 1000),
    secure,
  })}`;
}

export function clearOAuthStateCookieHeader({ secure }) {
  return `${OAUTH_STATE_COOKIE}=; ${cookieAttributes({ maxAgeSeconds: 0, secure })}`;
}

export function buildGoogleAuthorizeUrl({ clientId, redirectUri, state }) {
  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("prompt", "select_account");
  return url.href;
}

export async function exchangeGoogleCode({ clientId, clientSecret, code, redirectUri }) {
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token) {
    throw new Error(payload.error_description || payload.error || "Google token exchange failed.");
  }
  return payload;
}

export async function fetchGoogleUserInfo(accessToken) {
  const response = await fetch(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.email) {
    throw new Error(payload.error_description || payload.error || "Google userinfo request failed.");
  }
  return {
    email: normalizeEmail(payload.email),
    name: typeof payload.name === "string" ? payload.name : "",
    emailVerified: Boolean(payload.email_verified),
  };
}

export function authorizeUser(userInfo, config) {
  if (!userInfo.emailVerified) {
    return { ok: false, status: 403, error: "Google account email must be verified." };
  }
  if (!config.allowedEmails.has(userInfo.email)) {
    return { ok: false, status: 403, error: "This Google account is not on the allowlist." };
  }
  return {
    ok: true,
    user: {
      email: userInfo.email,
      name: userInfo.name,
      role: config.adminEmails.has(userInfo.email) ? "admin" : "user",
    },
  };
}

export function isSecureRequest(request, env = process.env) {
  if (env.PUBLIC_BASE_URL?.startsWith("https://")) return true;
  const forwarded = String(request.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  if (forwarded) return forwarded === "https";
  return false;
}

export { SESSION_COOKIE, OAUTH_STATE_COOKIE, DEFAULT_ADMIN_EMAIL };
