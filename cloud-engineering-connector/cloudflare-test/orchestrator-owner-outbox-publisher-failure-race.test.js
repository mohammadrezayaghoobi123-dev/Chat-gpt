import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { createOwnerAssertion } from "../orchestrator-owner-assertion.js";
import { canonicalJson, sha256Canonical } from "../orchestrator-protocol.js";
import { consumeOrchestratorOutbox, processOrchestratorOutbox } from "../worker.js";

const baseNow = 1_800_000_000_000;
const ownerId = "335530603";
const repositoryId = 1398846697;
const publisherId = "orchestrator-outbox-publisher";
const consumerId = "orchestrator-outbox-consumer";
const ownerKeySet = JSON.stringify({
  "owner-v1": "3031323334353637383961626364656630313233343536373839616263646566",
});
const workerKey = Uint8Array.from(
  "3031323334353637383961626364656630313233343536373839616263646566".match(/../g),
  byte => Number.parseInt(byte, 16),
);

async function workerAssertion(subject, role, operation, at) {
  const claims = {
    v: 1,
    iss: "chat-gpt111-worker",
    aud: "orchestrator-ledger",
    sub: subject,
    role,
    op: operation,
    iat: Math.floor(at / 1000),
    exp: Math.floor(at / 1000) + 60,
    jti: "owner-publisher-race-jti-" + crypto.randomUUID(),
  };
  const payload = btoa(String.fromCharCode(...new TextEncoder().encode(canonicalJson(claims))))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  const signingInput = "v1.test-v1." + payload;
  const key = await crypto.subtle.importKey(
    "raw",
    workerKey,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signingInput)),
  );
  const encoded = btoa(String.fromCharCode(...signature))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return signingInput + "." + encoded;
}

function ledgerFor(name) {
  return env.ORCHESTRATOR_LEDGER.get(env.ORCHESTRATOR_LEDGER.idFromName(name));
}

function makeTask(taskId) {
  return {
    taskId,
    state: "SCHEDULED",
    version: 1,
    agentRound: 0,
    createdAt: baseNow,
    updatedAt: baseNow,
    executorId: "agent:worker-1",
    commitSha: "a".repeat(40),
    objective: "Owner transition versus in-flight Outbox publisher callback",
  };
}

async function createTask(ledger, taskId) {
  return ledger.createTask({
    task: makeTask(taskId),
    idempotencyKey: "owner-publisher-race-create-" + taskId,
    inputHash: "b".repeat(64),
    now: baseNow,
    workerId: "orchestrator-scheduler",
    workerAssertion: await workerAssertion(
      "orchestrator-scheduler",
      "system",
      "createTask",
      baseNow,
    ),
  });
}

