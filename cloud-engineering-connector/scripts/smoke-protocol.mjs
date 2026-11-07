#!/usr/bin/env node
/**
 * Local protocol smoke against the committed worker module.
 * Not a live Cloudflare or ChatGPT/Claude interop test.
 *
 * Usage (from cloud-engineering-connector/):
 *   node scripts/smoke-protocol.mjs
 */
import worker from "../worker.js";

const env = { MCP_AUTH_TOKEN: "smoke-token" };
const req = (path, options = {}) => new Request("https://smoke.test" + path, options);
const rpc = (method, params = {}, id = 1) =>
  req("/mcp", {
    method: "POST",
    headers: {
      authorization: "Bearer smoke-token",
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });

const results = [];

async function step(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log("PASS", name);
  } catch (e) {
    results.push({ name, ok: false, error: String(e?.message || e) });
    console.log("FAIL", name, e?.message || e);
  }
}

await step("healthz", async () => {
  const r = await worker.fetch(req("/healthz"), {});
  if (r.status !== 200) throw new Error("status " + r.status);
  const b = await r.json();
  if (b.status !== "ok") throw new Error(JSON.stringify(b));
  if (b.execution !== "cloudflare-workers") throw new Error("execution");
  if (b.laptop_dependency !== false) throw new Error("laptop_dependency");
});

await step("initialize", async () => {
  const r = await worker.fetch(
    rpc("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "smoke", version: "1" },
    }),
    env
  );
  const b = await r.json();
  if (b.result?.serverInfo?.name !== "cloud-engineering-connector") {
    throw new Error(JSON.stringify(b));
  }
  if (b.result?.serverInfo?.version !== "0.2.0") {
    throw new Error("version " + b.result?.serverInfo?.version);
  }
});

await step("tools/list", async () => {
  const r = await worker.fetch(rpc("tools/list"), env);
  const b = await r.json();
  const names = b.result.tools.map((t) => t.name);
  const expected = [
    "project_inspect",
    "read_project_file",
    "engineering_standards",
    "architecture_review",
    "create_change_pr",
  ];
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    throw new Error(JSON.stringify(names));
  }
});

await step("allowlist_deny_foreign_repo", async () => {
  const r = await worker.fetch(
    rpc("tools/call", {
      name: "project_inspect",
      arguments: { owner: "octocat", repo: "hello-world" },
    }),
    env
  );
  const b = await r.json();
  if (!b.result?.isError) throw new Error("expected isError");
  if (!/allowlist/i.test(b.result.content[0].text)) {
    throw new Error(b.result.content[0].text);
  }
});

await step("auth_fail_closed", async () => {
  const r = await worker.fetch(req("/mcp", { method: "POST", body: "{}" }), {});
  if (r.status !== 503) throw new Error("status " + r.status);
});

await step("create_change_pr_no_token_fails_closed", async () => {
  const r = await worker.fetch(
    rpc("tools/call", {
      name: "create_change_pr",
      arguments: {
        owner: "mohammadrezayaghoobi123-dev",
        repo: "Chat-gpt",
        base_branch: "feature/cloud-engineering-connector",
        title: "Smoke",
        summary: "Should fail without GITHUB_TOKEN",
        files: [{ path: "README.md", content: "x" }],
      },
    }),
    env
  );
  const b = await r.json();
  if (!b.result?.isError) throw new Error("expected isError");
  if (!/GITHUB_TOKEN/i.test(b.result.content[0].text)) {
    throw new Error(b.result.content[0].text);
  }
});

const failed = results.filter((r) => !r.ok);
console.log(
  JSON.stringify(
    {
      total: results.length,
      passed: results.length - failed.length,
      failed: failed.length,
      note: "Local module smoke only — not live Worker or MCP client interop",
    },
    null,
    2
  )
);
if (failed.length) process.exit(1);
