import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createOwnerAssertion } from "../orchestrator-owner-assertion.js";
import { CLAIM_CANDIDATE_QUERY } from "../orchestrator-ledger.js";
import { canonicalJson, sha256Canonical } from "../orchestrator-protocol.js";

const now = 1_800_000_000_000;
const TEST_ASSERTION_KID = "test-v1";
const TEST_ASSERTION_KEY = Uint8Array.from(
  "3031323334353637383961626364656630313233343536373839616263646566".match(/../g),
  byte => Number.parseInt(byte, 16),
);

function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("=", "").split("+").join("-").split("/").join("_");
}

async function createWorkerAssertion({ subject, role, operation, nowMs }) {
  const issuedAt = Math.floor(nowMs / 1000);
  const claims = {
    v: 1, iss: "chat-gpt111-worker", aud: "orchestrator-ledger",
    sub: subject, role, op: operation, iat: issuedAt, exp: issuedAt + 60,
    jti: "jti-" + base64Url(crypto.getRandomValues(new Uint8Array(16))),
  };
  const payload = base64Url(new TextEncoder().encode(canonicalJson(claims)));
  const signingInput = "v1." + TEST_ASSERTION_KID + "." + payload;
  const key = await crypto.subtle.importKey("raw", TEST_ASSERTION_KEY, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signingInput)));
  return signingInput + "." + base64Url(signature);
}

function ledgerFor(name) {
  return env.ORCHESTRATOR_LEDGER.get(env.ORCHESTRATOR_LEDGER.idFromName(name));
}

async function createTask(ledger, taskId, executorId, state = "SCHEDULED", createdAt = now) {
  return ledger.createTask({
    task: {
      taskId, state, version: 1, agentRound: 0, createdAt, updatedAt: createdAt,
      executorId, commitSha: "a".repeat(40), objective: "candidate index fixture",
    },
    idempotencyKey: "candidate-index-" + taskId,
    inputHash: "b".repeat(64),
    workerId: "orchestrator-scheduler",
    workerAssertion: await createWorkerAssertion({
      subject: "orchestrator-scheduler", role: "system", operation: "createTask", nowMs: createdAt,
    }),
    now: createdAt,
  });
}

describe("OrchestratorLedger claim candidate index", () => {
  it("creates the candidate index table and executor ordering index during schema initialization", async () => {
    const ledger = ledgerFor("claim-candidate-index-schema");
    await ledger.ping();
    await runInDurableObject(ledger, async (_instance, state) => {
      const tables = state.storage.sql.exec(
        "SELECT name FROM sqlite_master WHERE type = 'table'",
      ).toArray().map(row => row.name);
      expect(tables).toContain("orchestrator_claim_candidates");
      const indexes = state.storage.sql.exec(
        "SELECT name FROM sqlite_master WHERE type = 'index'",
      ).toArray().map(row => row.name);
      expect(indexes).toContain("orchestrator_claim_candidates_by_executor_created");
      const columns = state.storage.sql.exec(
        "PRAGMA table_info(orchestrator_claim_candidates)",
      ).toArray().map(row => row.name);
      expect(columns).toContain("candidate_seq");
    });
  });

  it("indexes only active tasks with a stable executor and preserves deterministic ordering", async () => {
    const ledger = ledgerFor("claim-candidate-index-membership");
    await createTask(ledger, "candidate-z", "agent:worker-1", "SCHEDULED", now);
    await createTask(ledger, "candidate-a", "agent:worker-1", "RUNNING", now);
    await createTask(ledger, "candidate-terminal", "agent:worker-1", "COMPLETED", now + 1);
    await createTask(ledger, "candidate-other-executor", "agent:worker-2", "SCHEDULED", now + 2);

    await runInDurableObject(ledger, async (_instance, state) => {
      const rows = state.storage.sql.exec(
        "SELECT task_id, executor_id, created_at FROM orchestrator_claim_candidates WHERE executor_id = ? ORDER BY created_at, task_id",
        "agent:worker-1",
      ).toArray();
      expect(rows).toEqual([
        { task_id: "candidate-a", executor_id: "agent:worker-1", created_at: now },
        { task_id: "candidate-z", executor_id: "agent:worker-1", created_at: now },
      ]);
    });
  });

  it("keeps the candidate index consistent with authoritative task projections after task creation", async () => {
    const ledger = ledgerFor("claim-candidate-index-consistency");
    await createTask(ledger, "candidate-consistent-1", "agent:worker-1");
    await createTask(ledger, "candidate-consistent-2", "agent:worker-2", "FAILED", now + 1);

    await runInDurableObject(ledger, async (_instance, state) => {
      const expected = state.storage.sql.exec(
        "SELECT task_id, COALESCE(json_extract(task_json, '$.executorId'), json_extract(task_json, '$.assignedAgentId')) AS executor_id, created_at FROM orchestrator_tasks WHERE state IN ('SCHEDULED','RUNNING','VERIFYING') AND COALESCE(json_extract(task_json, '$.executorId'), json_extract(task_json, '$.assignedAgentId')) IS NOT NULL ORDER BY created_at, task_id",
      ).toArray();
      const actual = state.storage.sql.exec(
        "SELECT task_id, executor_id, created_at FROM orchestrator_claim_candidates ORDER BY created_at, task_id",
      ).toArray();
      expect(actual).toEqual(expected);
    });
  });
});


