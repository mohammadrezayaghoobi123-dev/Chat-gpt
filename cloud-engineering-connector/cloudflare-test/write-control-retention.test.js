import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const UNRESOLVED_LIMIT = 1000;
const NOW = 1_800_000_000_000;

function stubFor(name) {
  return env.WRITE_CONTROL.get(env.WRITE_CONTROL.idFromName(name));
}

function insertOperation(sql, { keyHash, requestHash, status, phase, updatedAt }) {
  sql.exec(
    `INSERT INTO write_operations
      (key_hash, request_hash, status, phase, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    keyHash, requestHash, status, phase, updatedAt, updatedAt,
  );
}

describe("WriteControl terminal operation retention", () => {
  it("prunes only terminal records strictly older than 30 days in the admission transaction", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    try {
      const stub = stubFor("retention-expired-terminal");
      const expiredSuccess = "a".repeat(64);
      const expiredFailure = "b".repeat(64);
      const boundarySuccess = "c".repeat(64);
      const unknown = "d".repeat(64);
      const active = "e".repeat(64);

      await runInDurableObject(stub, async (instance, state) => {
        const sql = state.storage.sql;
        insertOperation(sql, {
          keyHash: expiredSuccess, requestHash: "1".repeat(64),
          status: "SUCCEEDED", phase: "PR_CREATED", updatedAt: NOW - RETENTION_MS - 1,
        });
        insertOperation(sql, {
          keyHash: expiredFailure, requestHash: "2".repeat(64),
          status: "FAILED", phase: "RESERVED", updatedAt: NOW - RETENTION_MS - 1,
        });
        insertOperation(sql, {
          keyHash: boundarySuccess, requestHash: "3".repeat(64),
          status: "SUCCEEDED", phase: "PR_CREATED", updatedAt: NOW - RETENTION_MS,
        });
        insertOperation(sql, {
          keyHash: unknown, requestHash: "4".repeat(64),
          status: "UNKNOWN", phase: "PR_DISPATCHED", updatedAt: NOW - RETENTION_MS - 1,
        });
        insertOperation(sql, {
          keyHash: active, requestHash: "5".repeat(64),
          status: "IN_PROGRESS", phase: "COMMIT_DISPATCHED", updatedAt: NOW - RETENTION_MS - 1,
        });

        const result = await instance.admitWrite({
          keyHash: "f".repeat(64), requestHash: "6".repeat(64),
          windowMs: 60_000, limit: 5,
        });
        expect(result).toMatchObject({ admitted: true, replay: false });

        const rows = sql.exec(
          "SELECT key_hash, status FROM write_operations ORDER BY key_hash",
        ).toArray();
        const byKey = new Map(rows.map((row) => [row.key_hash, row.status]));
        expect(byKey.has(expiredSuccess)).toBe(false);
        expect(byKey.has(expiredFailure)).toBe(false);
        expect(byKey.get(boundarySuccess)).toBe("SUCCEEDED");
        expect(byKey.get(unknown)).toBe("UNKNOWN");
        expect(byKey.get(active)).toBe("IN_PROGRESS");
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps same-key terminal replay stable through the full 30-day retention window", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    try {
      const stub = stubFor("retention-replay-window");
      const keyHash = "7".repeat(64);
      const requestHash = "8".repeat(64);
      await runInDurableObject(stub, async (instance, state) => {
        insertOperation(state.storage.sql, {
          keyHash, requestHash, status: "SUCCEEDED", phase: "PR_CREATED",
          updatedAt: NOW - RETENTION_MS,
        });
        const replay = instance.admitWrite({
          keyHash, requestHash, windowMs: 60_000, limit: 5,
        });
        expect(replay).toMatchObject({
          admitted: true, replay: true,
          operation: { status: "SUCCEEDED", phase: "PR_CREATED" },
        });
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats an expired terminal key as a new admission after the 30-day window", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    try {
      const stub = stubFor("retention-expired-key-reuse");
      const keyHash = "9".repeat(64);
      const requestHash = "a".repeat(64);
      await runInDurableObject(stub, async (instance, state) => {
        insertOperation(state.storage.sql, {
          keyHash, requestHash, status: "SUCCEEDED", phase: "PR_CREATED",
          updatedAt: NOW - RETENTION_MS - 1,
        });
        const result = await instance.admitWrite({
          keyHash, requestHash, windowMs: 60_000, limit: 5,
        });
        expect(result).toMatchObject({
          admitted: true,
          replay: false,
          operation: { status: "IN_PROGRESS", phase: "RESERVED" },
        });
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("expires an old terminal idempotency tombstone before looking up the same key", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    try {
      const stub = stubFor("retention-expired-idempotency-key");
      const keyHash = "9".repeat(64);
      const requestHash = "a".repeat(64);
      await runInDurableObject(stub, async (instance, state) => {
        insertOperation(state.storage.sql, {
          keyHash, requestHash, status: "FAILED", phase: "RESERVED",
          updatedAt: NOW - RETENTION_MS - 1,
        });
        const result = instance.admitWrite({
          keyHash, requestHash, windowMs: 60_000, limit: 5,
        });
        expect(result).toMatchObject({
          admitted: true, replay: false,
          operation: { status: "IN_PROGRESS", phase: "RESERVED" },
        });
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed at the unresolved-operation ceiling and exposes storage counters", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    try {
      const stub = stubFor("retention-unknown-backlog-cap");
      await runInDurableObject(stub, async (instance, state) => {
        const sql = state.storage.sql;
        for (let i = 0; i < 1_000; i++) {
          const keyHash = i.toString(16).padStart(64, "0");
          insertOperation(sql, {
            keyHash,
            requestHash: (i + 2_000).toString(16).padStart(64, "0"),
            status: "UNKNOWN",
            phase: "PR_DISPATCHED",
            updatedAt: NOW - RETENTION_MS * 2,
          });
        }
        const result = await instance.admitWrite({
          keyHash: "f".repeat(64), requestHash: "e".repeat(64),
          windowMs: 60_000, limit: 5,
        });
        expect(result).toMatchObject({
          admitted: false,
          reason: "UNKNOWN_BACKLOG_FULL",
          storageStats: {
            unknownCount: 1_000,
            unresolvedCount: 1_000,
            unresolvedLimit: 1_000,
            unresolvedRemaining: 0,
          },
        });
        expect(sql.exec("SELECT COUNT(*) AS count FROM write_operations").one().count).toBe(1_000);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("allows a known idempotent replay even when the unresolved backlog is saturated", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    try {
      const stub = stubFor("retention-unknown-backlog-replay");
      const replayKey = "a".repeat(64);
      const replayHash = "b".repeat(64);
      await runInDurableObject(stub, async (instance, state) => {
        const sql = state.storage.sql;
        insertOperation(sql, {
          keyHash: replayKey, requestHash: replayHash, status: "UNKNOWN",
          phase: "PR_DISPATCHED", updatedAt: NOW - RETENTION_MS * 2,
        });
        for (let i = 1; i < 1_000; i++) {
          insertOperation(sql, {
            keyHash: i.toString(16).padStart(64, "0"),
            requestHash: (i + 2_000).toString(16).padStart(64, "0"),
            status: "UNKNOWN", phase: "PR_DISPATCHED",
            updatedAt: NOW - RETENTION_MS * 2,
          });
        }
        const replay = instance.admitWrite({
          keyHash: replayKey, requestHash: replayHash,
          windowMs: 60_000, limit: 5,
        });
        expect(replay).toMatchObject({
          admitted: true, replay: true,
          operation: { status: "UNKNOWN", phase: "PR_DISPATCHED" },
        });
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports logical payload estimates and operation-state counts after admission", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    try {
      const stub = stubFor("retention-storage-observability");
      await runInDurableObject(stub, async (instance) => {
        const result = await instance.admitWrite({
          keyHash: "c".repeat(64), requestHash: "d".repeat(64),
          windowMs: 60_000, limit: 5,
        });
        const stats = instance.getStorageStats();
        expect(result.storageStats).toEqual(expect.objectContaining({ unknownCount: 0, inProgressCount: 1, unresolvedCount: 1 }));
        expect(stats).toEqual(expect.objectContaining({
          unknownCount: 0,
          inProgressCount: 1,
          terminalCount: 0,
          unresolvedCount: 1,
          unresolvedLimit: 1_000,
          unresolvedRemaining: 999,
          operationCount: 1,
          admissionCount: 1,
          operationLogicalBytes: expect.any(Number),
          admissionLogicalBytes: expect.any(Number),
          logicalPayloadBytes: expect.any(Number),
          logicalPayloadUtilization: expect.any(Number),
          storageLimitBytes: 1_073_741_824,
          physicalStorageBytes: null,
          storageMeasurement: "logical_payload_estimate_not_physical_sqlite_allocation",
        }));
      });
    } finally {
      vi.useRealTimers();
    }
  });


  it("counts UTF-8 bytes rather than Unicode characters in logical storage estimates", async () => {
    const stub = stubFor("retention-storage-utf8-byte-count");
    const gitMetadata = JSON.stringify({ commitMessage: "🧪" });
    await runInDurableObject(stub, async (instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO write_operations
          (key_hash, request_hash, status, phase, created_at, updated_at, git_metadata)
         VALUES (?, ?, 'SUCCEEDED', 'PR_CREATED', ?, ?, ?)`,
        "a".repeat(64), "b".repeat(64), NOW, NOW, gitMetadata,
      );
      const stats = instance.getStorageStats();
      const expectedBytes = 64 + 64 + "SUCCEEDED".length + "PR_CREATED".length + 32
        + new TextEncoder().encode(gitMetadata).byteLength;
      expect(stats.operationLogicalBytes).toBe(expectedBytes);
      expect(stats.admissionLogicalBytes).toBe(0);
    });
  });


  it("counts stale IN_PROGRESS rows toward the unresolved safety ceiling", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    try {
      const stub = stubFor("retention-counts-in-progress");
      await runInDurableObject(stub, async (instance, state) => {
        for (let i = 0; i < 999; i++) {
          insertOperation(state.storage.sql, {
            keyHash: i.toString(16).padStart(64, "0"),
            requestHash: (i + 3_000).toString(16).padStart(64, "0"),
            status: "UNKNOWN", phase: "PR_DISPATCHED",
            updatedAt: NOW - RETENTION_MS * 2,
          });
        }
        insertOperation(state.storage.sql, {
          keyHash: "e".repeat(64), requestHash: "f".repeat(64),
          status: "IN_PROGRESS", phase: "COMMIT_DISPATCHED",
          updatedAt: NOW - RETENTION_MS * 2,
        });
        const result = instance.admitWrite({
          keyHash: "a".repeat(64), requestHash: "b".repeat(64),
          windowMs: 60_000, limit: 5,
        });
        expect(result).toMatchObject({
          admitted: false,
          reason: "UNKNOWN_BACKLOG_FULL",
          storageStats: { unknownCount: 999, inProgressCount: 1, unresolvedCount: 1_000 },
        });
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("serializes terminal pruning and concurrent admissions within the five-per-minute quota", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    try {
      const stub = stubFor("retention-concurrent-admission");
      await runInDurableObject(stub, async (_instance, state) => {
        for (let i = 0; i < 5; i++) {
          insertOperation(state.storage.sql, {
            keyHash: (i + 10).toString(16).padStart(64, "0"),
            requestHash: (i + 20).toString(16).padStart(64, "0"),
            status: "SUCCEEDED", phase: "PR_CREATED",
            updatedAt: NOW - RETENTION_MS - 1,
          });
        }
      });
      const results = await Promise.all(Array.from({ length: 10 }, (_, i) => stub.admitWrite({
        keyHash: (i + 100).toString(16).padStart(64, "0"),
        requestHash: (i + 200).toString(16).padStart(64, "0"),
        windowMs: 60_000, limit: 5,
      })));
      expect(results.filter((result) => result.admitted && !result.replay)).toHaveLength(5);
      expect(results.filter((result) => result.reason === "RATE_LIMITED")).toHaveLength(5);
      const stats = await stub.getStorageStats();
      expect(stats).toMatchObject({ terminalCount: 0, inProgressCount: 5, unresolvedCount: 5 });
    } finally {
      vi.useRealTimers();
    }
  });


  it("rejects oversized PR URL metadata before it can inflate the retained ledger", async () => {
    const stub = stubFor("retention-pr-url-bound");
    const keyHash = "f".repeat(64);
    await runInDurableObject(stub, async (instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO write_operations
          (key_hash, request_hash, status, phase, created_at, updated_at)
         VALUES (?, ?, 'IN_PROGRESS', 'PR_DISPATCHED', ?, ?)`,
        keyHash, "e".repeat(64), NOW, NOW,
      );
      const oversizedUrl = "https://github.com/" + "a".repeat(250) + "/" + "b".repeat(250) + "/pull/1";
      expect(() => instance.transitionOperation({
        keyHash,
        leaseGeneration: 1,
        expectedPhase: "PR_DISPATCHED",
        nextPhase: "PR_CREATED",
        status: "SUCCEEDED",
        metadata: {
          branchName: "assistant/mcp-" + keyHash,
          commitSha: "1".repeat(40),
          prNumber: 1,
          prUrl: oversizedUrl,
        },
      })).toThrow(/pull URL must match the PR number/);
      expect(state.storage.sql.exec(
        "SELECT status, phase FROM write_operations WHERE key_hash = ?", keyHash,
      ).one()).toMatchObject({ status: "IN_PROGRESS", phase: "PR_DISPATCHED" });
    });
  });


  it("keeps full logical-payload scans off the admission hot path", async () => {
    const stub = stubFor("retention-admission-fast-path");
    await runInDurableObject(stub, async (instance) => {
      instance.getStorageStats = () => {
        throw new Error("full storage scan must not run during admission");
      };
      const result = instance.admitWrite({
        keyHash: "b".repeat(64), requestHash: "c".repeat(64),
        windowMs: 60_000, limit: 5,
      });
      expect(result).toMatchObject({
        admitted: true,
        replay: false,
        storageStats: { unresolvedCount: 1, unresolvedLimit: UNRESOLVED_LIMIT },
      });
    });
  });
 
  it("keeps per-admission telemetry limited to unresolved indexed rows", async () => {
    const stub = stubFor("retention-admission-stats-bounded");
    await runInDurableObject(stub, async (instance, state) => {
      const sql = state.storage.sql;
      for (let i = 0; i < 128; i++) {
        insertOperation(sql, {
          keyHash: (i + 100).toString(16).padStart(64, "0"),
          requestHash: (i + 300).toString(16).padStart(64, "0"),
          status: i % 2 === 0 ? "SUCCEEDED" : "FAILED",
          phase: i % 2 === 0 ? "PR_CREATED" : "RESERVED",
          updatedAt: NOW - i,
        });
      }
      insertOperation(sql, {
        keyHash: "1".repeat(64), requestHash: "2".repeat(64),
        status: "UNKNOWN", phase: "PR_DISPATCHED", updatedAt: NOW,
      });
      insertOperation(sql, {
        keyHash: "3".repeat(64), requestHash: "4".repeat(64),
        status: "IN_PROGRESS", phase: "COMMIT_DISPATCHED", updatedAt: NOW,
      });

      const stats = instance.getAdmissionStats();
      expect(stats).toMatchObject({
        unknownCount: 1,
        inProgressCount: 1,
        unresolvedCount: 2,
        unresolvedLimit: UNRESOLVED_LIMIT,
        unresolvedRemaining: UNRESOLVED_LIMIT - 2,
      });
      expect(stats).not.toHaveProperty("terminalCount");
      expect(stats).not.toHaveProperty("operationCount");
      expect(stats).not.toHaveProperty("admissionCount");
    });
  });

 
  it("performs a real SQLite write/read/delete probe without retaining a ledger row", async () => {
    const stub = stubFor("retention-live-sqlite-write-probe");
    const keyHash = "d".repeat(64);
    const requestHash = "e".repeat(64);
    await runInDurableObject(stub, async (instance, state) => {
      const before = Number(state.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM write_operations",
      ).one().count);
      expect(instance.healthCheck({ keyHash, requestHash })).toEqual({ ok: true });
      const after = Number(state.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM write_operations",
      ).one().count);
      expect(after).toBe(before);
      expect(state.storage.sql.exec(
        "SELECT key_hash FROM write_operations WHERE key_hash = ?", keyHash,
      ).toArray()).toHaveLength(0);
    });
  });

});
