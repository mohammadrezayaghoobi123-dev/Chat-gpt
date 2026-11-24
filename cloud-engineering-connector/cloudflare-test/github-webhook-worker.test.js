import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
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
    const ownerEnv = {
      ...testEnv(),
      GITHUB_WEBHOOK_REPOSITORY: "mohammadrezayaghoobi123-dev/Chat-gpt",
      GITHUB_WEBHOOK_REPOSITORY_ID: "1398846697",
      GITHUB_WEBHOOK_OWNER_ID: "335530603",
    };
    const event = payload({
      action: "created",
      repository: { id: 1398846697, full_name: "mohammadrezayaghoobi123-dev/Chat-gpt" },
      issue: {
        ...payload().issue,
        html_url: "https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/issues/7",
      },
      comment: {
        id: 900001,
        body: `/orchestrator cancel ${taskId} --reason "Owner requested cancellation"`,
        created_at: new Date(createdAt).toISOString(),
        user: { id: 335530603, type: "User" },
      },
      sender: { id: 335530603, type: "User" },
    });
    const body = JSON.stringify(event);
    const deliveryId = "gh-owner-delivery-0000001";
    const first = await worker.fetch(
      await signedRequest(body, deliveryId, undefined, "issue_comment"),
      ownerEnv,
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
      ownerEnv,
    );
    expect(replay.status).toBe(202);
    await expect(replay.json()).resolves.toMatchObject({ status: "duplicate", deliveryId });

    const differentDeliverySameComment = await worker.fetch(
      await signedRequest(body, "gh-owner-delivery-0000002", undefined, "issue_comment"),
      ownerEnv,
    );
    expect(differentDeliverySameComment.status).toBe(202);
    await expect(differentDeliverySameComment.json()).resolves.toMatchObject({
      status: "duplicate",
      operation: "cancel",
    });

    const changedBody = JSON.stringify({
      ...event,
      comment: { ...event.comment, body: `/orchestrator cancel ${taskId} --reason "Changed reason"` },
    });
    const bodyConflict = await worker.fetch(
      await signedRequest(changedBody, deliveryId, undefined, "issue_comment"),
      ownerEnv,
    );
    expect(bodyConflict.status).toBe(409);
    await expect(bodyConflict.json()).resolves.toMatchObject({
      error: "owner_command_conflict",
      reason: "OWNER_RECEIPT_CONFLICT",
    });

    const secondComment = JSON.stringify({
      ...event,
      comment: {
        ...event.comment,
        id: 900002,
        body: `/orchestrator cancel ${taskId} --reason "Owner repeated cancellation"`,
      },
    });
    const terminalConflict = await worker.fetch(
      await signedRequest(secondComment, "gh-owner-delivery-0000003", undefined, "issue_comment"),
      ownerEnv,
    );
    expect(terminalConflict.status).toBe(409);
    await expect(terminalConflict.json()).resolves.toMatchObject({
      error: "owner_command_conflict",
      reason: "ILLEGAL_OWNER_TRANSITION",
    });
  });

  it("classifies bounded Owner Audit contention as retryable service unavailability", async () => {
    let ledgerCalls = 0;
    const fakeLedger = {
      authorizeOwnerWebhookRetry: async () => ({ registered: false }),
      executeOwnerCommand: async () => {
        ledgerCalls += 1;
        return { applied: false, reason: "AUDIT_CHAIN_CONTENTION" };
      },
    };
    const repository = "mohammadrezayaghoobi123-dev/Chat-gpt";
    const ownerId = 335530603;
    const ownerEnv = {
      ...testEnv(),
      ORCHESTRATOR_LEDGER: {
        idFromName: name => name,
        get: () => fakeLedger,
      },
      GITHUB_WEBHOOK_REPOSITORY: repository,
      GITHUB_WEBHOOK_REPOSITORY_ID: "1398846697",
      GITHUB_WEBHOOK_OWNER_ID: String(ownerId),
    };
    const taskId = "task-webhook-owner-audit-contention-0001";
    const event = payload({
      action: "created",
      repository: { id: 1398846697, full_name: repository },
      issue: {
        ...payload().issue,
        html_url: `https://github.com/${repository}/issues/7`,
      },
      comment: {
        id: 900011,
        body: `/orchestrator cancel ${taskId} --reason "Retry after bounded Audit contention"`,
        created_at: nowIso(),
        user: { id: ownerId, type: "User" },
      },
      sender: { id: ownerId, type: "User" },
    });
    const deliveryId = "gh-owner-audit-contention-0001";
    const response = await worker.fetch(
      await signedRequest(JSON.stringify(event), deliveryId, undefined, "issue_comment"),
      ownerEnv,
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("1");
    await expect(response.json()).resolves.toMatchObject({
      error: "owner_command_unavailable",
      reason: "AUDIT_CHAIN_CONTENTION",
    });
    expect(ledgerCalls).toBe(1);
  });

  it("consults the Ledger before rejecting a stale first-seen Owner comment", async () => {
    let authorizationCalls = 0;
    let executionCalls = 0;
    const fakeLedger = {
      authorizeOwnerWebhookRetry: async () => {
        authorizationCalls += 1;
        return { registered: false };
      },
      executeOwnerCommand: async () => {
        executionCalls += 1;
        return { applied: true };
      },
    };
    const repository = "mohammadrezayaghoobi123-dev/Chat-gpt";
    const ownerId = 335530603;
    const taskId = "task-webhook-stale-first-seen-0001";
    const event = payload({
      action: "created",
      repository: { id: 1398846697, full_name: repository },
      issue: {
        ...payload().issue,
        html_url: "https://github.com/" + repository + "/issues/7",
      },
      comment: {
        id: 900021,
        body: '/orchestrator cancel ' + taskId + ' --reason "Stale first-seen must stay rejected"',
        created_at: new Date(Date.now() - 600_000).toISOString(),
        user: { id: ownerId, type: "User" },
      },
      sender: { id: ownerId, type: "User" },
    });
    const ownerEnv = {
      ...testEnv(),
      GITHUB_WEBHOOK_REPOSITORY: repository,
      GITHUB_WEBHOOK_REPOSITORY_ID: "1398846697",
      GITHUB_WEBHOOK_OWNER_ID: String(ownerId),
      ORCHESTRATOR_LEDGER: { idFromName: name => name, get: () => fakeLedger },
    };
    const response = await worker.fetch(
      await signedRequest(JSON.stringify(event), "gh-owner-stale-first-seen-0001", undefined, "issue_comment"),
      ownerEnv,
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: "owner_command_rejected",
      reason: "COMMENT_TIMESTAMP_OUT_OF_RANGE",
    });
    expect(authorizationCalls).toBe(1);
    expect(executionCalls).toBe(0);
  });

  it("admits an old Owner comment only for an exact Ledger-authorized redelivery", async () => {
    let authorizationInput;
    let executionInput;
    const taskId = "task-webhook-owner-redelivery-0001";
    const fakeLedger = {
      authorizeOwnerWebhookRetry: async input => {
        authorizationInput = input;
        return { registered: true, retryAuthorized: true, retryCount: 1 };
      },
      executeOwnerCommand: async input => {
        executionInput = input;
        return {
          applied: true,
          operation: "cancel",
          task: { taskId, state: "CANCELLED", version: 2 },
        };
      },
    };
    const repository = "mohammadrezayaghoobi123-dev/Chat-gpt";
    const ownerId = 335530603;
    const deliveryId = "gh-owner-redelivery-0000001";
    const commentCreatedAt = Date.now() - 600_000;
    const event = payload({
      action: "created",
      repository: { id: 1398846697, full_name: repository },
      issue: {
        ...payload().issue,
        html_url: "https://github.com/" + repository + "/issues/7",
      },
      comment: {
        id: 900022,
        body: '/orchestrator cancel ' + taskId + ' --reason "Recover exact transient failure"',
        created_at: new Date(commentCreatedAt).toISOString(),
        user: { id: ownerId, type: "User" },
      },
      sender: { id: ownerId, type: "User" },
    });
    const body = JSON.stringify(event);
    const ownerEnv = {
      ...testEnv(),
      GITHUB_WEBHOOK_REPOSITORY: repository,
      GITHUB_WEBHOOK_REPOSITORY_ID: "1398846697",
      GITHUB_WEBHOOK_OWNER_ID: String(ownerId),
      ORCHESTRATOR_LEDGER: { idFromName: name => name, get: () => fakeLedger },
    };
    const response = await worker.fetch(
      await signedRequest(body, deliveryId, undefined, "issue_comment"),
      ownerEnv,
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      status: "applied",
      operation: "cancel",
      deliveryId,
      task: { taskId, state: "CANCELLED", version: 2 },
    });
    expect(authorizationInput).toMatchObject({
      deliveryId,
      commentId: "900022",
      repositoryId: 1398846697,
      actorId: String(ownerId),
      taskId,
      operation: "cancel",
      commentCreatedAt,
    });
    expect(authorizationInput.bodySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(typeof authorizationInput.assertion).toBe("string");
    expect(authorizationInput.assertion.length).toBeGreaterThan(0);
    expect(authorizationInput.commandHash).toMatch(/^[a-f0-9]{64}$/);
    expect(executionInput.assertionContext.deliveryId).toBe(deliveryId);
    expect(executionInput.bodySha256).toBe(authorizationInput.bodySha256);
  });

  it("preserves HTTP 403 when the Ledger rejects the signed Owner assertion", async () => {
    let executionCalls = 0;
    const taskId = "task-webhook-owner-assertion-rejected-0001";
    const fakeLedger = {
      authorizeOwnerWebhookRetry: async () => ({
        registered: true,
        denied: true,
        reason: "OWNER_ASSERTION_REJECTED",
      }),
      executeOwnerCommand: async () => {
        executionCalls += 1;
        return { applied: true };
      },
    };
    const repository = "mohammadrezayaghoobi123-dev/Chat-gpt";
    const ownerId = 335530603;
    const event = payload({
      action: "created",
      repository: { id: 1398846697, full_name: repository },
      issue: {
        ...payload().issue,
        html_url: "https://github.com/" + repository + "/issues/7",
      },
      comment: {
        id: 900024,
        body: '/orchestrator cancel ' + taskId + ' --reason "Rejected assertion"',
        created_at: new Date().toISOString(),
        user: { id: ownerId, type: "User" },
      },
      sender: { id: ownerId, type: "User" },
    });
    const ownerEnv = {
      ...testEnv(),
      GITHUB_WEBHOOK_REPOSITORY: repository,
      GITHUB_WEBHOOK_REPOSITORY_ID: "1398846697",
      GITHUB_WEBHOOK_OWNER_ID: String(ownerId),
      ORCHESTRATOR_LEDGER: { idFromName: name => name, get: () => fakeLedger },
    };
    const response = await worker.fetch(
      await signedRequest(JSON.stringify(event), "gh-owner-assertion-rejected-0001", undefined, "issue_comment"),
      ownerEnv,
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: "owner_command_rejected",
      reason: "OWNER_ASSERTION_REJECTED",
    });
    expect(executionCalls).toBe(0);
  });

  it("returns a stored terminal Owner receipt for stale redelivery without executing the command again", async () => {
    let executionCalls = 0;
    const taskId = "task-webhook-owner-redelivery-complete-0001";
    const fakeLedger = {
      authorizeOwnerWebhookRetry: async () => ({
        registered: true,
        completed: true,
        result: {
          applied: true,
          operation: "cancel",
          task: { taskId, state: "CANCELLED", version: 2 },
        },
      }),
      executeOwnerCommand: async () => {
        executionCalls += 1;
        return { applied: false, reason: "SHOULD_NOT_EXECUTE" };
      },
    };
    const repository = "mohammadrezayaghoobi123-dev/Chat-gpt";
    const ownerId = 335530603;
    const event = payload({
      action: "created",
      repository: { id: 1398846697, full_name: repository },
      issue: {
        ...payload().issue,
        html_url: "https://github.com/" + repository + "/issues/7",
      },
      comment: {
        id: 900023,
        body: '/orchestrator cancel ' + taskId + ' --reason "Already completed"',
        created_at: new Date(Date.now() - 600_000).toISOString(),
        user: { id: ownerId, type: "User" },
      },
      sender: { id: ownerId, type: "User" },
    });
    const ownerEnv = {
      ...testEnv(),
      GITHUB_WEBHOOK_REPOSITORY: repository,
      GITHUB_WEBHOOK_REPOSITORY_ID: "1398846697",
      GITHUB_WEBHOOK_OWNER_ID: String(ownerId),
      ORCHESTRATOR_LEDGER: { idFromName: name => name, get: () => fakeLedger },
    };
    const response = await worker.fetch(
      await signedRequest(JSON.stringify(event), "gh-owner-redelivery-complete-0001", undefined, "issue_comment"),
      ownerEnv,
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      status: "duplicate",
      operation: "cancel",
      task: { taskId, state: "CANCELLED", version: 2 },
    });
    expect(executionCalls).toBe(0);
  });

  it("rejects Owner-like comments with invalid author, repository, PR, action, or freshness before Ledger access", async () => {
    const repository = "mohammadrezayaghoobi123-dev/Chat-gpt";
    const ownerId = 335530603;
    const base = payload({
      action: "created",
      repository: { id: 1398846697, full_name: repository },
      issue: {
        ...payload().issue,
        html_url: `https://github.com/${repository}/issues/7`,
      },
      comment: {
        id: 900002,
        body: '/orchestrator quarantine task-owner-reject-0001 --reason "Owner safety test"',
        created_at: new Date().toISOString(),
        user: { id: ownerId, type: "User" },
      },
      sender: { id: ownerId, type: "User" },
    });
    const cases = [
      { name: "non-owner sender", expected: 403, patch: { sender: { id: 335530604, type: "User" }, comment: base.comment } },
      { name: "comment author mismatch", expected: 403, patch: { sender: base.sender, comment: { ...base.comment, user: { id: 335530604, type: "User" } } } },
      { name: "bot author", expected: 403, patch: { sender: base.sender, comment: { ...base.comment, user: { id: ownerId, type: "Bot" } } } },
      { name: "wrong repository", expected: 403, patch: { repository: { id: 123456, full_name: "owner/other" } } },
      { name: "pull request comment", expected: 422, patch: { issue: { ...base.issue, pull_request: { url: "https://api.github.com/repos/example/pulls/7" } } } },
      { name: "present but null pull request field", expected: 422, patch: { issue: { ...base.issue, pull_request: null } } },
      { name: "edited comment event", expected: 422, patch: { action: "edited" } },
    ];
    let ledgerRpcCalls = 0;
    const fakeLedger = {
      getTask: async () => { ledgerRpcCalls++; return null; },
      executeOwnerCommand: async () => { ledgerRpcCalls++; return { applied: true }; },
    };
    const ownerEnv = {
      ...testEnv(),
      GITHUB_WEBHOOK_REPOSITORY: repository,
      GITHUB_WEBHOOK_REPOSITORY_ID: "1398846697",
      GITHUB_WEBHOOK_OWNER_ID: String(ownerId),
      ORCHESTRATOR_LEDGER: { idFromName: name => name, get: () => fakeLedger },
    };
    for (const [index, item] of cases.entries()) {
      const event = {
        ...base,
        ...(item.patch || {}),
        ...(item.patch?.issue ? {} : { issue: base.issue }),
        ...(item.patch?.comment ? {} : { comment: base.comment }),
        ...(item.patch?.sender ? {} : { sender: base.sender }),
        ...(item.patch?.repository ? {} : { repository: base.repository }),
      };
      const response = await worker.fetch(
        await signedRequest(JSON.stringify(event), `gh-owner-reject-${String(index).padStart(8, "0")}`, undefined, "issue_comment"),
        ownerEnv,
      );
      expect(response.status, item.name).toBe(item.expected);
    }
    expect(ledgerRpcCalls).toBe(0);
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

  it("maps Owner command-hash failure to a bounded retryable response before Ledger mutation", async () => {
    const taskId = "task-webhook-owner-hash-failure-0001";
    const ledgerBinding = env.ORCHESTRATOR_LEDGER;
    const ledger = ledgerBinding.get(ledgerBinding.idFromName("orchestrator-ledger-global"));
    const createdAt = Date.now();
    await ledger.createTask({
      task: {
        taskId, state: "SCHEDULED", version: 1, agentRound: 0,
        createdAt, updatedAt: createdAt, executorId: "agent:worker-1",
        commitSha: "b".repeat(40), objective: "Owner webhook hash failure atomicity test",
      },
      idempotencyKey: "webhook-owner-hash-failure-create-0001",
      inputHash: "c".repeat(64),
      now: createdAt,
      workerId: "orchestrator-scheduler",
      workerAssertion: await createScheduledWorkerAssertion(
        env.LEDGER_WORKER_ASSERTION_KEYS, "test-v1",
        { subject: "orchestrator-scheduler", role: "system", operation: "createTask", nowMs: createdAt },
      ),
    });

    const repository = "mohammadrezayaghoobi123-dev/Chat-gpt";
    const ownerId = 335530603;
    const commentId = 900099;
    const deliveryId = "gh-owner-hash-failure-0001";
    const event = payload({
      action: "created",
      repository: { id: 1398846697, full_name: repository },
      issue: {
        ...payload().issue,
        html_url: "https://github.com/" + repository + "/issues/7",
      },
      comment: {
        id: commentId,
        body: '/orchestrator cancel ' + taskId + ' --reason "Hash failure must not mutate the Ledger"',
        created_at: new Date(createdAt).toISOString(),
        user: { id: ownerId, type: "User" },
      },
      sender: { id: ownerId, type: "User" },
    });
    const request = await signedRequest(
      JSON.stringify(event), deliveryId, undefined, "issue_comment",
    );

    let executeOwnerCommandCalls = 0;
    const ownerEnv = {
      ...testEnv(),
      GITHUB_WEBHOOK_REPOSITORY: repository,
      GITHUB_WEBHOOK_REPOSITORY_ID: "1398846697",
      GITHUB_WEBHOOK_OWNER_ID: String(ownerId),
      ORCHESTRATOR_LEDGER: {
        idFromName: name => ledgerBinding.idFromName(name),
        get: name => {
          const stub = ledgerBinding.get(name);
          return {
            authorizeOwnerWebhookRetry: input => stub.authorizeOwnerWebhookRetry(input),
            executeOwnerCommand: async input => {
              executeOwnerCommandCalls += 1;
              return stub.executeOwnerCommand(input);
            },
          };
        },
      },
    };

    const subtle = crypto.subtle;
    const originalDigest = subtle.digest.bind(subtle);
    const hadOwnDigest = Object.prototype.hasOwnProperty.call(subtle, "digest");
    const originalDescriptor = Object.getOwnPropertyDescriptor(subtle, "digest");
    const injectedFailure = new Error("SENSITIVE_OWNER_COMMAND_HASH_FAILURE");
    let digestCalls = 0;
    let nativeDigestCalls = 0;

    Object.defineProperty(subtle, "digest", {
      configurable: true,
      writable: true,
      value: (...args) => {
        digestCalls += 1;
        if (digestCalls === 2) return Promise.reject(injectedFailure);
        nativeDigestCalls += 1;
        return originalDigest(...args);
      },
    });

    let response;
    try {
      response = await worker.fetch(request, ownerEnv);
    } finally {
      if (hadOwnDigest) Object.defineProperty(subtle, "digest", originalDescriptor);
      else delete subtle.digest;
    }

    const responseText = await response.text();
    const responseBody = JSON.parse(responseText);
    const taskAfterFailure = await ledger.getTask({ taskId });
    const persisted = await runInDurableObject(ledger, async (_instance, state) => ({
      receipts: state.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_owner_command_receipts WHERE delivery_id = ? OR comment_id = ?",
        deliveryId, String(commentId),
      ).one().count,
      consumedAssertions: state.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_owner_consumed_assertions WHERE delivery_id = ? OR comment_id = ?",
        deliveryId, String(commentId),
      ).one().count,
      deliveries: state.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_github_webhook_deliveries WHERE delivery_id = ?",
        deliveryId,
      ).one().count,
      auditEvents: state.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_audit_events WHERE task_id = ?",
        taskId,
      ).one().count,
    }));
    expect({
      status: response.status,
      body: responseBody,
      rawMessageLeaked: responseText.includes(injectedFailure.message),
      stackLeaked: responseText.includes("stack"),
      digestCalls,
      nativeDigestCalls,
      executeOwnerCommandCalls,
      taskState: { state: taskAfterFailure.state, version: taskAfterFailure.version },
      ...persisted,
    }).toEqual({
      status: 503,
      body: { error: "owner_command_unavailable" },
      rawMessageLeaked: false,
      stackLeaked: false,
      digestCalls: 2,
      nativeDigestCalls: 1,
      executeOwnerCommandCalls: 0,
      taskState: { state: "SCHEDULED", version: 1 },
      receipts: 0,
      consumedAssertions: 0,
      deliveries: 0,
      auditEvents: 0,
    });
  });

});
