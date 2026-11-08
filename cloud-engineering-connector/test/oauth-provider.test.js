import test from "node:test";
import assert from "node:assert/strict";
import { createOAuthProvider } from "../identity/oauth-provider.js";

const ISSUER = "https://connector.example.test";
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

test("OAuth authorization-server metadata advertises the canonical issuer and S256 PKCE", async () => {
  const provider = createOAuthProvider({ issuer: ISSUER, resource: RESOURCE, apiHandler: { async fetch() { return new Response('ok'); } } });
  const response = await provider.fetch(new Request(ISSUER + "/.well-known/oauth-authorization-server"));
  assert.equal(response.status, 200);
  const metadata = await response.json();
  assert.equal(metadata.issuer, ISSUER);
  assert.equal(metadata.authorization_endpoint, ISSUER + "/authorize");
  assert.equal(metadata.token_endpoint, ISSUER + "/oauth/token");
  assert.ok(metadata.code_challenge_methods_supported.includes("S256"));
  assert.equal(metadata.code_challenge_methods_supported.includes("plain"), false);
  assert.equal(metadata.grant_types_supported.includes("authorization_code"), true);
});

test("protected-resource metadata binds MCP to the canonical resource and issuer", async () => {
  const provider = createOAuthProvider();
  const response = await provider.fetch(new Request(ISSUER + "/.well-known/oauth-protected-resource/mcp"));
  assert.equal(response.status, 200);
  const metadata = await response.json();
  assert.equal(metadata.resource, RESOURCE);
  assert.deepEqual(metadata.authorization_servers, [ISSUER]);
  assert.deepEqual(metadata.scopes_supported, ["mcp:read"]);
});

test("MCP resource rejects missing and invalid bearer tokens before invoking the API handler", async () => {
  let handlerCalls = 0;
  const provider = createOAuthProvider({
    issuer: ISSUER,
    resource: RESOURCE,
    apiHandler: { async fetch() { handlerCalls += 1; return Response.json({ reached: true }); } },
  });
  for (const authorization of [null, "Bearer deliberately-invalid"]) {
    const response = await provider.fetch(new Request(RESOURCE, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(authorization ? { authorization } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    }), env(), { waitUntil() {} });
    assert.equal(response.status, 401);
    assert.match(response.headers.get("www-authenticate") || "", /resource_metadata=/);
  }
  assert.equal(handlerCalls, 0);
});
