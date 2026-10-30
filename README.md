# MCP Inspector and Monitor

This workspace runs the official MCP Inspector web UI plus a read-only
dashboard for remote MCP servers over SSE or Streamable HTTP.

## Run in Codespaces

Install dependencies with `npm ci`, then start both services:

```bash
npm start
```

The Inspector UI is forwarded on port 5173 and opens automatically. The
monitoring dashboard is available on port 4173. Its MCP checks run every 15
seconds and show connection state, latency, tools, resources, prompts, and
aggregate check counts.

Set the default server URL when starting the workspace:

```bash
REMOTE_MCP_URL="https://mcp.example.com/sse" npm start
```

The devcontainer placeholder is `http://localhost:3000/sse`. Change it in
`.devcontainer/devcontainer.json` to persist a different default, then rebuild
the container. Set `MCP_TRANSPORT=http` for a Streamable HTTP endpoint; SSE is
the default. `npm run inspect:remote` launches only Inspector, and
`npm run dashboard` launches only the monitor.

## Monitor Multiple Servers

Set `REMOTE_MCP_SERVERS` to a JSON array to monitor multiple servers:

```bash
REMOTE_MCP_SERVERS='[{"name":"staging","url":"https://staging.example.com/sse","transport":"sse"},{"name":"production","url":"https://prod.example.com/mcp","transport":"http"}]' npm start
```

The dashboard checks every configured server. The Inspector UI connects to the
first entry in this list. Without the list, the dashboard uses `REMOTE_MCP_URL`
and `MCP_TRANSPORT`. Query strings and URL credentials are redacted in the
dashboard. The monitor currently probes servers without OAuth or custom
authentication headers; authenticated endpoints can still be inspected using
the Inspector UI, but will report as unavailable in the monitor.

## Deploy

The Inspector needs its Node backend, so this project runs the complete app
rather than serving a static UI bundle:

```bash
docker build -t mcp-inspectoriat .
docker run --rm -p 5173:5173 -p 4173:4173 \
	-e REMOTE_MCP_URL="https://mcp.example.com/sse" \
	-e ALLOWED_ORIGINS="https://inspector.example.com" \
	mcp-inspectoriat
```

Set `MCP_TRANSPORT=http` for Streamable HTTP or provide `REMOTE_MCP_SERVERS`
for several targets. A reverse proxy should provide HTTPS and an authentication
boundary for both services. The Inspector UI can call tools on connected
servers, so do not expose it publicly without access control. The dashboard is
read-only, but also reveals endpoint and server statistics.