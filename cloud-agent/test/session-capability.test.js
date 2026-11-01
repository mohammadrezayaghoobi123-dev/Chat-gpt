import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const coreSource = await readFile(new URL("../src/core.js", import.meta.url), "utf8");
const workerSource = await readFile(new URL("../src/worker.js", import.meta.url), "utf8");
const coreUrl = "data:text/javascript;base64," + Buffer.from(coreSource).toString("base64");
const testableWorkerSource = workerSource
  .replace(
    'import { DurableObject } from "cloudflare:workers";',
    "class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }"
  )
  .replace('from "./core.js"', 'from "' + coreUrl + '"');
const workerUrl = "data:text/javascript;base64," + Buffer.from(testableWorkerSource).toString("base64");
const { default: worker } = await import(workerUrl);

const TOKEN = "t".repeat(48);
const SESSION = "550e8400-e29b-41d4-a716-446655440000";
const SESSION_TOKEN = "s".repeat(64);

function envWithSessionStub({ sessionResponse = Response.json({ initialized: true }), onForward } = {}) {
  return {
    AGENT_AUTH_TOKEN: TOKEN,
    AGENT_RATE_LIMITER: { limit: async () => ({ success: true }) },
    AGENT_SESSIONS: {
      idFromName: name => name,
      get: () => ({
        fetch: async request => {
          onForward?.(request);
          return sessionResponse;
        }
      })
    }
  };
}

function authorizedRequest(path, { method = "GET", body, sessionToken } = {}) {
  const headers = { authorization: "Bearer " + TOKEN };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (sessionToken) headers["x-session-token"] = sessionToken;
  return new Request("https://agent.example" + path, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
}

test("authenticated session creation returns an independent session capability", async () => {
  let forwarded;
  const response = await worker.fetch(
    authorizedRequest("/api/sessions", { method: "POST" }),
    envWithSessionStub({ onForward: request => { forwarded = request; } })
  );
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.match(body.session_id, /^[0-9a-f-]{36}$/i);
  assert.match(body.session_token, /^[A-Za-z0-9_-]{40,}$/);
  assert.equal(forwarded.method, "POST");
  assert.equal(new URL(forwarded.url).pathname, "/initialize");
  const init = await forwarded.json();
  assert.equal(init.session_token, body.session_token);
});

test("session chat rejects a missing per-session capability before Durable Object access", async () => {
  let doCalls = 0;
  const response = await worker.fetch(
    authorizedRequest("/api/sessions/" + SESSION + "/chat", { method: "POST", body: { message: "hello" } }),
    envWithSessionStub({ onForward: () => { doCalls += 1; } })
  );
  assert.equal(response.status, 401);
  assert.equal(doCalls, 0);
});

test("session history rejects a missing per-session capability before Durable Object access", async () => {
  let doCalls = 0;
  const response = await worker.fetch(
    authorizedRequest("/api/sessions/" + SESSION + "/history"),
    envWithSessionStub({ onForward: () => { doCalls += 1; } })
  );
  assert.equal(response.status, 401);
  assert.equal(doCalls, 0);
});

test("session chat forwards the supplied capability only to the owning Durable Object", async () => {
  let forwarded;
  const response = await worker.fetch(
    authorizedRequest("/api/sessions/" + SESSION + "/chat", {
      method: "POST",
      body: { message: "hello" },
      sessionToken: SESSION_TOKEN
    }),
    envWithSessionStub({ onForward: request => { forwarded = request; } })
  );
  assert.equal(response.status, 200);
  assert.equal(forwarded.headers.get("x-session-token"), SESSION_TOKEN);
});
