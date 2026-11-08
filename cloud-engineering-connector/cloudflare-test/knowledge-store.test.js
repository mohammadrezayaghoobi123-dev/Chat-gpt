import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

function storeFor(name) {
  return env.KNOWLEDGE_STORE.get(env.KNOWLEDGE_STORE.idFromName(name));
}

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

describe("Option C Brain Store", () => {
  it("initializes the versioned SQLite schema and readiness probe", async () => {
    const store = storeFor("knowledge-schema-v2");
    await expect(store.ping()).resolves.toEqual({ ok: true, schemaVersion: 3 });
  });

  it("enforces tenant-scoped optimistic entity updates", async () => {
    const store = storeFor("knowledge-entity-versioning");
    const created = await store.upsertEntity({
      tenantId: "tenant-a", entityId: "service-api", entityType: "service",
      name: "API", properties: { tier: "core" }, expectedVersion: 0, now: 100,
    });
    expect(created).toMatchObject({ tenantId: "tenant-a", entityId: "service-api", version: 1, createdAt: 100 });
    const updated = await store.upsertEntity({
      tenantId: "tenant-a", entityId: "service-api", entityType: "service",
      name: "API v2", properties: { tier: "critical" }, expectedVersion: 1, now: 200,
    });
    expect(updated).toMatchObject({ name: "API v2", version: 2, createdAt: 100, updatedAt: 200 });
    await runInDurableObject(store, async instance => {
      expect(() => instance.upsertEntity({
        tenantId: "tenant-a", entityId: "service-api", entityType: "service",
        name: "stale overwrite", properties: {}, expectedVersion: 1, now: 300,
      })).toThrow(/Entity version changed/);
    });
    await store.upsertEntity({
      tenantId: "tenant-b", entityId: "service-api", entityType: "service",
      name: "Other tenant API", properties: {}, expectedVersion: 0, now: 101,
    });
    await expect(store.getEntity({ tenantId: "tenant-a", entityId: "service-api" }))
      .resolves.toMatchObject({ name: "API v2", version: 2 });
    await expect(store.getEntity({ tenantId: "tenant-c", entityId: "service-api" })).resolves.toBeNull();
  });

  it("rejects cross-tenant relationship endpoints and supports tenant-scoped tags", async () => {
    const store = storeFor("knowledge-relationships-tags");
    await store.upsertEntity({ tenantId: "tenant-a", entityId: "source", entityType: "service", name: "Source", expectedVersion: 0 });
    await store.upsertEntity({ tenantId: "tenant-b", entityId: "target", entityType: "service", name: "Target", expectedVersion: 0 });
    await runInDurableObject(store, async instance => {
      expect(() => instance.createRelationship({
        tenantId: "tenant-a", relationshipId: "rel-cross", sourceEntityId: "source",
        targetEntityId: "target", relationType: "depends_on",
      })).toThrow();
    });
    await store.upsertEntity({ tenantId: "tenant-a", entityId: "target", entityType: "service", name: "Target A", expectedVersion: 0 });
    await expect(store.createRelationship({
      tenantId: "tenant-a", relationshipId: "rel-1", sourceEntityId: "source",
      targetEntityId: "target", relationType: "depends_on",
    })).resolves.toMatchObject({ tenantId: "tenant-a", relationshipId: "rel-1" });
    await store.putTag({ tenantId: "tenant-a", tagId: "critical", label: "Critical" });
    await store.attachTag({ tenantId: "tenant-a", entityId: "source", tagId: "critical" });
    await expect(store.listEntityTags({ tenantId: "tenant-a", entityId: "source" }))
      .resolves.toEqual([{ tagId: "critical", label: "Critical" }]);
    await expect(store.listEntityTags({ tenantId: "tenant-b", entityId: "source" })).resolves.toEqual([]);
  });

  it("keeps GitHub document revisions immutable and records sync state separately", async () => {
    const store = storeFor("knowledge-document-history");
    const ref = {
      tenantId: "tenant-a", documentId: "adr-001", repository: "owner/knowledge-vault",
      path: "decisions/adr-001.md", commitSha: "1".repeat(40), contentSha256: "a".repeat(64),
    };
    await store.putDocumentRef({ ...ref, now: 100 });
    await runInDurableObject(store, async instance => {
      expect(() => instance.putDocumentRef({ ...ref, contentSha256: "b".repeat(64), now: 200 }))
        .toThrow(/cannot be rebound/);
    });
    await store.setDocumentSyncState({
      tenantId: "tenant-a", documentId: "adr-001", status: "synced",
      lastSeenCommit: "1".repeat(40), lastSyncedCommit: "1".repeat(40), now: 300,
    });
    await expect(store.getDocumentSyncState({ tenantId: "tenant-a", documentId: "adr-001" }))
      .resolves.toMatchObject({ status: "synced", lastSyncedCommit: "1".repeat(40) });
    await expect(store.listDocumentRefs({ tenantId: "tenant-b", documentId: "adr-001" })).resolves.toEqual([]);
  });

  it("uses a durable idempotent outbox with bounded retries and dead-letter state", async () => {
    const store = storeFor("knowledge-outbox");
    const input = {
      tenantId: "tenant-a", eventId: "evt-001", idempotencyKey: "knowledge-sync-001",
      aggregateType: "document", aggregateId: "adr-001", eventType: "vault.document.sync",
      payload: { repository: "owner/knowledge-vault", path: "decisions/adr-001.md" }, now: 100,
    };
    const concurrentInput = { ...input, eventId: "evt-concurrent", idempotencyKey: "knowledge-sync-concurrent", now: 200_000 };
    const concurrentReplay = await Promise.all([
      store.enqueueOutbox(concurrentInput),
      store.enqueueOutbox(concurrentInput),
    ]);
    expect(concurrentReplay[0].eventId).toBe("evt-concurrent");
    expect(concurrentReplay[1].eventId).toBe("evt-concurrent");
    const first = await store.enqueueOutbox(input);
    const replay = await store.enqueueOutbox(input);
    expect(replay.eventId).toBe(first.eventId);
    const reorderedReplay = await store.enqueueOutbox({
      ...input, payload: { path: "decisions/adr-001.md", repository: "owner/knowledge-vault" },
    });
    expect(reorderedReplay.eventId).toBe(first.eventId);
    await runInDurableObject(store, async instance => {
      await expect(instance.enqueueOutbox({ ...input, payload: { repository: "owner/other", path: "x.md" } }))
        .rejects.toMatchObject({ code: "KNOWLEDGE_IDEMPOTENCY_CONFLICT" });
    });
    const claimed = await store.claimOutbox({ now: 101, leaseMs: 1000 });
    expect(claimed).toMatchObject({ eventId: "evt-001", status: "processing", attempts: 1 });
    await store.failOutbox({ tenantId: "tenant-a", eventId: "evt-001", leaseGeneration: claimed.leaseGeneration, error: "temporary GitHub 503", now: 102, maxAttempts: 2 });
    const retry = await store.claimOutbox({ now: 100_000, leaseMs: 1000 });
    expect(retry).toMatchObject({ eventId: "evt-001", status: "processing", attempts: 2 });
    await store.failOutbox({ tenantId: "tenant-a", eventId: "evt-001", leaseGeneration: retry.leaseGeneration, error: "permanent failure", now: 100_001, maxAttempts: 2 });
    await expect(store.getOutboxEvent({ tenantId: "tenant-a", eventId: "evt-001" }))
      .resolves.toMatchObject({ status: "dead_letter", attempts: 2 });
    const otherTenant = await store.enqueueOutbox({
      ...input, tenantId: "tenant-b", eventId: "evt-tenant-b",
      payload: { repository: "owner/other-tenant", path: "docs/other.md" }, now: 100_002,
    });
    expect(otherTenant).toMatchObject({ tenantId: "tenant-b", eventId: "evt-tenant-b", status: "pending" });
    const otherClaim = await store.claimOutbox({ now: 100_003, leaseMs: 1000 });
    expect(otherClaim).toMatchObject({ tenantId: "tenant-b", eventId: "evt-tenant-b", status: "processing" });
    await store.completeOutbox({
      tenantId: "tenant-b", eventId: "evt-tenant-b",
      leaseGeneration: otherClaim.leaseGeneration, now: 100_004,
    });
    await expect(store.getOutboxEvent({ tenantId: "tenant-b", eventId: "evt-tenant-b" }))
      .resolves.toMatchObject({ status: "completed" });
  });

  it("indexes only derived snapshots and can rebuild FTS5 from stored index sources", async () => {
    const store = storeFor("knowledge-derived-index");
    await store.upsertEntity({
      tenantId: "tenant-a", entityId: "entity-fts", entityType: "service",
      name: "Payment gateway", properties: { owner: "platform", description: "payment settlement" }, expectedVersion: 0,
    });
    const body = "The payment gateway processes card authorization and settlement.";
    const contentSha256 = await sha256(body);
    const ref = {
      tenantId: "tenant-a", documentId: "adr-payments", repository: "owner/knowledge-vault",
      path: "decisions/payments.md", commitSha: "2".repeat(40), contentSha256,
    };
    await store.putDocumentRef(ref);
    await store.indexDocumentSnapshot({ ...ref, text: body });
    await expect(store.search({ tenantId: "tenant-a", query: "payment settlement", limit: 10 }))
      .resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ recordType: "entity", recordId: "entity-fts" }),
        expect.objectContaining({ recordType: "document", recordId: "adr-payments", commitSha: "2".repeat(40) }),
      ]));
    await store.rebuildIndex({ tenantId: "tenant-a" });
    await expect(store.search({ tenantId: "tenant-a", query: "payment settlement", limit: 10 }))
      .resolves.toHaveLength(2);
    await expect(store.search({ tenantId: "tenant-b", query: "payment", limit: 10 })).resolves.toEqual([]);
  });

  it("persists records across Durable Object RPC boundaries", async () => {
    const store = storeFor("knowledge-persistence");
    await store.upsertEntity({
      tenantId: "tenant-a", entityId: "persisted", entityType: "document",
      name: "Persistent", properties: { durable: true }, expectedVersion: 0, now: 500,
    });
    await runInDurableObject(store, async instance => {
      expect(instance.ping()).toEqual({ ok: true, schemaVersion: 3 });
      expect(instance.getEntity({ tenantId: "tenant-a", entityId: "persisted" }))
        .toMatchObject({ name: "Persistent", properties: { durable: true }, version: 1 });
    });
  });
});

