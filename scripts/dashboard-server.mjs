import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  Client,
  SSEClientTransport,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  getProfileManifest,
  getProfiles,
  launchPreparedInspector,
  loadLocalEnv,
  prepareProfile,
  stopChild,
} from "./profile-runtime.mjs";
import { saveStoredCredentials } from "./credentials-store.mjs";
import { redactUrl } from "./targets.mjs";
import {
  authorizeUser,
  buildGoogleAuthorizeUrl,
  clearOAuthStateCookieHeader,
  clearSessionCookieHeader,
  createOAuthState,
  createSessionToken,
  exchangeGoogleCode,
  fetchGoogleUserInfo,
  getAuthConfig,
  isSecureRequest,
  oauthStateCookieHeader,
  parseCookies,
  readSession,
  resolvePublicOrigin,
  sessionCookieHeader,
  verifyOAuthState,
  OAUTH_STATE_COOKIE,
} from "./google-auth.mjs";

// Prefer DASHBOARD_PORT so Railway public domains pinned to 4173 keep working
// even when the platform injects PORT=8080.
const port = Number(process.env.DASHBOARD_PORT || process.env.PORT || 4173);
const host = process.env.DASHBOARD_HOST || process.env.HOST || "127.0.0.1";
const pollIntervalMs = 15_000;
const retryDelayMs = 60_000;
const probeTimeoutMs = 10_000;
const page = await readFile(new URL("../public/dashboard.html", import.meta.url), "utf8");
const loginPage = await readFile(new URL("../public/login.html", import.meta.url), "utf8");

await loadLocalEnv();
const authConfig = getAuthConfig();

async function ensurePersistentDataDirs() {
  const dataRoot = process.env.RAILWAY_VOLUME_MOUNT_PATH || "/data";
  const storageDir = process.env.MCP_STORAGE_DIR || `${dataRoot}/mcp-inspector`;
  const secretFile = process.env.MCP_INSPECTOR_SECRET_FILE || `${dataRoot}/secrets.json`;
  const credentialsFile = process.env.MCP_CREDENTIALS_FILE || `${dataRoot}/credentials.enc`;
  const directories = new Set([storageDir, dirname(secretFile), dirname(credentialsFile)]);

  for (const directory of directories) {
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
    } catch (error) {
      if (["EACCES", "EPERM", "EROFS"].includes(error.code)) {
        console.warn(`Unable to prepare persistent data directory ${directory}: ${error.message}`);
        continue;
      }
      throw error;
    }
  }
}

await ensurePersistentDataDirs();
const profileManifest = await getProfileManifest();
const eventLog = [];
let activeProfile = null;
let activePrepared = null;
let activeMonitor = null;
let inspectorChild = null;
let inspectorStatus = "stopped";
let switching = false;
let refreshing = false;
let refreshTimer;
let nextMonitorRetryAt = 0;
let state = createState();

function createState() {
  return {
    status: "offline",
    checks: 0,
    successfulChecks: 0,
    failedChecks: 0,
    tools: 0,
    resources: 0,
    prompts: 0,
    latencyMs: null,
    averageLatencyMs: null,
    serverInfo: null,
    lastCheckedAt: null,
    connectedSince: null,
    lastError: null,
  };
}

function safeMessage(message) {
  let output = String(message ?? "");
  for (const profile of profileManifest.profiles) {
    for (const key of profile.requiredEnv) {
      const secret = process.env[key];
      if (secret) output = output.replaceAll(secret, "[redacted]");
    }
  }
  if (activePrepared?.serverConfig.url) {
    output = output.replaceAll(activePrepared.serverConfig.url, redactUrl(activePrepared.serverConfig.url));
  }
  return output.slice(0, 500);
}

function recordLog(level, event, message) {
  eventLog.push({
    timestamp: new Date().toISOString(),
    level,
    event,
    message: safeMessage(message),
    profile: activeProfile?.id ?? null,
  });
  if (eventLog.length > 200) eventLog.splice(0, eventLog.length - 200);
}

function createMonitorTransport(config) {
  if (config.type === "stdio") {
    return new StdioClientTransport({
      command: config.command,
      args: config.args,
      cwd: config.cwd,
      env: { ...getDefaultEnvironment(), ...(config.env ?? {}) },
    });
  }
  if (config.type === "sse") return new SSEClientTransport(new URL(config.url));
  if (config.type === "http") return new StreamableHTTPClientTransport(new URL(config.url));
  throw new Error(`Unsupported MCP transport: ${config.type}`);
}

