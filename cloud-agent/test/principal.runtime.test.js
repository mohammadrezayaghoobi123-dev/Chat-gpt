import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/worker.js";

const BASE = "https://agent-principal.test";
const AUTH = "owner-token-for-runtime-tests-0123456789abcdef";
const USER_A_TOKEN = "A".repeat(43);
const USER_B_TOKEN = "B".repeat(43);

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

const USER_KEYS = JSON.stringify({
  "tester-a": await sha256Hex(USER_A_TOKEN),
  "tester-b": await sha256Hex(USER_B_TOKEN)
});

const testEnv = {
  AGENT_AUTH_TOKEN: AUTH,
  AGENT_USER_KEYS: USER_KEYS,
  AGENT_SESSIONS: env.AGENT_SESSIONS,
  AGENT_BUDGET: env.AGENT_BUDGET,
  AGENT_RATE_LIMITER: { limit: async () => ({ success: true }) }
};

async function fetchWorker(path, token = AUTH, envOverride = testEnv, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("authorization", "Bearer " + token);
  if (!headers.has("cf-connecting-ip")) headers.set("cf-connecting-ip", "203.0.113.10");
  return worker.fetch(new Request(BASE + path, { ...init, headers }), envOverride);
}

async function createSession(token = AUTH) {
  const response = await fetchWorker("/api/sessions", token, testEnv, { method: "POST" });
  expect(response.status).toBe(201);
  return response.json();
}

function sessionStub(sessionId) {
  return env.AGENT_SESSIONS.get(env.AGENT_SESSIONS.idFromName(sessionId));
}

describe("Cloudflare Workers runtime: principal identity and session ownership", () => {
  it("binds a new session to the authenticated principal", async () => {
    const session = await createSession(USER_A_TOKEN);
    await runInDurableObject(sessionStub(session.session_id), async (_instance, state) => {
      expect(await state.storage.get("principal-id")).toBe("tester-a");
    });
  });

  it("rejects another principal even when the session capability is known", async () => {
    const session = await createSession(USER_A_TOKEN);
    const response = await fetchWorker(
      "/api/sessions/" + session.session_id + "/history",
      USER_B_TOKEN,
      testEnv,
      { headers: { "x-session-token": session.session_token } }
    );
    expect(response.status).toBe(403);
  });

  it("does not allow the owner principal to impersonate a tester session", async () => {
    const session = await createSession(USER_A_TOKEN);
    const response = await fetchWorker(
      "/api/sessions/" + session.session_id + "/history",
      AUTH,
      testEnv,
      { headers: { "x-session-token": session.session_token } }
    );
    expect(response.status).toBe(403);
  });

  it("continues to support the owner credential as a distinct principal", async () => {
    const session = await createSession(AUTH);
    await runInDurableObject(sessionStub(session.session_id), async (_instance, state) => {
      expect(await state.storage.get("principal-id")).toBe("owner");
    });
  });

  it("fails closed when the user-key registry is malformed", async () => {
    const invalidEnv = { ...testEnv, AGENT_USER_KEYS: "{invalid-json" };
    const response = await fetchWorker("/api/sessions", USER_A_TOKEN, invalidEnv, { method: "POST" });
    expect(response.status).toBe(503);
  });

  it("rejects unknown user tokens", async () => {
    const response = await fetchWorker("/api/sessions", "X".repeat(43), testEnv, { method: "POST" });
    expect(response.status).toBe(401);
  });

  it("revokes a user's access immediately when its hash is removed from the registry", async () => {
    const session = await createSession(USER_A_TOKEN);
    const revokedEnv = { ...testEnv, AGENT_USER_KEYS: JSON.stringify({ "tester-b": await sha256Hex(USER_B_TOKEN) }) };
    const response = await fetchWorker(
      "/api/sessions/" + session.session_id + "/history",
      USER_A_TOKEN,
      revokedEnv,
      { headers: { "x-session-token": session.session_token } }
    );
    expect(response.status).toBe(401);
  });
});
