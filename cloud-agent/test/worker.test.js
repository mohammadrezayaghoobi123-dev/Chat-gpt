import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { Script } from "node:vm";
import { readFile } from "node:fs/promises";

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

function makeBudgetBinding({ reserveStatus = 201, settleStatus = 200, onReserve, onSettle } = {}) {
  return {
    idFromName: name => name,
    get: () => ({
      fetch: async request => {
        const path = new URL(request.url).pathname;
        if (path === "/reserve") {
          const body = await request.json();
          onReserve?.(body);
          return Response.json({ reserved_neurons: body.neurons }, { status: reserveStatus });
        }
        if (path === "/settle") {
          const body = await request.json();
          onSettle?.(body);
          return Response.json({ settled: true }, { status: settleStatus });
        }
        return new Response("not found", { status: 404 });
      }
    })
  };
}

async function makeAgent({ storage, ai = { run: async () => ({ choices: [{ message: { role: "assistant", content: "verified test response" } }] }) }, budget } = {}) {
  const token = "s".repeat(43);
  const digest = await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const tokenHash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  storage ||= makeStorage({ "last-activity-at": Date.now() });
  if (!(await storage.get("session-token-hash"))) await storage.put("session-token-hash", tokenHash);
  if (!(await storage.get("principal-id"))) await storage.put("principal-id", "owner");
  const ctx = { storage };
  const env = { AI: ai, AGENT_BUDGET: budget || makeBudgetBinding() };
  return { agent: new AgentSession(ctx, env), storage, env };
}

function chatRequest(message = "inspect this project") {
  return new Request("https://agent-session.internal/chat", {
    method: "POST",
    headers: { "content-type": "application/json", "x-session-token": "s".repeat(43), "x-principal-id": "owner" },
    body: JSON.stringify({ message })
  });
}

function historyRequest() {
  return new Request("https://agent-session.internal/history", { method: "GET", headers: { "x-session-token": "s".repeat(43), "x-principal-id": "owner" } });
}

function publicEnv(overrides = {}) {
  return {
    AGENT_AUTH_TOKEN: TOKEN,
    AGENT_RATE_LIMITER: { limit: async () => ({ success: true }) },
    AGENT_BUDGET: {
      idFromName: name => name,
      get: () => ({ fetch: async request => Response.json({ allowed: true, reserved_neurons: 1 }) })
    },
    AGENT_SESSIONS: {
      idFromName: name => name,
      get: () => ({ fetch: async request => Response.json({ forwarded: new URL(request.url).pathname }) })
    },
    ...overrides
  };
}

test("health endpoint returns liveness metadata without exposing secrets", async () => {
  const response = await worker.fetch(new Request("https://agent.example/healthz"), publicEnv());
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.mode, "read-only");
  assert.equal(JSON.stringify(body).includes(TOKEN), false);
});

