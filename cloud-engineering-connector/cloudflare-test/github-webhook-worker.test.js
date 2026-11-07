import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../worker.js";
import { createScheduledWorkerAssertion } from "../orchestrator-worker-identity.js";

const secret = "test-github-webhook-secret-at-least-32-bytes";
const nowIso = () => new Date().toISOString();

function payload(overrides = {}) {
  const timestamp = nowIso();
  return {
    action: "opened",
    repository: { id: 123456, full_name: "owner/repo" },
    sender: { id: 42 },
    issue: {
      number: 7,
      title: "Intake request",
      body: "Please review this bounded request.",
      labels: [{ name: "engineering-intake" }],
      html_url: "https://github.com/owner/repo/issues/7",
      created_at: timestamp,
      updated_at: timestamp,
    },
    ...overrides,
  };
}

async function signedRequest(body, deliveryId, signatureOverride, eventName = "issues") {
  const bytes = new TextEncoder().encode(body);
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, bytes));
  const hex = Array.from(signature, byte => byte.toString(16).padStart(2, "0")).join("");
  return new Request("https://connector.test/webhooks/github", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": signatureOverride ?? "sha256=" + hex,
      "x-github-delivery": deliveryId,
      "x-github-event": eventName,
      "cf-connecting-ip": "192.0.2.10",
    },
    body,
  });
}

function testEnv() {
  return {
    ORCHESTRATOR_LEDGER: env.ORCHESTRATOR_LEDGER,
    MCP_RATE_LIMITER: { limit: async () => ({ success: true }) },
    GITHUB_WEBHOOK_SECRET: secret,
    GITHUB_WEBHOOK_REPOSITORY: "owner/repo",
    GITHUB_WEBHOOK_REPOSITORY_ID: "123456",
    GITHUB_WEBHOOK_AUTHORIZED_ACTOR_IDS: '["42"]',
    GITHUB_WEBHOOK_ALLOWED_EVENT_ACTIONS: '{"issues":["opened"]}',
    GITHUB_WEBHOOK_REQUIRED_LABEL: "engineering-intake",
    GITHUB_WEBHOOK_OWNER_ID: "42",
    LEDGER_OWNER_ASSERTION_KEYS: env.LEDGER_OWNER_ASSERTION_KEYS,
    LEDGER_OWNER_ASSERTION_ACTIVE_KID: "owner-v1",
    LEDGER_WORKER_ASSERTION_KEYS: env.LEDGER_WORKER_ASSERTION_KEYS,
    LEDGER_WORKER_ASSERTION_ACTIVE_KID: "test-v1",
    GITHUB_WEBHOOK_OWNER_MAX_AGE_MS: "300000",
  };
}

