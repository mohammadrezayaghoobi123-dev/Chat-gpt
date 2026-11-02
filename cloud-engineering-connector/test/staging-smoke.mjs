import assert from "node:assert/strict";

const base = process.env.STAGING_MCP_URL;
assert.ok(base?.startsWith("https://"), "STAGING_MCP_URL must use HTTPS");
const origin = new URL(base).origin;
const timeout = () => ({ signal: AbortSignal.timeout(30_000) });

const health = await fetch(new URL("/healthz", base), timeout());
assert.equal(health.status, 200, "GET /healthz must return HTTP 200");
const healthBody = await health.json();
assert.equal(healthBody.status, "ok");
assert.equal(healthBody.service, "cloud-engineering-connector");
assert.equal(healthBody.execution, "cloudflare-workers");
assert.equal(healthBody.laptop_dependency, false);
assert.equal(healthBody.durable_objects, "ok", "healthz must execute a live SQLite Durable Object probe");
assert.equal(healthBody.mcp, "ok", "healthz must execute an authenticated MCP tools/list self-check");
console.log("PASS: health and security headers");
for (const [header, expected] of [
  ["x-content-type-options", "nosniff"],
  ["x-frame-options", "DENY"],
  ["referrer-policy", "no-referrer"],
  ["cache-control", "no-store"],
]) assert.equal(health.headers.get(header), expected, `security header ${header}`);

const consoleResponse = await fetch(new URL("/", base), timeout());
assert.equal(consoleResponse.status, 200, "GET / must serve the read-only console");
assert.match(consoleResponse.headers.get("content-security-policy") ?? "", /script-src 'nonce-/);
assert.equal(consoleResponse.headers.get("cache-control"), "no-store");
const html = await consoleResponse.text();
assert.match(html, /MCP Console/);
assert.match(html, /architecture_analyze/);
assert.doesNotMatch(html, /MCP_AUTH_TOKEN|GITHUB_TOKEN|auth_configured|github_configured|localStorage|sessionStorage/);
console.log("PASS: root console and CSP");

const getMcp = await fetch(new URL("/mcp", base), timeout());
assert.equal(getMcp.status, 405, "GET /mcp must be rejected");
assert.match(getMcp.headers.get("allow") ?? "", /POST/);

const preflight = await fetch(new URL("/mcp", base), {
  method: "OPTIONS",
  headers: {
    origin,
    "access-control-request-method": "POST",
    "access-control-request-headers": "content-type,accept",
  },
  ...timeout(),
});
assert.equal(preflight.status, 204, "same-origin preflight must succeed");
assert.equal(preflight.headers.get("access-control-allow-origin"), origin);
console.log("PASS: same-origin CORS preflight");

const crossOrigin = await fetch(new URL("/mcp", base), {
  method: "POST",
  headers: {
    origin: "https://attacker.example",
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  },
  body: JSON.stringify({ jsonrpc: "2.0", id: 99000, method: "tools/list", params: {} }),
  ...timeout(),
});
assert.equal(crossOrigin.status, 403, "unlisted cross-origin requests must be rejected");
console.log("PASS: cross-origin denial");

async function rpc(method, params = {}, id = 99001, token = null, extraHeaders = {}) {
  const headers = {
    origin,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...extraHeaders,
  };
  if (token !== null) headers.authorization = "Bearer " + token;
  const message = { jsonrpc: "2.0", method, params };
  if (id !== null) message.id = id;
  const response = await fetch(new URL("/mcp", base), {
    method: "POST",
    headers,
    body: JSON.stringify(message),
    ...timeout(),
  });
  const body = response.status === 202 ? null : await response.json();
  return { response, body };
}

const initialized = await rpc("initialize", {
  protocolVersion: "2025-11-25",
  capabilities: {},
  clientInfo: { name: "staging-acceptance", version: "1.0.0" },
}, 99001);
assert.equal(initialized.response.status, 200);
assert.equal(initialized.body.result.protocolVersion, "2025-11-25");
console.log("PASS: MCP initialize");

// Claude compatibility probe: MCP legacy protocol 2025-06-18.
const claudeInitialized = await rpc("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "claude-compatibility-probe", version: "1.0.0" },
}, 99008);
assert.equal(claudeInitialized.response.status, 200);
assert.equal(claudeInitialized.body.result.protocolVersion, "2025-06-18");
const claudeListed = await rpc("tools/list", {}, 99009, null, {
  "MCP-Protocol-Version": "2025-06-18",
});
assert.equal(claudeListed.response.status, 200);
assert.ok(claudeListed.body.result.tools.some((tool) => tool.name === "architecture_analyze"));
console.log("PASS: Claude MCP 2025-06-18 initialize and tools/list");

