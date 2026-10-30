import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadStoredCredentials } from "./credentials-store.mjs";
import { getConfiguredTargets } from "./targets.mjs";

const profileManifestPath = new URL("../configs/profiles.json", import.meta.url);
const profilesDirectory = new URL("../configs/", import.meta.url);

export async function loadLocalEnv() {
  try {
    process.loadEnvFile();
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const credentials = await loadStoredCredentials();
  for (const [key, value] of Object.entries(credentials)) {
    if (!process.env[key]?.trim()) process.env[key] = value;
  }
}

async function getManifest() {
  return JSON.parse(await readFile(profileManifestPath, "utf8"));
}

export async function getProfileManifest() {
  return getManifest();
}

export async function getProfiles() {
  const { profiles } = await getManifest();
  return profiles.map((profile) => ({
    ...profile,
    missingEnv: profile.requiredEnv.filter((key) => !process.env[key]?.trim()),
  }));
}

function createRemoteConfig() {
  const [target] = getConfiguredTargets();
  return {
    config: {
      type: target.transport === "http" ? "http" : "sse",
      url: target.url,
    },
  };
}

function resolveEnvironment(config, profile) {
  const missing = new Set();
  const servers = config.mcpServers ?? {};

  for (const server of Object.values(servers)) {
    for (const [key, value] of Object.entries(server.env ?? {})) {
      if (typeof value !== "string") continue;
      server.env[key] = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name) => {
        const resolved = process.env[name];
        if (!resolved?.trim()) missing.add(name);
        return resolved ?? "";
      });
    }
  }

  for (const key of profile.requiredEnv) {
    if (!process.env[key]?.trim()) missing.add(key);
  }

  if (missing.size > 0) {
    throw new Error(`Missing required environment variables: ${[...missing].join(", ")}`);
  }

  return config;
}

export async function prepareProfile(profileId) {
  const { profiles } = await getManifest();
  const profile = profiles.find((candidate) => candidate.id === profileId);
  if (!profile) throw new Error(`Unknown MCP profile: ${profileId}`);

  let config;
  if (profile.config) {
    const configPath = new URL(profile.config, profilesDirectory);
    config = JSON.parse(await readFile(configPath, "utf8"));
  } else {
    const remote = createRemoteConfig();
    config = { mcpServers: { [profile.server]: remote.config } };
  }

  resolveEnvironment(config, profile);
  const serverConfig = config.mcpServers?.[profile.server];
  if (!serverConfig) {
    throw new Error(`Profile ${profileId} does not define server ${profile.server}.`);
  }

  const directory = await mkdtemp(join(tmpdir(), "mcp-inspector-profile-"));
  const configPath = join(directory, `${profile.id}.json`);
  await writeFile(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });

  return {
    profile,
    serverName: profile.server,
    serverConfig,
    configPath,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

export function inspectorEnvironment() {
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

  return env;
}

export function launchPreparedInspector(prepared) {
  const child = spawn(
    "mcp-inspector",
    ["--web", "--config", prepared.configPath, "--server", prepared.serverName],
    { env: inspectorEnvironment(), stdio: "inherit" },
  );

  child.once("exit", () => prepared.cleanup());
  child.once("error", () => prepared.cleanup());
  return child;
}

export async function startInspector(profileId) {
  const prepared = await prepareProfile(profileId);
  return { ...prepared, child: launchPreparedInspector(prepared) };
}

export async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;

  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const timeout = setTimeout(() => child.kill("SIGKILL"), 3000);
  timeout.unref();
  await exited;
  clearTimeout(timeout);
}