async function closeMonitor() {
  const session = activeMonitor;
  activeMonitor = null;
  if (session) await session.client.close().catch(() => {});
}

function attachInspectorEvents(child, profileId) {
  child.once("spawn", () => {
    if (inspectorChild !== child) return;
    inspectorStatus = "running";
    recordLog("info", "inspector.process.running", `Inspector process started for ${profileId}.`);
  });
  child.on("error", (error) => {
    if (inspectorChild !== child) return;
    inspectorStatus = "error";
    recordLog("error", "inspector.start.failed", `${profileId}: ${error.message}`);
  });
  child.on("exit", (code, signal) => {
    if (inspectorChild === child) {
      inspectorChild = null;
      inspectorStatus = code === 0 ? "stopped" : "error";
    }
    recordLog(code === 0 ? "info" : "warn", "inspector.process.exited", `${profileId}: code ${code ?? "-"}, signal ${signal ?? "-"}`);
  });
}

async function refreshStats(session) {
  if (refreshing || activeMonitor !== session) return;
  refreshing = true;
  const startedAt = Date.now();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    void session.client.close().catch(() => {});
  }, probeTimeoutMs);
  timeout.unref();

  try {
    const [tools, resources, prompts] = await Promise.allSettled([
      session.client.listTools(),
      session.client.listResources(),
      session.client.listPrompts(),
    ]);
    if (activeMonitor !== session) return;
    if (timedOut) throw new Error(`MCP capability check timed out after ${probeTimeoutMs / 1000}s.`);

    const now = new Date().toISOString();
    state.status = "online";
    state.checks += 1;
    state.successfulChecks += 1;
    state.latencyMs = Date.now() - startedAt;
    state.averageLatencyMs = Math.round(
      ((state.averageLatencyMs ?? 0) * (state.successfulChecks - 1) + state.latencyMs)
        / state.successfulChecks,
    );
    state.tools = tools.status === "fulfilled" ? tools.value.tools?.length ?? 0 : 0;
    state.resources = resources.status === "fulfilled" ? resources.value.resources?.length ?? 0 : 0;
    state.prompts = prompts.status === "fulfilled" ? prompts.value.prompts?.length ?? 0 : 0;
    state.serverInfo = session.client.getServerVersion() ?? null;
    state.lastCheckedAt = now;
    state.connectedSince ||= now;
    state.lastError = null;
    const unsupported = [tools, resources, prompts].filter((result) => result.status === "rejected").length;
    recordLog(unsupported ? "warn" : "info", "capabilities.refreshed", `tools ${state.tools}, resources ${state.resources}, prompts ${state.prompts}${unsupported ? `; ${unsupported} list request(s) unavailable` : ""}`);
  } catch (error) {
    if (activeMonitor !== session) return;
    state.status = "offline";
    state.checks += 1;
    state.failedChecks += 1;
    state.lastCheckedAt = new Date().toISOString();
    state.connectedSince = null;
    state.lastError = safeMessage(timedOut ? `MCP check timed out after ${probeTimeoutMs / 1000}s.` : error.message);
    nextMonitorRetryAt = Date.now() + retryDelayMs;
    recordLog("error", "monitor.check.failed", state.lastError);
    await closeMonitor();
  } finally {
    clearTimeout(timeout);
    refreshing = false;
  }
}

async function connectMonitor(prepared) {
  const client = new Client({ name: "mcp-inspectoriat-dashboard", version: "1.0.0" });
  const transport = createMonitorTransport(prepared.serverConfig);
  const session = { client, transport, profileId: prepared.profile.id };
  activeMonitor = session;
  state.status = "connecting";
  recordLog("info", "monitor.connecting", `Connecting to ${prepared.profile.name} over ${prepared.serverConfig.type}.`);
  transport.onerror = (error) => {
    if (activeMonitor !== session) return;
    state.status = "offline";
    state.lastError = safeMessage(error.message);
    nextMonitorRetryAt = Date.now() + retryDelayMs;
    recordLog("error", "monitor.transport.error", state.lastError);
  };
  transport.onclose = () => {
    if (activeMonitor !== session) return;
    state.status = "offline";
    state.connectedSince = null;
    nextMonitorRetryAt = Date.now() + retryDelayMs;
    recordLog("warn", "monitor.transport.closed", `Connection to ${prepared.profile.name} closed.`);
  };

  try {
    const timeout = setTimeout(() => void client.close().catch(() => {}), probeTimeoutMs);
    timeout.unref();
    try {
      await client.connect(transport);
    } finally {
      clearTimeout(timeout);
    }
    if (activeMonitor !== session) return;
    state.status = "online";
    nextMonitorRetryAt = 0;
    recordLog("info", "monitor.connected", `Connected to ${prepared.profile.name}.`);
    await refreshStats(session);
  } catch (error) {
    if (activeMonitor !== session) return;
    state.status = "offline";
    state.checks += 1;
    state.failedChecks += 1;
    state.lastCheckedAt = new Date().toISOString();
    state.connectedSince = null;
    state.lastError = safeMessage(error.message);
    nextMonitorRetryAt = Date.now() + retryDelayMs;
    recordLog("error", "monitor.connect.failed", state.lastError);
    await closeMonitor();
  }
}