const notificationResponse = await fetch(new URL("/mcp", base), {
  method: "POST",
  headers: {
    origin,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": "2025-11-25",
  },
  body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }),
  ...timeout(),
});
assert.equal(notificationResponse.status, 202, "a true JSON-RPC notification without an id must be acknowledged with HTTP 202");
assert.equal(await notificationResponse.text(), "");
console.log("PASS: MCP initialized notification");

const listed = await rpc("tools/list", {}, 99002);
assert.equal(listed.response.status, 200, "PUBLIC_READ_ONLY must allow unauthenticated read-only discovery");
const toolNames = listed.body.result.tools.map((tool) => tool.name);
assert.deepEqual(toolNames, [
  "project_inspect",
  "read_project_file",
  "engineering_standards",
  "architecture_review",
  "architecture_analyze",
]);
assert.ok(!toolNames.includes("create_change_pr"), "write tool must never be advertised anonymously");
console.log("PASS: anonymous read-only tool discovery");

const inspected = await rpc("tools/call", {
  name: "project_inspect",
  arguments: {
    owner: "mohammadrezayaghoobi123-dev",
    repo: "Chat-gpt",
    branch: "integration/security-hardening-stack",
  },
}, 99003);
assert.equal(inspected.response.status, 200);
assert.equal(inspected.body.result.isError, undefined, inspected.body.result.content?.[0]?.text || JSON.stringify(inspected.body));
const project = JSON.parse(inspected.body.result.content[0].text);
assert.equal(project.repository, "mohammadrezayaghoobi123-dev/Chat-gpt");
assert.equal(project.visibility, "public");
console.log("PASS: live GitHub project_inspect");

const fileRead = await rpc("tools/call", {
  name: "read_project_file",
  arguments: {
    owner: "mohammadrezayaghoobi123-dev",
    repo: "Chat-gpt",
    path: "cloud-engineering-connector/README.md",
    ref: "integration/security-hardening-stack",
  },
}, 99004);
assert.equal(fileRead.response.status, 200);
assert.equal(fileRead.body.result.isError, undefined, fileRead.body.result.content?.[0]?.text || JSON.stringify(fileRead.body));
const file = JSON.parse(fileRead.body.result.content[0].text);
assert.equal(file.path, "cloud-engineering-connector/README.md");
assert.ok(file.content.length > 0);
console.log("PASS: live GitHub read_project_file");

const analysis = await rpc("tools/call", {
  name: "architecture_analyze",
  arguments: {
    owner: "mohammadrezayaghoobi123-dev",
    repo: "Chat-gpt",
    ref: "integration/security-hardening-stack",
    paths: ["cloud-engineering-connector/README.md"],
  },
}, 99005);
assert.equal(analysis.response.status, 200);
assert.equal(analysis.body.result.isError, undefined, analysis.body.result.content?.[0]?.text || JSON.stringify(analysis.body));
const report = JSON.parse(analysis.body.result.content[0].text);
assert.equal(report.status, "analysis_completed");
assert.equal(report.evidence[0].path, "cloud-engineering-connector/README.md");
console.log("PASS: live architecture_analyze");

const writeDenied = await rpc("tools/call", { name: "create_change_pr", arguments: {} }, 99006);
assert.equal(writeDenied.response.status, 200);
assert.equal(writeDenied.body.result.isError, true);
assert.match(writeDenied.body.result.content[0].text, /PUBLIC_READ_ONLY allowlist/);
console.log("PASS: anonymous write denied");

const invalidBearer = await rpc("tools/list", {}, 99007, "deliberately-invalid-post-deploy-probe");
assert.equal(invalidBearer.response.status, 401, "a supplied invalid bearer token must still be rejected");
assert.equal(invalidBearer.response.headers.get("www-authenticate"), "Bearer");
assert.equal(invalidBearer.body.error, "unauthorized");
console.log("PASS: invalid bearer denied");

console.log(JSON.stringify({
  result: "PASS",
  staging: new URL(base).host,
  checks: [
    "healthz, SQLite Durable Object probe, and authenticated MCP registry self-check",
    "root console, nonce CSP, no-store, and no credential/config disclosure",
    "same-origin CORS accepted; unlisted cross-origin rejected",
    "MCP initialize 2025-11-25 and initialized notification",
    "Claude-compatible MCP 2025-06-18 initialize and tools/list",
    "anonymous tools/list exposes exactly five read-only tools",
    "live public GitHub project_inspect and read_project_file",
    "live architecture_analyze against a repository file",
    "anonymous create_change_pr denied by PUBLIC_READ_ONLY allowlist",
    "invalid bearer token rejected with HTTP 401",
  ],
  credentialMaterialLogged: false,
}, null, 2));
