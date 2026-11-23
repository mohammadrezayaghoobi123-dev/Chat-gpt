import test from "node:test";
import assert from "node:assert/strict";

const encoder = new TextEncoder();
const nowMs = 1_800_000_000_000;
const kid = "executor-ed25519-v1";

function encodeBase64Url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

async function fixture() {
  const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const privateKey = encodeBase64Url(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const publicKey = encodeBase64Url(await crypto.subtle.exportKey("raw", pair.publicKey));
  const publicKeySet = JSON.stringify({
    [kid]: {
      publicKey,
      subject: "orchestrator-executor",
      role: "agent",
      operations: ["claimTask"],
    },
  });
  return { pair, privateKey, publicKey, publicKeySet };
}

async function loadApi() {
  try {
    return await import("../orchestrator-executor-assertion.js");
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND") return {};
    throw error;
  }
}

function assertApi(api) {
  assert.equal(typeof api.createExecutorWorkerAssertion, "function");
  assert.equal(typeof api.verifyExecutorWorkerAssertion, "function");
}

test("Executor Ed25519 assertion round-trips with a public-only verifier key set", async () => {
  const api = await loadApi();
  assertApi(api);
  const keys = await fixture();
  const token = await api.createExecutorWorkerAssertion(keys.privateKey, kid, { nowMs });
  const verified = await api.verifyExecutorWorkerAssertion(keys.publicKeySet, token, { nowMs });
  assert.equal(verified.subject, "orchestrator-executor");
  assert.equal(verified.role, "agent");
  assert.equal(verified.operation, "claimTask");
  assert.equal(verified.kid, kid);
  assert.equal(verified.expiresAt - verified.issuedAt, 60);
  assert.match(verified.jti, /^jti-[A-Za-z0-9_-]{22}$/);
});

test("Executor signer cannot select another principal, role, or operation", async () => {
  const api = await loadApi();
  assertApi(api);
  const keys = await fixture();
  for (const input of [
    { nowMs, subject: "orchestrator-scheduler" },
    { nowMs, role: "system" },
    { nowMs, operation: "createTask" },
    { nowMs, operation: "transitionTask" },
  ]) {
    await assert.rejects(
      api.createExecutorWorkerAssertion(keys.privateKey, kid, input),
      error => error?.code === "AUTHENTICATED_WORKER_REQUIRED",
    );
  }
});

test("Executor verifier rejects a legacy HMAC key set and never treats it as an Ed25519 public key", async () => {
  const api = await loadApi();
  assertApi(api);
  const keys = await fixture();
  const token = await api.createExecutorWorkerAssertion(keys.privateKey, kid, { nowMs });
  const legacyHmacKeySet = JSON.stringify({ "worker-v1": "a".repeat(64) });
  await assert.rejects(
    api.verifyExecutorWorkerAssertion(legacyHmacKeySet, token, { nowMs }),
    error => error?.code === "AUTHENTICATED_WORKER_REQUIRED",
  );
});

test("Executor verifier rejects unknown key IDs, wrong key material, and malformed key metadata", async () => {
  const api = await loadApi();
  assertApi(api);
  const keys = await fixture();
  const token = await api.createExecutorWorkerAssertion(keys.privateKey, kid, { nowMs });
  await assert.rejects(
    api.verifyExecutorWorkerAssertion(keys.publicKeySet, token.replace(kid, "unknown-kid"), { nowMs }),
    error => error?.code === "AUTHENTICATED_WORKER_REQUIRED",
  );
  const malformed = JSON.stringify({ [kid]: { publicKey: "not-a-key", subject: "orchestrator-executor", role: "agent", operations: ["claimTask"] } });
  await assert.rejects(
    api.verifyExecutorWorkerAssertion(malformed, token, { nowMs }),
    error => error?.code === "AUTHENTICATED_WORKER_REQUIRED",
  );
  const otherKeyPair = await fixture();
  const mismatchedPublicKeySet = JSON.stringify({
    [kid]: {
      publicKey: otherKeyPair.publicKey,
      subject: "orchestrator-executor",
      role: "agent",
      operations: ["claimTask"],
    },
  });
  await assert.rejects(
    api.verifyExecutorWorkerAssertion(mismatchedPublicKeySet, token, { nowMs }),
    error => error?.code === "AUTHENTICATED_WORKER_REQUIRED",
  );
});

test("Executor verifier rejects altered payloads and signatures", async () => {
  const api = await loadApi();
  assertApi(api);
  const keys = await fixture();
  const token = await api.createExecutorWorkerAssertion(keys.privateKey, kid, { nowMs });
  const parts = token.split(".");
  const alteredPayload = encodeBase64Url(encoder.encode(JSON.stringify({ sub: "orchestrator-scheduler" })));
  await assert.rejects(
    api.verifyExecutorWorkerAssertion(keys.publicKeySet, [parts[0], parts[1], alteredPayload, parts[3]].join("."), { nowMs }),
    error => error?.code === "AUTHENTICATED_WORKER_REQUIRED",
  );
  const signature = Buffer.from(parts[3], "base64url");
  signature[0] ^= 0x01;
  await assert.rejects(
    api.verifyExecutorWorkerAssertion(keys.publicKeySet, [parts[0], parts[1], parts[2], encodeBase64Url(signature)].join("."), { nowMs }),
    error => error?.code === "AUTHENTICATED_WORKER_REQUIRED",
  );
});

test("Executor verifier enforces expiry, clock skew, principal, role, and operation policy", async () => {
  const api = await loadApi();
  assertApi(api);
  const keys = await fixture();
  const token = await api.createExecutorWorkerAssertion(keys.privateKey, kid, { nowMs });
  await assert.rejects(
    api.verifyExecutorWorkerAssertion(keys.publicKeySet, token, { nowMs: nowMs + 120_000 }),
    error => error?.code === "AUTHENTICATED_WORKER_REQUIRED",
  );
  const unauthorizedPolicy = JSON.stringify({
    [kid]: { publicKey: keys.publicKey, subject: "orchestrator-scheduler", role: "system", operations: ["createTask"] },
  });
  await assert.rejects(
    api.verifyExecutorWorkerAssertion(unauthorizedPolicy, token, { nowMs }),
    error => error?.code === "AUTHENTICATED_WORKER_REQUIRED",
  );
});

test("Executor signer rejects malformed PKCS8 keys and invalid timestamps", async () => {
  const api = await loadApi();
  assertApi(api);
  await assert.rejects(
    api.createExecutorWorkerAssertion("not-pkcs8", kid, { nowMs }),
    error => error?.code === "AUTHENTICATED_WORKER_REQUIRED",
  );
  const keys = await fixture();
  await assert.rejects(
    api.createExecutorWorkerAssertion(keys.privateKey, kid, { nowMs: 0 }),
    error => error?.code === "AUTHENTICATED_WORKER_REQUIRED",
  );
});

test("Executor verifier rejects private-key fields anywhere in its public key set", async () => {
  const api = await loadApi();
  assertApi(api);
  const keys = await fixture();
  const token = await api.createExecutorWorkerAssertion(keys.privateKey, kid, { nowMs });
  const mixedKeySet = JSON.stringify({
    [kid]: {
      publicKey: keys.publicKey,
      subject: "orchestrator-executor",
      role: "agent",
      operations: ["claimTask"],
    },
    "executor-next": {
      publicKey: keys.publicKey,
      privateKey: "must-never-be-present",
      subject: "orchestrator-executor",
      role: "agent",
      operations: ["claimTask"],
    },
  });
  await assert.rejects(
    api.verifyExecutorWorkerAssertion(mixedKeySet, token, { nowMs }),
    error => error?.code === "AUTHENTICATED_WORKER_REQUIRED",
  );
});