async function ownerCommand({ operation, taskId, eventId, suffix, at }) {
  const command = {
    operation,
    taskId,
    eventId,
    reason: "Owner requested " + operation,
  };
  const assertionContext = {
    actorId: ownerId,
    repositoryId,
    taskId,
    operation,
    deliveryId: "delivery-owner-publisher-race-" + suffix,
    commentId: String(123456900 + Number(suffix)),
    commandHash: await sha256Canonical({
      eventId,
      operation,
      reason: command.reason,
      taskId,
    }),
  };
  return {
    assertion: await createOwnerAssertion(ownerKeySet, "owner-v1", assertionContext, at),
    assertionContext,
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

function ledgerRuntimeBinding(ledger) {
  return {
    idFromName: name => name,
    get: name => name === "orchestrator-ledger-global" ? ledger : null,
  };
}

function publisherRuntime(ledger, queue) {
  return {
    ORCHESTRATOR_LEDGER: ledgerRuntimeBinding(ledger),
    ORCHESTRATOR_OUTBOX_QUEUE: queue,
    LEDGER_WORKER_ASSERTION_KEYS: env.LEDGER_WORKER_ASSERTION_KEYS,
    LEDGER_WORKER_ASSERTION_ACTIVE_KID: "test-v1",
  };
}

function consumerRuntime(ledger) {
  return {
    ORCHESTRATOR_LEDGER: ledgerRuntimeBinding(ledger),
    LEDGER_WORKER_ASSERTION_KEYS: env.LEDGER_WORKER_ASSERTION_KEYS,
    LEDGER_WORKER_ASSERTION_ACTIVE_KID: "test-v1",
  };
}

describe("Owner transition versus in-flight Outbox Publisher callback", () => {
  it.each([
    ["failure", "cancel", "CANCELLED", "OWNER_TASK_CANCELLED", "OWNER_CANCELLED", "11"],
    ["success", "cancel", "CANCELLED", "OWNER_TASK_CANCELLED", "OWNER_CANCELLED", "12"],
    ["failure", "quarantine", "QUARANTINED", "OWNER_TASK_QUARANTINED", "OWNER_QUARANTINED", "13"],
    ["success", "quarantine", "QUARANTINED", "OWNER_TASK_QUARANTINED", "OWNER_QUARANTINED", "14"],
  ])(
    "prevents a late Publisher %s callback from reopening an event after Owner %s",
    async (sendOutcome, operation, expectedState, auditType, ownerErrorCode, suffix) => {
      let clockNow = baseNow + 1;
      const dateNow = vi.spyOn(Date, "now").mockImplementation(() => clockNow);
      let releaseQueueSend;
      let signalQueueSend;
      let queueSendEntered = false;
      const queueSendGate = new Promise(resolve => {
        releaseQueueSend = resolve;
      });
      const queueSendStarted = new Promise(resolve => {
        signalQueueSend = resolve;
      });
      const queued = [];
      const taskId = "task-owner-publisher-race-" + operation + "-" + sendOutcome;
      const eventId = "evt-owner-publisher-race-" + operation + "-" + sendOutcome;
      const idempotencyKey = "outbox-owner-publisher-race-" + operation + "-" + sendOutcome;
      const payload = {
        taskId,
        version: 1,
        transition: "created",
        source: "owner-publisher-race",
      };
      const ledger = ledgerFor("orchestrator-ledger-global");

      try {
        expect(await createTask(ledger, taskId)).toMatchObject({
          created: true,
          task: { taskId, state: "SCHEDULED", version: 1 },
        });
        expect(await enqueueTaskEvent(ledger, {
          taskId,
          eventId,
          idempotencyKey,
          payload,
          at: baseNow + 1,
        })).toMatchObject({
          enqueued: true,
          event: { eventId, status: "PENDING", attempts: 0, leaseGeneration: 0 },
        });

        const queue = {
          send: async (message, options) => {
            queued.push({ message: structuredClone(message), options });
            if (!queueSendEntered) {
              queueSendEntered = true;
              signalQueueSend();
              await queueSendGate;
              if (sendOutcome === "failure") {
                throw new Error("Injected queue acknowledgement loss after transport acceptance.");
              }
            }
          },
        };
        const publisherPromise = processOrchestratorOutbox(
          publisherRuntime(ledger, queue),
          { maxEvents: 1 },
        );

        await queueSendStarted;
        expect(queued).toHaveLength(1);
        expect(queued[0]).toMatchObject({
          options: { contentType: "json" },
          message: {
            schemaVersion: 1,
            eventId,
            idempotencyKey,
            taskId,
            eventType: "task.transitioned",
            payload,
            attempts: 1,
            createdAt: baseNow + 1,
          },
        });

        clockNow = baseNow + 2;
        const input = await ownerCommand({
          operation,
          taskId,
          eventId: "owner-" + eventId,
          suffix,
          at: clockNow,
        });
        const ownerResult = await ledger.executeOwnerCommand(input);
        expect(ownerResult).toMatchObject({
          applied: true,
          operation,
          task: { taskId, state: expectedState, version: 2 },
        });

        // The Queue send settles only after the Owner transaction has revoked
        // the Publisher lease. Its completion/failure callback is now stale.
        clockNow = baseNow + 3;
        releaseQueueSend();
        const publisherResult = await publisherPromise;
        if (sendOutcome === "success") {
          expect(publisherResult).toEqual({
            processed: 1,
            published: 1,
            failed: 0,
            deadLettered: 0,
            completionPending: 1,
          });
        } else {
          expect(publisherResult).toEqual({
            processed: 1,
            published: 0,
            failed: 1,
            deadLettered: 0,
            completionPending: 0,
          });
        }

        // In both transport outcomes, the fixture observed an accepted message.
        // A later Queue delivery must be acknowledged as deterministically stale,
        // without creating a durable Consumer receipt.
        clockNow = baseNow + 4;
        let acknowledged = false;
        let retried = false;
        const delivery = {
          body: structuredClone(queued[0].message),
          ack() { acknowledged = true; },
          retry() { retried = true; },
        };
        const consumerResult = await consumeOrchestratorOutbox(
          { messages: [delivery] },
          consumerRuntime(ledger),
        );
        expect(consumerResult).toEqual({
          received: 1,
          acknowledged: 1,
          retried: 0,
          duplicates: 0,
        });
        expect(acknowledged).toBe(true);
        expect(retried).toBe(false);

        await expect(ledger.getTask({ taskId })).resolves.toMatchObject({
          taskId,
          state: expectedState,
          version: 2,
        });

        await runInDurableObject(ledger, async (_instance, state) => {
          const outbox = state.storage.sql.exec(
            "SELECT status, attempts, lease_worker_id, lease_generation, lease_until, retry_state, next_attempt_at, last_error_code, dead_lettered_at, updated_at FROM orchestrator_outbox_events WHERE event_id = ?",
            eventId,
          ).one();
          expect(outbox).toMatchObject({
            status: "IN_PROGRESS",
            attempts: 1,
            lease_worker_id: null,
            lease_generation: 2,
            lease_until: 0,
            retry_state: "DEAD_LETTER",
            next_attempt_at: 0,
            last_error_code: ownerErrorCode,
            dead_lettered_at: baseNow + 2,
            updated_at: baseNow + 2,
          });

          expect(state.storage.sql.exec(
            "SELECT COUNT(*) AS count FROM orchestrator_outbox_receipts WHERE event_id = ?",
            eventId,
          ).one().count).toBe(0);
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
            "SELECT COUNT(*) AS count FROM orchestrator_owner_consumed_assertions WHERE task_id = ? AND operation = ?",
            taskId,
            operation,
          ).one().count).toBe(1);

          expect(state.storage.sql.exec(
            "SELECT COUNT(*) AS count FROM orchestrator_consumed_assertions WHERE subject = ? AND role = 'publisher' AND operation = 'claimOutbox'",
            publisherId,
          ).one().count).toBe(1);
          expect(state.storage.sql.exec(
            "SELECT COUNT(*) AS count FROM orchestrator_consumed_assertions WHERE subject = ? AND role = 'publisher' AND operation = ?",
            publisherId,
            sendOutcome === "success" ? "completeOutbox" : "failOutbox",
          ).one().count).toBe(0);
          expect(state.storage.sql.exec(
            "SELECT COUNT(*) AS count FROM orchestrator_consumed_assertions WHERE subject = ? AND role = 'consumer' AND operation = 'recordOutboxReceipt'",
            consumerId,
          ).one().count).toBe(1);
        });

        // A lease expiry cannot resurrect a DEAD_LETTER event, even after the
        // original Publisher lease duration has elapsed.
        clockNow = baseNow + 120_002;
        const lateClaimAssertion = await workerAssertion(
          publisherId,
          "publisher",
          "claimOutbox",
          clockNow,
        );
        const lateClaim = await ledger.claimOutbox({
          workerId: publisherId,
          workerAssertion: lateClaimAssertion,
          leaseMs: 120_000,
          now: clockNow,
        });
        expect(lateClaim).toMatchObject({
          claimed: false,
          reason: "NO_OUTBOX_AVAILABLE",
        });

        await runInDurableObject(ledger, async (_instance, state) => {
          expect(state.storage.sql.exec(
            "SELECT COUNT(*) AS count FROM orchestrator_consumed_assertions WHERE subject = ? AND role = 'publisher' AND operation = 'claimOutbox'",
            publisherId,
          ).one().count).toBe(1);
        });
      } finally {
        releaseQueueSend?.();
        dateNow.mockRestore();
      }
    },
  );
});