const ownerId = "335530603";
const repositoryId = 1398846697;
const ownerKeySet = JSON.stringify({
  "owner-v1": "3031323334353637383961626364656630313233343536373839616263646566",
});
const agent = { id: "agent:worker-1", authenticated: true, identityVerified: true, role: "agent" };
const transitionEvidence = { kind: "test-evidence", reference: "ci://candidate-index-transition" };

async function seedCandidate(ledger, taskId, executorId = "agent:worker-1", createdAt = now) {
  await runInDurableObject(ledger, async (_instance, state) => {
    state.storage.sql.exec(
      "INSERT INTO orchestrator_claim_candidates (task_id, executor_id, created_at) VALUES (?, ?, ?)",
      taskId, executorId, createdAt,
    );
  });
}

async function ownerCancelInput(taskId) {
  const command = {
    operation: "cancel", taskId, reason: "Owner requested cancellation",
    eventId: "candidate-owner-cancel-" + taskId,
  };
  const context = {
    actorId: ownerId, repositoryId, taskId, operation: command.operation,
    deliveryId: "delivery-" + taskId + "-0001",
    commentId: "987654321",
    commandHash: await sha256Canonical({
      eventId: command.eventId, operation: command.operation,
      reason: command.reason, taskId: command.taskId,
    }),
  };
  return {
    assertion: await createOwnerAssertion(ownerKeySet, "owner-v1", context, now),
    assertionContext: context,
    command,
    bodySha256: "c".repeat(64),
    provenance: {
      eventName: "issue_comment.created",
      repository: "mohammadrezayaghoobi123-dev/Chat-gpt",
      issueNumber: 7,
      commentCreatedAt: now,
    },
    now,
  };
}

describe("OrchestratorLedger candidate synchronization", () => {
  it("backfills candidate rows idempotently when the schema initializer is rerun", async () => {
    const ledger = ledgerFor("claim-candidate-index-backfill");
    await createTask(ledger, "candidate-backfill", "agent:worker-1");
    await runInDurableObject(ledger, async (instance, state) => {
      state.storage.sql.exec("DELETE FROM orchestrator_claim_candidates");
      instance.ensureSchema();
      const rows = state.storage.sql.exec(
        "SELECT task_id, executor_id, created_at FROM orchestrator_claim_candidates",
      ).toArray();
      expect(rows).toEqual([
        { task_id: "candidate-backfill", executor_id: "agent:worker-1", created_at: now },
      ]);
      instance.ensureSchema();
      expect(state.storage.sql.exec("SELECT COUNT(*) AS count FROM orchestrator_claim_candidates").one().count).toBe(1);
    });
  });

  it("removes a task from the candidate index atomically when it transitions out of claimable states", async () => {
    const ledger = ledgerFor("claim-candidate-index-transition-removal");
    await createTask(ledger, "candidate-transition", "agent:worker-1");
    const lease = await ledger.claimTask({
      workerId: "agent:worker-1",
      workerAssertion: await createWorkerAssertion({
        subject: "agent:worker-1", role: "agent", operation: "claimTask", nowMs: now,
      }),
      leaseMs: 30_000, now,
    });
    expect(lease).toMatchObject({ claimed: true, task: { taskId: "candidate-transition" } });
    const result = await ledger.transitionTask({
      taskId: "candidate-transition",
      expectedVersion: 1,
      expectedState: "SCHEDULED",
      nextState: "BLOCKED",
      actor: agent,
      evidence: transitionEvidence,
      now: now + 1,
      workerId: "agent:worker-1",
      workerAssertion: await createWorkerAssertion({
        subject: "agent:worker-1", role: "agent", operation: "transitionTask", nowMs: now + 1,
      }),
      leaseGeneration: lease.leaseGeneration,
    });
    expect(result).toMatchObject({ updated: true, task: { state: "BLOCKED", version: 2 } });
    await runInDurableObject(ledger, async (_instance, state) => {
      expect(state.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_claim_candidates WHERE task_id = ?",
        "candidate-transition",
      ).one().count).toBe(0);
    });
  });

  it("removes a task from the candidate index atomically when an Owner command cancels it", async () => {
    const ledger = ledgerFor("claim-candidate-index-owner-cancel");
    await createTask(ledger, "candidate-owner-cancel", "agent:worker-1");
    const result = await ledger.executeOwnerCommand(await ownerCancelInput("candidate-owner-cancel"));
    expect(result).toMatchObject({
      applied: true, operation: "cancel",
      task: { taskId: "candidate-owner-cancel", state: "CANCELLED", version: 2 },
    });
    await runInDurableObject(ledger, async (_instance, state) => {
      expect(state.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_claim_candidates WHERE task_id = ?",
        "candidate-owner-cancel",
      ).one().count).toBe(0);
    });
  });
});


