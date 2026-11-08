import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const { default: worker } = await import("./helpers/load-worker.js");
const config = await import("../src/config.js");
const workerSource = await readFile(new URL("../src/worker.js", import.meta.url), "utf8");
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

const SECRET = "x".repeat(48);
const bindings = (overrides = {}) => ({
  AGENT_AUTH_TOKEN: SECRET,
  AI: { run: async () => ({}) },
  AGENT_SESSIONS: { idFromName: n => n, get: () => ({ fetch: async () => Response.json({}) }) },
  AGENT_BUDGET: { idFromName: n => n, get: () => ({ fetch: async () => Response.json({}) }) },
  AGENT_RATE_LIMITER: { limit: async () => ({ success: true }) },
  ...overrides
});
const health = async env => {
  const response = await worker.fetch(new Request("https://agent.example/healthz"), env);
  return { response, body: await response.json() };
};

const MOVED_CONSTANTS = [
  "VERSION", "MODEL", "OWNER", "REPO", "SYSTEM_PROMPT", "TOOL_DEFINITIONS", "SECURITY_HEADERS",
  "INPUT_NEURONS_PER_MILLION", "OUTPUT_NEURONS_PER_MILLION", "MAX_COMPLETION_TOKENS"
];

test("worker.js imports shared constants from config.js instead of redefining them", () => {
  assert.match(workerSource, /from "\.\/config\.js"/);
  for (const name of MOVED_CONSTANTS) {
    assert.equal(new RegExp("^(?:export )?(?:const|let|var) " + name + "\\b", "m").test(workerSource), false, name + " must not be redefined in worker.js");
  }
});

test("worker.js does not hard-code the version, user-agent version, or default ref", () => {
  assert.equal(workerSource.includes('"0.1.0"'), false);
  assert.equal(/master-brain-cloud-agent\/\d/.test(workerSource), false);
  assert.equal(workerSource.includes('"master-brain/integrated"'), false);
  assert.match(workerSource, /DEFAULT_REF/);
});

test("package.json version and the budget cap cannot drift from config.js", async () => {
  assert.equal(packageJson.version, config.VERSION);
  const budget = await import("../src/budget.js");
  assert.equal(budget.DAILY_NEURON_BUDGET, config.DAILY_NEURON_BUDGET);
});

test("/healthz reports the config version, model, repository and read-only mode", async () => {
  const { response, body } = await health(bindings());
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.service, "master-brain-cloud-agent");
  assert.equal(body.version, config.VERSION);
  assert.equal(body.model, config.MODEL);
  assert.equal(body.repository, config.REPO_FULL);
  assert.equal(body.mode, "read-only");
});

test("/healthz reports binding presence as booleans and ready=true only when all are bound", async () => {
  const full = await health(bindings());
  assert.deepEqual(full.body.bindings, { ai: true, sessions: true, budget: true, rate_limiter: true });
  assert.equal(full.body.ready, true);
  for (const [binding, key] of [["AI", "ai"], ["AGENT_SESSIONS", "sessions"], ["AGENT_BUDGET", "budget"], ["AGENT_RATE_LIMITER", "rate_limiter"]]) {
    const { response, body } = await health(bindings({ [binding]: undefined }));
    assert.equal(response.status, 200, "liveness stays 200 when " + binding + " is missing");
    assert.equal(body.bindings[key], false, key);
    assert.equal(body.ready, false, "ready must be false without " + binding);
  }
});

test("/healthz never exposes secret values or secret-presence flags", async () => {
  const { body } = await health(bindings({ AGENT_USER_KEYS: JSON.stringify({ alice: "a".repeat(64) }) }));
  const text = JSON.stringify(body);
  assert.equal(text.includes(SECRET), false);
  assert.equal(text.includes("a".repeat(64)), false);
  assert.equal(/token|secret|auth|keys?\b/i.test(Object.keys(body.bindings).join(" ")), false);
  assert.equal(/token|secret|auth/i.test(Object.keys(body).join(" ")), false);
});
