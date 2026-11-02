import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";

const coreSource = await readFile(new URL("../src/core.js", import.meta.url), "utf8");
const workerSource = await readFile(new URL("../src/worker.js", import.meta.url), "utf8");
const coreUrl = "data:text/javascript;base64," + Buffer.from(coreSource).toString("base64");
const testableWorkerSource = workerSource
  .replace(
    'import { DurableObject } from "cloudflare:workers";',
    "class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }"
  )
  .replace('from "./core.js"', 'from "' + coreUrl + '"')
  .replace(
    'import { AgentBudget, DAILY_NEURON_BUDGET } from "./budget.js";',
    "const DAILY_NEURON_BUDGET = 1000; class AgentBudget {}"
  );
const workerUrl = "data:text/javascript;base64," + Buffer.from(testableWorkerSource).toString("base64");
const { default: worker, AgentSession } = await import(workerUrl);

const TOKEN = "t".repeat(48);
const SESSION = "550e8400-e29b-41d4-a716-446655440000";
const SESSION_TOKEN = "s".repeat(43);
const PRINCIPAL_AUTH_HASH = Array.from(new Uint8Array(await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(TOKEN))), byte => byte.toString(16).padStart(2, "0")).join("");

function makeStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  const alarms = [];
  return {
    values,
    alarms,
    async get(key) { return values.get(key); },
    async put(keyOrEntries, value) {
      if (arguments.length === 1 && keyOrEntries && typeof keyOrEntries === "object") {
        for (const [key, entry] of Object.entries(keyOrEntries)) values.set(key, entry);
      } else {
        values.set(keyOrEntries, value);
      }
    },
    async delete(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      let count = 0;
      for (const key of list) if (values.delete(key)) count += 1;
      return count;
    },
    async setAlarm(timestamp) { alarms.push(timestamp); }
  };
}

function envWithSessionStub({ sessionResponse = Response.json({ initialized: true }), onForward } = {}) {
  return {
    AGENT_AUTH_TOKEN: TOKEN,
    AGENT_RATE_LIMITER: { limit: async () => ({ success: true }) },
    AGENT_BUDGET: { idFromName: name => name, get: () => ({ fetch: async () => Response.json({ allowed: true }) }) },
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

function makeBudgetBinding() {
  return {
    idFromName: name => name,
    get: () => ({
      fetch: async request => {
        const path = new URL(request.url).pathname;
        if (path === "/reserve") return Response.json({ reserved_neurons: 10 }, { status: 201 });
        if (path === "/settle") return Response.json({ settled: true });
        return new Response("not found", { status: 404 });
      }
    })
  };
}

async function makeInitializedAgent(token = SESSION_TOKEN, initial = {}) {
  const storage = makeStorage(initial);
  const agent = new AgentSession({ storage }, {
    AI: { run: async () => ({ choices: [{ message: { role: "assistant", content: "authorized response" } }] }) },
    AGENT_BUDGET: makeBudgetBinding()
  });
  const digest = await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const tokenHash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  const initialized = await agent.fetch(new Request("https://agent-session.internal/initialize", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token_hash: tokenHash, principal_id: "owner", principal_auth_hash: PRINCIPAL_AUTH_HASH })
  }));
  assert.equal(initialized.status, 201);
  if (Object.hasOwn(initial, "last-activity-at")) {
    await storage.put("last-activity-at", initial["last-activity-at"]);
  }
  return { agent, storage, tokenHash };
}

test("authenticated session creation returns a random capability and stores only its SHA-256 verifier", async () => {
  let forwarded;
  const response = await worker.fetch(
    authorizedRequest("/api/sessions", { method: "POST" }),
    envWithSessionStub({ onForward: request => { forwarded = request; } })
  );
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.match(body.session_id, /^[0-9a-f-]{36}$/i);
  assert.match(body.session_token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(forwarded.method, "POST");
  assert.equal(new URL(forwarded.url).pathname, "/initialize");
  const init = await forwarded.json();
  assert.match(init.token_hash, /^[0-9a-f]{64}$/);
  assert.equal(init.principal_auth_hash, PRINCIPAL_AUTH_HASH);
  assert.equal(Object.hasOwn(init, "session_token"), false);
  assert.notEqual(init.token_hash, body.session_token);
});

test("session creation fails closed when Durable Object initialization fails", async () => {
  const response = await worker.fetch(
    authorizedRequest("/api/sessions", { method: "POST" }),
    envWithSessionStub({ sessionResponse: new Response("unavailable", { status: 503 }) })
  );
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(Object.hasOwn(body, "session_token"), false);
});

test("session initialization is one-time and persists only a verifier", async () => {
  const { agent, storage, tokenHash } = await makeInitializedAgent();
  assert.equal(storage.values.get("session-token-hash"), tokenHash);
  assert.equal(storage.values.has("session_token"), false);
  const duplicate = await agent.fetch(new Request("https://agent-session.internal/initialize", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token_hash: "b".repeat(64), principal_id: "owner", principal_auth_hash: PRINCIPAL_AUTH_HASH })
  }));
  assert.equal(duplicate.status, 409);
  assert.equal(storage.values.get("session-token-hash"), tokenHash);
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

