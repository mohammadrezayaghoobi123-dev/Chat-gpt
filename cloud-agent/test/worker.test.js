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
    AGENT_BUDGET: { idFromName: name => name, get: () => ({ fetch: async () => Response.json({ allowed: true }) }) },
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
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("permissions-policy"), "camera=(), microphone=(), geolocation=()");
  assert.equal(response.headers.get("cross-origin-resource-policy"), "same-origin");
});

test("Cloud Agent JSON API responses carry restrictive browser security headers", async () => {
  const response = await worker.fetch(new Request("https://agent.example/api/sessions", { method: "POST", headers: { "cf-connecting-ip": "203.0.113.10" } }), publicEnv());
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("content-security-policy"), "default-src 'none'; frame-ancestors 'none'");
  assert.equal(response.headers.get("permissions-policy"), "camera=(), microphone=(), geolocation=()");
  assert.equal(response.headers.get("cross-origin-resource-policy"), "same-origin");
});

test("API rejects missing bearer auth after consuming the isolated auth-failure quota", async () => {
  const limiterKeys = [];
  let doCalls = 0;
  const env = publicEnv({
    AGENT_RATE_LIMITER: { limit: async ({ key }) => { limiterKeys.push(key); return { success: true }; } },
    AGENT_SESSIONS: { idFromName: () => "id", get: () => ({ fetch: async () => { doCalls += 1; return new Response(); } }) }
  });
  const response = await worker.fetch(new Request("https://agent.example/api/sessions/" + SESSION + "/chat", { method: "POST", headers: { "cf-connecting-ip": "203.0.113.10" } }), env);
  assert.equal(response.status, 401);
  assert.deepEqual(limiterKeys, ["master-brain-cloud-agent-auth-failure:203.0.113.10"]);
  assert.equal(doCalls, 0);
});

test("invalid bearer auth is rate-limited independently and returns 429 after quota exhaustion", async () => {
  let calls = 0;
  const env = publicEnv({
    AGENT_RATE_LIMITER: { limit: async ({ key }) => {
      calls += 1;
      assert.equal(key, "master-brain-cloud-agent-auth-failure:203.0.113.10");
      return { success: false };
    } }
  });
  const response = await worker.fetch(new Request("https://agent.example/api/sessions", {
    method: "POST",
    headers: { authorization: "Bearer invalid-token", "cf-connecting-ip": "203.0.113.10" }
  }), env);
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "60");
  assert.equal(calls, 1);
});

test("invalid bearer auth fails closed when the auth-failure limiter is unavailable", async () => {
  const response = await worker.fetch(new Request("https://agent.example/api/sessions", {
    method: "POST",
    headers: { authorization: "Bearer invalid-token" }
  }), publicEnv({ AGENT_RATE_LIMITER: undefined }));
  assert.equal(response.status, 503);
});

test("authenticated traffic is not charged against the failed-authentication IP quota", async () => {
  let limiterCalls = 0;
  let forwardedPrincipal;
  const env = publicEnv({
    AGENT_RATE_LIMITER: { limit: async () => { limiterCalls += 1; return { success: false }; } },
    AGENT_SESSIONS: { idFromName: () => "id", get: () => ({ fetch: async request => {
      forwardedPrincipal = request.headers.get("x-principal-id");
      return Response.json({ ok: true });
    } }) }
  });
  const response = await worker.fetch(new Request("https://agent.example/api/sessions/" + SESSION + "/history", {
    headers: { authorization: "Bearer " + TOKEN, "x-session-token": "s".repeat(43) }
  }), env);
  assert.equal(response.status, 200);
  assert.equal(limiterCalls, 0);
  assert.equal(forwardedPrincipal, "owner");
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
    headers: { "content-type": "application/json", "x-session-token": "s".repeat(43), "x-principal-id": "owner" },
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


test("authentication failure quota is isolated by Cloudflare client IP", async () => {
  const limiterKeys = [];
  const env = publicEnv({
    AGENT_RATE_LIMITER: { limit: async ({ key }) => { limiterKeys.push(key); return { success: true }; } }
  });
  for (const ip of ["203.0.113.10", "203.0.113.11", "2001:db8:abcd:12::1", "2001:db8:abcd:12::2"]) {
    const response = await worker.fetch(new Request("https://agent.example/api/sessions", {
      method: "POST",
      headers: { "cf-connecting-ip": ip }
    }), env);
    assert.equal(response.status, 401);
  }
  assert.deepEqual(limiterKeys, [
    "master-brain-cloud-agent-auth-failure:203.0.113.10",
    "master-brain-cloud-agent-auth-failure:203.0.113.11",
    "master-brain-cloud-agent-auth-failure:v6/64:2001:db8:abcd:12",
    "master-brain-cloud-agent-auth-failure:v6/64:2001:db8:abcd:12"
  ]);
});

test("authentication failure limiter rejects missing or malformed Cloudflare client identity", async () => {
  let limiterCalls = 0;
  const env = publicEnv({
    AGENT_RATE_LIMITER: { limit: async () => { limiterCalls += 1; return { success: true }; } }
  });
  for (const ip of [null, "not-an-ip", "203.0.113.999"]) {
    const headers = new Headers();
    if (ip !== null) headers.set("cf-connecting-ip", ip);
    const response = await worker.fetch(new Request("https://agent.example/api/sessions", {
      method: "POST",
      headers
    }), env);
    assert.equal(response.status, 503);
  }
  assert.equal(limiterCalls, 0);
});


test("Cloud Agent adds HSTS to HTTPS JSON and console responses but not HTTP", async () => {
  const httpsHealth = await worker.fetch(new Request("https://agent.example/healthz"), publicEnv());
  assert.equal(httpsHealth.status, 200);
  assert.equal(httpsHealth.headers.get("strict-transport-security"), "max-age=31536000");
  assert.equal(httpsHealth.headers.get("x-frame-options"), "DENY");

  const httpsConsole = await worker.fetch(new Request("https://agent.example/"), publicEnv());
  assert.equal(httpsConsole.status, 200);
  assert.equal(httpsConsole.headers.get("strict-transport-security"), "max-age=31536000");
  assert.match(httpsConsole.headers.get("content-security-policy"), /script-src 'nonce-/);

  const httpHealth = await worker.fetch(new Request("http://agent.example/healthz"), publicEnv());
  assert.equal(httpHealth.status, 200);
  assert.equal(httpHealth.headers.get("strict-transport-security"), null);
});
