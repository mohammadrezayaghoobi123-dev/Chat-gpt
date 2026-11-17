import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const wrangler = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
const testWrangler = readFileSync(new URL("../wrangler.test.toml", import.meta.url), "utf8");
const vitestConfig = readFileSync(new URL("../vitest.config.js", import.meta.url), "utf8");
const writeControlVitestConfig = readFileSync(new URL("../vitest.write-control.config.js", import.meta.url), "utf8");

test("Worker DO lifecycle uses exports and never mixes legacy migrations", () => {
  assert.doesNotMatch(wrangler, /^\s*\[\[?(?:env\.staging\.)?migrations\]\]?\s*$/m);
  for (const className of ["KnowledgeStore", "OrchestratorLedger", "TenantDirectory"]) {
    assert.match(wrangler, new RegExp("\\[exports\\." + className + "\\]"));
    assert.match(wrangler, new RegExp("\\[env\\.staging\\.exports\\." + className + "\\]"));
  }
});

test("legacy Staging WriteControl remains a live SQLite class and binding", () => {
  assert.match(wrangler, /name = "WRITE_CONTROL"\s*\nclass_name = "WriteControl"/);
  assert.match(wrangler, /\[env\.staging\.exports\.WriteControl\]\s*\ntype = "durable-object"\s*\nstorage = "sqlite"/);
  assert.doesNotMatch(wrangler, /\[exports\.WriteControl\]/);
});

test("Production and Staging retain distinct OAuth KV and rate-limit resource IDs", () => {
  const prodKv = wrangler.match(/\[\[kv_namespaces\]\]\s*\nbinding = "OAUTH_KV"\s*\nid = "([^"]+)"/)?.[1];
  const stagingKv = wrangler.match(/\[\[env\.staging\.kv_namespaces\]\]\s*\nbinding = "OAUTH_KV"\s*\nid = "([^"]+)"/)?.[1];
  const prodRate = wrangler.match(/\[\[ratelimits\]\]\s*\nname = "MCP_RATE_LIMITER"\s*\nnamespace_id = "([^"]+)"/)?.[1];
  const stagingRate = wrangler.match(/\[\[env\.staging\.ratelimits\]\]\s*\nname = "MCP_RATE_LIMITER"\s*\nnamespace_id = "([^"]+)"/)?.[1];
  assert.ok(prodKv && stagingKv && prodRate && stagingRate);
  assert.notEqual(prodKv, stagingKv);
  assert.notEqual(prodRate, stagingRate);
});

test("WriteControl test harness is isolated from deploy environment config", () => {
  assert.match(testWrangler, /^name = "cloud-engineering-connector-test"$/m);
  assert.match(testWrangler, /\[exports\.WriteControl\]/);
  assert.match(testWrangler, /name = "WRITE_CONTROL"\s*\nclass_name = "WriteControl"/);
  assert.doesNotMatch(testWrangler, /^\s*\[\[?(?:env\.staging\.)?migrations\]\]?\s*$/m);
  assert.doesNotMatch(testWrangler, /OAUTH_KV|MCP_RATE_LIMITER/);
});

test("WriteControl suites run only under the isolated test config", () => {
  assert.match(vitestConfig, /exclude:\s*\["cloudflare-test\/write-control\*\.test\.js"\]/);
  assert.match(writeControlVitestConfig, /configPath:\s*"\.\/wrangler\.test\.toml"/);
  assert.match(writeControlVitestConfig, /include:\s*\["cloudflare-test\/write-control\*\.test\.js"\]/);
});

test("Production and Staging preserve active observability and log-retention settings", () => {
  for (const prefix of ["", "env.staging."]) {
    assert.match(wrangler, new RegExp("\\[" + prefix.replaceAll(".", "\\\\.") + "observability\\]"));
    assert.match(wrangler, new RegExp("\\[" + prefix.replaceAll(".", "\\\\.") + "observability\\.logs\\]"));
    assert.match(wrangler, new RegExp("\\[" + prefix.replaceAll(".", "\\\\.") + "observability\\.traces\\]"));
  }
  assert.match(wrangler, /enabled = true[\s\S]*?redact_query_string = true[\s\S]*?invocation_logs = false[\s\S]*?persist = true/);
});
