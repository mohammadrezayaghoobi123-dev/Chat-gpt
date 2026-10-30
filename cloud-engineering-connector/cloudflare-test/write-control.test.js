import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";

function stubFor(name = "write-control-contract") {
  return env.WRITE_CONTROL.get(env.WRITE_CONTROL.idFromName(name));
}

const request = (keyHash, requestHash) => ({
  keyHash,
  requestHash,
  now: 1_800_000_000_000,
  windowMs: 60_000,
  limit: 5,
});

describe("WriteControl atomic admission and idempotency contract", () => {
  it("admits at most five distinct writes in a rolling 60-second window using the Durable Object clock", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const start = 1_800_000_000_000;
      vi.setSystemTime(start);
      const stub = stubFor("quota-five");
      const results = [];
      for (let i = 0; i < 5; i++) {
        results.push(await stub.admitWrite(request(i.toString(16).padStart(64, "0"), (i + 100).toString(16).padStart(64, "0"))));
      }
      vi.setSystemTime(start + 59_999);
      results.push(await stub.admitWrite({ ...request("5".repeat(64), "105".padStart(64, "0")), now: start + 86_400_000 }));
      expect(results.filter((item) => item.admitted)).toHaveLength(5);
      expect(results[5]).toMatchObject({ admitted: false, reason: "RATE_LIMITED" });
      expect(results[5].retryAfterSeconds).toBeGreaterThan(0);
      vi.setSystemTime(start + 60_001);
      await expect(stub.admitWrite(request("6".repeat(64), "106".padStart(64, "0"))))
        .resolves.toMatchObject({ admitted: true, replay: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it("replays the same idempotency key without consuming a second admission", async () => {
    const stub = stubFor("idempotency-replay");
    const input = request("a".repeat(64), "b".repeat(64));
    const first = await stub.admitWrite(input);
    const replay = await stub.admitWrite({ ...input, now: input.now + 1 });
    expect(first).toMatchObject({ admitted: true, replay: false });
    expect(replay).toMatchObject({ admitted: true, replay: true, operation: { phase: "RESERVED", status: "IN_PROGRESS" } });
  });

  it("rejects reuse of an idempotency key for a different request fingerprint", async () => {
    const stub = stubFor("idempotency-conflict");
    const input = request("c".repeat(64), "d".repeat(64));
    await stub.admitWrite(input);
    await expect(stub.admitWrite({ ...input, requestHash: "e".repeat(64) })).resolves.toMatchObject({
      admitted: false,
      reason: "IDEMPOTENCY_CONFLICT",
    });
  });

  it("serializes concurrent admissions so the global quota cannot be exceeded", async () => {
    const stub = stubFor("concurrent-admissions");
    const results = await Promise.all(
      Array.from({ length: 24 }, (_, i) =>
        stub.admitWrite(request((i + 1000).toString(16).padStart(64, "0"), (i + 2000).toString(16).padStart(64, "0"))),
      ),
    );
    expect(results.filter((item) => item.admitted && !item.replay)).toHaveLength(5);
    expect(results.filter((item) => item.reason === "RATE_LIMITED")).toHaveLength(19);
  });

  it("enforces compare-and-set phase transitions", async () => {
    const stub = stubFor("phase-transition");
    const keyHash = "f".repeat(64);
    await stub.admitWrite(request(keyHash, "1".repeat(64)));
    await expect(stub.transitionOperation({
      keyHash,
      expectedPhase: "RESERVED",
      nextPhase: "TREE_DISPATCHED",
      now: 1_800_000_000_001,
    })).resolves.toMatchObject({ updated: true, operation: { phase: "TREE_DISPATCHED" } });
    await expect(stub.transitionOperation({
      keyHash,
      expectedPhase: "TREE_DISPATCHED",
      nextPhase: "TREE_WRITTEN",
      now: 1_800_000_000_002,
    })).resolves.toMatchObject({ updated: true, operation: { phase: "TREE_WRITTEN" } });
    await expect(stub.transitionOperation({
      keyHash,
      expectedPhase: "RESERVED",
      nextPhase: "TREE_DISPATCHED",
      now: 1_800_000_000_003,
    })).resolves.toMatchObject({ updated: false, reason: "PHASE_CONFLICT" });
  });

  it("reconciles an ambiguous branch creation only when the exact deterministic branch and commit match", async () => {
    const stub = stubFor("unknown-branch-reconcile");
    const keyHash = "5".repeat(64);
    const commitSha = "c".repeat(40);
    const branchName = "assistant/mcp-" + keyHash;
    await stub.admitWrite(request(keyHash, "d".repeat(64)));
    await stub.transitionOperation({ keyHash, expectedPhase: "RESERVED", nextPhase: "TREE_DISPATCHED", now: 1_800_000_000_001 });
    await stub.transitionOperation({ keyHash, expectedPhase: "TREE_DISPATCHED", nextPhase: "TREE_WRITTEN", now: 1_800_000_000_001 });
    await stub.transitionOperation({ keyHash, expectedPhase: "TREE_WRITTEN", nextPhase: "COMMIT_WRITTEN", now: 1_800_000_000_002, metadata: { commitSha } });
    await stub.markOperationStatus({ keyHash, status: "UNKNOWN", now: 1_800_000_000_003, errorCode: "UPSTREAM_OUTCOME_UNCERTAIN" });
    await expect(stub.reconcileBranchWritten({ keyHash, now: 1_800_000_000_004, branchName, commitSha }))
      .resolves.toMatchObject({ updated: true, operation: { status: "IN_PROGRESS", phase: "BRANCH_WRITTEN", branchName, commitSha } });
    await expect(stub.reconcileBranchWritten({ keyHash, now: 1_800_000_000_005, branchName, commitSha: "e".repeat(40) }))
      .resolves.toMatchObject({ updated: false, reason: "RECONCILIATION_NOT_ALLOWED" });
  });

  it("reconciles an UNKNOWN PR_DISPATCHED operation only after verified PR evidence", async () => {
    const stub = stubFor("unknown-pr-reconcile");
    const keyHash = "6".repeat(64);
    const commitSha = "a".repeat(40);
    const branchName = "assistant/mcp-" + keyHash;
    await stub.admitWrite(request(keyHash, "7".repeat(64)));
    await stub.transitionOperation({ keyHash, expectedPhase: "RESERVED", nextPhase: "TREE_DISPATCHED", now: 1_800_000_000_001 });
    await stub.transitionOperation({ keyHash, expectedPhase: "TREE_DISPATCHED", nextPhase: "TREE_WRITTEN", now: 1_800_000_000_001 });
    await stub.transitionOperation({ keyHash, expectedPhase: "TREE_WRITTEN", nextPhase: "COMMIT_WRITTEN", now: 1_800_000_000_002, metadata: { commitSha } });
    await stub.transitionOperation({ keyHash, expectedPhase: "COMMIT_WRITTEN", nextPhase: "BRANCH_WRITTEN", now: 1_800_000_000_003, metadata: { branchName } });
    await stub.transitionOperation({ keyHash, expectedPhase: "BRANCH_WRITTEN", nextPhase: "PR_DISPATCHED", now: 1_800_000_000_004 });
    await stub.markOperationStatus({ keyHash, status: "UNKNOWN", now: 1_800_000_000_005, errorCode: "UPSTREAM_OUTCOME_UNCERTAIN" });
    await expect(stub.reconcilePrCreated({
      keyHash, now: 1_800_000_000_006, branchName, commitSha, prNumber: 42,
      prUrl: "https://github.com/acme/project/pull/42",
    })).resolves.toMatchObject({ updated: true, operation: { status: "SUCCEEDED", phase: "PR_CREATED", prNumber: 42, errorCode: null } });
  });

  it("refuses UNKNOWN reconciliation unless the operation is at PR_DISPATCHED", async () => {
    const stub = stubFor("unknown-early-phase");
    const keyHash = "8".repeat(64);
    await stub.admitWrite(request(keyHash, "9".repeat(64)));
    await stub.markOperationStatus({ keyHash, status: "UNKNOWN", now: 1_800_000_000_001 });
    await expect(stub.reconcilePrCreated({
      keyHash, now: 1_800_000_000_002, branchName: "assistant/mcp-" + keyHash,
      commitSha: "b".repeat(40), prNumber: 43, prUrl: "https://github.com/acme/project/pull/43",
    })).resolves.toMatchObject({ updated: false, reason: "RECONCILIATION_NOT_ALLOWED" });
  });

  it("records definite upstream rejection as terminal FAILED", async () => {
    const stub = stubFor("terminal-failure");
    const keyHash = "4".repeat(64);
    await stub.admitWrite(request(keyHash, "5".repeat(64)));
    await expect(stub.markOperationStatus({
      keyHash,
      status: "FAILED",
      now: 1_800_000_000_001,
      errorCode: "UPSTREAM_REJECTED",
    })).resolves.toMatchObject({ updated: true, operation: { status: "FAILED", errorCode: "UPSTREAM_REJECTED" } });
  });

  it("moves expired in-progress operations to UNKNOWN using the Durable Object clock", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const start = 1_800_000_000_000;
      vi.setSystemTime(start);
      const stub = stubFor("stale-unknown");
      const keyHash = "2".repeat(64);
      await stub.admitWrite(request(keyHash, "3".repeat(64)));
      vi.setSystemTime(start + 120_001);
      const changed = await stub.markStaleOperationsUnknown({ leaseMs: 120_000 });
      expect(changed).toBeGreaterThanOrEqual(1);
      await expect(stub.getOperation(keyHash)).resolves.toMatchObject({
        status: "UNKNOWN",
        phase: "RESERVED",
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
