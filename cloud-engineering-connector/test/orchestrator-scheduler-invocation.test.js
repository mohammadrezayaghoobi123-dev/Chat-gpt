import test from "node:test";
import assert from "node:assert/strict";
import {
  createSchedulerInvocationAssertion,
  verifySchedulerInvocationAssertion,
} from "../orchestrator-scheduler-invocation.js";

const NOW = 1_800_000_000_000;
const keySet = JSON.stringify({ "scheduler-k1": "a".repeat(64) });
const expected = Object.freeze({
  invocationId: "invocation-20261124-0001",
  cron: "*/5 * * * *",
  scheduledTime: NOW,
  nowMs: NOW,
});

test("scheduler invocation assertion verifies exact platform schedule context", async () => {
  const token = await createSchedulerInvocationAssertion(keySet, "scheduler-k1", expected);
  const verified = await verifySchedulerInvocationAssertion(keySet, token, expected);
  assert.equal(verified.subject, "orchestrator-scheduler");
  assert.equal(verified.invocationId, expected.invocationId);
  assert.equal(verified.cron, expected.cron);
  assert.equal(verified.scheduledTime, expected.scheduledTime);
  assert.equal(verified.keyId, "scheduler-k1");
  assert.match(verified.jti, /^jti-/);
});

test("scheduler invocation assertion rejects invocation, cron, or scheduled-time substitution", async () => {
  const token = await createSchedulerInvocationAssertion(keySet, "scheduler-k1", expected);
  await assert.rejects(
    verifySchedulerInvocationAssertion(keySet, token, { ...expected, invocationId: "invocation-other" }),
    error => error.code === "SCHEDULER_INVOCATION_REQUIRED",
  );
  await assert.rejects(
    verifySchedulerInvocationAssertion(keySet, token, { ...expected, cron: "0 * * * *" }),
    error => error.code === "SCHEDULER_INVOCATION_REQUIRED",
  );
  await assert.rejects(
    verifySchedulerInvocationAssertion(keySet, token, { ...expected, scheduledTime: NOW + 1 }),
    error => error.code === "SCHEDULER_INVOCATION_REQUIRED",
  );
});

test("scheduler invocation assertion rejects malformed cron and out-of-range expiry", async () => {
  await assert.rejects(
    createSchedulerInvocationAssertion(keySet, "scheduler-k1", { ...expected, cron: "every five minutes" }),
    error => error.code === "SCHEDULER_INVOCATION_REQUIRED",
  );
  const token = await createSchedulerInvocationAssertion(keySet, "scheduler-k1", expected);
  await assert.rejects(
    verifySchedulerInvocationAssertion(keySet, token, { ...expected, nowMs: NOW + 70_000 }),
    error => error.code === "SCHEDULER_INVOCATION_REQUIRED",
  );
});

test("scheduler invocation assertion rejects token tampering and unknown key IDs", async () => {
  const token = await createSchedulerInvocationAssertion(keySet, "scheduler-k1", expected);
  const parts = token.split(".");
  parts[2] = (parts[2][0] === "A" ? "B" : "A") + parts[2].slice(1);
  await assert.rejects(
    verifySchedulerInvocationAssertion(keySet, parts.join("."), expected),
    error => error.code === "SCHEDULER_INVOCATION_REQUIRED",
  );
  const unknownKeyToken = await createSchedulerInvocationAssertion(keySet, "scheduler-k1", expected);
  const unknownParts = unknownKeyToken.split(".");
  unknownParts[1] = "scheduler-k2";
  await assert.rejects(
    verifySchedulerInvocationAssertion(keySet, unknownParts.join("."), expected),
    error => error.code === "SCHEDULER_INVOCATION_REQUIRED",
  );
});