describe("OrchestratorLedger lease/index separation", () => {
  it("keeps the derived task candidate row stable across lease claim and release", async () => {
    const ledger = ledgerFor("claim-candidate-index-lease-separation");
    await createTask(ledger, "candidate-lease-stable", "agent:worker-1");
    const before = await runInDurableObject(ledger, async (_instance, state) =>
      state.storage.sql.exec(
        "SELECT task_id, executor_id, created_at FROM orchestrator_claim_candidates WHERE task_id = ?",
        "candidate-lease-stable",
      ).one(),
    );
    const lease = await ledger.claimTask({
      workerId: "agent:worker-1",
      workerAssertion: await createWorkerAssertion({
        subject: "agent:worker-1", role: "agent", operation: "claimTask", nowMs: now,
      }),
      leaseMs: 30_000, now,
    });
    expect(lease).toMatchObject({ claimed: true });
    const released = await ledger.releaseLease({
      taskId: "candidate-lease-stable",
      workerId: "agent:worker-1",
      workerAssertion: await createWorkerAssertion({
        subject: "agent:worker-1", role: "agent", operation: "releaseLease", nowMs: now + 1,
      }),
      leaseGeneration: lease.leaseGeneration,
      now: now + 1,
    });
    expect(released).toMatchObject({ released: true });
    const after = await runInDurableObject(ledger, async (_instance, state) =>
      state.storage.sql.exec(
        "SELECT task_id, executor_id, created_at FROM orchestrator_claim_candidates WHERE task_id = ?",
        "candidate-lease-stable",
      ).one(),
    );
    expect(after).toEqual(before);
  });
});


describe("OrchestratorLedger candidate index fail-closed behavior", () => {
  it("does not claim an authoritative task when its derived candidate row is missing", async () => {
    const ledger = ledgerFor("claim-candidate-index-missing-row");
    await createTask(ledger, "candidate-missing-row", "agent:worker-1");
    await runInDurableObject(ledger, async (_instance, state) => {
      state.storage.sql.exec(
        "DELETE FROM orchestrator_claim_candidates WHERE task_id = ?",
        "candidate-missing-row",
      );
    });
    const result = await ledger.claimTask({
      workerId: "agent:worker-1",
      workerAssertion: await createWorkerAssertion({
        subject: "agent:worker-1", role: "agent", operation: "claimTask", nowMs: now,
      }),
      leaseMs: 30_000,
      now,
    });
    expect(result).toEqual({ claimed: false, reason: "CANDIDATE_INDEX_INCONSISTENT" });
    await runInDurableObject(ledger, async (_instance, state) => {
      expect(state.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_execution_leases WHERE task_id = ?",
        "candidate-missing-row",
      ).one().count).toBe(0);
    });
  });
});


describe("OrchestratorLedger claim candidate query plan", () => {
  it("uses the executor and deterministic-order candidate index", async () => {
    const ledger = ledgerFor("claim-candidate-query-plan");
    await createTask(ledger, "candidate-query-plan", "agent:worker-1");
    await runInDurableObject(ledger, async (_instance, state) => {
      const plan = state.storage.sql.exec(
        "EXPLAIN QUERY PLAN " + CLAIM_CANDIDATE_QUERY,
        "agent:worker-1", 0, 0, "", 129,
      ).toArray();
      const details = plan.map(row => row.detail).join("\n");
      expect(details).toContain("orchestrator_claim_candidates_by_executor_created");
      expect(details).not.toContain("USE TEMP B-TREE FOR ORDER BY");
    });
  });
});