it("Vault proposals persist idempotently and transition from proposed to merged", async () => {
  const store = storeFor("vault-proposal-lifecycle");
  const input = {
    tenantId: "tenant-a", proposalId: "proposal-00000001", documentId: "doc_123",
    repository: "mohammadrezayaghoobi123-dev/Chat-gpt", path: "knowledge/tenants/owner/architecture.md",
    expectedBlobSha: "ABSENT", proposedContentSha256: "a".repeat(64),
    pullRequestNumber: 987, pullRequestUrl: "https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/pull/987",
    branch: "assistant/mcp-vault-proposal-01", commitSha: "b".repeat(40), now: 100,
  };
  const recorded = await store.recordVaultProposal(input);
  expect(recorded).toMatchObject({ tenantId: "tenant-a", proposalId: "proposal-00000001", status: "proposed" });
  expect(await store.recordVaultProposal(input)).toMatchObject({ pullRequestNumber: 987 });
  expect(await store.listPendingVaultProposals({ tenantId: "tenant-a" })).toHaveLength(1);
  expect(await store.getVaultProposal({ tenantId: "tenant-b", proposalId: "proposal-00000001" })).toBeNull();
  const merged = await store.updateVaultProposal({
    tenantId: "tenant-a", proposalId: "proposal-00000001", status: "merged",
    mergeCommitSha: "c".repeat(40), mergedBlobSha: "d".repeat(40), now: 200,
  });
  expect(merged).toMatchObject({ status: "merged", mergeCommitSha: "c".repeat(40), mergedBlobSha: "d".repeat(40) });
  expect(await store.listPendingVaultProposals({ tenantId: "tenant-a" })).toHaveLength(0);
  await runInDurableObject(store, async instance => {
    expect(() => instance.updateVaultProposal({
      tenantId: "tenant-a", proposalId: "proposal-00000001", status: "closed", now: 300,
    })).toThrow(/already in a terminal state/);
  });
});