test("session chat forwards the capability header to the selected Durable Object", async () => {
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

test("wrong session capability is rejected before history or rate state is accessed", async () => {
  const { agent, storage } = await makeInitializedAgent(SESSION_TOKEN, {
    history: [{ role: "assistant", content: "private history" }]
  });
  const response = await agent.fetch(new Request("https://agent-session.internal/history", {
    headers: { "x-principal-id": "owner", "x-principal-auth-hash": PRINCIPAL_AUTH_HASH, "x-session-token": "x".repeat(43) }
  }));
  assert.equal(response.status, 401);
  assert.equal(storage.values.get("history")[0].content, "private history");
  assert.equal(storage.values.has("rate-window"), false);
});

test("wrong session capability is rejected for chat before model invocation", async () => {
  let modelCalls = 0;
  const { agent, storage } = await makeInitializedAgent();
  agent.env.AI.run = async () => {
    modelCalls += 1;
    return { choices: [{ message: { role: "assistant", content: "must not run" } }] };
  };
  const response = await agent.fetch(new Request("https://agent-session.internal/chat", {
    method: "POST",
    headers: { "content-type": "application/json", "x-session-token": "x".repeat(43), "x-principal-id": "owner", "x-principal-auth-hash": PRINCIPAL_AUTH_HASH },
    body: JSON.stringify({ message: "unauthorized prompt" })
  }));
  assert.equal(response.status, 401);
  assert.equal(modelCalls, 0);
  assert.equal(storage.values.has("history"), false);
});

test("a session capability cannot cross Durable Object session ownership boundaries", async () => {
  const firstCapability = "a".repeat(43);
  const secondCapability = "b".repeat(43);
  const first = await makeInitializedAgent(firstCapability);
  const second = await makeInitializedAgent(secondCapability, {
    history: [{ role: "assistant", content: "session B private history" }]
  });
  const response = await second.agent.fetch(new Request("https://agent-session.internal/history", {
    headers: { "x-principal-id": "owner", "x-principal-auth-hash": PRINCIPAL_AUTH_HASH, "x-session-token": firstCapability }
  }));
  assert.equal(response.status, 401);
  assert.deepEqual(second.storage.values.get("history"), [
    { role: "assistant", content: "session B private history" }
  ]);
  assert.equal(second.storage.values.has("rate-window"), false);
  assert.equal(first.storage.values.has("history"), false);
});

test("valid session capability permits access to that session's history", async () => {
  const { agent } = await makeInitializedAgent(SESSION_TOKEN, {
    history: [{ role: "assistant", content: "private history" }]
  });
  const response = await agent.fetch(new Request("https://agent-session.internal/history", {
    headers: { "x-principal-id": "owner", "x-principal-auth-hash": PRINCIPAL_AUTH_HASH, "x-session-token": SESSION_TOKEN }
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    messages: [{ role: "assistant", content: "private history" }]
  });
});

test("history projects only user-facing role and content and never returns stored capability metadata", async () => {
  const { agent, storage, tokenHash } = await makeInitializedAgent(SESSION_TOKEN);
  storage.values.set("history", [
    { role: "user", content: "question", session_token: SESSION_TOKEN },
    { role: "assistant", content: "safe answer", token_hash: tokenHash },
    { role: "tool", content: "tool output", session_token: SESSION_TOKEN }
  ]);
  const response = await agent.fetch(new Request("https://agent-session.internal/history", {
    headers: { "x-principal-id": "owner", "x-principal-auth-hash": PRINCIPAL_AUTH_HASH, "x-session-token": SESSION_TOKEN }
  }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body, {
    messages: [
      { role: "user", content: "question" },
      { role: "assistant", content: "safe answer" }
    ]
  });
  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes(SESSION_TOKEN), false);
  assert.equal(serialized.includes(tokenHash), false);
});

test("valid session capability permits chat and history persists only after authorization", async () => {
  const { agent, storage } = await makeInitializedAgent();
  const response = await agent.fetch(new Request("https://agent-session.internal/chat", {
    method: "POST",
    headers: { "content-type": "application/json", "x-session-token": SESSION_TOKEN, "x-principal-id": "owner", "x-principal-auth-hash": PRINCIPAL_AUTH_HASH },
    body: JSON.stringify({ message: "run authorized chat" })
  }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).answer, "authorized response");
  assert.equal(storage.values.get("history")[0].content, "run authorized chat");
});

test("expired sessions delete history, rate state, and verifier before rejecting further access", async () => {
  const stale = Date.now() - 8 * 24 * 60 * 60 * 1000;
  const { agent, storage } = await makeInitializedAgent(SESSION_TOKEN, {
    history: [{ role: "assistant", content: "expired private history" }],
    "rate-window": [stale],
    "last-activity-at": stale
  });
  const response = await agent.fetch(new Request("https://agent-session.internal/history", {
    headers: { "x-principal-id": "owner", "x-principal-auth-hash": PRINCIPAL_AUTH_HASH, "x-session-token": SESSION_TOKEN }
  }));
  assert.equal(response.status, 410);
  assert.equal(storage.values.has("history"), false);
  assert.equal(storage.values.has("rate-window"), false);
  assert.equal(storage.values.has("last-activity-at"), false);
  assert.equal(storage.values.has("session-token-hash"), false);
  const secondAttempt = await agent.fetch(new Request("https://agent-session.internal/history", {
    headers: { "x-principal-id": "owner", "x-principal-auth-hash": PRINCIPAL_AUTH_HASH, "x-session-token": SESSION_TOKEN }
  }));
  assert.equal(secondAttempt.status, 401);
});
