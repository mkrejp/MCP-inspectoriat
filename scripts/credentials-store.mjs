import { randomBytes, createCipheriv, createDecipheriv, scryptSync } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const VERSION = 1;

function storePath() {
  return resolve(process.env.MCP_CREDENTIALS_FILE || ".mcp-inspector/credentials.enc");
}

function encryptionKey(salt) {
  const configuredKey = process.env.CREDENTIALS_ENCRYPTION_KEY || "";
  if (!/^[a-fA-F0-9]{64}$/.test(configuredKey)) {
    throw new Error("CREDENTIALS_ENCRYPTION_KEY must be a 64-character hex secret.");
  }
  return scryptSync(Buffer.from(configuredKey, "hex"), salt, 32);
}

function decodeEnvelope(encoded) {
  const envelope = JSON.parse(encoded);
  if (envelope.version !== VERSION || !envelope.salt || !envelope.iv || !envelope.tag || !envelope.data) {
    throw new Error("Credential store format is invalid.");
  }
  return envelope;
}

export async function loadStoredCredentials() {
  let encoded;
  try {
    encoded = await readFile(storePath(), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }

  try {
    const envelope = decodeEnvelope(encoded);
    const salt = Buffer.from(envelope.salt, "base64");
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(salt), Buffer.from(envelope.iv, "base64"));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.data, "base64")),
      decipher.final(),
    ]).toString("utf8");
    const credentials = JSON.parse(plaintext);
    if (!credentials || typeof credentials !== "object" || Array.isArray(credentials)) {
      throw new Error("Credential payload is invalid.");
    }
    return credentials;
  } catch {
    throw new Error("Unable to decrypt stored credentials. Check CREDENTIALS_ENCRYPTION_KEY.");
  }
}

export async function saveStoredCredentials(credentials) {
  const existing = await loadStoredCredentials();
  const merged = { ...existing, ...credentials };
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(salt), iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(merged), "utf8"),
    cipher.final(),
  ]);
  const envelope = `${JSON.stringify({
    version: VERSION,
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: encrypted.toString("base64"),
  })}\n`;
  const path = storePath();
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;

  try {
    await writeFile(temporaryPath, envelope, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }

  return Object.keys(merged);
}