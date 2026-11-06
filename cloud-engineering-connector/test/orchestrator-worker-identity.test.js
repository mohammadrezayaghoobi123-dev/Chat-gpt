import test from "node:test";
import assert from "node:assert/strict";
import { createScheduledWorkerAssertion, verifyWorkerAssertion } from "../orchestrator-worker-identity.js";

const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
const keySet = JSON.stringify({ "worker-v1": key });
const nowMs = 1_800_000_000_000;

test("scheduled signer issues a short-lived publisher assertion bound to one Ledger operation", async () => {
  const token = await createScheduledWorkerAssertion(keySet, "worker-v1", {
    subject: "orchestrator-outbox-publisher",
    role: "publisher",
    operation: "claimOutbox",
    nowMs,
  });
  const verified = await verifyWorkerAssertion(keySet, token, {
    subject: "orchestrator-outbox-publisher",
    role: "publisher",
    operation: "claimOutbox",
    nowMs,
  });
  assert.equal(verified.subject, "orchestrator-outbox-publisher");
  assert.equal(verified.role, "publisher");
  assert.equal(verified.operation, "claimOutbox");
  assert.equal(verified.expiresAt - verified.issuedAt, 60);
});

test("scheduled signer cannot mint agent identities or caller-selected principals", async () => {
  await assert.rejects(
    createScheduledWorkerAssertion(keySet, "worker-v1", {
      subject: "agent:attacker",
      role: "agent",
      operation: "claimTask",
      nowMs,
    }),
    error => error?.code === "AUTHENTICATED_WORKER_REQUIRED",
  );
  await assert.rejects(
    createScheduledWorkerAssertion(keySet, "worker-v1", {
      subject: "orchestrator-outbox-publisher",
      role: "system",
      operation: "createTask",
      nowMs,
    }),
    error => error?.code === "AUTHENTICATED_WORKER_REQUIRED",
  );
});

test("scheduled signer rejects missing active key, weak key material, and invalid time", async () => {
  await assert.rejects(
    createScheduledWorkerAssertion(keySet, "unknown-kid", {
      subject: "orchestrator-outbox-publisher", role: "publisher", operation: "claimOutbox", nowMs,
    }),
    error => error?.code === "AUTHENTICATED_WORKER_REQUIRED",
  );
  await assert.rejects(
    createScheduledWorkerAssertion(JSON.stringify({ "worker-v1": "abcd" }), "worker-v1", {
      subject: "orchestrator-outbox-publisher", role: "publisher", operation: "claimOutbox", nowMs,
    }),
    error => error?.code === "AUTHENTICATED_WORKER_REQUIRED",
  );
  await assert.rejects(
    createScheduledWorkerAssertion(keySet, "worker-v1", {
      subject: "orchestrator-outbox-publisher", role: "publisher", operation: "claimOutbox", nowMs: 0,
    }),
    error => error?.code === "AUTHENTICATED_WORKER_REQUIRED",
  );
});
