import test from "node:test";
import assert from "node:assert/strict";
import { consumeOrchestratorDeadLetters, consumeOrchestratorOutbox, handleOrchestratorQueue, processOrchestratorOutbox } from "../worker.js";

const now = Date.now();
const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
const keySet = JSON.stringify({ "worker-v1": key });
const event = {
  eventId: "outbox-event-0001",
  idempotencyKey: "outbox-idempotency-0001",
  taskId: "task-0001",
  eventType: "task.transitioned",
  payload: { taskId: "task-0001", version: 2, from: "SCHEDULED", to: "RUNNING" },
  attempts: 1,
  createdAt: now,
};
function fixture({ send = async () => {}, complete = async () => ({ completed: true }), fail = async () => ({ failed: true }) } = {}) {
  const calls = [];
  const ledger = {
    claimOutbox: async input => { calls.push({ method: "claimOutbox", input }); return { claimed: true, event, leaseGeneration: 3 }; },
    completeOutbox: async input => { calls.push({ method: "completeOutbox", input }); return complete(input); },
    failOutbox: async input => { calls.push({ method: "failOutbox", input }); return fail(input); },
  };
  const queue = { send: async (message, options) => { calls.push({ method: "send", message, options }); return send(message, options); } };
  const env = {
    ORCHESTRATOR_LEDGER: { idFromName: name => name, get: () => ledger },
    ORCHESTRATOR_OUTBOX_QUEUE: queue,
    LEDGER_WORKER_ASSERTION_KEYS: keySet,
    LEDGER_WORKER_ASSERTION_ACTIVE_KID: "worker-v1",
  };
  return { env, calls };
}

test("does not claim Ledger events until the Queue producer is configured", async () => {
  const { env, calls } = fixture();
  delete env.ORCHESTRATOR_OUTBOX_QUEUE;
  const result = await processOrchestratorOutbox(env);
  assert.equal(result.reason, "orchestrator_outbox_queue_unavailable");
  assert.equal(calls.filter(call => call.method === "claimOutbox").length, 0);
});

test("publishes a stable event envelope and completes the fenced Ledger lease", async () => {
  const { env, calls } = fixture();
  const result = await processOrchestratorOutbox(env, { maxEvents: 1 });
  assert.deepEqual(result, { processed: 1, published: 1, failed: 0, deadLettered: 0, completionPending: 0 });
  const sent = calls.find(call => call.method === "send");
  assert.equal(sent.message.schemaVersion, 1);
  assert.equal(sent.message.eventId, event.eventId);
  assert.equal(sent.message.eventType, event.eventType);
  assert.deepEqual(sent.message.payload, event.payload);
  assert.equal(sent.options.contentType, "json");
  const completed = calls.find(call => call.method === "completeOutbox");
  assert.equal(completed.input.workerId, "orchestrator-outbox-publisher");
  assert.equal(completed.input.leaseGeneration, 3);
  assert.equal(typeof completed.input.workerAssertion, "string");
});

test("records retryable failure when queue publication rejects", async () => {
  const { env, calls } = fixture({ send: async () => { throw new Error("queue unavailable"); } });
  const result = await processOrchestratorOutbox(env, { maxEvents: 1 });
  assert.deepEqual(result, { processed: 1, published: 0, failed: 1, deadLettered: 0, completionPending: 0 });
  const failed = calls.find(call => call.method === "failOutbox");
  assert.equal(failed.input.errorCode, "OUTBOX_QUEUE_PUBLISH_FAILED");
  assert.equal(failed.input.retryable, true);
  assert.equal(typeof failed.input.workerAssertion, "string");
  assert.equal(calls.some(call => call.method === "completeOutbox"), false);
});

test("does not release or fail a lease when queue publication succeeded but completion is uncertain", async () => {
  const { env, calls } = fixture({ complete: async () => ({ completed: false, reason: "LEASE_FENCE_MISMATCH" }) });
  const result = await processOrchestratorOutbox(env, { maxEvents: 1 });
  assert.deepEqual(result, { processed: 1, published: 1, failed: 0, deadLettered: 0, completionPending: 1 });
  assert.equal(calls.some(call => call.method === "failOutbox"), false);
});

