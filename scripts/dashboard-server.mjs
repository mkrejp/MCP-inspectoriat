import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import {
  Client,
  SSEClientTransport,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { getConfiguredTargets, redactUrl } from "./targets.mjs";

const port = Number(process.env.DASHBOARD_PORT || 4173);
const host = process.env.DASHBOARD_HOST || process.env.HOST || "127.0.0.1";
const pollIntervalMs = 15_000;
const probeTimeoutMs = 10_000;
const targets = getConfiguredTargets();
const page = await readFile(new URL("../public/dashboard.html", import.meta.url), "utf8");
const state = new Map(
  targets.map((target) => [target.id, {
    status: "checking",
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
  }]),
);

let refreshing = false;

async function probe(target) {
  const result = state.get(target.id);
  const startedAt = Date.now();
  let client;
  let timedOut = false;

  try {
    client = new Client({ name: "mcp-inspectoriat-dashboard", version: "1.0.0" });
    const transport = target.transport === "sse"
      ? new SSEClientTransport(new URL(target.url))
      : new StreamableHTTPClientTransport(new URL(target.url));
    const timeout = setTimeout(() => {
      timedOut = true;
      void client.close().catch(() => {});
    }, probeTimeoutMs);
    timeout.unref();

    try {
      await client.connect(transport);
      const [tools, resources, prompts] = await Promise.allSettled([
        client.listTools(),
        client.listResources(),
        client.listPrompts(),
      ]);
      const now = Date.now();
      result.status = "online";
      result.successfulChecks += 1;
      result.latencyMs = now - startedAt;
      result.averageLatencyMs = Math.round(
        ((result.averageLatencyMs ?? 0) * (result.successfulChecks - 1) + result.latencyMs)
          / result.successfulChecks,
      );
      result.tools = tools.status === "fulfilled" ? tools.value.tools?.length ?? 0 : 0;
      result.resources = resources.status === "fulfilled" ? resources.value.resources?.length ?? 0 : 0;
      result.prompts = prompts.status === "fulfilled" ? prompts.value.prompts?.length ?? 0 : 0;
      result.serverInfo = client.getServerVersion() ?? null;
      result.lastCheckedAt = new Date(now).toISOString();
      result.connectedSince ||= result.lastCheckedAt;
      result.lastError = null;
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    result.status = "offline";
    result.failedChecks += 1;
    result.lastCheckedAt = new Date().toISOString();
    result.connectedSince = null;
    result.lastError = timedOut
      ? `MCP probe timed out after ${probeTimeoutMs / 1000}s.`
      : String(error?.message || error).replaceAll(target.url, redactUrl(target.url));
  } finally {
    result.checks += 1;
    if (client) await client.close().catch(() => {});
  }
}

async function refreshAll() {
  if (refreshing) return;
  refreshing = true;
  try {
    await Promise.all(targets.map(probe));
  } finally {
    refreshing = false;
  }
}

function statusPayload() {
  const servers = targets.map((target) => ({
    id: target.id,
    name: target.name,
    url: redactUrl(target.url),
    transport: target.transport,
    ...state.get(target.id),
  }));
  const online = servers.filter((server) => server.status === "online");

  return {
    generatedAt: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
    pollIntervalMs,
    refreshing,
    summary: {
      totalServers: servers.length,
      onlineServers: online.length,
      totalTools: servers.reduce((total, server) => total + server.tools, 0),
      totalResources: servers.reduce((total, server) => total + server.resources, 0),
      totalPrompts: servers.reduce((total, server) => total + server.prompts, 0),
      checks: servers.reduce((total, server) => total + server.checks, 0),
      failures: servers.reduce((total, server) => total + server.failedChecks, 0),
    },
    servers,
  };
}

const server = createServer((request, response) => {
  const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
  response.setHeader("X-Content-Type-Options", "nosniff");

  if (request.method === "GET" && pathname === "/api/status") {
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
    });
    response.end(JSON.stringify(statusPayload()));
    return;
  }

  if (request.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": "text/html; charset=utf-8",
    });
    response.end(page);
    return;
  }

  response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  response.end("Not found");
});

server.listen(port, host, () => {
  console.log(`MCP dashboard listening on http://${host}:${port}`);
  console.log(`Monitoring ${targets.length} MCP server${targets.length === 1 ? "" : "s"}.`);
  void refreshAll();
  setInterval(() => void refreshAll(), pollIntervalMs).unref();
});