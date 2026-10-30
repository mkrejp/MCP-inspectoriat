const DEFAULT_URL = "http://localhost:3000/sse";

export function getConfiguredTargets(env = process.env) {
  let candidates;

  if (env.REMOTE_MCP_SERVERS?.trim()) {
    try {
      candidates = JSON.parse(env.REMOTE_MCP_SERVERS);
    } catch (error) {
      throw new Error("REMOTE_MCP_SERVERS must be a valid JSON array.", { cause: error });
    }

    if (!Array.isArray(candidates) || candidates.length === 0) {
      throw new Error("REMOTE_MCP_SERVERS must contain at least one server.");
    }
  } else {
    candidates = [
      {
        name: env.MCP_SERVER_NAME || "Remote MCP Server",
        url: env.REMOTE_MCP_URL?.trim() || DEFAULT_URL,
        transport: env.MCP_TRANSPORT || "sse",
      },
    ];
  }

  return candidates.map((candidate, index) => {
    const name = typeof candidate.name === "string" && candidate.name.trim()
      ? candidate.name.trim()
      : `MCP server ${index + 1}`;
    const url = typeof candidate.url === "string" ? candidate.url.trim() : "";
    const transport = candidate.transport || "sse";

    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch (error) {
      throw new Error(`Invalid URL for ${name}.`, { cause: error });
    }

    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      throw new Error(`URL for ${name} must use HTTP or HTTPS.`);
    }
    if (!["sse", "http"].includes(transport)) {
      throw new Error(`Transport for ${name} must be "sse" or "http".`);
    }

    return { id: `${index}-${name}`, name, url, transport };
  });
}

export function redactUrl(value) {
  const url = new URL(value);
  url.username = "";
  url.password = "";
  url.hash = "";
  if (url.search) url.search = "?redacted";
  return url.href;
}