import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { createOwnerAssertion } from "../orchestrator-owner-assertion.js";
import { canonicalJson, sha256Canonical } from "../orchestrator-protocol.js";

const now = 1_800_000_000_000;
const ownerId = "335530603";
const repositoryId = 1398846697;
const ownerKeySet = JSON.stringify({
  "owner-v1": "3031323334353637383961626364656630313233343536373839616263646566",
});
const workerKey = Uint8Array.from(
  "3031323334353637383961626364656630313233343536373839616263646566".match(/../g),
  byte => Number.parseInt(byte, 16),
);

async function workerAssertion(subject, role, operation, at = now) {
  const claims = {
    v: 1,
    iss: "chat-gpt111-worker",
    aud: "orchestrator-ledger",
    sub: subject,
    role,
    op: operation,
    iat: Math.floor(at / 1000),
    exp: Math.floor(at / 1000) + 60,
    jti: "multi-actor-jti-" + crypto.randomUUID(),
  };
  const payload = btoa(String.fromCharCode(...new TextEncoder().encode(canonicalJson(claims))))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  const input = "v1.test-v1." + payload;
  const key = await crypto.subtle.importKey(
    "raw",
    workerKey,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(input)),
  );
  const encoded = btoa(String.fromCharCode(...signature))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return input + "." + encoded;
}

function assertionJti(token) {
  const payload = token.split(".")[2].replace(/-/g, "+").replace(/_/g, "/");
  const decoded = atob(payload + "=".repeat((4 - payload.length % 4) % 4));
  return JSON.parse(decoded).jti;
}

function ledgerFor(name) {
  return env.ORCHESTRATOR_LEDGER.get(env.ORCHESTRATOR_LEDGER.idFromName(name));
}

function task(taskId) {
  return {
    taskId,
    state: "SCHEDULED",
    version: 1,
    agentRound: 0,
    createdAt: now,
    updatedAt: now,
    executorId: "agent:worker-1",
    commitSha: "a".repeat(40),
    objective: "multi-actor outbox linearizability test",
  };
}

async function createTask(ledger, taskId) {
  return ledger.createTask({
    task: task(taskId),
    idempotencyKey: "multi-actor-create-" + taskId,
    inputHash: "b".repeat(64),
    now,
    workerId: "orchestrator-scheduler",
    workerAssertion: await workerAssertion(
      "orchestrator-scheduler",
      "system",
      "createTask",
      now,
    ),
  });
}

async function ownerInput({ operation, taskId, eventId, suffix, at }) {
  const command = {
    operation,
    taskId,
    eventId,
    reason: "Owner requested " + operation,
  };
  const context = {
    actorId: ownerId,
    repositoryId,
    taskId,
    operation,
    deliveryId: "delivery-multi-actor-" + suffix,
    commentId: String(123456820 + Number(suffix)),
    commandHash: await sha256Canonical({
      eventId,
      operation,
      reason: command.reason,
      taskId,
    }),
  };
  return {
    assertion: await createOwnerAssertion(ownerKeySet, "owner-v1", context, at),
    assertionContext: context,
    command,
    bodySha256: "c".repeat(64),
    provenance: {
      eventName: "issue_comment.created",
      repository: "mohammadrezayaghoobi123-dev/Chat-gpt",
      issueNumber: 7,
      commentCreatedAt: at,
    },
    now: at,
  };
}

async function enqueueTaskEvent(ledger, { taskId, eventId, idempotencyKey, payload, at }) {
  return ledger.enqueueOutbox({
    eventId,
    idempotencyKey,
    taskId,
    eventType: "task.transitioned",
    payload,
    workerId: "agent:worker-1",
    workerAssertion: await workerAssertion("agent:worker-1", "agent", "enqueueOutbox", at),
    now: at,
  });
}

