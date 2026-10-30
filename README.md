# MCP Inspector and Profiles

This workspace runs the official MCP Inspector and a profile-aware dashboard.
Choose a server in the dashboard to restart the Inspector against that isolated
profile and reset its statistics.

## Configure Credentials

Copy the template and configure an encryption key for local use:

```bash
cp .env.example .env
openssl rand -hex 32
```

Put the generated 64-character hex value in `CREDENTIALS_ENCRYPTION_KEY` in
`.env`, or store it as a Codespaces/deployment secret. Keep this key stable and
outside git. The `.env` template also includes the optional remote endpoint:

```dotenv
CREDENTIALS_ENCRYPTION_KEY=<64-character-hex-secret>
REMOTE_MCP_URL=http://localhost:3000/sse
MCP_TRANSPORT=sse
```

When a selected profile needs credentials, the dashboard opens a password
dialog. Values are encrypted with AES-256-GCM and saved to
`.mcp-inspector/credentials.enc` with restrictive file permissions. The
plaintext is not returned to the browser or written to the activity log. The
Inspector gets a temporary profile file which is deleted when its process exits.
`.env` and the credential store are ignored by git.

In Codespaces, store `CREDENTIALS_ENCRYPTION_KEY` as a Codespaces secret. The
encrypted credential file is in the workspace and survives container rebuilds.
For deployment, preserve both the encrypted data volume and the same key in a
secret manager. Losing or changing the key makes existing credentials unreadable.

## Run in Codespaces

Install dependencies and start the dashboard plus Inspector:

```bash
npm ci
npm start
```

The Inspector UI runs on port 5173 and the dashboard on port 4173. In the
dashboard, choose GitHub, PostgreSQL, Brave Search, Fetch, Sequential Thinking,
or the configured remote endpoint. Selecting a profile stops the previous
Inspector and monitor connection, starts the selected server, resets capability
statistics, and records the transition in Application activity.

The devcontainer forwards both ports and opens the Inspector UI automatically.
For a one-off target override, set `REMOTE_MCP_URL` and `MCP_TRANSPORT` before
starting. Use `MCP_TRANSPORT=http` for Streamable HTTP; SSE is the default.

## Launch a Profile Directly

The profiles are in `configs/` and use the standard MCP `mcpServers` shape:

```bash
npm run inspect:github
npm run inspect:postgres
npm run inspect:brave-search
npm run inspect:fetch
npm run inspect:sequential-thinking
```

You can also use the generic router:

```bash
npm run inspect:profile -- github
```

`configs/profiles.json` is the master profile list used by the dashboard and
launcher. Each profile is read-only to Inspector and launches one stdio server
with `npx -y`.

The requested `@modelcontextprotocol/server-fetch` package currently returns
npm 404 (checked 2026-10-30). Its profile is included as specified, but it will
not connect until that package is published or its config is changed to an
available Fetch server.

## Deploy

The Inspector includes a Node backend, so deploy the complete runtime instead
of serving its static UI files alone:

```bash
docker build -t mcp-inspectoriat .
docker volume create mcp-inspector-data
docker run --rm -p 5173:5173 -p 4173:4173 \
  --env-file .env \
  -v mcp-inspector-data:/data \
  -e ALLOWED_ORIGINS="https://inspector.example.com" \
  mcp-inspectoriat
```

The Docker image stores encrypted credentials at `/data/credentials.enc`.
Preserve the named volume and the same `CREDENTIALS_ENCRYPTION_KEY` secret to
keep credentials readable after redeploy.

For Railway, attach a persistent volume mounted at `/data` and add
`CREDENTIALS_ENCRYPTION_KEY` as a Railway service variable. Generate the key
locally with `openssl rand -hex 32`, then enter it directly in Railway's secret
settings; do not commit it or put it in a Docker build argument. Keep both the
volume and the key when redeploying. The Docker image already uses
`/data/credentials.enc` for its encrypted credential store.

Put an authenticating reverse proxy or private network in front of **both**
ports. Inspector can invoke tools on the selected server, and the dashboard can
switch among its configured profiles and accept credentials; neither should be
exposed publicly without HTTPS and access control.