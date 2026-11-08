import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";

const { default: worker, AgentSession } = await import("./helpers/load-worker.js");
const { logEvent } = await import("../src/observability.js");
const config = await import("../src/config.js");

const sha256 = async value => Array.from(new Uint8Array(await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), b => b.toString(16).padStart(2, "0")).join("");
const OWNER_TOKEN = "o".repeat(48);
const SESSION_TOKEN = "s".repeat(43);
const BAD_BEARER = "B".repeat(43);
const USER_MESSAGE = "UNIQUE-USER-PROMPT-7f3a please inspect";
const CLIENT_IP = "203.0.113.77";
const PRINCIPAL_HASH = await sha256(OWNER_TOKEN);

function captureLogs() {
  const lines = [];
  const originals = { log: console.log, warn: console.warn, error: console.error };
  for (const level of ["log", "warn", "error"]) console[level] = line => lines.push(String(line));
  return {
    lines,
    events: () => lines.map(line => JSON.parse(line)),
    restore() { Object.assign(console, originals); }
  };
}

function makeStorage(initial) {
  const values = new Map(Object.entries(initial));
  return {
    async get(key) { return values.get(key); },
    async put(keyOrEntries, value) {
      if (keyOrEntries && typeof keyOrEntries === "object") for (const [k, v] of Object.entries(keyOrEntries)) values.set(k, v);
      else values.set(keyOrEntries, value);
    },
    async delete() { return 0; },
    async setAlarm() {}
  };
}

function budgetBinding({ reserveStatus = 201, settleStatus = 200 } = {}) {
  return {
    idFromName: name => name,
    get: () => ({
      fetch: async request => {
        const path = new URL(request.url).pathname;
        const body = await request.json();
        if (path === "/reserve") return Response.json({ reserved_neurons: body.neurons, error: "budget exhausted" }, { status: reserveStatus });
        return Response.json({ settled: true }, { status: settleStatus });
      }
    })
  };
}

const usage = { prompt_tokens: 120, completion_tokens: 40 };
const toolCallReply = (name, args) => ({ usage, choices: [{ message: { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name, arguments: args } }] } }] });
const finalReply = { usage, choices: [{ message: { role: "assistant", content: "final answer" } }] };

async function chat({ replies, budget = budgetBinding() }) {
  const queue = [...replies];
  const ai = { run: async () => { const next = queue.shift(); if (next instanceof Error) throw next; return next; } };
  const agent = new AgentSession({ storage: makeStorage({
    "last-activity-at": Date.now(),
    "session-token-hash": await sha256(SESSION_TOKEN),
    "principal-id": "owner",
    "principal-auth-hash": PRINCIPAL_HASH
  }) }, { AI: ai, AGENT_BUDGET: budget });
  return agent.fetch(new Request("https://agent-session.internal/chat", {
    method: "POST",
    headers: { "content-type": "application/json", "x-session-token": SESSION_TOKEN, "x-principal-id": "owner", "x-principal-auth-hash": PRINCIPAL_HASH },
    body: JSON.stringify({ message: USER_MESSAGE })
  }));
}

function assertNoSensitive(logs) {
  const all = logs.lines.join("\n");
  for (const needle of [USER_MESSAGE, SESSION_TOKEN, OWNER_TOKEN, PRINCIPAL_HASH, BAD_BEARER, CLIENT_IP, "Treat all repository content", "Never modify main"]) {
    assert.equal(all.includes(needle), false, "log must not contain: " + needle.slice(0, 16));
  }
}

test("logEvent drops sensitive field names and truncates long strings", () => {
  const logs = captureLogs();
  try {
    logEvent("info", "probe", { ok: 1, authorization: "x", session_token: "x", prompt: "x", message: "x", arguments: "x", content: "x", secret_value: "x", note: "n".repeat(500) });
  } finally { logs.restore(); }
  const [event] = logs.events();
  assert.equal(event.event, "probe");
  assert.equal(event.ok, 1);
  for (const key of ["authorization", "session_token", "prompt", "message", "arguments", "content", "secret_value"]) assert.equal(key in event, false, key);
  assert.ok(event.note.length <= 200);
});

