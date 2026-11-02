import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const smoke = readFileSync(new URL("./production-smoke.mjs", import.meta.url), "utf8");
const releaseWorkflow = readFileSync(new URL("../../.github/workflows/connector-production-release.yml", import.meta.url), "utf8");

test("Production smoke passes the Production URL and release identity to the shared acceptance suite", () => {
  assert.match(smoke, /process\.env\.STAGING_MCP_URL\s*=\s*base/);
  assert.match(smoke, /process\.env\.RELEASE_ENV\s*=\s*"production"/);
  assert.doesNotMatch(smoke, /process\.env\.MCP_BASE_URL\s*=/);
});

test("Production release preflight requires a verifiable PUBLIC_READ_ONLY=true flag", () => {
  assert.match(releaseWorkflow, /assert\.equal\(publicReadOnly\?\.type,\s*"plain_text"/);
  assert.match(releaseWorkflow, /assert\.equal\(publicReadOnly\.text,\s*"true"/);
});