it("Vault proposal IDs cannot be rebound to another change or non-canonical PR URL", async () => {
  const store = storeFor("vault-proposal-immutability");
  const input = {
    tenantId: "tenant-a", proposalId: "proposal-00000002", documentId: "doc_456",
    repository: "mohammadrezayaghoobi123-dev/Chat-gpt", path: "knowledge/tenants/owner/adr.md",
    expectedBlobSha: "e".repeat(40), proposedContentSha256: "f".repeat(64),
    pullRequestNumber: 988, pullRequestUrl: "https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/pull/988",
    branch: "assistant/mcp-vault-proposal-02", commitSha: "1".repeat(40), now: 100,
  };
  await store.recordVaultProposal(input);
  await runInDurableObject(store, async instance => {
    expect(() => instance.recordVaultProposal({ ...input, proposedContentSha256: "2".repeat(64) }))
      .toThrow(/already bound to a different Vault change/);
    expect(() => instance.recordVaultProposal({ ...input, pullRequestUrl: "https://evil.example/pull/988" }))
      .toThrow(/canonical GitHub URL/);
  });
});

it("deferOutbox releases a pending-review lease without consuming retry attempts", async () => {
  const store = storeFor("outbox-defer");
  await store.enqueueOutbox({
    tenantId: "tenant-a", eventId: "vault-event-1", idempotencyKey: "vault-proposal-1",
    aggregateType: "document", aggregateId: "doc_1", eventType: "vault.document.proposed",
    payload: { proposalId: "proposal-1" }, now: 1000,
  });
  const first = await store.claimOutbox({ tenantId: "tenant-a", now: 1000, leaseMs: 1000 });
  expect(first.attempts).toBe(1);
  const deferred = await store.deferOutbox({
    tenantId: "tenant-a", eventId: "vault-event-1", leaseGeneration: first.leaseGeneration,
    now: 2000, retryAfterMs: 60_000,
  });
  expect(deferred).toMatchObject({ status: "retry", attempts: 0, nextAttemptAt: 62_000, leaseUntil: null });
  await runInDurableObject(store, async instance => {
    expect(() => instance.completeOutbox({
      tenantId: "tenant-a", eventId: "vault-event-1", leaseGeneration: first.leaseGeneration, now: 3000,
    })).toThrow(/lease is stale/);
  });
  const second = await store.claimOutbox({ tenantId: "tenant-a", now: 62_000, leaseMs: 1000 });
  expect(second.leaseGeneration).toBe(first.leaseGeneration + 1);
  expect(second.attempts).toBe(1);
});


it("does not expose the internal derived-index writer as a Durable Object RPC method", async () => {
  const store = storeFor("knowledge-index-writer-boundary");
  await runInDurableObject(store, async instance => {
    expect(instance.indexSource).toBeUndefined();
    expect(typeof instance.search).toBe("function");
  });
});
