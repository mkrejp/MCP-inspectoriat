import { SSEClientTransport, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";

/**
 * Copy configured request headers onto the HTTP client.
 * Header values are already resolved from stored credentials by prepareProfile.
 *
 * @param {Record<string, unknown>} config
 * @returns {{ headers: Record<string, string> } | undefined}
 */
function requestInitFromConfig(config) {
  const headers = config.headers;
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) return undefined;

  const resolved = {};
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value !== "string" || value.length === 0) continue;
    resolved[name] = value;
  }
  if (Object.keys(resolved).length === 0) return undefined;
  return { headers: resolved };
}

/**
 * Open the dashboard's capability probe using the same transport the Inspector uses.
 *
 * @param {Record<string, unknown>} config
 * @returns {import("@modelcontextprotocol/client").Transport}
 */
export function createMonitorTransport(config) {
  if (config.type === "stdio") {
    return new StdioClientTransport({
      command: String(config.command),
      args: Array.isArray(config.args) ? config.args.map(String) : undefined,
      cwd: typeof config.cwd === "string" ? config.cwd : undefined,
      env: { ...getDefaultEnvironment(), ...(config.env ?? {}) },
    });
  }

  const requestInit = requestInitFromConfig(config);
  if (config.type === "sse") return new SSEClientTransport(new URL(String(config.url)), { requestInit });
  if (config.type === "http") return new StreamableHTTPClientTransport(new URL(String(config.url)), { requestInit });
  throw new Error(`Unsupported MCP transport: ${config.type}`);
}