describe("OrchestratorLedger bounded candidate cursor", () => {
  it("returns a bounded continuation and resumes without skipping pre-snapshot work", async () => {
    const ledger = ledgerFor("claim-candidate-bounded-cursor");
    const taskIds = Array.from({ length: 129 }, (_value, index) =>
      "task-" + String(index).padStart(3, "0"),
    );
    for (const taskId of taskIds) {
      await createTask(ledger, taskId, "agent:worker-1");
    }
    await runInDurableObject(ledger, async (_instance, state) => {
      state.storage.transactionSync(() => {
        for (const taskId of taskIds.slice(0, 128)) {
          state.storage.sql.exec(
            "INSERT INTO orchestrator_execution_leases (task_id, worker_id, lease_generation, lease_until, updated_at) VALUES (?, ?, 1, ?, ?)",
            taskId, "agent:other-worker", now + 60_000, now,
          );
        }
      });
    });

    const first = await ledger.claimTask({
      workerId: "agent:worker-1",
      workerAssertion: await createWorkerAssertion({
        subject: "agent:worker-1", role: "agent", operation: "claimTask", nowMs: now,
      }),
      leaseMs: 30_000,
      now,
    });
    expect(first).toMatchObject({
      claimed: false,
      reason: "CLAIM_SCAN_BUDGET_EXHAUSTED",
      nextCursor: {
        version: 1,
        executorId: "agent:worker-1",
        snapshotSequence: 129,
        createdAt: now,
        taskId: "task-127",
      },
      candidatesExamined: 128,
      candidateRowsRead: 129,
    });

    // This task sorts before the cursor but was created after the scan snapshot.
    await createTask(ledger, "task-000-new", "agent:worker-1", "SCHEDULED", now);

    const second = await ledger.claimTask({
      workerId: "agent:worker-1",
      workerAssertion: await createWorkerAssertion({
        subject: "agent:worker-1", role: "agent", operation: "claimTask", nowMs: now + 1,
      }),
      leaseMs: 30_000,
      now: now + 1,
      cursor: first.nextCursor,
    });
    expect(second).toMatchObject({
      claimed: true,
      task: { taskId: "task-128" },
      leaseGeneration: 1,
      candidatesExamined: 1,
      candidateRowsRead: 1,
    });
  });
});


describe("OrchestratorLedger reconciliation fail-closed policy", () => {
  it("does not accept caller-shaped reconciliation evidence without a trusted issuer", async () => {
    const ledger = ledgerFor("claim-reconciliation-untrusted-evidence");
    await createTask(ledger, "candidate-expired-lease", "agent:worker-1");
    const first = await ledger.claimTask({
      workerId: "agent:worker-1",
      workerAssertion: await createWorkerAssertion({
        subject: "agent:worker-1", role: "agent", operation: "claimTask", nowMs: now,
      }),
      leaseMs: 100,
      now,
    });
    expect(first).toMatchObject({ claimed: true, leaseGeneration: 1 });
    const result = await ledger.claimTask({
      workerId: "agent:worker-1",
      workerAssertion: await createWorkerAssertion({
        subject: "agent:worker-1", role: "agent", operation: "claimTask", nowMs: now + 101,
      }),
      leaseMs: 100,
      now: now + 101,
      reconciliationEvidence: {
        checked: true,
        priorGeneration: first.leaseGeneration,
        evidenceRef: "github://untrusted-caller-controlled-reference",
      },
    });
    expect(result).toMatchObject({ claimed: false, reason: "RECONCILIATION_REQUIRED" });
    await runInDurableObject(ledger, async (_instance, state) => {
      expect(state.storage.sql.exec(
        "SELECT worker_id, lease_generation, lease_until FROM orchestrator_execution_leases WHERE task_id = ?",
        "candidate-expired-lease",
      ).one()).toMatchObject({
        worker_id: "agent:worker-1",
        lease_generation: 1,
        lease_until: now + 100,
      });
    });
  });
});