test("console CSP uses the same nonce for style and script and forbids unsafe-inline", async () => {
  const response = await worker.fetch(new Request("https://agent.example/"), publicEnv());
  const csp = response.headers.get("content-security-policy");
  const html = await response.text();
  const nonce = csp.match(/style-src 'nonce-([^']+)'/)?.[1];
  assert.ok(nonce);
  assert.match(csp, /script-src 'nonce-/);
  assert.equal(csp.includes("unsafe-inline"), false);
  assert.ok(html.includes('<style nonce="' + nonce + '">'));
  assert.ok(html.includes('<script nonce="' + nonce + '">'));
  const scriptStart = html.indexOf('<script nonce="' + nonce + '">') + ('<script nonce="' + nonce + '">').length;
  const scriptEnd = html.indexOf("</script>", scriptStart);
  const inlineScript = html.slice(scriptStart, scriptEnd);
  assert.ok(inlineScript);
  assert.doesNotThrow(() => new Script(inlineScript));
  assert.match(inlineScript, /x-session-token/);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("API rejects missing bearer auth before rate limiting or Durable Object access", async () => {
  let limiterCalls = 0;
  let doCalls = 0;
  const env = publicEnv({
    AGENT_RATE_LIMITER: { limit: async () => { limiterCalls += 1; return { success: true }; } },
    AGENT_SESSIONS: { idFromName: () => "id", get: () => ({ fetch: async () => { doCalls += 1; return new Response(); } }) }
  });
  const response = await worker.fetch(new Request("https://agent.example/api/sessions/" + SESSION + "/chat", { method: "POST" }), env);
  assert.equal(response.status, 401);
  assert.equal(limiterCalls, 0);
  assert.equal(doCalls, 0);
});

test("global rate limiter fails closed and rejects before creating a session", async () => {
  let doCalls = 0;
  const env = publicEnv({
    AGENT_RATE_LIMITER: { limit: async () => ({ success: false }) },
    AGENT_SESSIONS: { idFromName: () => "id", get: () => ({ fetch: async () => { doCalls += 1; return new Response(); } }) }
  });
  const denied = await worker.fetch(new Request("https://agent.example/api/sessions/" + SESSION + "/chat", { method: "POST", headers: { authorization: "Bearer " + TOKEN, "x-session-token": "s".repeat(43) } }), env);
  assert.equal(denied.status, 429);
  assert.equal(denied.headers.get("retry-after"), "60");
  env.AGENT_RATE_LIMITER = { limit: async () => { throw new Error("binding unavailable"); } };
  const unavailable = await worker.fetch(new Request("https://agent.example/api/sessions/" + SESSION + "/chat", { method: "POST", headers: { authorization: "Bearer " + TOKEN, "x-session-token": "s".repeat(43) } }), env);
  assert.equal(unavailable.status, 503);
  assert.equal(doCalls, 0);
});

test("authenticated routing canonicalizes UUID case before Durable Object lookup", async () => {
  let routedName;
  const env = publicEnv({
    AGENT_SESSIONS: {
      idFromName: name => { routedName = name; return name; },
      get: () => ({ fetch: async request => Response.json({ path: new URL(request.url).pathname }) })
    }
  });
  const response = await worker.fetch(new Request("https://agent.example/api/sessions/" + SESSION.toUpperCase() + "/history", {
    headers: { authorization: "Bearer " + TOKEN, "x-session-token": "s".repeat(43) }
  }), env);
  assert.equal(response.status, 200);
  assert.equal(routedName, SESSION);
  assert.deepEqual(await response.json(), { path: "/history" });
});

test("Durable Object chat persists bounded history and schedules expiry", async () => {
  const { agent, storage } = await makeAgent();
  const response = await agent.fetch(chatRequest());
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.answer, "verified test response");
  assert.equal(body.read_only, true);
  const history = storage.values.get("history");
  assert.deepEqual(history.map(item => item.role), ["user", "assistant"]);
  assert.equal(storage.values.get("rate-window").length, 1);
  assert.equal(storage.alarms.length, 2);
  assert.ok(storage.values.get("last-activity-at") > 0);
});

test("malformed and oversized chat requests are rejected before model invocation but still count toward rate limits", async () => {
  let modelCalls = 0;
  const { agent, storage } = await makeAgent({ ai: { run: async () => { modelCalls += 1; return {}; } } });
  const malformed = await agent.fetch(new Request("https://agent-session.internal/chat", { method: "POST", headers: { "x-session-token": "s".repeat(43), "x-principal-id": "owner" }, body: "{" }));
  assert.equal(malformed.status, 400);
  const oversized = await agent.fetch(new Request("https://agent-session.internal/chat", {
    method: "POST",
    headers: { "content-type": "application/json", "x-session-token": "s".repeat(43) },
    body: "x".repeat(12_001)
  }));
  assert.equal(oversized.status, 413);
  assert.equal(modelCalls, 0);
  assert.equal(storage.values.get("rate-window").length, 2);
});

test("daily budget denial blocks Workers AI before inference", async () => {
  let modelCalls = 0;
  const { agent, storage } = await makeAgent({
    ai: { run: async () => { modelCalls += 1; return {}; } },
    budget: makeBudgetBinding({ reserveStatus: 429 })
  });
  const response = await agent.fetch(chatRequest("must be blocked by budget"));
  assert.equal(response.status, 429);
  assert.equal(modelCalls, 0);
  assert.equal(storage.values.has("history"), false);
});

test("model usage is settled against the reserved Neuron estimate", async () => {
  let reservation;
  let settlement;
  const budget = makeBudgetBinding({
    onReserve: body => { reservation = body; },
    onSettle: body => { settlement = body; }
  });
  const { agent } = await makeAgent({
    budget,
    ai: { run: async () => ({
      usage: { prompt_tokens: 1_000, completion_tokens: 100 },
      choices: [{ message: { role: "assistant", content: "budget-accounted answer" } }]
    }) }
  });
  const response = await agent.fetch(chatRequest("measure actual usage"));
  assert.equal(response.status, 200);
  assert.ok(reservation.neurons >= 10);
  assert.equal(settlement.success, true);
  assert.equal(settlement.actual_neurons, 10);
});

test("model failure settles the full reservation conservatively", async () => {
  let settlement;
  const budget = makeBudgetBinding({ onSettle: body => { settlement = body; } });
  const { agent } = await makeAgent({
    budget,
    ai: { run: async () => { throw new Error("simulated inference failure"); } }
  });
  const response = await agent.fetch(chatRequest("force model failure"));
  assert.equal(response.status, 503);
  assert.equal(settlement.success, false);
  assert.equal(Object.hasOwn(settlement, "actual_neurons"), false);
});

test("missing model usage metadata consumes the full reservation", async () => {
  let reservation;
  let settlement;
  const budget = makeBudgetBinding({
    onReserve: body => { reservation = body; },
    onSettle: body => { settlement = body; }
  });
  const { agent } = await makeAgent({
    budget,
    ai: { run: async () => ({
      choices: [{ message: { role: "assistant", content: "no usage metadata" } }]
    }) }
  });
  const response = await agent.fetch(chatRequest("missing usage data"));
  assert.equal(response.status, 200);
  assert.equal(settlement.success, true);
  assert.equal(Object.hasOwn(settlement, "actual_neurons"), false);
  assert.ok(reservation.neurons > 0);
});

test("history endpoint is rate-limited and preserves active stored history", async () => {
  const recent = Date.now() - 1_000;
  const staleRequest = Date.now() - 60_001;
  const storage = makeStorage({
    history: [{ role: "assistant", content: "active" }],
    "rate-window": [staleRequest],
    "last-activity-at": recent
  });
  const { agent } = await makeAgent({ storage });
  const response = await agent.fetch(historyRequest());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { messages: [{ role: "assistant", content: "active" }] });
  assert.equal(storage.values.has("history"), true);
  assert.equal(storage.values.get("rate-window").length, 1);
  for (let i = 0; i < 7; i += 1) assert.equal((await agent.fetch(historyRequest())).status, 200);
  assert.equal((await agent.fetch(historyRequest())).status, 429);
});

test("alarm idempotently removes expired session state", async () => {
  const stale = Date.now() - 8 * 24 * 60 * 60 * 1000;
  const storage = makeStorage({
    history: [{ role: "user", content: "old" }],
    "rate-window": [stale],
    "last-activity-at": stale
  });
  const { agent } = await makeAgent({ storage });
  await agent.alarm();
  assert.equal(storage.values.has("history"), false);
  assert.equal(storage.values.has("rate-window"), false);
  assert.equal(storage.values.has("last-activity-at"), false);
  assert.equal(storage.values.has("session-token-hash"), false);
});