async function consumerReceipt(instance, {
  eventId,
  idempotencyKey,
  taskId,
  payload,
  createdAt,
  envelopeSha256,
  at,
}) {
  const consumerId = "orchestrator-outbox-consumer";
  const assertion = await workerAssertion(
    consumerId,
    "consumer",
    "recordOutboxReceipt",
    at,
  );
  const result = await instance.recordOutboxReceipt({
    eventId,
    eventType: "task.transitioned",
    idempotencyKey,
    taskId,
    payload,
    createdAt,
    schemaVersion: 1,
    envelopeSha256,
    consumerId,
    workerAssertion: assertion,
    now: at,
  });
  return { result, jti: assertionJti(assertion) };
}

async function holdOwnerAfterSnapshot(instance, input, eventType, interleave) {
  let releaseGate;
  let signalGate;
  let held = false;
  const reached = new Promise(resolve => {
    signalGate = resolve;
  });
  const gate = new Promise(resolve => {
    releaseGate = resolve;
  });
  const originalDigest = crypto.subtle.digest;
  const digestSpy = vi.spyOn(crypto.subtle, "digest").mockImplementation(
    async function (algorithm, data) {
      const serialized = new TextDecoder().decode(data);
      if (
        !held &&
        serialized.includes('"eventType":"' + eventType + '"') &&
        serialized.includes(input.command.eventId)
      ) {
        held = true;
        signalGate();
        await gate;
      }
      return Reflect.apply(originalDigest, this, [algorithm, data]);
    },
  );

  try {
    const ownerPromise = instance.executeOwnerCommand(input);
    await reached;
    const interleaved = await interleave(instance);
    releaseGate();
    const ownerResult = await ownerPromise;
    return { interleaved, ownerResult };
  } finally {
    releaseGate();
    digestSpy.mockRestore();
  }
}

