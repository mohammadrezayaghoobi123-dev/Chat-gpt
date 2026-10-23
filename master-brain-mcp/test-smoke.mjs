import { spawn } from "node:child_process";
import assert from "node:assert/strict";

const port = 3217;
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ["server.js"], {
  cwd: new URL(".", import.meta.url),
  env: { ...process.env, PORT: String(port), NODE_ENV: "test" },
  stdio: "ignore"
});

async function request(method, body, sessionId) {
  const headers = { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  return fetch(base + "/mcp", { method: "POST", headers, body: JSON.stringify(body) });
}

try {
  let ready = false;
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(base + "/healthz");
      if (r.ok) { ready = true; break; }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.equal(ready, true, "health endpoint did not become ready");

  const health = await (await fetch(base + "/healthz")).json();
  assert.equal(health.status, "ok");

  const initResponse = await request("POST", {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "smoke-test", version: "1.0.0" }
    }
  });
  assert.equal(initResponse.status, 200, "MCP initialize failed");
  const sessionId = initResponse.headers.get("mcp-session-id");
  assert.ok(sessionId, "missing MCP session ID");
  const init = await initResponse.json();
  assert.equal(init.result?.serverInfo?.name, "master-brain-mcp");

  const notification = await request("POST", { jsonrpc: "2.0", method: "notifications/initialized" }, sessionId);
  assert.ok(notification.ok, "initialized notification failed");

  const listResponse = await request("POST", { jsonrpc: "2.0", id: 2, method: "tools/list" }, sessionId);
  const list = await listResponse.json();
  assert.equal(listResponse.status, 200);
  const names = (list.result?.tools || []).map(tool => tool.name);
  for (const name of ["master_brain_status", "master_brain_architecture", "proof_audit_template"]) {
    assert.ok(names.includes(name), `missing tool: ${name}`);
  }

  const callResponse = await request("POST", {
    jsonrpc: "2.0", id: 3, method: "tools/call",
    params: { name: "master_brain_status", arguments: {} }
  }, sessionId);
  const call = await callResponse.json();
  assert.equal(callResponse.status, 200);
  assert.match(call.result?.content?.[0]?.text || "", /"mode": "read_only"/);

  console.log("Smoke test passed: health, MCP initialize, tool listing, and read-only tool call.");
} finally {
  child.kill("SIGTERM");
}