test("fails closed before claiming when signing configuration is absent", async () => {
  const { env, calls } = fixture();
  delete env.LEDGER_WORKER_ASSERTION_KEYS;
  const result = await processOrchestratorOutbox(env);
  assert.equal(result.reason, "worker_assertion_signing_unavailable");
  assert.equal(calls.filter(call => call.method === "claimOutbox").length, 0);
});


test("send-success plus uncertain completion survives duplicate Queue delivery through durable receipt deduplication", async () => {
  const queued = [];
  const { env, calls } = fixture({
    send: async message => { queued.push(message); },
    complete: async () => ({ completed: false, reason: "LEASE_FENCE_MISMATCH" }),
  });
  const published = await processOrchestratorOutbox(env, { maxEvents: 1 });
  assert.equal(published.completionPending, 1);
  assert.equal(queued.length, 1);
  assert.equal(calls.some(call => call.method === "failOutbox"), false);

  const receipts = new Map();
  const receiptCalls = [];
  const consumerEnv = {
    ORCHESTRATOR_LEDGER: {
      idFromName: name => name,
      get: () => ({
        recordOutboxReceipt: async input => {
          receiptCalls.push(input);
          const existing = receipts.get(input.eventId);
          if (existing) {
            return existing === input.envelopeSha256
              ? { recorded: false, replay: true, eventId: input.eventId }
              : { recorded: false, conflict: true, reason: "OUTBOX_EVENT_ID_CONFLICT" };
          }
          receipts.set(input.eventId, input.envelopeSha256);
          return { recorded: true, eventId: input.eventId };
        },
      }),
    },
    LEDGER_WORKER_ASSERTION_KEYS: env.LEDGER_WORKER_ASSERTION_KEYS,
    LEDGER_WORKER_ASSERTION_ACTIVE_KID: env.LEDGER_WORKER_ASSERTION_ACTIVE_KID,
  };
  const delivered = () => ({
    body: queued[0],
    acknowledged: false,
    retried: false,
    ack() { this.acknowledged = true; },
    retry() { this.retried = true; },
  });
  const first = delivered();
  const duplicate = delivered();
  const firstResult = await consumeOrchestratorOutbox({ messages: [first] }, consumerEnv);
  const duplicateResult = await consumeOrchestratorOutbox({ messages: [duplicate] }, consumerEnv);
  assert.deepEqual(firstResult, { received: 1, acknowledged: 1, retried: 0, duplicates: 0 });
  assert.deepEqual(duplicateResult, { received: 1, acknowledged: 1, retried: 0, duplicates: 1 });
  assert.equal(receiptCalls.length, 2);
  assert.equal(receipts.size, 1);
  assert.equal(first.acknowledged, true);
  assert.equal(duplicate.acknowledged, true);
});


test("emits redacted structured consumer metrics for retry outcomes", async () => {
  const lines = [];
  const originalError = console.error;
  console.error = line => lines.push(String(line));
  try {
    const consumerEnv = {
      ORCHESTRATOR_LEDGER: {
        idFromName: name => name,
        get: () => ({ recordOutboxReceipt: async () => ({ recorded: false, reason: "OUTBOX_SOURCE_NOT_FOUND" }) }),
      },
      LEDGER_WORKER_ASSERTION_KEYS: keySet,
      LEDGER_WORKER_ASSERTION_ACTIVE_KID: "worker-v1",
    };
    const body = { ...event, schemaVersion: 1 };
    const message = {
      body,
      ack() { throw new Error("unexpected ack"); },
      retry() { this.retried = true; },
    };
    const result = await consumeOrchestratorOutbox({ messages: [message] }, consumerEnv);
    assert.deepEqual(result, { received: 1, acknowledged: 0, retried: 1, duplicates: 0 });
    assert.equal(message.retried, true);
    assert.equal(lines.length, 1);
    const record = JSON.parse(lines[0]);
    assert.deepEqual(
      { event: record.event, severity: record.severity, received: record.received, acknowledged: record.acknowledged, retried: record.retried, duplicates: record.duplicates },
      { event: "orchestrator_outbox_consume", severity: "warning", received: 1, acknowledged: 0, retried: 1, duplicates: 0 },
    );
    assert.equal(lines[0].includes(JSON.stringify(body)), false, "consumer telemetry must not contain message payloads");
    assert.equal(lines[0].includes(key), false, "consumer telemetry must not contain signing material");
  } finally {
    console.error = originalError;
  }
});