describe("OrchestratorLedger migration, concurrency, and scale", () => {
  it("migrates the previous candidate-table schema without losing eligible rows", async () => {
    const ledger = ledgerFor("claim-candidate-index-legacy-migration");
    await createTask(ledger, "candidate-legacy-migration", "agent:worker-1");
    await runInDurableObject(ledger, async (instance, state) => {
      state.storage.sql.exec("DROP INDEX orchestrator_claim_candidates_by_executor_created");
      state.storage.sql.exec("DROP TABLE orchestrator_claim_candidates");
      state.storage.sql.exec(`
        CREATE TABLE orchestrator_claim_candidates (
          task_id TEXT PRIMARY KEY REFERENCES orchestrator_tasks(task_id) ON DELETE CASCADE,
          executor_id TEXT NOT NULL,
          created_at INTEGER NOT NULL
        )
      `);
      state.storage.sql.exec(
        "CREATE INDEX orchestrator_claim_candidates_by_executor_created ON orchestrator_claim_candidates(executor_id, created_at, task_id)",
      );
      state.storage.sql.exec(
        "INSERT INTO orchestrator_claim_candidates (task_id, executor_id, created_at) VALUES (?, ?, ?)",
        "candidate-legacy-migration", "agent:worker-1", now,
      );
      instance.ensureSchema();
      const columns = state.storage.sql.exec(
        "PRAGMA table_info(orchestrator_claim_candidates)",
      ).toArray().map(row => row.name);
      expect(columns).toContain("candidate_seq");
      expect(state.storage.sql.exec(
        "SELECT task_id, executor_id, created_at FROM orchestrator_claim_candidates",
      ).toArray()).toEqual([
        { task_id: "candidate-legacy-migration", executor_id: "agent:worker-1", created_at: now },
      ]);
      expect(state.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'orchestrator_claim_candidates_legacy'",
      ).one().count).toBe(0);
    });
  });

  it("claims distinct tasks under concurrent multi-worker contention", async () => {
    const ledger = ledgerFor("claim-candidate-multi-worker-contention");
    const taskIds = [];
    for (let index = 0; index < 12; index++) {
      const workerId = index % 2 === 0 ? "agent:worker-1" : "agent:worker-2";
      const taskId = "candidate-concurrent-" + String(index).padStart(2, "0");
      taskIds.push(taskId);
      await createTask(ledger, taskId, workerId);
    }
    const results = await Promise.all(Array.from({ length: 12 }, async (_value, index) => {
      const workerId = index % 2 === 0 ? "agent:worker-1" : "agent:worker-2";
      return ledger.claimTask({
        workerId,
        workerAssertion: await createWorkerAssertion({
          subject: workerId, role: "agent", operation: "claimTask", nowMs: now,
        }),
        leaseMs: 30_000,
        now,
      });
    }));
    const claimed = results.filter(result => result.claimed);
    const claimedIds = claimed.map(result => result.task.taskId);
    expect(claimed).toHaveLength(12);
    expect(new Set(claimedIds).size).toBe(12);
    expect(new Set(claimedIds)).toEqual(new Set(taskIds));
    await runInDurableObject(ledger, async (_instance, state) => {
      expect(state.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_execution_leases WHERE worker_id IS NOT NULL",
      ).one().count).toBe(12);
    });
  });

  it("bounds work and resumes losslessly across a 30,000-task, 29,999-active-lease queue", async () => {
    const ledger = ledgerFor("claim-candidate-30000-stress");
    await runInDurableObject(ledger, async (_instance, state) => {
      state.storage.transactionSync(() => {
        for (let start = 1; start <= 30_000; start += 1_000) {
          const end = Math.min(start + 999, 30_000);
          state.storage.sql.exec(`
            WITH RECURSIVE seq(n) AS (
              SELECT ? UNION ALL SELECT n + 1 FROM seq WHERE n < ?
            )
            INSERT INTO orchestrator_tasks
              (task_id, idempotency_key, input_hash, state, version, task_json, created_at, updated_at)
            SELECT
              'stress-' || printf('%05d', n),
              'stress-idem-' || printf('%05d', n),
              ?, 'SCHEDULED', 1,
              json_object(
                'taskId', 'stress-' || printf('%05d', n),
                'state', 'SCHEDULED', 'version', 1, 'agentRound', 0,
                'createdAt', ?, 'updatedAt', ?, 'executorId', 'agent:worker-1',
                'commitSha', ?, 'objective', '30k candidate stress fixture'
              ),
              ?, ?
            FROM seq
          `, start, end, "a".repeat(64), now, now, "b".repeat(40), now, now);
        }
        state.storage.sql.exec(`
          INSERT INTO orchestrator_claim_candidates (task_id, executor_id, created_at)
          SELECT task_id, 'agent:worker-1', created_at
          FROM orchestrator_tasks
          WHERE task_id LIKE 'stress-%'
          ORDER BY created_at, task_id
        `);
        state.storage.sql.exec(`
          INSERT INTO orchestrator_execution_leases
            (task_id, worker_id, lease_generation, lease_until, updated_at)
          SELECT task_id, 'agent:other-worker', 1, ?, ?
          FROM orchestrator_tasks
          WHERE task_id LIKE 'stress-%' AND task_id != 'stress-30000'
        `, now + 60_000, now);
      });
      expect(state.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_claim_candidates WHERE executor_id = ?",
        "agent:worker-1",
      ).one().count).toBe(30_000);
      expect(state.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_execution_leases",
      ).one().count).toBe(29_999);
    });

    let result = await ledger.claimTask({
      workerId: "agent:worker-1",
      workerAssertion: await createWorkerAssertion({
        subject: "agent:worker-1", role: "agent", operation: "claimTask", nowMs: now,
      }),
      leaseMs: 30_000,
      now,
    });
    let calls = 1;
    let cursor = result.nextCursor;
    while (!result.claimed && cursor && calls < 300) {
      result = await ledger.claimTask({
        workerId: "agent:worker-1",
        workerAssertion: await createWorkerAssertion({
          subject: "agent:worker-1", role: "agent", operation: "claimTask", nowMs: now + calls,
        }),
        leaseMs: 30_000,
        now: now + calls,
        cursor,
      });
      expect(result.candidatesExamined).toBeLessThanOrEqual(128);
      expect(result.candidateRowsRead).toBeLessThanOrEqual(129);
      cursor = result.nextCursor;
      calls++;
    }
    expect(result).toMatchObject({
      claimed: true,
      task: { taskId: "stress-30000" },
      leaseGeneration: 1,
    });
    expect(calls).toBe(235);
  });
});


