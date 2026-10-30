import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

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
  it("admits at most five distinct writes in a rolling 60-second window", async () => {
    const stub = stubFor("quota-five");
    const results = [];
    for (let i = 0; i < 6; i++) {
      results.push(await stub.admitWrite(request(i.toString(16).padStart(64, "0"), (i + 100).toString(16).padStart(64, "0"))));
    }
    expect(results.filter((item) => item.admitted)).toHaveLength(5);
    expect(results[5]).toMatchObject({ admitted: false, reason: "RATE_LIMITED" });
    expect(results[5].retryAfterSeconds).toBeGreaterThan(0);
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
      nextPhase: "TREE_WRITTEN",
      now: 1_800_000_000_001,
    })).resolves.toMatchObject({ updated: true, operation: { phase: "TREE_WRITTEN" } });
    await expect(stub.transitionOperation({
      keyHash,
      expectedPhase: "RESERVED",
      nextPhase: "COMMIT_WRITTEN",
      now: 1_800_000_000_002,
    })).resolves.toMatchObject({ updated: false, reason: "PHASE_CONFLICT" });
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

  it("moves expired in-progress operations to UNKNOWN without replaying them", async () => {
    const stub = stubFor("stale-unknown");
    const keyHash = "2".repeat(64);
    await stub.admitWrite(request(keyHash, "3".repeat(64)));
    const changed = await stub.markStaleOperationsUnknown({
      now: 1_800_000_200_000,
      leaseMs: 120_000,
    });
    expect(changed).toBe(1);
    await expect(stub.getOperation(keyHash)).resolves.toMatchObject({
      status: "UNKNOWN",
      phase: "RESERVED",
    });
  });
});
