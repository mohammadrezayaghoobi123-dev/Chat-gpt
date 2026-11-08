import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";

const { default: worker, AgentSession } = await import("./helpers/load-worker.js");
const { parseRevocationEpoch } = await import("../src/auth.js");

const sha256 = async value => Array.from(new Uint8Array(await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), b => b.toString(16).padStart(2, "0")).join("");
const OWNER_TOKEN = "o".repeat(48);
const SESSION_TOKEN = "s".repeat(43);
const PRINCIPAL_HASH = await sha256(OWNER_TOKEN);

function makeStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    async get(key) { return values.get(key); },
    async put(keyOrEntries, value) {
      if (keyOrEntries && typeof keyOrEntries === "object") for (const [k, v] of Object.entries(keyOrEntries)) values.set(k, v);
      else values.set(keyOrEntries, value);
    },
    async delete(keys) { let n = 0; for (const key of Array.isArray(keys) ? keys : [keys]) if (values.delete(key)) n += 1; return n; },
    async setAlarm() {}
  };
}

async function liveSession(extra = {}) {
  return {
    "last-activity-at": Date.now(),
    "session-token-hash": await sha256(SESSION_TOKEN),
    "principal-id": "owner",
    "principal-auth-hash": PRINCIPAL_HASH,
    history: [{ role: "user", content: "kept?" }],
    ...extra
  };
}

function aiSpy() {
  const spy = { calls: 0, run: async () => { spy.calls += 1; throw new Error("model must not be called"); } };
  return spy;
}

const access = (agent, path = "/history", method = "GET") => agent.fetch(new Request("https://agent-session.internal" + path, {
  method,
  headers: { "content-type": "application/json", "x-session-token": SESSION_TOKEN, "x-principal-id": "owner", "x-principal-auth-hash": PRINCIPAL_HASH },
  body: method === "POST" ? JSON.stringify({ message: "hello" }) : undefined
}));

const initialize = (agent) => agent.fetch(new Request("https://agent-session.internal/initialize", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ token_hash: "a".repeat(64), principal_id: "owner", principal_auth_hash: PRINCIPAL_HASH })
}));

test("parseRevocationEpoch accepts a missing value as 0 and rejects anything but a canonical non-negative integer", () => {
  assert.equal(parseRevocationEpoch(undefined), 0);
  assert.equal(parseRevocationEpoch(""), 0);
  assert.equal(parseRevocationEpoch("0"), 0);
  assert.equal(parseRevocationEpoch("7"), 7);
  assert.equal(parseRevocationEpoch("123456789"), 123456789);
  for (const bad of ["abc", "-1", "1.5", "01", " 1", "1 ", "1e3", "1234567890", "0x10", null, 5, {}]) {
    assert.equal(parseRevocationEpoch(bad), null, String(bad));
  }
});

test("a new session records the current revocation epoch", async () => {
  const storage = makeStorage();
  const agent = new AgentSession({ storage }, { AGENT_REVOCATION_EPOCH: "3" });
  assert.equal((await initialize(agent)).status, 201);
  assert.equal(storage.values.get("revocation-epoch"), 3);
});

test("a session from the current epoch stays usable", async () => {
  const agent = new AgentSession({ storage: makeStorage(await liveSession({ "revocation-epoch": 3 })) }, { AGENT_REVOCATION_EPOCH: "3" });
  const response = await access(agent);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).messages.length, 1);
});

test("a session without a stored epoch is epoch 0 and keeps working while the configured epoch is 0 or unset", async () => {
  for (const env of [{}, { AGENT_REVOCATION_EPOCH: "0" }]) {
    const agent = new AgentSession({ storage: makeStorage(await liveSession()) }, env);
    assert.equal((await access(agent)).status, 200);
  }
});

test("raising the epoch rejects an existing session at once and erases its stored data", async () => {
  for (const stored of [undefined, 0, 2]) {
    const storage = makeStorage(await liveSession(stored === undefined ? {} : { "revocation-epoch": stored }));
    const agent = new AgentSession({ storage }, { AGENT_REVOCATION_EPOCH: "5" });
    const response = await access(agent);
    assert.equal(response.status, 410, "stored epoch " + stored);
    assert.deepEqual([...storage.values.keys()], [], "all session data must be erased");
  }
});