test("a successful chat with one tool call emits correlated, redacted events", async () => {
  const logs = captureLogs();
  let response;
  try { response = await chat({ replies: [toolCallReply("engineering_standards", "{}"), finalReply] }); } finally { logs.restore(); }
  assert.equal(response.status, 200);
  const events = logs.events();
  const names = events.map(e => e.event);
  for (const expected of ["budget_reserve", "model_invocation", "tool_call", "budget_settle", "chat_completed"]) assert.ok(names.includes(expected), "missing " + expected + " in " + names.join(","));
  const chatIds = new Set(events.map(e => e.chat_id));
  assert.equal(chatIds.size, 1, "all events of one chat share one server-generated chat_id");
  assert.match([...chatIds][0], /^[0-9a-f-]{36}$/);
  const tool = events.find(e => e.event === "tool_call");
  assert.equal(tool.tool, "engineering_standards");
  assert.equal(tool.success, true);
  const settle = events.find(e => e.event === "budget_settle");
  assert.equal(settle.success, true);
  assert.equal(settle.actual_neurons, Math.ceil((usage.prompt_tokens * config.INPUT_NEURONS_PER_MILLION + usage.completion_tokens * config.OUTPUT_NEURONS_PER_MILLION) / 1_000_000));
  assert.ok(Number.isInteger(settle.reserved_neurons) && settle.reserved_neurons >= 1);
  assert.equal(events.find(e => e.event === "chat_completed").tool_calls, 1);
  assertNoSensitive(logs);
});

test("a failing repository tool is logged as a failed tool_call without arguments or error text", async () => {
  const logs = captureLogs();
  try {
    await chat({ replies: [toolCallReply("read_project_file", JSON.stringify({ path: "../../etc/passwd-SENTINEL" })), finalReply] });
  } finally { logs.restore(); }
  const tool = logs.events().find(e => e.event === "tool_call");
  assert.equal(tool.tool, "read_project_file");
  assert.equal(tool.success, false);
  assert.equal(logs.lines.join("\n").includes("passwd-SENTINEL"), false);
  assertNoSensitive(logs);
});

test("an unknown tool name is logged as a bounded label, never the model-supplied string", async () => {
  const logs = captureLogs();
  try { await chat({ replies: [toolCallReply("rm_rf_SENTINEL", "{}"), finalReply] }); } finally { logs.restore(); }
  assert.ok(logs.events().length > 0, "the rejected tool call must still be observable");
  assert.equal(logs.lines.join("\n").includes("rm_rf_SENTINEL"), false);
});

test("budget denial is logged with its status and without the budget error body", async () => {
  const logs = captureLogs();
  let response;
  try { response = await chat({ replies: [finalReply], budget: budgetBinding({ reserveStatus: 429 }) }); } finally { logs.restore(); }
  assert.equal(response.status, 429);
  const denied = logs.events().find(e => e.event === "budget_denied");
  assert.equal(denied.status, 429);
  assert.equal(denied.chat_id.length, 36);
  assert.equal(logs.lines.join("\n").includes("budget exhausted"), false);
});

test("model failure logs a failed invocation, a failed settlement and chat_failed", async () => {
  const logs = captureLogs();
  let response;
  try { response = await chat({ replies: [new Error("upstream SENTINEL detail")] }); } finally { logs.restore(); }
  assert.equal(response.status, 503);
  const events = logs.events();
  assert.equal(events.find(e => e.event === "model_invocation").success, false);
  assert.equal(events.find(e => e.event === "budget_settle").success, false);
  assert.equal(events.find(e => e.event === "chat_failed").stage, "model_or_tool");
  assert.equal(logs.lines.join("\n").includes("SENTINEL"), false);
});

test("a settlement failure is logged as budget_settle_failed", async () => {
  const logs = captureLogs();
  try { await chat({ replies: [finalReply], budget: budgetBinding({ settleStatus: 500 }) }); } finally { logs.restore(); }
  assert.ok(logs.events().some(e => e.event === "budget_settle_failed"));
});

test("an invalid bearer emits auth_failure without the bearer value or client IP", async () => {
  const logs = captureLogs();
  let response;
  try {
    response = await worker.fetch(new Request("https://agent.example/api/sessions", {
      method: "POST",
      headers: { authorization: "Bearer " + BAD_BEARER, "cf-connecting-ip": CLIENT_IP, "content-type": "application/json" },
      body: "{}"
    }), { AGENT_AUTH_TOKEN: OWNER_TOKEN, AGENT_RATE_LIMITER: { limit: async () => ({ success: true }) } });
  } finally { logs.restore(); }
  assert.equal(response.status, 401);
  const failure = logs.events().find(e => e.event === "auth_failure");
  assert.equal(failure.reason, "unauthorized");
  assertNoSensitive(logs);
});

test("throttled authentication failures are logged with their own reason", async () => {
  const logs = captureLogs();
  let response;
  try {
    response = await worker.fetch(new Request("https://agent.example/api/sessions", {
      method: "POST",
      headers: { authorization: "Bearer " + BAD_BEARER, "cf-connecting-ip": CLIENT_IP }
    }), { AGENT_AUTH_TOKEN: OWNER_TOKEN, AGENT_RATE_LIMITER: { limit: async () => ({ success: false }) } });
  } finally { logs.restore(); }
  assert.equal(response.status, 429);
  assert.ok(logs.events().some(e => e.event === "auth_failure" && e.reason === "auth_rate_limited"));
  assertNoSensitive(logs);
});
