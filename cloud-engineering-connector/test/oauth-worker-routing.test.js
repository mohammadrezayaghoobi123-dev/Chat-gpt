import test from "node:test";
import assert from "node:assert/strict";
import worker from "../worker.js";

const ISSUER = "https://chat-gpt111.mohammadrezayaghoobi123.workers.dev";
const RESOURCE = ISSUER + "/mcp";

function memoryKv() {
  const values = new Map();
  return {
    async get(key, type) {
      const value = values.get(key);
      if (value === undefined) return null;
      return type === "json" ? JSON.parse(value) : value;
    },
    async put(key, value) { values.set(key, value); },
    async delete(key) { values.delete(key); },
    async list({ prefix = "" } = {}) {
      return { keys: [...values.keys()].filter(key => key.startsWith(prefix)).map(name => ({ name })), list_complete: true };
    },
  };
}

function env() {
  return {
    OAUTH_KV: memoryKv(),
    OAUTH_ISSUER: ISSUER,
    MCP_RESOURCE_URL: RESOURCE,
  };
}

test("Worker publishes OAuth authorization-server discovery from the configured issuer", async () => {
  const response = await worker.fetch(new Request(ISSUER + "/.well-known/oauth-authorization-server"), env());
  assert.equal(response.status, 200);
  const metadata = await response.json();
  assert.equal(metadata.issuer, ISSUER);
  assert.equal(metadata.authorization_endpoint, ISSUER + "/authorize");
  assert.equal(metadata.token_endpoint, ISSUER + "/oauth/token");
  assert.ok(metadata.code_challenge_methods_supported.includes("S256"));
});

test("Worker publishes protected-resource metadata for the canonical MCP endpoint", async () => {
  const response = await worker.fetch(new Request(ISSUER + "/.well-known/oauth-protected-resource/mcp"), env());
  assert.equal(response.status, 200);
  const metadata = await response.json();
  assert.equal(metadata.resource, RESOURCE);
  assert.deepEqual(metadata.authorization_servers, [ISSUER]);
  assert.deepEqual(metadata.scopes_supported, ["mcp:read"]);
});

test("Worker keeps interactive authorization fail-closed until Access OIDC is configured", async () => {
  const response = await worker.fetch(new Request(ISSUER + "/authorize"), env());
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "no-store");
});