test("a revoked session never reaches the model or the budget, for chat or history", async () => {
  const ai = aiSpy();
  let budgetCalls = 0;
  const budget = { idFromName: n => n, get: () => ({ fetch: async () => { budgetCalls += 1; return Response.json({}); } }) };
  const agent = new AgentSession({ storage: makeStorage(await liveSession({ "revocation-epoch": 1 })) }, { AGENT_REVOCATION_EPOCH: "2", AI: ai, AGENT_BUDGET: budget });
  assert.equal((await access(agent, "/chat", "POST")).status, 410);
  assert.equal((await access(agent, "/history")).status, 401, "after erasure the session no longer exists");
  assert.equal(ai.calls, 0);
  assert.equal(budgetCalls, 0);
});

test("revocation is idempotent and a repeated request keeps failing closed", async () => {
  const storage = makeStorage(await liveSession());
  const agent = new AgentSession({ storage }, { AGENT_REVOCATION_EPOCH: "1" });
  const statuses = [];
  for (let i = 0; i < 3; i += 1) statuses.push((await access(agent)).status);
  assert.deepEqual(statuses, [410, 401, 401]);
});

test("a revoked session is rejected even when the caller presents a wrong capability, and its data is still erased", async () => {
  const storage = makeStorage(await liveSession({ "revocation-epoch": 0 }));
  const agent = new AgentSession({ storage }, { AGENT_REVOCATION_EPOCH: "1" });
  const response = await agent.fetch(new Request("https://agent-session.internal/history", {
    headers: { "x-session-token": "x".repeat(43), "x-principal-id": "owner", "x-principal-auth-hash": PRINCIPAL_HASH }
  }));
  assert.equal(response.status, 410);
  assert.equal(storage.values.size, 0);
});

test("an invalid configured epoch fails closed for initialization and for every existing session, and erases nothing", async () => {
  for (const bad of ["abc", "-1", "1.5", "01"]) {
    const storage = makeStorage(await liveSession());
    const agent = new AgentSession({ storage }, { AGENT_REVOCATION_EPOCH: bad });
    assert.equal((await access(agent)).status, 503, bad);
    assert.ok(storage.values.size > 0, "an invalid configuration must not destroy data");
    assert.equal((await initialize(new AgentSession({ storage: makeStorage() }, { AGENT_REVOCATION_EPOCH: bad }))).status, 503, "init " + bad);
  }
});

test("lowering the epoch below a session's epoch also rejects it (rollback cannot revive a newer session)", async () => {
  const storage = makeStorage(await liveSession({ "revocation-epoch": 4 }));
  const agent = new AgentSession({ storage }, { AGENT_REVOCATION_EPOCH: "3" });
  assert.equal((await access(agent)).status, 410);
});

test("/healthz stays live but is not ready when the revocation epoch is invalid", async () => {
  const env = { AI: {}, AGENT_SESSIONS: {}, AGENT_BUDGET: {}, AGENT_RATE_LIMITER: {} };
  const good = await (await worker.fetch(new Request("https://agent.example/healthz"), { ...env, AGENT_REVOCATION_EPOCH: "2" })).json();
  assert.equal(good.ready, true);
  assert.equal(good.revocation_epoch_valid, true);
  const response = await worker.fetch(new Request("https://agent.example/healthz"), { ...env, AGENT_REVOCATION_EPOCH: "nope" });
  const bad = await response.json();
  assert.equal(response.status, 200);
  assert.equal(bad.ready, false);
  assert.equal(bad.revocation_epoch_valid, false);
  assert.equal(JSON.stringify(bad).includes("nope"), false, "the configured value is not echoed");
});

test("session creation through the Worker refuses to start when the epoch is invalid", async () => {
  const response = await worker.fetch(new Request("https://agent.example/api/sessions", {
    method: "POST",
    headers: { authorization: "Bearer " + OWNER_TOKEN, "content-type": "application/json" },
    body: "{}"
  }), {
    AGENT_AUTH_TOKEN: OWNER_TOKEN,
    AGENT_REVOCATION_EPOCH: "bad",
    AGENT_RATE_LIMITER: { limit: async () => ({ success: true }) },
    AGENT_SESSIONS: { idFromName: n => n, get: () => ({ fetch: async () => { throw new Error("must not reach the Durable Object"); } }) }
  });
  assert.equal(response.status, 503);
});
