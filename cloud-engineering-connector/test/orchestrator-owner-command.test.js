import test from "node:test";
import assert from "node:assert/strict";
import { parseOwnerCommand } from "../orchestrator-owner-command.js";

test("parses a bounded Owner cancel command without evaluating shell syntax", () => {
  assert.deepEqual(
    parseOwnerCommand('/orchestrator cancel task-0001 --reason "stop the unsafe rollout"'),
    {
      operation: "cancel",
      taskId: "task-0001",
      reason: "stop the unsafe rollout",
    },
  );
});

test("rejects command lookalikes, unknown operations, malformed task IDs, and unsafe reasons", () => {
  for (const body of [
    "please /orchestrator cancel task-0001 --reason \"x\"",
    "/orchestrator run task-0001 --reason \"x\"",
    '/orchestrator cancel ../task --reason "x"',
    '/orchestrator cancel task-0001 --reason "token=abc123"',
    '/orchestrator cancel task-0001 --reason "line one\\nline two"',
    '/orchestrator cancel task-0001 --reason "' + "x".repeat(241) + '"',
    '/orchestrator cancel task-0001 --reason "missing close',
    '/orchestrator cancel task-0001 --reason "x" trailing',
  ]) {
    assert.equal(parseOwnerCommand(body), null, body);
  }
});
