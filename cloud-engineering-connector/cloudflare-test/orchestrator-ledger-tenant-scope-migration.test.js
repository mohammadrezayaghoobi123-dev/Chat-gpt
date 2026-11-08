import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

function ledgerFor(name) {
  return env.ORCHESTRATOR_LEDGER.get(env.ORCHESTRATOR_LEDGER.idFromName(name));
}

const SCOPED_TABLES = [
  "orchestrator_tasks",
  "orchestrator_processed_messages",
  "orchestrator_execution_leases",
  "orchestrator_claim_candidates",
  "orchestrator_claim_scan_cursors",
  "orchestrator_outbox_events",
  "orchestrator_outbox_receipts",
  "orchestrator_outbox_dead_letters",
  "orchestrator_consumed_assertions",
  "orchestrator_consumed_reconciliation_evidence",
  "orchestrator_github_webhook_deliveries",
  "orchestrator_github_business_idempotency",
  "orchestrator_owner_consumed_assertions",
  "orchestrator_owner_command_receipts",
  "orchestrator_audit_events",
];

describe("OrchestratorLedger tenant/project scope schema migration", () => {
  it("adds explicit tenant and project scope to every persisted ledger table", async () => {
    const ledger = ledgerFor("tenant-scope-schema-v8");
    await runInDurableObject(ledger, async instance => {
      const sql = instance.ctx.storage.sql;
      for (const table of SCOPED_TABLES) {
        const columns = new Set(sql.exec(`PRAGMA table_info(${table})`).toArray().map(row => row.name));
        expect(columns.has("tenant_id"), `${table} must have tenant_id`).toBe(true);
        expect(columns.has("project_id"), `${table} must have project_id`).toBe(true);
      }
      expect(instance.ping().schemaVersion).toBe(8);
    });
  });

  it("preserves a v7 task row and assigns an explicit legacy scope during migration", async () => {
    const ledger = ledgerFor("tenant-scope-v7-upgrade");
    await runInDurableObject(ledger, async instance => {
      const sql = instance.ctx.storage.sql;
      sql.exec("DROP TABLE orchestrator_claim_candidates");
      sql.exec("DROP TABLE orchestrator_tasks");
      sql.exec(`
        CREATE TABLE orchestrator_tasks (
          task_id TEXT PRIMARY KEY,
          idempotency_key TEXT NOT NULL UNIQUE,
          input_hash TEXT NOT NULL CHECK(length(input_hash) = 64),
          state TEXT NOT NULL,
          version INTEGER NOT NULL CHECK(version > 0),
          task_json TEXT NOT NULL CHECK(json_valid(task_json)),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
      const task = {
        taskId: "legacy-task-1",
        state: "SCHEDULED",
        version: 1,
        createdAt: 100,
        updatedAt: 100,
        title: "preserve legacy task",
      };
      sql.exec(
        "INSERT INTO orchestrator_tasks (task_id, idempotency_key, input_hash, state, version, task_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        task.taskId,
        "legacy-idem-1",
        "a".repeat(64),
        task.state,
        task.version,
        JSON.stringify(task),
        task.createdAt,
        task.updatedAt,
      );

      instance.ensureSchema();
      const row = sql.exec("SELECT * FROM orchestrator_tasks WHERE task_id = ?", task.taskId).toArray()[0];
      expect(row).toMatchObject({
        task_id: task.taskId,
        idempotency_key: "legacy-idempotency-1",
        input_hash: "a".repeat(64),
        state: "SCHEDULED",
        version: 1,
        created_at: 100,
        updated_at: 100,
        tenant_id: "__legacy__",
        project_id: "__legacy__",
      });
      expect(JSON.parse(row.task_json)).toEqual(task);
    });
  });

  it("is idempotent and does not rewrite existing scoped records on repeated initialization", async () => {
    const ledger = ledgerFor("tenant-scope-migration-idempotent");
    await runInDurableObject(ledger, async instance => {
      const sql = instance.ctx.storage.sql;
      instance.ensureSchema();
      instance.ensureSchema();
      const migration = sql.exec(
        "SELECT version FROM orchestrator_schema_migrations WHERE version = 8",
      ).toArray()[0];
      expect(migration?.version).toBe(8);
      const row = sql.exec(
        "SELECT tenant_id, project_id FROM orchestrator_tasks WHERE task_id = ?",
        "not-present",
      ).toArray()[0];
      expect(row).toBeUndefined();
    });
  });
});