describe("GitHub webhook Worker route", () => {
  it("authenticates the raw body, validates the configured intake policy, and durably deduplicates delivery IDs", async () => {
    const deliveryId = "gh-worker-delivery-0001";
    const body = JSON.stringify(payload());
    const first = await worker.fetch(await signedRequest(body, deliveryId), testEnv());
    expect(first.status).toBe(202);
    await expect(first.json()).resolves.toMatchObject({
      status: "accepted",
      decision: "DRY_RUN_ACCEPT",
      sideEffects: false,
      taskExecution: false,
    });

    const replay = await worker.fetch(await signedRequest(body, deliveryId), testEnv());
    expect(replay.status).toBe(202);
    await expect(replay.json()).resolves.toMatchObject({ status: "duplicate", deliveryId });

    const distinctDeliveryReplay = await worker.fetch(
      await signedRequest(body, "gh-worker-delivery-0002"), testEnv(),
    );
    expect(distinctDeliveryReplay.status).toBe(202);
    await expect(distinctDeliveryReplay.json()).resolves.toMatchObject({
      status: "duplicate",
      deliveryId: "gh-worker-delivery-0002",
    });

    const changedBody = JSON.stringify(payload({
      issue: { ...payload().issue, title: "Changed signed payload" },
    }));
    const businessConflict = await worker.fetch(
      await signedRequest(changedBody, "gh-worker-delivery-0003"), testEnv(),
    );
    expect(businessConflict.status).toBe(409);
    await expect(businessConflict.json()).resolves.toMatchObject({
      error: "webhook_delivery_conflict",
      reason: "IDEMPOTENCY_CONFLICT",
    });

    const conflict = await worker.fetch(await signedRequest(changedBody, deliveryId), testEnv());
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({ error: "webhook_delivery_conflict" });
  });


  it("routes a verified Owner issue comment through the atomic Ledger path without generic pre-claim", async () => {
    const taskId = "task-webhook-owner-0001";
    const ledger = env.ORCHESTRATOR_LEDGER.get(env.ORCHESTRATOR_LEDGER.idFromName("orchestrator-ledger-global"));
    const createdAt = Date.now();
    const task = {
      taskId, state: "SCHEDULED", version: 1, agentRound: 0,
      createdAt, updatedAt: createdAt, executorId: "agent:worker-1",
      commitSha: "a".repeat(40), objective: "webhook owner integration test",
    };
    await ledger.createTask({
      task, idempotencyKey: "webhook-owner-create-0001", inputHash: "a".repeat(64),
      now: createdAt, workerId: "orchestrator-scheduler",
      workerAssertion: await createScheduledWorkerAssertion(
        env.LEDGER_WORKER_ASSERTION_KEYS, "test-v1",
        { subject: "orchestrator-scheduler", role: "system", operation: "createTask", nowMs: createdAt },
      ),
    });
    const event = payload({
      action: "created",
      comment: {
        id: 900001,
        body: `/orchestrator cancel ${taskId} --reason "Owner requested cancellation"`,
        created_at: new Date(createdAt).toISOString(),
        user: { id: 42, type: "User" },
      },
      sender: { id: 42, type: "User" },
    });
    const body = JSON.stringify(event);
    const deliveryId = "gh-owner-delivery-0000001";
    const first = await worker.fetch(
      await signedRequest(body, deliveryId, undefined, "issue_comment"),
      testEnv(),
    );
    expect(first.status).toBe(202);
    await expect(first.json()).resolves.toMatchObject({
      status: "applied",
      operation: "cancel",
      task: { taskId, state: "CANCELLED", version: 2 },
    });
    await expect(ledger.getTask({ taskId })).resolves.toMatchObject({ state: "CANCELLED", version: 2 });

    const replay = await worker.fetch(
      await signedRequest(body, deliveryId, undefined, "issue_comment"),
      testEnv(),
    );
    expect(replay.status).toBe(202);
    await expect(replay.json()).resolves.toMatchObject({ status: "duplicate", deliveryId });

    const differentDeliverySameComment = await worker.fetch(
      await signedRequest(body, "gh-owner-delivery-0000002", undefined, "issue_comment"),
      testEnv(),
    );
    expect(differentDeliverySameComment.status).toBe(202);
    await expect(differentDeliverySameComment.json()).resolves.toMatchObject({
      status: "duplicate",
      reason: "OWNER_RECEIPT_CONFLICT",
    });
  });

  it("treats the same semantic GitHub issue event as a replay when provider timestamps differ", async () => {
    const firstPayload = payload();
    const firstBody = JSON.stringify(firstPayload);
    const first = await worker.fetch(
      await signedRequest(firstBody, "gh-worker-semantic-0001"), testEnv(),
    );
    expect(first.status).toBe(202);

    const replayPayload = payload({
      issue: {
        ...firstPayload.issue,
        updated_at: new Date(Date.parse(firstPayload.issue.updated_at) + 5_000).toISOString(),
      },
    });
    const replay = await worker.fetch(
      await signedRequest(JSON.stringify(replayPayload), "gh-worker-semantic-0002"), testEnv(),
    );
    expect(replay.status).toBe(202);
    await expect(replay.json()).resolves.toMatchObject({
      status: "duplicate",
      deliveryId: "gh-worker-semantic-0002",
    });
  });

  it("rejects a bad signature before intake or replay-store mutation", async () => {
    const body = JSON.stringify(payload());
    const request = await signedRequest(body, "gh-worker-delivery-0002", "sha256=" + "0".repeat(64));
    const response = await worker.fetch(request, testEnv());
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: "webhook_unauthorized" });
  });

  it("fails closed when webhook policy or durable replay storage is unavailable", async () => {
    const body = JSON.stringify(payload());
    const request = await signedRequest(body, "gh-worker-delivery-0003");
    const missingPolicy = testEnv();
    delete missingPolicy.GITHUB_WEBHOOK_REQUIRED_LABEL;
    const policyResponse = await worker.fetch(request, missingPolicy);
    expect(policyResponse.status).toBe(503);

    const missingStore = { ...testEnv(), ORCHESTRATOR_LEDGER: undefined };
    const storeResponse = await worker.fetch(
      await signedRequest(body, "gh-worker-delivery-0004"), missingStore,
    );
    expect(storeResponse.status).toBe(503);
  });
});
