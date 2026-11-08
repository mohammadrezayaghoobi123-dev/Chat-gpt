// Credential matrix for the Cloud MCP worker: MCP_AUTH_TOKEN / GITHUB_TOKEN each valid, absent, invalid.
// fetch() is replaced by a stub (declared mock): no real network call is made. The stub records calls so the
// tests can prove that nothing reaches api.github.com when credentials are missing.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import worker from "../worker.js";

const SECRET = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const GH = "ghp_FAKE_TOKEN_FOR_TEST_0123456789";
const post = (body, auth) => new Request("https://example.test/mcp", {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "cf-connecting-ip": "203.0.113.10", ...(auth ? { authorization: auth } : {}) },
  body: JSON.stringify(body),
});
const call = (name, args = {}, auth = "Bearer " + SECRET) =>
  post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, auth);

async function withFetch(impl, fn) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (...a) => { calls.push(a); return impl(...a); };
  try { await fn(calls); } finally { globalThis.fetch = original; }
}
const ghError = (status, message) => new Response(JSON.stringify({ message }), { status });

test("MCP_AUTH_TOKEN absent: 503 for any request body, never 400, no GitHub call", async () => {
  await withFetch(() => ghError(200, "x"), async (calls) => {
    for (const body of ["{}", "", "not json", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })]) {
      const r = await worker.fetch(new Request("https://example.test/mcp", { method: "POST", body }), {});
      assert.equal(r.status, 503, "body " + JSON.stringify(body));
    }
    const withBearer = await worker.fetch(call("project_inspect", { owner: "o", repo: "r" }, "Bearer anything"), {});
    assert.equal(withBearer.status, 503);
    assert.equal(calls.length, 0);
  });
});

test("MCP_AUTH_TOKEN invalid or missing bearer: 401, no GitHub call, secret not echoed", async () => {
  await withFetch(() => ghError(200, "x"), async (calls) => {
    for (const auth of [null, "Bearer wrong", "bearer " + SECRET, SECRET, "Bearer "]) {
      const r = await worker.fetch(call("project_inspect", { owner: "o", repo: "r" }, auth), { MCP_AUTH_TOKEN: SECRET, GITHUB_TOKEN: GH, MCP_RATE_LIMITER: { limit: async () => ({ success: true }) } });
      assert.equal(r.status, 401, String(auth));
      assert.ok(!(await r.text()).includes(SECRET));
    }
    assert.equal(calls.length, 0);
  });
});

// Contract note (recorded reason for changing this assertion): PR #15 (merged by the owner) deliberately allows
// unauthenticated GitHub GET requests for public read-only use, so "no GitHub call" no longer holds for reads.
// What must still hold: the request carries NO authorization header, and a refusal from GitHub (401/403/404) is
// reported as an explicit configuration hint naming GITHUB_READONLY_TOKEN instead of an unauthenticated request.
test("GITHUB_TOKEN absent: read uses the dedicated read-only credential", async () => {
  for (const status of [401, 403, 404]) {
    await withFetch(() => ghError(status, "Not Found"), async (calls) => {
      for (const tool of ["project_inspect", "read_project_file"]) {
        const args = tool === "read_project_file" ? { owner: "mohammadrezayaghoobi123-dev", repo: "Chat-gpt", path: "README.md" } : { owner: "mohammadrezayaghoobi123-dev", repo: "Chat-gpt" };
        const r = await worker.fetch(call(tool, args), { MCP_AUTH_TOKEN: SECRET, GITHUB_READONLY_TOKEN: "read-only-test-token", MCP_RATE_LIMITER: { limit: async () => ({ success: true }) } });
        const b = await r.json();
        assert.ok(b.result?.isError, JSON.stringify({status:r.status,body:b,tool,statusCode:status}));
        const text = b.result.content[0].text;
        assert.match(text, new RegExp("GitHub API " + status));
        assert.match(text, new RegExp("GitHub API " + status));
        assert.doesNotMatch(text, new RegExp(SECRET));
      }
      assert.ok(calls.length >= 1);
      for (const c of calls) assert.equal(c[1].headers.authorization, "Bearer read-only-test-token");
    });
  }
});

