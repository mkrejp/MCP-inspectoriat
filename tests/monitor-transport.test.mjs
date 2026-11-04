import { createServer } from "node:http";
import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { createMonitorTransport } from "../scripts/monitor-transport.mjs";

/**
 * @param {import("node:http").IncomingMessage} _request
 * @param {import("node:http").ServerResponse} response
 * @returns {void}
 */
function rejectUnauthorized(_request, response) {
  response.writeHead(401, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: "unauthorized" }));
}

test("streamable HTTP monitor sends the resolved lunar API key header", async () => {
  /** @type {string[]} */
  const headerValues = [];
  const server = createServer((request, response) => {
    headerValues.push(request.headers["x-lunar-api-key"] ?? "");
    rejectUnauthorized(request, response);
  });
  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const client = new Client({ name: "monitor-transport-test", version: "1.0.0" });
  const transport = createMonitorTransport({
    type: "http",
    url: `http://127.0.0.1:${address.port}/mcp`,
    headers: { "x-lunar-api-key": "stored-auth-key" },
  });

  await assert.rejects(client.connect(transport));
  await client.close().catch(() => {});
  server.close();

  assert.deepEqual(headerValues, ["stored-auth-key"]);
});

test("streamable HTTP monitor sends the resolved Authorization Bearer header", async () => {
  /** @type {string[]} */
  const headerValues = [];
  const server = createServer((request, response) => {
    headerValues.push(request.headers.authorization ?? "");
    rejectUnauthorized(request, response);
  });
  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const client = new Client({ name: "monitor-transport-test", version: "1.0.0" });
  const transport = createMonitorTransport({
    type: "http",
    url: `http://127.0.0.1:${address.port}/mcp/`,
    headers: { Authorization: "Bearer test-token" },
  });

  await assert.rejects(client.connect(transport));
  await client.close().catch(() => {});
  server.close();

  assert.deepEqual(headerValues, ["Bearer test-token"]);
});

test("streamable HTTP monitor omits the header when the profile has none", async () => {
  /** @type {Array<string | undefined>} */
  const headerValues = [];
  const server = createServer((request, response) => {
    headerValues.push(request.headers["x-lunar-api-key"]);
    rejectUnauthorized(request, response);
  });
  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const client = new Client({ name: "monitor-transport-test", version: "1.0.0" });
  const transport = createMonitorTransport({
    type: "http",
    url: `http://127.0.0.1:${address.port}/mcp`,
  });

  await assert.rejects(client.connect(transport));
  await client.close().catch(() => {});
  server.close();

  assert.deepEqual(headerValues, [undefined]);
});
