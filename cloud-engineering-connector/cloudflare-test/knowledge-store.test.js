import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

function storeFor(name) {
  return env.KNOWLEDGE_STORE.get(env.KNOWLEDGE_STORE.idFromName(name));
}

describe("KnowledgeStore tenant-scoped data integrity", () => {
  it("initializes a versioned SQLite schema and exposes a readiness probe", async () => {
    const store = storeFor("knowledge-schema-ready");
    await expect(store.ping()).resolves.toEqual({ ok: true, schemaVersion: 1 });
  });

  it("upserts and retrieves entities only within the authenticated tenant namespace", async () => {
    const store = storeFor("knowledge-tenant-isolation");
    const first = await store.upsertEntity({
      tenantId: "tenant-a", entityId: "project-1", entityType: "project",
      name: "Master Brain", properties: { status: "active" }, now: 100,
    });
    expect(first).toMatchObject({ tenantId: "tenant-a", entityId: "project-1", name: "Master Brain" });
    await store.upsertEntity({
      tenantId: "tenant-b", entityId: "project-1", entityType: "project",
      name: "Different tenant project", properties: {}, now: 101,
    });
    await expect(store.getEntity({ tenantId: "tenant-a", entityId: "project-1" }))
      .resolves.toMatchObject({ name: "Master Brain", properties: { status: "active" }, createdAt: 100 });
    await expect(store.getEntity({ tenantId: "tenant-b", entityId: "project-1" }))
      .resolves.toMatchObject({ name: "Different tenant project" });
    await expect(store.getEntity({ tenantId: "tenant-c", entityId: "project-1" })).resolves.toBeNull();
  });

  it("updates an entity without changing its original creation timestamp", async () => {
    const store = storeFor("knowledge-entity-upsert");
    await store.upsertEntity({
      tenantId: "tenant-a", entityId: "entity-1", entityType: "service",
      name: "Old name", properties: { version: 1 }, now: 100,
    });
    const updated = await store.upsertEntity({
      tenantId: "tenant-a", entityId: "entity-1", entityType: "service",
      name: "New name", properties: { version: 2 }, now: 200,
    });
    expect(updated).toMatchObject({ name: "New name", properties: { version: 2 }, createdAt: 100, updatedAt: 200 });
  });

  it("rejects relationships whose endpoints do not both exist in the same tenant", async () => {
    const store = storeFor("knowledge-relationship-foreign-keys");
    await store.upsertEntity({ tenantId: "tenant-a", entityId: "source", entityType: "service", name: "Source", now: 100 });
    await expect(Promise.resolve().then(() => store.createRelationship({
      tenantId: "tenant-a", relationshipId: "rel-1", sourceEntityId: "source",
      targetEntityId: "missing", relationType: "depends_on", now: 101,
    }))).rejects.toThrow();
    await store.upsertEntity({ tenantId: "tenant-b", entityId: "target", entityType: "service", name: "Other tenant", now: 100 });
    await expect(Promise.resolve().then(() => store.createRelationship({
      tenantId: "tenant-a", relationshipId: "rel-2", sourceEntityId: "source",
      targetEntityId: "target", relationType: "depends_on", now: 102,
    }))).rejects.toThrow();
  });

  it("stores immutable document revisions keyed by tenant, document, and Git commit SHA", async () => {
    const store = storeFor("knowledge-document-revisions");
    const base = {
      tenantId: "tenant-a", documentId: "adr-001",
      repository: "owner/knowledge-vault", path: "decisions/adr-001.md",
      contentSha256: "a".repeat(64),
    };
    await store.putDocumentRef({ ...base, commitSha: "1".repeat(40), now: 100 });
    await store.putDocumentRef({ ...base, commitSha: "2".repeat(40), contentSha256: "b".repeat(64), now: 200 });
    await expect(Promise.resolve().then(() => store.putDocumentRef({
      ...base, commitSha: "1".repeat(40), contentSha256: "c".repeat(64), now: 300,
    }))).rejects.toThrow(/immutable/);
    await expect(store.putDocumentRef({ ...base, commitSha: "1".repeat(40), now: 400 }))
      .resolves.toMatchObject({ contentSha256: "a".repeat(64), updatedAt: 100 });
    await expect(store.listDocumentRefs({ tenantId: "tenant-a", documentId: "adr-001" }))
      .resolves.toHaveLength(2);
    await expect(store.listDocumentRefs({ tenantId: "tenant-b", documentId: "adr-001" }))
      .resolves.toHaveLength(0);
  });

  it("rejects malformed Git references, non-normalized paths, and oversized or non-object properties", async () => {
    const store = storeFor("knowledge-input-validation");
    const base = {
      tenantId: "tenant-a", documentId: "doc-1", repository: "owner/repo",
      path: "docs/design.md", commitSha: "a".repeat(40), contentSha256: "b".repeat(64),
    };
    await expect(Promise.resolve().then(() => store.putDocumentRef({ ...base, commitSha: "not-a-git-sha" }))).rejects.toThrow(/commitSha/);
    await expect(Promise.resolve().then(() => store.putDocumentRef({ ...base, path: "../secrets.md" }))).rejects.toThrow(/path/);
    await expect(Promise.resolve().then(() => store.upsertEntity({
      tenantId: "tenant-a", entityId: "bad-entity", entityType: "note",
      name: "Bad properties", properties: ["not", "an", "object"],
    }))).rejects.toThrow(/properties/);
    await expect(Promise.resolve().then(() => store.upsertEntity({
      tenantId: "tenant-a", entityId: "bad/id", entityType: "note",
      name: "Bad identifier", properties: {},
    }))).rejects.toThrow(/entityId/);
    await expect(Promise.resolve().then(() => store.upsertEntity({
      tenantId: "tenant-a", entityId: "oversized", entityType: "note",
      name: "Oversized properties", properties: { payload: "x".repeat(32_769) },
    }))).rejects.toThrow(/32768 bytes/);
  });

  it("persists tenant records in the Durable Object SQLite storage", async () => {
    const store = storeFor("knowledge-persistence");
    await store.upsertEntity({
      tenantId: "tenant-a", entityId: "persistent-1", entityType: "document",
      name: "Persistent record", properties: { durable: true }, now: 100,
    });
    await runInDurableObject(store, async (instance) => {
      expect(instance.ping()).toEqual({ ok: true, schemaVersion: 1 });
      expect(instance.getEntity({ tenantId: "tenant-a", entityId: "persistent-1" }))
        .toMatchObject({ name: "Persistent record", properties: { durable: true } });
    });
  });
});
