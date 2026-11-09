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

describe("Brain Store tenant/project isolation", () => {
  it("allows identical entity identifiers in separate projects without cross-project reads or writes", async () => {
    const store = storeFor("knowledge-project-entity-isolation");
    const red = await store.upsertEntity({
      tenantId: "tenant-alpha", projectId: "project-red", entityId: "service-api",
      entityType: "service", name: "Red API", properties: { owner: "red" },
      expectedVersion: 0, now: 100,
    });
    const blue = await store.upsertEntity({
      tenantId: "tenant-alpha", projectId: "project-blue", entityId: "service-api",
      entityType: "service", name: "Blue API", properties: { owner: "blue" },
      expectedVersion: 0, now: 101,
    });
    expect(red).toMatchObject({ projectId: "project-red", name: "Red API", version: 1 });
    expect(blue).toMatchObject({ projectId: "project-blue", name: "Blue API", version: 1 });
    await expect(store.getEntity({
      tenantId: "tenant-alpha", projectId: "project-red", entityId: "service-api",
    })).resolves.toMatchObject({ name: "Red API", properties: { owner: "red" } });
    await expect(store.getEntity({
      tenantId: "tenant-alpha", projectId: "project-blue", entityId: "service-api",
    })).resolves.toMatchObject({ name: "Blue API", properties: { owner: "blue" } });
    await expect(store.getEntity({
      tenantId: "tenant-alpha", projectId: "project-green", entityId: "service-api",
    })).resolves.toBeNull();
  });

  it("rejects cross-project relationships and tag attachments", async () => {
    const store = storeFor("knowledge-project-relationship-tag-isolation");
    await store.upsertEntity({
      tenantId: "tenant-alpha", projectId: "project-red", entityId: "source",
      entityType: "service", name: "Source", expectedVersion: 0, now: 100,
    });
    await store.upsertEntity({
      tenantId: "tenant-alpha", projectId: "project-blue", entityId: "target",
      entityType: "service", name: "Target", expectedVersion: 0, now: 101,
    });
    await store.putTag({
      tenantId: "tenant-alpha", projectId: "project-red", tagId: "critical",
      label: "Critical", now: 102,
    });
    await runInDurableObject(store, async instance => {
      expect(() => instance.createRelationship({
        tenantId: "tenant-alpha", projectId: "project-red", relationshipId: "cross-project-rel",
        sourceEntityId: "source", targetEntityId: "target", relationType: "depends_on", now: 103,
      })).toThrow();
      expect(() => instance.attachTag({
        tenantId: "tenant-alpha", projectId: "project-blue", entityId: "target",
        tagId: "critical", now: 104,
      })).toThrow();
    });
    await expect(store.listEntityTags({
      tenantId: "tenant-alpha", projectId: "project-blue", entityId: "target",
    })).resolves.toEqual([]);
  });

  it("isolates derived FTS search and rebuild operations by project", async () => {
    const store = storeFor("knowledge-project-search-isolation");
    await store.upsertEntity({
      tenantId: "tenant-alpha", projectId: "project-red", entityId: "red-payment",
      entityType: "service", name: "Red payment gateway",
      properties: { description: "payment settlement" }, expectedVersion: 0, now: 100,
    });
    await store.upsertEntity({
      tenantId: "tenant-alpha", projectId: "project-blue", entityId: "blue-payment",
      entityType: "service", name: "Blue payment gateway",
      properties: { description: "payment settlement" }, expectedVersion: 0, now: 101,
    });
    await expect(store.search({
      tenantId: "tenant-alpha", projectId: "project-red", query: "payment settlement", limit: 10,
    })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ recordId: "red-payment" }),
    ]));
    await expect(store.search({
      tenantId: "tenant-alpha", projectId: "project-red", query: "payment settlement", limit: 10,
    })).resolves.not.toEqual(expect.arrayContaining([
      expect.objectContaining({ recordId: "blue-payment" }),
    ]));
    await store.rebuildIndex({ tenantId: "tenant-alpha", projectId: "project-red" });
    await expect(store.search({
      tenantId: "tenant-alpha", projectId: "project-blue", query: "payment settlement", limit: 10,
    })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ recordId: "blue-payment" }),
    ]));
  });

  it("supports same outbox event and idempotency identifiers in independent projects", async () => {
    const store = storeFor("knowledge-project-outbox-isolation");
    const base = {
      tenantId: "tenant-alpha", eventId: "event-shared", idempotencyKey: "request-shared",
      aggregateType: "document", aggregateId: "doc-shared", eventType: "vault.document.sync",
      payload: { path: "docs/architecture.md" }, now: 100,
    };
    const red = await store.enqueueOutbox({ ...base, projectId: "project-red" });
    const blue = await store.enqueueOutbox({ ...base, projectId: "project-blue", now: 101 });
    expect(red).toMatchObject({ projectId: "project-red", eventId: "event-shared" });
    expect(blue).toMatchObject({ projectId: "project-blue", eventId: "event-shared" });
    const redClaim = await store.claimOutbox({
      tenantId: "tenant-alpha", projectId: "project-red", now: 102, leaseMs: 1_000,
    });
    const blueClaim = await store.claimOutbox({
      tenantId: "tenant-alpha", projectId: "project-blue", now: 103, leaseMs: 1_000,
    });
    expect(redClaim).toMatchObject({ projectId: "project-red", eventId: "event-shared" });
    expect(blueClaim).toMatchObject({ projectId: "project-blue", eventId: "event-shared" });
    await store.completeOutbox({
      tenantId: "tenant-alpha", projectId: "project-red", eventId: "event-shared",
      leaseGeneration: redClaim.leaseGeneration, now: 104,
    });
    await expect(store.getOutboxEvent({
      tenantId: "tenant-alpha", projectId: "project-red", eventId: "event-shared",
    })).resolves.toMatchObject({ status: "completed" });
    await expect(store.getOutboxEvent({
      tenantId: "tenant-alpha", projectId: "project-blue", eventId: "event-shared",
    })).resolves.toMatchObject({ status: "processing" });
  });

  it("keeps document revisions and Vault proposals project-local", async () => {
    const store = storeFor("knowledge-project-doc-proposal-isolation");
    const sha = "a".repeat(40);
    const redRef = {
      tenantId: "tenant-alpha", projectId: "project-red", documentId: "adr-shared",
      repository: "org/red-repo", path: "docs/adr.md", commitSha: sha,
      contentSha256: "b".repeat(64), now: 100,
    };
    const blueRef = {
      ...redRef, projectId: "project-blue", repository: "org/blue-repo",
      path: "architecture/adr.md", contentSha256: "c".repeat(64), now: 101,
    };
    await store.putDocumentRef(redRef);
    await store.putDocumentRef(blueRef);
    await expect(store.listDocumentRefs({
      tenantId: "tenant-alpha", projectId: "project-red", documentId: "adr-shared",
    })).resolves.toHaveLength(1);
    await expect(store.listDocumentRefs({
      tenantId: "tenant-alpha", projectId: "project-blue", documentId: "adr-shared",
    })).resolves.toMatchObject([expect.objectContaining({ repository: "org/blue-repo" })]);

    const proposal = {
      tenantId: "tenant-alpha", proposalId: "proposal-shared", documentId: "adr-shared",
      repository: "org/red-repo", path: "docs/adr.md", expectedBlobSha: "ABSENT",
      proposedContentSha256: await sha256("red proposal"), pullRequestNumber: 51,
      pullRequestUrl: "https://github.com/org/red-repo/pull/51",
      branch: "feature/red", commitSha: "d".repeat(40), now: 102,
    };
    const redProposal = await store.recordVaultProposal({ ...proposal, projectId: "project-red" });
    const blueProposal = await store.recordVaultProposal({
      ...proposal, projectId: "project-blue", repository: "org/blue-repo",
      path: "architecture/adr.md", pullRequestNumber: 51,
      pullRequestUrl: "https://github.com/org/blue-repo/pull/51",
      proposedContentSha256: await sha256("blue proposal"), commitSha: "e".repeat(40), now: 103,
    });
    expect(redProposal).toMatchObject({ projectId: "project-red", proposalId: "proposal-shared" });
    expect(blueProposal).toMatchObject({ projectId: "project-blue", proposalId: "proposal-shared" });
    await expect(store.getVaultProposal({
      tenantId: "tenant-alpha", projectId: "project-blue", proposalId: "proposal-shared",
    })).resolves.toMatchObject({ repository: "org/blue-repo" });
  });
});