test("GITHUB_TOKEN absent: read-only credential still reports non-auth GitHub errors", async () => {
  await withFetch(() => ghError(500, "boom"), async () => {
    const r = await worker.fetch(call("project_inspect", { owner: "mohammadrezayaghoobi123-dev", repo: "Chat-gpt" }), { MCP_AUTH_TOKEN: SECRET, GITHUB_READONLY_TOKEN: "read-only-test-token", MCP_RATE_LIMITER: { limit: async () => ({ success: true }) } });
    const text = (await r.json()).result.content[0].text;
    assert.match(text, /GitHub API 500/);
    assert.doesNotMatch(text, /GITHUB_READONLY_TOKEN/);
  });
});

test("create_change_pr without GITHUB_TOKEN: fails before any GitHub call", async () => {
  await withFetch(() => ghError(200, "x"), async (calls) => {
    const r = await worker.fetch(call("create_change_pr", { owner: "o", repo: "r", title: "t", summary: "s", files: [{ path: "docs/a.md", content: "x" }] }), { MCP_AUTH_TOKEN: SECRET, MCP_RATE_LIMITER: { limit: async () => ({ success: true }) } });
    const b = await r.json();
    assert.equal(b.result.isError, true);
    assert.match(b.result.content[0].text, /GITHUB_TOKEN/);
    assert.equal(calls.length, 0);
  });
});

test("GITHUB_READONLY_TOKEN invalid: GitHub's 401 surfaces without leaking either token", async () => {
  await withFetch(() => ghError(401, "Bad credentials"), async (calls) => {
    const r = await worker.fetch(call("project_inspect", { owner: "mohammadrezayaghoobi123-dev", repo: "Chat-gpt" }), { MCP_AUTH_TOKEN: SECRET, GITHUB_TOKEN: "write-only-test-token", GITHUB_READONLY_TOKEN: GH, MCP_RATE_LIMITER: { limit: async () => ({ success: true }) } });
    const text = await r.text();
    const b = JSON.parse(text);
    assert.equal(b.result.isError, true);
    assert.match(b.result.content[0].text, /401/);
    assert.ok(!text.includes(GH) && !text.includes(SECRET));
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1].headers.authorization, "Bearer " + GH); // read-only credential sent only to GitHub
  });
});

test("both GitHub credentials valid: reads use the read-only bearer", async () => {
  await withFetch((url) => new Response(JSON.stringify(String(url).endsWith("/repos/mohammadrezayaghoobi123-dev/Chat-gpt")
    ? { full_name: "mohammadrezayaghoobi123-dev/Chat-gpt", private: false, default_branch: "feature/cloud-engineering-connector" } : { sha: "abc", commit: { message: "m", tree: { sha: "t" } }, tree: [] }), { status: 200 }), async (calls) => {
    const r = await worker.fetch(call("project_inspect", { owner: "mohammadrezayaghoobi123-dev", repo: "Chat-gpt" }), { MCP_AUTH_TOKEN: SECRET, GITHUB_TOKEN: "write-only-test-token", GITHUB_READONLY_TOKEN: "read-only-test-token", MCP_RATE_LIMITER: { limit: async () => ({ success: true }) } });
    const b = await r.json();
    assert.notEqual(b.result.isError, true);
    assert.ok(calls.length >= 1);
    for (const call of calls) assert.equal(call[1].headers.authorization, "Bearer read-only-test-token");
  });
});

test("healthz never returns secret values", async () => {
  const r = await worker.fetch(new Request("https://example.test/healthz"), { MCP_AUTH_TOKEN: SECRET, GITHUB_TOKEN: GH, MCP_RATE_LIMITER: { limit: async () => ({ success: true }) } });
  const text = await r.text();
  assert.ok(!text.includes(SECRET) && !text.includes(GH));
});


