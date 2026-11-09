import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

function storeFor(name) {
  return env.KNOWLEDGE_STORE.get(env.KNOWLEDGE_STORE.idFromName(name));
}

describe("Brain Store v4 project-scope migration", () => {
  it("copies all tenant-only v3 records into the quarantined legacy project without data loss", async () => {
    const store = storeFor("knowledge-v4-legacy-migration");
    await runInDurableObject(store, async instance => {
      const sql = instance.ctx.storage.sql;
      const now = 1_800_000_000_000;
      const commit = "a".repeat(40);
      const digest = "b".repeat(64);

      sql.exec(
        "INSERT INTO knowledge_entities(tenant_id, entity_id, entity_type, name, properties_json, version, created_at, updated_at) VALUES(?, ?, ?, ?, ?, 1, ?, ?)",
        "tenant-old", "legacy-source", "service", "Legacy source", JSON.stringify({ preserved: true }), now - 20, now - 10,
      );
      sql.exec(
        "INSERT INTO knowledge_entities(tenant_id, entity_id, entity_type, name, properties_json, version, created_at, updated_at) VALUES(?, ?, ?, ?, ?, 1, ?, ?)",
        "tenant-old", "legacy-target", "service", "Legacy target", JSON.stringify({ preserved: true }), now - 20, now - 10,
      );
      sql.exec(
        "INSERT INTO knowledge_relationships(tenant_id, relationship_id, source_entity_id, target_entity_id, relation_type, properties_json, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)",
        "tenant-old", "legacy-rel", "legacy-source", "legacy-target", "depends_on", JSON.stringify({ weight: 1 }), now - 9,
      );
      sql.exec(
        "INSERT INTO knowledge_tags(tenant_id, tag_id, label, normalized_label, created_at) VALUES(?, ?, ?, ?, ?)",
        "tenant-old", "legacy-tag", "Legacy", "legacy", now - 8,
      );
      sql.exec(
        "INSERT INTO knowledge_entity_tags(tenant_id, entity_id, tag_id, created_at) VALUES(?, ?, ?, ?)",
        "tenant-old", "legacy-source", "legacy-tag", now - 7,
      );
      sql.exec(
        "INSERT INTO knowledge_document_refs(tenant_id, document_id, repository, path, commit_sha, content_sha256, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?)",
        "tenant-old", "legacy-doc", "org/legacy", "docs/legacy.md", commit, digest, now - 6,
      );
      sql.exec(
        "INSERT INTO knowledge_document_sync(tenant_id, document_id, status, last_seen_commit, last_synced_commit, last_error, updated_at) VALUES(?, ?, ?, ?, ?, NULL, ?)",
        "tenant-old", "legacy-doc", "synced", commit, commit, now - 5,
      );
      sql.exec(
        "INSERT INTO knowledge_outbox(event_id, tenant_id, idempotency_key, aggregate_type, aggregate_id, event_type, payload_json, fingerprint, status, attempts, next_attempt_at, lease_until, lease_generation, last_error, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, NULL, 0, NULL, ?, ?)",
        "legacy-event", "tenant-old", "legacy-idem", "document", "legacy-doc", "vault.sync",
        JSON.stringify({ documentId: "legacy-doc" }), digest, now, now - 4, now - 4,
      );
      sql.exec(
        "INSERT INTO knowledge_vault_proposals(tenant_id, proposal_id, document_id, repository, path, expected_blob_sha, proposed_content_sha256, pr_number, pr_url, branch, commit_sha, status, merge_commit_sha, merged_blob_sha, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', NULL, NULL, ?, ?)",
        "tenant-old", "legacy-proposal", "legacy-doc", "org/legacy", "docs/legacy.md", "ABSENT",
        digest, 7, "https://github.com/org/legacy/pull/7", "legacy/branch", commit, now - 3, now - 3,
      );
      sql.exec(
        "INSERT INTO knowledge_index_sources(tenant_id, record_type, record_id, commit_sha, content_sha256, title, body, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)",
        "tenant-old", "document", "legacy-doc", commit, digest, "Legacy document", "legacy indexed body", now - 2,
      );

      sql.exec("DELETE FROM knowledge_schema_migrations WHERE version = 4");
      instance.ensureSchema();

      const count = table => sql.exec(
        "SELECT COUNT(*) AS count FROM " + table + " WHERE tenant_id = ? AND project_id = '__legacy__'",
        "tenant-old",
      ).one().count;
      expect(count("knowledge_entities_v4")).toBe(2);
      expect(count("knowledge_relationships_v4")).toBe(1);
      expect(count("knowledge_tags_v4")).toBe(1);
      expect(count("knowledge_entity_tags_v4")).toBe(1);
      expect(count("knowledge_document_refs_v4")).toBe(1);
      expect(count("knowledge_document_sync_v4")).toBe(1);
      expect(count("knowledge_outbox_v4")).toBe(1);
      expect(count("knowledge_vault_proposals_v4")).toBe(1);
      expect(count("knowledge_index_sources_v4")).toBe(1);
      expect(sql.exec(
        "SELECT COUNT(*) AS count FROM knowledge_fts_v4 WHERE tenant_id = ? AND project_id = '__legacy__'",
        "tenant-old",
      ).one().count).toBe(1);
      expect(instance.getEntity({
        tenantId: "tenant-old", projectId: "project-new", entityId: "legacy-source",
      })).toBeNull();
      expect(sql.exec(
        "SELECT COUNT(*) AS count FROM knowledge_entities WHERE tenant_id = ?",
        "tenant-old",
      ).one().count).toBe(2);
      expect(instance.ping()).toEqual({ ok: true, schemaVersion: 4 });
    });
  });
});