async function switchProfile(profileId) {
  if (switching) throw new Error("A profile switch is already in progress.");
  switching = true;
  recordLog("info", "profile.switch.requested", `Requested profile ${profileId}.`);
  let prepared;

  try {
    prepared = await prepareProfile(profileId);
    await closeMonitor();
    const previousChild = inspectorChild;
    inspectorChild = null;
    if (previousChild) {
      inspectorStatus = "stopping";
      recordLog("info", "inspector.stopping", `Stopping previous profile ${activeProfile?.id ?? "unknown"}.`);
      await stopChild(previousChild);
    }
    if (activePrepared) await activePrepared.cleanup();

    activeProfile = prepared.profile;
    activePrepared = prepared;
    state = createState();
    nextMonitorRetryAt = 0;
    state.status = "connecting";
    recordLog("info", "statistics.reset", `Statistics reset for ${profileId}.`);
    inspectorChild = launchPreparedInspector(prepared);
    inspectorStatus = "starting";
    attachInspectorEvents(inspectorChild, profileId);
    recordLog("info", "inspector.process.starting", `Starting Inspector for ${profileId} on port ${process.env.CLIENT_PORT || "5173"}.`);
    void connectMonitor(prepared);
    return statusPayload();
  } catch (error) {
    if (prepared && prepared !== activePrepared) await prepared.cleanup();
    recordLog("error", "profile.switch.failed", safeMessage(error.message));
    throw error;
  } finally {
    switching = false;
  }
}

function statusPayload() {
  const config = activePrepared?.serverConfig;
  const endpoint = config?.type === "stdio"
    ? [config.command, ...(config.args ?? [])].join(" ")
    : config?.url
      ? redactUrl(config.url)
      : "-";
  const activeServer = activeProfile ? [{
    id: activeProfile.id,
    name: activeProfile.name,
    url: endpoint,
    transport: config?.type ?? "-",
    ...state,
  }] : [];

  return {
    generatedAt: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
    pollIntervalMs,
    refreshing,
    switching,
    activeProfile: activeProfile ? {
      id: activeProfile.id,
      name: activeProfile.name,
      description: activeProfile.description,
    } : null,
    inspector: { status: inspectorStatus, pid: inspectorChild?.pid ?? null },
    summary: {
      totalServers: activeServer.length,
      onlineServers: state.status === "online" ? 1 : 0,
      totalTools: state.tools,
      totalResources: state.resources,
      totalPrompts: state.prompts,
      checks: state.checks,
      failures: state.failedChecks,
    },
    servers: activeServer,
  };
}

function sendJson(response, status, data) {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(data));
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16_384) throw new Error("Request body is too large.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function isSameOrigin(request) {
  try {
    return new URL(request.headers.origin).host === request.headers.host;
  } catch {
    return false;
  }
}

function sendHtml(response, status, html, headers = {}) {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "text/html; charset=utf-8",
    ...headers,
  });
  response.end(html);
}

function redirect(response, location, headers = {}) {
  response.writeHead(302, { Location: location, "Cache-Control": "no-store", ...headers });
  response.end();
}

function appendSetCookie(headers, cookie) {
  const existing = headers["Set-Cookie"];
  if (!existing) {
    headers["Set-Cookie"] = cookie;
    return headers;
  }
  headers["Set-Cookie"] = Array.isArray(existing) ? [...existing, cookie] : [existing, cookie];
  return headers;
}

function requireAuth(request, response, pathname) {
  const session = readSession(request, authConfig);
  if (session) return session;

  if (request.method === "GET" && !pathname.startsWith("/api/")) {
    redirect(response, "/login");
  } else {
    sendJson(response, 401, { error: "Authentication required." });
  }
  return null;
}

