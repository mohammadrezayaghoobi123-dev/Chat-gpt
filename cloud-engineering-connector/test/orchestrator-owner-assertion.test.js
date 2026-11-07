import test from "node:test";
import assert from "node:assert/strict";
import { createOwnerAssertion, verifyOwnerAssertion } from "../orchestrator-owner-assertion.js";

const now = 1_800_000_000_000;
const keySet = JSON.stringify({
  "owner-v1": "3031323334353637383961626364656630313233343536373839616263646566",
});
const context = Object.freeze({
  actorId: "335530603",
  repositoryId: 1398846697,
  taskId: "task-0001",
  operation: "cancel",
  deliveryId: "delivery-owner-0001",
  commentId: "123456789",
  commandHash: "a".repeat(64),
});

test("creates and verifies a short-lived Owner assertion bound to the full command context", async () => {
  const token = await createOwnerAssertion(keySet, "owner-v1", context, now);
  const verified = await verifyOwnerAssertion(keySet, token, { ...context, nowMs: now + 1000 });
  assert.equal(verified.role, "owner");
  assert.equal(verified.actorId, context.actorId);
  assert.equal(verified.repositoryId, context.repositoryId);
  assert.equal(verified.taskId, context.taskId);
  assert.equal(verified.operation, context.operation);
  assert.equal(verified.deliveryId, context.deliveryId);
  assert.equal(verified.commentId, context.commentId);
  assert.equal(verified.commandHash, context.commandHash);
  assert.ok(verified.jti.length >= 22);
});

test("rejects an Owner assertion when any command context field is changed", async () => {
  const token = await createOwnerAssertion(keySet, "owner-v1", context, now);
  await assert.rejects(
    verifyOwnerAssertion(keySet, token, { ...context, deliveryId: "delivery-owner-0002", nowMs: now + 1000 }),
  );
  await assert.rejects(
    verifyOwnerAssertion(keySet, token, { ...context, taskId: "task-0002", nowMs: now + 1000 }),
  );
});

test("rejects expired, malformed, or misconfigured Owner assertions", async () => {
  const token = await createOwnerAssertion(keySet, "owner-v1", context, now);
  await assert.rejects(verifyOwnerAssertion(keySet, token, { ...context, nowMs: now + 60_000 }));
  await assert.rejects(verifyOwnerAssertion(keySet, token, { ...context, operation: "release", nowMs: now + 1000 }));
  await assert.rejects(createOwnerAssertion(keySet, "missing-kid", context, now));
  await assert.rejects(createOwnerAssertion("{}", "owner-v1", context, now));
});
