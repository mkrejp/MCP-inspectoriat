import { spawn } from "node:child_process";
import { getConfiguredTargets } from "./targets.mjs";

const [primaryTarget] = getConfiguredTargets();
const { url: remoteUrl, transport } = primaryTarget;
const clientPort = process.env.CLIENT_PORT || "5173";
const env = { ...process.env, CLIENT_PORT: clientPort };

if (process.env.CODESPACE_NAME) {
  env.HOST ||= "0.0.0.0";
  env.DANGEROUSLY_BIND_ALL_INTERFACES ||= "true";

  const forwardingDomain = process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN;
  if (!env.ALLOWED_ORIGINS && forwardingDomain) {
    env.ALLOWED_ORIGINS = [
      `https://${process.env.CODESPACE_NAME}-${clientPort}.${forwardingDomain}`,
      `http://localhost:${clientPort}`,
      `http://127.0.0.1:${clientPort}`,
    ].join(",");
  }
}

const inspector = spawn(
  "mcp-inspector",
  ["--web", "--transport", transport, "--server-url", remoteUrl],
  { env, stdio: "inherit" },
);

inspector.on("error", (error) => {
  console.error("Failed to start MCP Inspector:", error.message);
  process.exitCode = 1;
});

inspector.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exitCode = code ?? 1;
  }
});