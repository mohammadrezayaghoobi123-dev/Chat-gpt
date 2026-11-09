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
      expect(instance.ping().schemaVersion).toBe(11);
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
        idempotency_key: "legacy-idem-1",
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

  it("backfills child rows from the task's persisted tenant/project identity", async () => {
    const ledger = ledgerFor("tenant-scope-child-backfill");
    await runInDurableObject(ledger, async instance => {
      const sql = instance.ctx.storage.sql;
      sql.exec("DROP TABLE orchestrator_claim_candidates");
      sql.exec("DROP TABLE orchestrator_tasks");
      sql.exec("DROP TABLE orchestrator_processed_messages");
      sql.exec("DROP TABLE orchestrator_execution_leases");
      sql.exec("DROP TABLE orchestrator_outbox_events");
      sql.exec("DROP TABLE orchestrator_audit_events");
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
      sql.exec(`
        CREATE TABLE orchestrator_processed_messages (
          message_id TEXT PRIMARY KEY, task_id TEXT NOT NULL,
          input_hash TEXT NOT NULL CHECK(length(input_hash) = 64),
          envelope_json TEXT NOT NULL CHECK(json_valid(envelope_json)),
          received_at INTEGER NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('ACCEPTED','QUARANTINED'))
        )
      `);
      sql.exec(`
        CREATE TABLE orchestrator_execution_leases (
          task_id TEXT PRIMARY KEY, worker_id TEXT,
          lease_generation INTEGER NOT NULL CHECK(lease_generation >= 0),
          lease_until INTEGER NOT NULL, updated_at INTEGER NOT NULL
        )
      `);
      sql.exec(`
        CREATE TABLE orchestrator_outbox_events (
          event_id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE,
          task_id TEXT NOT NULL, event_type TEXT NOT NULL,
          payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
          status TEXT NOT NULL CHECK(status IN ('PENDING','IN_PROGRESS','COMPLETED')),
          attempts INTEGER NOT NULL CHECK(attempts >= 0),
          lease_worker_id TEXT, lease_generation INTEGER NOT NULL CHECK(lease_generation >= 0),
          lease_until INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        )
      `);
      sql.exec(`
        CREATE TABLE orchestrator_audit_events (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE,
          task_id TEXT NOT NULL, actor_id TEXT NOT NULL, actor_role TEXT NOT NULL,
          event_type TEXT NOT NULL, details_json TEXT NOT NULL CHECK(json_valid(details_json)),
          previous_hash TEXT, event_hash TEXT NOT NULL CHECK(length(event_hash) = 64),
          created_at INTEGER NOT NULL
        )
      `);
      const task = {
        taskId: "scoped-task-1", tenantId: "tenant-alpha", projectId: "project-red",
        state: "SCHEDULED", version: 1, createdAt: 200, updatedAt: 200,
      };
      sql.exec(
        "INSERT INTO orchestrator_tasks (task_id, idempotency_key, input_hash, state, version, task_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        task.taskId, "idem-backfill", "b".repeat(64), task.state, task.version,
        JSON.stringify(task), task.createdAt, task.updatedAt,
      );
      sql.exec(
        "INSERT INTO orchestrator_processed_messages (message_id, task_id, input_hash, envelope_json, received_at, status) VALUES (?, ?, ?, ?, ?, 'ACCEPTED')",
        "message-backfill", task.taskId, "c".repeat(64), JSON.stringify({ messageId: "message-backfill" }), 201,
      );
      sql.exec(
        "INSERT INTO orchestrator_execution_leases (task_id, worker_id, lease_generation, lease_until, updated_at) VALUES (?, ?, ?, ?, ?)",
        task.taskId, "worker-alpha", 2, 500, 202,
      );
      sql.exec(
        "INSERT INTO orchestrator_outbox_events (event_id, idempotency_key, task_id, event_type, payload_json, status, attempts, lease_generation, lease_until, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'PENDING', 0, 0, 0, 203, 203)",
        "event-backfill", "idem-event-backfill", task.taskId, "task.created", JSON.stringify({ taskId: task.taskId }),
      );
      sql.exec(
        "INSERT INTO orchestrator_audit_events (event_id, task_id, actor_id, actor_role, event_type, details_json, event_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        "audit-backfill", task.taskId, "system", "system", "TASK_CREATED", JSON.stringify({ taskId: task.taskId }), "d".repeat(64), 204,
      );

      instance.ensureSchema();
      for (const table of [
        "orchestrator_processed_messages",
        "orchestrator_execution_leases",
        "orchestrator_outbox_events",
        "orchestrator_audit_events",
      ]) {
        const row = sql.exec(`SELECT tenant_id, project_id FROM ${table} LIMIT 1`).toArray()[0];
        expect(row, `${table} must inherit only its linked task scope`).toEqual({
          tenant_id: "tenant-alpha",
          project_id: "project-red",
        });
      }
    });
  });

  it("does not return a task across tenant or project boundaries", async () => {
    const ledger = ledgerFor("tenant-scope-task-read-boundary");
    await runInDurableObject(ledger, async instance => {
      const sql = instance.ctx.storage.sql;
      const task = {
        taskId: "private-task-a",
        tenantId: "tenant-alpha",
        projectId: "project-red",
        state: "SCHEDULED",
        version: 1,
        createdAt: 300,
        updatedAt: 300,
      };
      sql.exec(
        "INSERT INTO orchestrator_tasks (task_id, idempotency_key, input_hash, state, version, task_json, created_at, updated_at, tenant_id, project_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        task.taskId, "idem-private-a", "e".repeat(64), task.state, task.version,
        JSON.stringify(task), task.createdAt, task.updatedAt, task.tenantId, task.projectId,
      );

      expect(instance.getTask({
        taskId: task.taskId,
        tenantId: "tenant-beta",
        projectId: "project-red",
      })).toBeNull();
      expect(instance.getTask({
        taskId: task.taskId,
        tenantId: "tenant-alpha",
        projectId: "project-blue",
      })).toBeNull();
      expect(instance.getTask({
        taskId: task.taskId,
        tenantId: "tenant-alpha",
        projectId: "project-red",
      })).toMatchObject({ taskId: task.taskId, tenantId: "tenant-alpha", projectId: "project-red" });
      expect(instance.getTask({ taskId: task.taskId })).toBeNull();
    });
  });

  it("does not rerun the v8 task-scope backfill after its migration is recorded", async () => {
    const ledger = ledgerFor("tenant-scope-v8-no-repeat-backfill");
    await runInDurableObject(ledger, async instance => {
      const sql = instance.ctx.storage.sql;
      const task = {
        taskId: "v8-repeat-task",
        tenantId: "tenant-repeat",
        projectId: "project-repeat",
        state: "SCHEDULED",
        version: 1,
        createdAt: 400,
        updatedAt: 400,
      };
      sql.exec(
        "INSERT INTO orchestrator_tasks (task_id, idempotency_key, input_hash, state, version, task_json, created_at, updated_at, tenant_id, project_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        task.taskId,
        "idem-v8-repeat",
        "f".repeat(64),
        task.state,
        task.version,
        JSON.stringify(task),
        task.createdAt,
        task.updatedAt,
        task.tenantId,
        task.projectId,
      );
      sql.exec("CREATE TABLE v8_migration_update_probe (updates INTEGER NOT NULL)");
      sql.exec("INSERT INTO v8_migration_update_probe (updates) VALUES (0)");
      sql.exec(`
        CREATE TRIGGER count_v8_task_backfill_updates
        BEFORE UPDATE ON orchestrator_tasks
        BEGIN
          UPDATE v8_migration_update_probe SET updates = updates + 1;
        END
      `);

      instance.ensureSchema();

      expect(sql.exec("SELECT updates FROM v8_migration_update_probe").toArray()[0].updates).toBe(0);
      expect(sql.exec(
        "SELECT tenant_id, project_id FROM orchestrator_tasks WHERE task_id = ?",
        task.taskId,
      ).toArray()[0]).toEqual({
        tenant_id: "tenant-repeat",
        project_id: "project-repeat",
      });
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
      const scopedBackfillIndexMigration = sql.exec(
        "SELECT version FROM orchestrator_schema_migrations WHERE version = 10",
      ).toArray()[0];
      expect(scopedBackfillIndexMigration?.version).toBe(10);
      const index = sql.exec(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?",
        "orchestrator_tasks_by_scope_executor_created",
      ).toArray()[0];
      expect(index?.name).toBe("orchestrator_tasks_by_scope_executor_created");
      const claimDiagnosticIndexMigration = sql.exec(
        "SELECT version FROM orchestrator_schema_migrations WHERE version = 11",
      ).toArray()[0];
      expect(claimDiagnosticIndexMigration?.version).toBe(11);
      const diagnosticIndex = sql.exec(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?",
        "orchestrator_tasks_by_scope_state_executor_created",
      ).toArray()[0];
      expect(diagnosticIndex?.name).toBe("orchestrator_tasks_by_scope_state_executor_created");
      const row = sql.exec(
        "SELECT tenant_id, project_id FROM orchestrator_tasks WHERE task_id = ?",
        "not-present",
      ).toArray()[0];
      expect(row).toBeUndefined();
    });
  });
});
