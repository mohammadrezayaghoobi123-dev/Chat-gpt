import test from "node:test";
import assert from "node:assert/strict";
import { validateReconciliationEvidenceConfig } from "../orchestrator-reconciliation-evidence.js";

const validKeys = JSON.stringify({
  "reconcile-v1": "3031323334353637383961626364656630313233343536373839616263646566",
});
const validIssuers = JSON.stringify(["test-reconciler"]);

test("reconciliation readiness accepts a valid independent keyset and issuer allowlist", () => {
  assert.equal(validateReconciliationEvidenceConfig(validKeys, validIssuers), true);
});

test("reconciliation readiness fails closed when its keyset is missing or malformed", () => {
  assert.equal(validateReconciliationEvidenceConfig(undefined, validIssuers), false);
  assert.equal(validateReconciliationEvidenceConfig(JSON.stringify({ "bad key": "x" }), validIssuers), false);
  assert.equal(validateReconciliationEvidenceConfig("not-json", validIssuers), false);
});

test("reconciliation readiness fails closed when the issuer allowlist is missing or malformed", () => {
  assert.equal(validateReconciliationEvidenceConfig(validKeys, undefined), false);
  assert.equal(validateReconciliationEvidenceConfig(validKeys, JSON.stringify([])), false);
  assert.equal(validateReconciliationEvidenceConfig(validKeys, JSON.stringify(["*"])), false);
});
