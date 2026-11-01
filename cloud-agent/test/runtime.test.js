import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/worker.js";

const BASE = "https://agent-runtime.test";
const AUTH = "test-only-cloud-agent-token-0123456789abcdef0123456789";
const testEnv = {
  AGENT_AUTH_TOKEN: AUTH,
  AGENT_SESSIONS: env.AGENT_SESSIONS,
  AGENT_RATE_LIMITER: {
    limit: async () => ({ success: true })
  }
};

async function fetchWorker(path, init = {}) {
  return worker.fetch(new Request(BASE + path, init), testEnv);
}

async function createSession() {
  const response = await fetchWorker("/api/sessions", {
    method: "POST",
    headers: { authorization: "Bearer " + AUTH }
  });
  expect(response.status).toBe(201);
  const body = await response.json();
  expect(body.session_id).toMatch(/^[0-9a-f-]{36}$/i);
  expect(body.session_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  return body;
}

function sessionStub(sessionId) {
  return env.AGENT_SESSIONS.get(env.AGENT_SESSIONS.idFromName(sessionId));
}

describe("Cloudflare Workers runtime: session capability isolation", () => {
  it("creates a real Durable Object session and persists only a SHA-256 verifier", async () => {
    const session = await createSession();
    const stub = sessionStub(session.session_id);

    await runInDurableObject(stub, async (_instance, state) => {
      const verifier = await state.storage.get("session-token-hash");
      expect(verifier).toMatch(/^[0-9a-f]{64}$/);
      expect(verifier).not.toBe(session.session_token);
      expect(await state.storage.get("session_token")).toBeUndefined();
      expect(await state.storage.get("last-activity-at")).toEqual(expect.any(Number));
    });
  });

  it("rejects a missing capability at the Worker boundary", async () => {
    const session = await createSession();
    const response = await fetchWorker(
      "/api/sessions/" + session.session_id + "/history",
      { headers: { authorization: "Bearer " + AUTH } }
    );
    expect(response.status).toBe(401);
  });

  it("isolates two real Durable Object sessions from each other's capabilities", async () => {
    const first = await createSession();
    const second = await createSession();

    const crossSession = await fetchWorker(
      "/api/sessions/" + second.session_id + "/history",
      {
        headers: {
          authorization: "Bearer " + AUTH,
          "x-session-token": first.session_token
        }
      }
    );
    expect(crossSession.status).toBe(401);

    const ownSession = await fetchWorker(
      "/api/sessions/" + second.session_id + "/history",
      {
        headers: {
          authorization: "Bearer " + AUTH,
          "x-session-token": second.session_token
        }
      }
    );
    expect(ownSession.status).toBe(200);
    expect(await ownSession.json()).toEqual({ messages: [] });
  });

  it("returns persisted history only to the capability owner", async () => {
    const session = await createSession();
    const stub = sessionStub(session.session_id);
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put("history", [
        { role: "assistant", content: "runtime-persisted-history" }
      ]);
    });

    const denied = await fetchWorker(
      "/api/sessions/" + session.session_id + "/history",
      {
        headers: {
          authorization: "Bearer " + AUTH,
          "x-session-token": "z".repeat(43)
        }
      }
    );
    expect(denied.status).toBe(401);

    const allowed = await fetchWorker(
      "/api/sessions/" + session.session_id + "/history",
      {
        headers: {
          authorization: "Bearer " + AUTH,
          "x-session-token": session.session_token
        }
      }
    );
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({
      messages: [{ role: "assistant", content: "runtime-persisted-history" }]
    });
  });

  it("expires a real Durable Object session and removes its capability verifier", async () => {
    const session = await createSession();
    const stub = sessionStub(session.session_id);
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put("last-activity-at", Date.now() - 8 * 24 * 60 * 60 * 1000);
    });

    const response = await fetchWorker(
      "/api/sessions/" + session.session_id + "/history",
      {
        headers: {
          authorization: "Bearer " + AUTH,
          "x-session-token": session.session_token
        }
      }
    );
    expect(response.status).toBe(410);
    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.get("session-token-hash")).toBeUndefined();
      expect(await state.storage.get("history")).toBeUndefined();
    });
  });

  it("executes the Durable Object alarm cleanup in the Workers runtime", async () => {
    const session = await createSession();
    const stub = sessionStub(session.session_id);
    await runInDurableObject(stub, async (instance, state) => {
      await state.storage.put({
        history: [{ role: "user", content: "expired" }],
        "rate-window": [Date.now() - 8 * 24 * 60 * 60 * 1000],
        "last-activity-at": Date.now() - 8 * 24 * 60 * 60 * 1000
      });
      await instance.alarm();
      expect(await state.storage.get("session-token-hash")).toBeUndefined();
      expect(await state.storage.get("history")).toBeUndefined();
      expect(await state.storage.get("rate-window")).toBeUndefined();
    });
  });
});