describe("OrchestratorLedger claim concurrency and cursor validation", () => {
  it("allows only one concurrent claimant to acquire the same task lease", async () => {
    const ledger = ledgerFor("claim-candidate-same-task-contention");
    await createTask(ledger, "candidate-contention-one", "agent:worker-1");
    const results = await Promise.all(Array.from({ length: 20 }, async () => ledger.claimTask({
      workerId: "agent:worker-1",
      workerAssertion: await createWorkerAssertion({
        subject: "agent:worker-1", role: "agent", operation: "claimTask", nowMs: now,
      }),
      leaseMs: 30_000,
      now,
    })));
    expect(results.filter(result => result.claimed)).toHaveLength(1);
    expect(results.filter(result => !result.claimed && result.reason === "NO_TASK_AVAILABLE")).toHaveLength(19);
    await runInDurableObject(ledger, async (_instance, state) => {
      expect(state.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_execution_leases WHERE task_id = ? AND worker_id IS NOT NULL",
        "candidate-contention-one",
      ).one().count).toBe(1);
    });
  });

  it("rejects a cursor scoped to a different executor before any lease side effect", async () => {
    const ledger = ledgerFor("claim-candidate-invalid-cursor");
    await createTask(ledger, "candidate-invalid-cursor", "agent:worker-1");
    const result = await ledger.claimTask({
      workerId: "agent:worker-1",
      workerAssertion: await createWorkerAssertion({
        subject: "agent:worker-1", role: "agent", operation: "claimTask", nowMs: now,
      }),
      leaseMs: 30_000,
      now,
      cursor: {
        version: 1,
        executorId: "agent:worker-2",
        snapshotSequence: 1,
        createdAt: now,
        taskId: "candidate-invalid-cursor",
      },
    });
    expect(result).toEqual({ claimed: false, reason: "INVALID_CLAIM_CURSOR" });
    await runInDurableObject(ledger, async (_instance, state) => {
      expect(state.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_execution_leases WHERE task_id = ?",
        "candidate-invalid-cursor",
      ).one().count).toBe(0);
    });
  });
});


describe("OrchestratorLedger candidate identifier invariant", () => {
  it("does not backfill malformed executor identifiers into the candidate index", async () => {
    const ledger = ledgerFor("claim-candidate-invalid-executor");
    await createTask(ledger, "candidate-invalid-executor", "agent worker");
    await runInDurableObject(ledger, async (instance, state) => {
      instance.ensureSchema();
      expect(state.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_claim_candidates WHERE task_id = ?",
        "candidate-invalid-executor",
      ).one().count).toBe(0);
    });
  });
});