test("health endpoint never reveals credential configuration booleans", async () => {
  const response = await worker.fetch(new Request("https://example.test/healthz"), {
    MCP_AUTH_TOKEN: SECRET,
    GITHUB_TOKEN: GH
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(Object.hasOwn(body, "github_configured"), false);
  assert.equal(Object.hasOwn(body, "auth_configured"), false);
});

const readyzRequest = () => new Request("https://example.test/readyz", { headers: { "cf-connecting-ip": "203.0.113.20" } });
const okLimiter = { limit: async () => ({ success: true }) };

test("readyz reports not_ready when the Durable Object binding is absent", async () => {
  const response = await worker.fetch(readyzRequest(), { MCP_RATE_LIMITER: okLimiter });
  const body = await response.json();
  assert.equal(response.status, 503);
  assert.equal(body.status, "not_ready");
  assert.equal(body.durable_objects, "unavailable");
});

test("readyz uses a lightweight Durable Object ping rather than a full storage scan", async () => {
  const response = await worker.fetch(readyzRequest(), {
    MCP_RATE_LIMITER: okLimiter,
    WRITE_CONTROL: {
      idFromName: name => name,
      get: () => ({ ping: async () => ({ ok: true, schemaVersion: 1 }) })
    },
    KNOWLEDGE_STORE: {
      idFromName: name => name,
      get: () => ({ ping: async () => ({ ok: true, schemaVersion: 3 }) })
    },
    ORCHESTRATOR_LEDGER: {
      idFromName: name => name,
      get: () => ({ ping: async () => ({ ok: true, schemaVersion: 7 }) })
    },
    ORCHESTRATOR_OUTBOX_QUEUE: { send: async () => {} },
    ORCHESTRATOR_OUTBOX_QUEUE_NAME: "chat-gpt111-staging-orchestrator-outbox",
    ORCHESTRATOR_OUTBOX_DLQ_QUEUE: "chat-gpt111-staging-orchestrator-outbox-dlq",
    LEDGER_WORKER_ASSERTION_KEYS: JSON.stringify({ "worker-v1": randomBytes(32).toString("hex") }),
    LEDGER_WORKER_ASSERTION_ACTIVE_KID: "worker-v1",
    LEDGER_RECONCILIATION_EVIDENCE_KEYS: JSON.stringify({ "reconcile-v1": "3031323334353637383961626364656630313233343536373839616263646566" }),
    LEDGER_RECONCILIATION_EVIDENCE_ISSUERS: JSON.stringify(["test-reconciler"])
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.status, "ready");
  assert.equal(body.durable_objects, "ok");
  assert.equal(body.knowledge_store, "ok");
  assert.equal(body.orchestrator_ledger, "ok");
  assert.equal(body.orchestrator_outbox_publisher, "ok");
});

test("readyz is rate limited before it touches the shared write-control Durable Object (DEF-0012)", async () => {
  let pings = 0;
  const response = await worker.fetch(readyzRequest(), {
    MCP_RATE_LIMITER: { limit: async () => ({ success: false }) },
    WRITE_CONTROL: { idFromName: name => name, get: () => ({ ping: async () => { pings++; return { ok: true, schemaVersion: 1 }; } }) }
  });
  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), { error: "rate_limited" });
  assert.equal(pings, 0);
});

test("readyz fails closed without touching the Durable Object when the limiter is unavailable (DEF-0012)", async () => {
  let pings = 0;
  const response = await worker.fetch(readyzRequest(), {
    WRITE_CONTROL: { idFromName: name => name, get: () => ({ ping: async () => { pings++; return { ok: true, schemaVersion: 1 }; } }) }
  });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "rate_limiter_unavailable" });
  assert.equal(pings, 0);
});

test("short configured MCP token fails closed before rate limiting or request parsing", async () => {
  let limiterCalls = 0;
  const response = await worker.fetch(post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, "Bearer short"), {
    MCP_AUTH_TOKEN: "short",
    MCP_RATE_LIMITER: { limit: async () => { limiterCalls++; return { success: true }; } }
  });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: "server_misconfigured",
    message: "MCP_AUTH_TOKEN must be at least 32 characters."
  });
  assert.equal(limiterCalls, 0);
});