function authUnavailablePage() {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Sign-in unavailable</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 36rem; margin: 4rem auto; padding: 0 1.25rem;">
<h1>Sign-in unavailable</h1>
<p>Google OAuth is not configured. Set <code>GOOGLE_CLIENT_ID</code>, <code>GOOGLE_CLIENT_SECRET</code>, and a session secret (<code>CREDENTIALS_ENCRYPTION_KEY</code> or <code>SESSION_SECRET</code>).</p>
</body></html>`;
}

const server = createServer(async (request, response) => {
  const requestUrl = new URL(request.url, `http://${request.headers.host}`);
  const pathname = requestUrl.pathname;
  response.setHeader("X-Content-Type-Options", "nosniff");
  const secure = isSecureRequest(request);

  if (request.method === "GET" && pathname === "/login") {
    if (!authConfig.configured) {
      sendHtml(response, 503, authUnavailablePage());
      return;
    }
    const session = readSession(request, authConfig);
    if (session) {
      redirect(response, "/");
      return;
    }
    sendHtml(response, 200, loginPage);
    return;
  }

  if (request.method === "GET" && pathname === "/auth/google") {
    if (!authConfig.configured) {
      sendHtml(response, 503, authUnavailablePage());
      return;
    }
    try {
      const origin = resolvePublicOrigin(request);
      const redirectUri = `${origin}/auth/google/callback`;
      const { nonce, token } = createOAuthState(authConfig.sessionSecret);
      const location = buildGoogleAuthorizeUrl({
        clientId: authConfig.clientId,
        redirectUri,
        state: nonce,
      });
      redirect(response, location, {
        "Set-Cookie": oauthStateCookieHeader(token, { secure }),
      });
    } catch (error) {
      sendJson(response, 500, { error: safeMessage(error.message) });
    }
    return;
  }

  if (request.method === "GET" && pathname === "/auth/google/callback") {
    if (!authConfig.configured) {
      sendHtml(response, 503, authUnavailablePage());
      return;
    }
    const clearState = clearOAuthStateCookieHeader({ secure });
    try {
      const code = requestUrl.searchParams.get("code");
      const state = requestUrl.searchParams.get("state");
      const cookies = parseCookies(request.headers.cookie);
      const expectedNonce = verifyOAuthState(cookies[OAUTH_STATE_COOKIE], authConfig.sessionSecret);
      if (!code || !state || !expectedNonce || state !== expectedNonce) {
        response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8", "Set-Cookie": clearState });
        response.end("Invalid OAuth state.");
        return;
      }

      const origin = resolvePublicOrigin(request);
      const redirectUri = `${origin}/auth/google/callback`;
      const tokens = await exchangeGoogleCode({
        clientId: authConfig.clientId,
        clientSecret: authConfig.clientSecret,
        code,
        redirectUri,
      });
      const userInfo = await fetchGoogleUserInfo(tokens.access_token);
      const authorized = authorizeUser(userInfo, authConfig);
      if (!authorized.ok) {
        response.writeHead(authorized.status, {
          "Content-Type": "text/plain; charset=utf-8",
          "Set-Cookie": clearState,
        });
        response.end(authorized.error);
        return;
      }

      const sessionToken = createSessionToken(authorized.user, authConfig.sessionSecret);
      const headers = appendSetCookie(
        appendSetCookie({ Location: "/" }, sessionCookieHeader(sessionToken, { secure })),
        clearState,
      );
      response.writeHead(302, { "Cache-Control": "no-store", ...headers });
      response.end();
      recordLog("info", "auth.login", `Signed in ${authorized.user.email} (${authorized.user.role}).`);
    } catch (error) {
      response.writeHead(502, {
        "Content-Type": "text/plain; charset=utf-8",
        "Set-Cookie": clearState,
      });
      response.end(safeMessage(error.message));
    }
    return;
  }

  if (request.method === "POST" && pathname === "/auth/logout") {
    if (!isSameOrigin(request) && request.headers.origin) {
      sendJson(response, 403, { error: "Logout must come from this dashboard." });
      return;
    }
    redirect(response, "/login", {
      "Set-Cookie": clearSessionCookieHeader({ secure }),
    });
    return;
  }

  if (request.method === "GET" && pathname === "/api/me") {
    const session = readSession(request, authConfig);
    if (!session) {
      sendJson(response, 401, { error: "Authentication required." });
      return;
    }
    sendJson(response, 200, session);
    return;
  }

  const session = requireAuth(request, response, pathname);
  if (!session) return;

  if (request.method === "GET" && pathname === "/api/profiles") {
    sendJson(response, 200, {
      profiles: await getProfiles(),
      selected: activeProfile?.id ?? profileManifest.defaultProfile,
      credentialStorageReady: /^[a-fA-F0-9]{64}$/.test(process.env.CREDENTIALS_ENCRYPTION_KEY || ""),
    });
    return;
  }
  if (request.method === "GET" && pathname === "/api/status") {
    sendJson(response, 200, statusPayload());
    return;
  }
  if (request.method === "GET" && pathname === "/api/logs") {
    sendJson(response, 200, { logs: eventLog.slice(-100) });
    return;
  }
  if (request.method === "POST" && pathname === "/api/profile") {
    if (!isSameOrigin(request)) {
      sendJson(response, 403, { error: "Profile selection must come from this dashboard." });
      return;
    }
    try {
      const body = await readJsonBody(request);
      const payload = await switchProfile(body.profileId);
      sendJson(response, 202, payload);
    } catch (error) {
      const missingEnv = error.message.match(/^Missing required environment variables: (.+)$/)?.[1]
        .split(", ") ?? [];
      if (missingEnv.length > 0) {
        sendJson(response, 428, { error: "Credentials are required for this profile.", missingEnv });
        return;
      }
      sendJson(response, 400, { error: safeMessage(error.message) });
    }
    return;
  }
  if (request.method === "POST" && pathname === "/api/credentials") {
    if (!isSameOrigin(request)) {
      sendJson(response, 403, { error: "Credentials must be submitted from this dashboard." });
      return;
    }
    try {
      const body = await readJsonBody(request);
      const profile = profileManifest.profiles.find((candidate) => candidate.id === body.profileId);
      if (!profile || profile.requiredEnv.length === 0) {
        sendJson(response, 400, { error: "This profile does not accept credentials." });
        return;
      }
      const submitted = body.credentials;
      if (!submitted || typeof submitted !== "object" || Array.isArray(submitted)) {
        sendJson(response, 400, { error: "Credential values are required." });
        return;
      }
      const unknownKeys = Object.keys(submitted).filter((key) => !profile.requiredEnv.includes(key));
      if (unknownKeys.length > 0) {
        sendJson(response, 400, { error: "The submission contains unsupported credential fields." });
        return;
      }
      const missingValues = profile.requiredEnv.filter((key) => (
        !process.env[key]?.trim() && !(typeof submitted[key] === "string" && submitted[key].trim())
      ));
      if (missingValues.length > 0) {
        sendJson(response, 400, { error: "Enter a value for every required credential.", missingEnv: missingValues });
        return;
      }

      const credentials = Object.fromEntries(Object.entries(submitted).map(([key, value]) => [key, value.trim()]));
      await saveStoredCredentials(credentials);
      Object.assign(process.env, credentials);
      recordLog("info", "credentials.persisted", `Encrypted credentials saved for ${profile.name}.`);
      const payload = await switchProfile(profile.id);
      sendJson(response, 202, payload);
    } catch (error) {
      const status = error.message.startsWith("CREDENTIALS_ENCRYPTION_KEY") ? 503 : 400;
      sendJson(response, status, { error: safeMessage(error.message) });
    }
    return;
  }
  if (request.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
    sendHtml(response, 200, page);
    return;
  }

  response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  response.end("Not found");
});

async function refreshActiveProfile() {
  if (switching || !activePrepared || refreshing) return;
  if (activeMonitor && state.status === "online") {
    await refreshStats(activeMonitor);
    return;
  }
  if (Date.now() < nextMonitorRetryAt) return;
  await closeMonitor();
  await connectMonitor(activePrepared);
}

async function shutdown() {
  clearInterval(refreshTimer);
  await closeMonitor();
  const child = inspectorChild;
  inspectorChild = null;
  await stopChild(child);
  if (activePrepared) await activePrepared.cleanup();
  server.close();
}

server.listen(port, host, () => {
  console.log(`MCP dashboard listening on http://${host}:${port}`);
  recordLog("info", "dashboard.started", `Dashboard listening on port ${port}.`);
  const defaultProfile = process.env.MCP_PROFILE || profileManifest.defaultProfile;
  void switchProfile(defaultProfile).catch(() => {});
  refreshTimer = setInterval(() => void refreshActiveProfile(), pollIntervalMs);
  refreshTimer.unref();
});

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());