describe("Multi-actor Owner, Agent, Publisher, and Consumer linearizability", () => {
  it("linearizes Owner Cancel after an Agent transition and fences late Publisher ACK and Consumer receipt", async () => {
    const taskId = "task-multi-actor-cancel-0001";
    const ledger = ledgerFor("multi-actor-cancel-publisher-consumer");
    await createTask(ledger, taskId);

    const claim = await ledger.claimTask({
      taskId,
      workerId: "agent:worker-1",
      workerAssertion: await workerAssertion("agent:worker-1", "agent", "claimTask", now + 1),
      leaseMs: 30_000,
      now: now + 1,
    });
    expect(claim).toMatchObject({ claimed: true, leaseGeneration: 1 });

    const eventId = "multi-actor-cancel-outbox-0001";
    const idempotencyKey = "multi-actor-cancel-dedupe-0001";
    const payload = { taskId, version: 1, from: "READY", to: "SCHEDULED" };
    expect(await enqueueTaskEvent(ledger, {
      taskId,
      eventId,
      idempotencyKey,
      payload,
      at: now + 1,
    })).toMatchObject({ enqueued: true });

    const publisherId = "orchestrator-outbox-publisher";
    const publisherClaim = await ledger.claimOutbox({
      workerId: publisherId,
      workerAssertion: await workerAssertion(publisherId, "publisher", "claimOutbox", now + 2),
      leaseMs: 30_000,
      now: now + 2,
    });
    expect(publisherClaim).toMatchObject({
      claimed: true,
      event: { eventId },
      leaseGeneration: 1,
    });

    const transitionAssertion = await workerAssertion(
      "agent:worker-1",
      "agent",
      "transitionTask",
      now + 3,
    );
    const transitionJti = assertionJti(transitionAssertion);
    const command = await ownerInput({
      operation: "cancel",
      taskId,
      eventId: "owner-multi-actor-cancel-0001",
      suffix: "01",
      at: now + 4,
    });

    let transition;
    let latePublisher;
    let lateReceipt;
    let publisherJti;
    let consumerJti;
    await runInDurableObject(ledger, async instance => {
      const race = await holdOwnerAfterSnapshot(
        instance,
        command,
        "OWNER_TASK_CANCELLED",
        async ownerInstance => {
          transition = await ownerInstance.transitionTask({
            taskId,
            expectedVersion: 1,
            expectedState: "SCHEDULED",
            nextState: "RUNNING",
            actor: { id: "agent:worker-1", role: "agent" },
            evidence: { executionStartedAt: now + 3 },
            now: now + 3,
            workerId: "agent:worker-1",
            workerAssertion: transitionAssertion,
            leaseGeneration: claim.leaseGeneration,
          });
          return transition;
        },
      );
      expect(race.ownerResult).toMatchObject({
        applied: true,
        operation: "cancel",
        task: { taskId, state: "CANCELLED", version: 3 },
      });
      latePublisher = await workerAssertion(publisherId, "publisher", "completeOutbox", now + 5);
      publisherJti = assertionJti(latePublisher);
      const publisherResult = await instance.completeOutbox({
        eventId,
        workerId: publisherId,
        workerAssertion: latePublisher,
        leaseGeneration: publisherClaim.leaseGeneration,
        now: now + 5,
      });
      expect(publisherResult).toMatchObject({
        completed: false,
        reason: "LEASE_FENCE_MISMATCH",
      });

      const receipt = await consumerReceipt(instance, {
        eventId,
        idempotencyKey,
        taskId,
        payload,
        createdAt: now + 1,
        envelopeSha256: "d".repeat(64),
        at: now + 6,
      });
      lateReceipt = receipt.result;
      consumerJti = receipt.jti;
    });

    expect(transition).toMatchObject({
      updated: true,
      task: { taskId, state: "RUNNING", version: 2 },
    });
    expect(lateReceipt).toMatchObject({
      recorded: false,
      blocked: true,
      reason: "TASK_VERSION_FENCED",
    });
    await expect(ledger.getTask({ taskId })).resolves.toMatchObject({
      taskId,
      state: "CANCELLED",
      version: 3,
    });

    await runInDurableObject(ledger, async (_instance, state) => {
      expect(state.storage.sql.exec(
        "SELECT worker_id, lease_generation, lease_until FROM orchestrator_execution_leases WHERE task_id = ?",
        taskId,
      ).one()).toMatchObject({
        worker_id: null,
        lease_generation: 2,
        lease_until: 0,
      });
      expect(state.storage.sql.exec(
        "SELECT status, retry_state, lease_worker_id, lease_generation, lease_until FROM orchestrator_outbox_events WHERE event_id = ?",
        eventId,
      ).one()).toMatchObject({
        status: "IN_PROGRESS",
        retry_state: "DEAD_LETTER",
        lease_worker_id: null,
        lease_generation: 2,
        lease_until: 0,
      });
      expect(state.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_outbox_receipts WHERE event_id = ?",
        eventId,
      ).one().count).toBe(0);
      expect(state.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_owner_command_receipts WHERE task_id = ? AND operation = 'cancel'",
        taskId,
      ).one().count).toBe(1);
      expect(state.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_audit_events WHERE task_id = ? AND event_type = 'OWNER_TASK_CANCELLED'",
        taskId,
      ).one().count).toBe(1);
      expect(state.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_consumed_assertions WHERE jti = ?",
        transitionJti,
      ).one().count).toBe(1);
      expect(state.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_consumed_assertions WHERE jti = ?",
        publisherJti,
      ).one().count).toBe(0);
      expect(state.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_consumed_assertions WHERE jti = ?",
        consumerJti,
      ).one().count).toBe(1);
    });
  });

  it("linearizes Owner Quarantine after Agent releaseLease and rejects a late Consumer receipt", async () => {
    const taskId = "task-multi-actor-quarantine-release-0001";
    const ledger = ledgerFor("multi-actor-quarantine-release-consumer");
    await createTask(ledger, taskId);

    const claim = await ledger.claimTask({
      taskId,
      workerId: "agent:worker-1",
      workerAssertion: await workerAssertion("agent:worker-1", "agent", "claimTask", now + 1),
      leaseMs: 30_000,
      now: now + 1,
    });
    expect(claim).toMatchObject({ claimed: true, leaseGeneration: 1 });

    const eventId = "multi-actor-quarantine-outbox-0001";
    const idempotencyKey = "multi-actor-quarantine-dedupe-0001";
    const payload = { taskId, version: 1, from: "READY", to: "SCHEDULED" };
    expect(await enqueueTaskEvent(ledger, {
      taskId,
      eventId,
      idempotencyKey,
      payload,
      at: now + 1,
    })).toMatchObject({ enqueued: true });

    const command = await ownerInput({
      operation: "quarantine",
      taskId,
      eventId: "owner-multi-actor-quarantine-0001",
      suffix: "02",
      at: now + 4,
    });

    let releaseResult;
    let lateReleaseResult;
    let lateReleaseJti;
    let lateReceipt;
    let consumerJti;
    await runInDurableObject(ledger, async instance => {
      const race = await holdOwnerAfterSnapshot(
        instance,
        command,
        "OWNER_TASK_QUARANTINED",
        async ownerInstance => {
          const assertion = await workerAssertion(
            "agent:worker-1",
            "agent",
            "releaseLease",
            now + 2,
          );
          const result = await ownerInstance.releaseLease({
            taskId,
            workerId: "agent:worker-1",
            workerAssertion: assertion,
            leaseGeneration: claim.leaseGeneration,
            now: now + 2,
          });
          return { result, jti: assertionJti(assertion) };
        },
      );
      releaseResult = race.interleaved.result;
      expect(race.ownerResult).toMatchObject({
        applied: true,
        operation: "quarantine",
        task: { taskId, state: "QUARANTINED", version: 2 },
      });

      const staleAssertion = await workerAssertion(
        "agent:worker-1",
        "agent",
        "releaseLease",
        now + 5,
      );
      lateReleaseJti = assertionJti(staleAssertion);
      lateReleaseResult = await instance.releaseLease({
        taskId,
        workerId: "agent:worker-1",
        workerAssertion: staleAssertion,
        leaseGeneration: claim.leaseGeneration,
        now: now + 5,
      });
      expect(lateReleaseResult).toMatchObject({
        released: false,
        reason: "LEASE_FENCE_MISMATCH",
      });

      const receipt = await consumerReceipt(instance, {
        eventId,
        idempotencyKey,
        taskId,
        payload,
        createdAt: now + 1,
        envelopeSha256: "e".repeat(64),
        at: now + 6,
      });
      lateReceipt = receipt.result;
      consumerJti = receipt.jti;
    });

    expect(releaseResult).toMatchObject({ released: true, leaseGeneration: 1 });
    expect(lateReceipt).toMatchObject({
      recorded: false,
      blocked: true,
      reason: "TASK_VERSION_FENCED",
    });
    await expect(ledger.getTask({ taskId })).resolves.toMatchObject({
      taskId,
      state: "QUARANTINED",
      version: 2,
    });

    await runInDurableObject(ledger, async (_instance, state) => {
      expect(state.storage.sql.exec(
        "SELECT worker_id, lease_generation, lease_until FROM orchestrator_execution_leases WHERE task_id = ?",
        taskId,
      ).one()).toMatchObject({
        worker_id: null,
        lease_generation: 2,
        lease_until: 0,
      });
      expect(state.storage.sql.exec(
        "SELECT status, retry_state, lease_worker_id, lease_generation, lease_until FROM orchestrator_outbox_events WHERE event_id = ?",
        eventId,
      ).one()).toMatchObject({
        status: "PENDING",
        retry_state: "DEAD_LETTER",
        lease_worker_id: null,
        lease_generation: 1,
        lease_until: 0,
      });
      expect(state.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_outbox_receipts WHERE event_id = ?",
        eventId,
      ).one().count).toBe(0);
      expect(state.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_owner_command_receipts WHERE task_id = ? AND operation = 'quarantine'",
        taskId,
      ).one().count).toBe(1);
      expect(state.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_audit_events WHERE task_id = ? AND event_type = 'OWNER_TASK_QUARANTINED'",
        taskId,
      ).one().count).toBe(1);
      expect(state.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_consumed_assertions WHERE jti = ?",
        raceJtiPlaceholder,
      ).one().count).toBe(1);
      expect(state.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_consumed_assertions WHERE jti = ?",
        lateReleaseJti,
      ).one().count).toBe(0);
      expect(state.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_consumed_assertions WHERE jti = ?",
        consumerJti,
      ).one().count).toBe(1);
    });
  });

  it.each([
    ["cancel", "CANCELLED", "OWNER_TASK_CANCELLED"],
    ["quarantine", "QUARANTINED", "OWNER_TASK_QUARANTINED"],
  ])("preserves a valid Consumer receipt committed before Owner %s", async (operation, expectedState, auditType) => {
    const suffix = operation === "cancel" ? "03" : "04";
    const taskId = "task-multi-actor-preowner-receipt-" + operation;
    const ledger = ledgerFor("multi-actor-preowner-receipt-" + operation);
    await createTask(ledger, taskId);

    const eventId = "multi-actor-preowner-event-" + operation;
    const idempotencyKey = "multi-actor-preowner-dedupe-" + operation;
    const payload = { taskId, version: 1, from: "READY", to: "SCHEDULED" };
    expect(await enqueueTaskEvent(ledger, {
      taskId,
      eventId,
      idempotencyKey,
      payload,
      at: now + 1,
    })).toMatchObject({ enqueued: true });

    const command = await ownerInput({
      operation,
      taskId,
      eventId: "owner-multi-actor-preowner-" + operation,
      suffix,
      at: now + 4,
    });

    let firstReceipt;
    let replayReceipt;
    let firstConsumerJti;
    let replayConsumerJti;
    await runInDurableObject(ledger, async instance => {
      const race = await holdOwnerAfterSnapshot(
        instance,
        command,
        auditType,
        async ownerInstance => {
          const receipt = await consumerReceipt(ownerInstance, {
            eventId,
            idempotencyKey,
            taskId,
            payload,
            createdAt: now + 1,
            envelopeSha256: "f".repeat(64),
            at: now + 2,
          });
          return receipt;
        },
      );
      firstReceipt = race.interleaved.result;
      firstConsumerJti = race.interleaved.jti;
      expect(firstReceipt).toMatchObject({ recorded: true, eventId });
      expect(race.ownerResult).toMatchObject({
        applied: true,
        operation,
        task: { taskId, state: expectedState, version: 2 },
      });

      const replay = await consumerReceipt(instance, {
        eventId,
        idempotencyKey,
        taskId,
        payload,
        createdAt: now + 1,
        envelopeSha256: "f".repeat(64),
        at: now + 6,
      });
      replayReceipt = replay.result;
      replayConsumerJti = replay.jti;
    });

    expect(replayReceipt).toMatchObject({
      recorded: false,
      replay: true,
      eventId,
    });
    await expect(ledger.getTask({ taskId })).resolves.toMatchObject({
      taskId,
      state: expectedState,
      version: 2,
    });

    await runInDurableObject(ledger, async (_instance, state) => {
      expect(state.storage.sql.exec(
        "SELECT status, retry_state, lease_worker_id, lease_generation, lease_until FROM orchestrator_outbox_events WHERE event_id = ?",
        eventId,
      ).one()).toMatchObject({
        status: "PENDING",
        retry_state: "DEAD_LETTER",
        lease_worker_id: null,
        lease_generation: 1,
        lease_until: 0,
      });
      expect(state.storage.sql.exec(
        "SELECT event_id, event_type, schema_version, envelope_sha256, consumer_id FROM orchestrator_outbox_receipts WHERE event_id = ?",
        eventId,
      ).one()).toMatchObject({
        event_id: eventId,
        event_type: "task.transitioned",
        schema_version: 1,
        envelope_sha256: "f".repeat(64),
        consumer_id: "orchestrator-outbox-consumer",
      });
      expect(state.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_outbox_receipts WHERE event_id = ?",
        eventId,
      ).one().count).toBe(1);
      expect(state.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_owner_command_receipts WHERE task_id = ? AND operation = ?",
        taskId,
        operation,
      ).one().count).toBe(1);
      expect(state.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_audit_events WHERE task_id = ? AND event_type = ?",
        taskId,
        auditType,
      ).one().count).toBe(1);
      expect(state.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_consumed_assertions WHERE jti IN (?, ?)",
        firstConsumerJti,
        replayConsumerJti,
      ).one().count).toBe(2);
    });
  });
});