test("archives DLQ deliveries idempotently before acknowledging them", async () => {
  const archived = new Map();
  const calls = [];
  const queueName = "chat-gpt111-staging-orchestrator-outbox-dlq";
  const consumerEnv = {
    ORCHESTRATOR_OUTBOX_DLQ_QUEUE: queueName,
    ORCHESTRATOR_OUTBOX_QUEUE_NAME: "chat-gpt111-staging-orchestrator-outbox",
    ORCHESTRATOR_LEDGER: {
      idFromName: name => name,
      get: () => ({
        recordOutboxDeadLetter: async input => {
          calls.push(input);
          const existing = archived.get(input.messageId);
          if (existing) return existing === input.bodySha256
            ? { recorded: false, replay: true, messageId: input.messageId }
            : { recorded: false, conflict: true, reason: "DEAD_LETTER_MESSAGE_ID_CONFLICT" };
          archived.set(input.messageId, input.bodySha256);
          return { recorded: true, messageId: input.messageId };
        },
      }),
    },
    LEDGER_WORKER_ASSERTION_KEYS: keySet,
    LEDGER_WORKER_ASSERTION_ACTIVE_KID: "worker-v1",
  };
  const body = { ...event, schemaVersion: 1 };
  const deliver = () => ({
    id: "cf-message-0001",
    timestamp: new Date(now),
    attempts: 5,
    body,
    acknowledged: false,
    retried: false,
    ack() { this.acknowledged = true; },
    retry() { this.retried = true; },
  });
  const first = deliver();
  const firstResult = await consumeOrchestratorDeadLetters({ queue: queueName, messages: [first] }, consumerEnv);
  const duplicate = deliver();
  const duplicateResult = await handleOrchestratorQueue({ queue: queueName, messages: [duplicate] }, consumerEnv);
  assert.deepEqual(firstResult, { received: 1, archived: 1, duplicates: 0, retried: 0 });
  assert.deepEqual(duplicateResult, { received: 1, archived: 1, duplicates: 1, retried: 0 });
  assert.equal(first.acknowledged, true);
  assert.equal(duplicate.acknowledged, true);
  assert.equal(archived.size, 1);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].queueName, queueName);
  assert.equal(calls[0].messageAttempts, 5);
  assert.equal(typeof calls[0].workerAssertion, "string");
  assert.equal(calls[0].archiverId, "orchestrator-outbox-dlq-archiver");
});

test("retries DLQ messages when durable archival is unavailable and refuses an unexpected queue", async () => {
  const queueName = "chat-gpt111-staging-orchestrator-outbox-dlq";
  const message = {
    id: "cf-message-0002",
    timestamp: new Date(now),
    attempts: 6,
    body: { safe: true },
    retried: false,
    retry() { this.retried = true; },
    ack() { throw new Error("must not acknowledge unarchived DLQ data"); },
  };
  const unavailable = await consumeOrchestratorDeadLetters(
    { queue: queueName, messages: [message] },
    { ORCHESTRATOR_OUTBOX_DLQ_QUEUE: queueName },
  );
  assert.deepEqual(unavailable, { received: 1, archived: 0, duplicates: 0, retried: 1 });
  assert.equal(message.retried, true);

  const wrongQueue = {
    id: "cf-message-0003",
    timestamp: new Date(now),
    attempts: 1,
    body: { safe: true },
    retried: false,
    retry() { this.retried = true; },
  };
  const rejected = await consumeOrchestratorDeadLetters(
    { queue: "unexpected-queue", messages: [wrongQueue] },
    { ORCHESTRATOR_OUTBOX_DLQ_QUEUE: queueName },
  );
  assert.equal(rejected.retried, 1);
  assert.equal(wrongQueue.retried, true);
});
