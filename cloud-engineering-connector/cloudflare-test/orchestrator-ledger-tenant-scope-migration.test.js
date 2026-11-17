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
      expect(instance.ping().schemaVersion).toBe(12);
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

      // Rewind the complete v8-v12 migration chain to model a v7 database.
      sql.exec("DELETE FROM orchestrator_schema_migrations WHERE version BETWEEN 8 AND 12");
      instance.ensureSchema();
      const row = sql.exec("SELECT * FROM orchestrator_tasks WHERE task_id = ?", task.taskId).toArray()[0];
      expect(row).toMatchObject({
        task_id: task.taskId,
        idempotency_key: "tp1:10:__legacy__:10:__legacy__:13:legacy-idem-1",
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

      // Rewind the complete v8-v12 migration chain to model a v7 database.
      sql.exec("DELETE FROM orchestrator_schema_migrations WHERE version BETWEEN 8 AND 12");
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

  it("migrates v8 idempotency keys without transient global-UNIQUE collisions", async () => {
    const ledger = ledgerFor("tenant-scope-v9-idempotency-key-collision");
    await runInDurableObject(ledger, async instance => {
      const sql = instance.ctx.storage.sql;

      // Reconstruct the v8 boundary while retaining the legacy global UNIQUE
      // constraint on orchestrator_tasks.idempotency_key.
      for (const indexName of [
        "orchestrator_tasks_by_tenant_project_idempotency",
        "orchestrator_outbox_by_tenant_project_idempotency",
        "orchestrator_claim_candidates_by_scope_executor_order",
        "orchestrator_tasks_by_scope_executor_created",
        "orchestrator_tasks_by_scope_state_executor_created",
        "orchestrator_tasks_by_tenant_project",
      ]) {
        sql.exec("DROP INDEX IF EXISTS " + indexName);
      }
      sql.exec("DELETE FROM orchestrator_schema_migrations WHERE version IN (9, 10, 11, 12)");
      sql.exec("CREATE INDEX orchestrator_tasks_by_tenant_project ON orchestrator_tasks(tenant_id, project_id)");

      const firstTask = {
        taskId: "collision-task-a",
        tenantId: "a",
        projectId: "b",
        state: "SCHEDULED",
        version: 1,
        createdAt: 1000,
        updatedAt: 1000,
      };
      const secondTask = {
        taskId: "collision-task-b",
        tenantId: "x",
        projectId: "y",
        state: "SCHEDULED",
        version: 1,
        createdAt: 1001,
        updatedAt: 1001,
      };
      const secondLegacyKey = "tp1:1:a:1:b:1:c";

      // The first row's final key equals the second row's still-legacy key.
      // A row-by-row in-place update therefore violates the old global UNIQUE
      // constraint even though both final encoded keys are distinct.
      for (const [task, idempotencyKey] of [
        [firstTask, "c"],
        [secondTask, secondLegacyKey],
      ]) {
        sql.exec(
          "INSERT INTO orchestrator_tasks (task_id, idempotency_key, input_hash, state, version, task_json, created_at, updated_at, tenant_id, project_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          task.taskId,
          idempotencyKey,
          "a".repeat(64),
          task.state,
          task.version,
          JSON.stringify(task),
          task.createdAt,
          task.updatedAt,
          task.tenantId,
          task.projectId,
        );
      }

      expect(() => instance.ensureSchema()).not.toThrow();

      const migrated = sql.exec(
        "SELECT task_id, idempotency_key FROM orchestrator_tasks ORDER BY task_id",
      ).toArray();
      expect(migrated).toEqual([
        { task_id: "collision-task-a", idempotency_key: "tp1:1:a:1:b:1:c" },
        { task_id: "collision-task-b", idempotency_key: "tp1:1:x:1:y:15:tp1:1:a:1:b:1:c" },
      ]);
      expect(sql.exec(
        "SELECT version FROM orchestrator_schema_migrations WHERE version = 9",
      ).toArray()[0]?.version).toBe(9);
    });
  });

  it("migrates v8 outbox idempotency keys without transient global-UNIQUE collisions", async () => {
    const ledger = ledgerFor("tenant-scope-v9-outbox-idempotency-key-collision");
    await runInDurableObject(ledger, async instance => {
      const sql = instance.ctx.storage.sql;

      // Reconstruct the v8 boundary while retaining the legacy global UNIQUE
      // constraint on orchestrator_outbox_events.idempotency_key.
      for (const indexName of [
        "orchestrator_tasks_by_tenant_project_idempotency",
        "orchestrator_outbox_by_tenant_project_idempotency",
        "orchestrator_claim_candidates_by_scope_executor_order",
        "orchestrator_tasks_by_scope_executor_created",
        "orchestrator_tasks_by_scope_state_executor_created",
      ]) {
        sql.exec("DROP INDEX IF EXISTS " + indexName);
      }
      sql.exec("DELETE FROM orchestrator_schema_migrations WHERE version IN (9, 10, 11, 12)");

      const secondLegacyKey = "tp1:1:a:1:b:1:c";
      for (const [eventId, idempotencyKey, tenantId, projectId, createdAt] of [
        ["collision-event-a", "c", "a", "b", 1100],
        ["collision-event-b", secondLegacyKey, "x", "y", 1101],
      ]) {
        sql.exec(
          "INSERT INTO orchestrator_outbox_events (event_id, idempotency_key, task_id, event_type, payload_json, status, attempts, lease_worker_id, lease_generation, lease_until, created_at, updated_at, tenant_id, project_id) VALUES (?, ?, ?, ?, ?, 'PENDING', 0, NULL, 0, 0, ?, ?, ?, ?)",
          eventId,
          idempotencyKey,
          "legacy-task-" + eventId,
          "TASK_CREATED",
          "{}",
          createdAt,
          createdAt,
          tenantId,
          projectId,
        );
      }

      expect(() => instance.ensureSchema()).not.toThrow();

      const migrated = sql.exec(
        "SELECT event_id, idempotency_key FROM orchestrator_outbox_events ORDER BY event_id",
      ).toArray();
      expect(migrated).toEqual([
        { event_id: "collision-event-a", idempotency_key: "tp1:1:a:1:b:1:c" },
        { event_id: "collision-event-b", idempotency_key: "tp1:1:x:1:y:15:tp1:1:a:1:b:1:c" },
      ]);
      expect(sql.exec(
        "SELECT version FROM orchestrator_schema_migrations WHERE version = 9",
      ).toArray()[0]?.version).toBe(9);
    });
  });

  it("upgrades a populated schema-v9 ledger to v12 and drops only the task scope index", async () => {
    const ledger = ledgerFor("tenant-scope-v9-to-v12-upgrade");
    await runInDurableObject(ledger, async instance => {
      const sql = instance.ctx.storage.sql;
      const task = {
        taskId: "v9-upgrade-task",
        tenantId: "tenant-upgrade",
        projectId: "project-upgrade",
        executorId: "worker-upgrade",
        state: "SCHEDULED",
        version: 1,
        createdAt: 700,
        updatedAt: 701,
      };
      const taskJson = JSON.stringify(task);
      sql.exec(
        "INSERT INTO orchestrator_tasks (task_id, idempotency_key, input_hash, state, version, task_json, created_at, updated_at, tenant_id, project_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        task.taskId, "v9-upgrade-idempotency", "f".repeat(64), task.state,
        task.version, taskJson, task.createdAt, task.updatedAt, task.tenantId, task.projectId,
      );

      // Reconstruct the schema-v9 boundary: retain all v9 data and migrations,
      // but remove only the three additive indexes and their migration records.
      sql.exec("DROP INDEX IF EXISTS orchestrator_tasks_by_scope_executor_created");
      sql.exec("DROP INDEX IF EXISTS orchestrator_tasks_by_scope_state_executor_created");
      sql.exec("DELETE FROM orchestrator_schema_migrations WHERE version IN (10, 11, 12)");
      // Reconstruct the v9 state even though the test harness initialized the
      // current schema before entering this callback.
      sql.exec("CREATE INDEX IF NOT EXISTS orchestrator_tasks_by_tenant_project ON orchestrator_tasks(tenant_id, project_id)");
      expect(sql.exec("SELECT version FROM orchestrator_schema_migrations WHERE version = 9").toArray()[0]?.version).toBe(9);
      expect(sql.exec(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?",
        "orchestrator_tasks_by_tenant_project",
      ).toArray()[0]?.name).toBe("orchestrator_tasks_by_tenant_project");
      expect(sql.exec(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?",
        "orchestrator_outbox_events_by_tenant_project",
      ).toArray()[0]?.name).toBe("orchestrator_outbox_events_by_tenant_project");

      instance.ensureSchema();

      const row = sql.exec(
        "SELECT task_id, idempotency_key, input_hash, state, version, task_json, created_at, updated_at, tenant_id, project_id FROM orchestrator_tasks WHERE task_id = ?",
        task.taskId,
      ).toArray()[0];
      expect(row).toEqual({
        task_id: task.taskId,
        idempotency_key: "v9-upgrade-idempotency",
        input_hash: "f".repeat(64),
        state: task.state,
        version: task.version,
        task_json: taskJson,
        created_at: task.createdAt,
        updated_at: task.updatedAt,
        tenant_id: task.tenantId,
        project_id: task.projectId,
      });
      for (const indexName of [
        "orchestrator_tasks_by_scope_executor_created",
        "orchestrator_tasks_by_scope_state_executor_created",
        "orchestrator_outbox_events_by_tenant_project",
      ]) {
        const index = sql.exec(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?",
          indexName,
        ).toArray()[0];
        expect(index?.name).toBe(indexName);
      }
      expect(sql.exec(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?",
        "orchestrator_tasks_by_tenant_project",
      ).toArray()[0]).toBeUndefined();
      expect(sql.exec(
        "SELECT version FROM orchestrator_schema_migrations WHERE version = 12",
      ).toArray()[0]?.version).toBe(12);
      expect(instance.ping().schemaVersion).toBe(12);

      const appliedAtBeforeRetry = sql.exec(
        "SELECT version, applied_at FROM orchestrator_schema_migrations WHERE version IN (10, 11, 12) ORDER BY version",
      ).toArray();
      instance.ensureSchema();
      const appliedAtAfterRetry = sql.exec(
        "SELECT version, applied_at FROM orchestrator_schema_migrations WHERE version IN (10, 11, 12) ORDER BY version",
      ).toArray();
      expect(appliedAtAfterRetry).toEqual(appliedAtBeforeRetry);
      expect(sql.exec(
        "SELECT task_json FROM orchestrator_tasks WHERE task_id = ?",
        task.taskId,
      ).toArray()[0]?.task_json).toBe(taskJson);
    });
  });




  it("rolls back v8 task and child-scope backfills when its migration marker fails", async () => {
    const ledger = ledgerFor("tenant-scope-v8-rollback-on-marker-failure");
    await runInDurableObject(ledger, async instance => {
      const sql = instance.ctx.storage.sql;
      const task = {
        taskId: "v8-rollback-task",
        tenantId: "tenant-rollback",
        projectId: "project-rollback",
        state: "SCHEDULED",
        version: 1,
        createdAt: 900,
        updatedAt: 901,
      };
      // Reconstruct v7 task/lease tables so the v8 transaction itself is tested.
      sql.exec("DROP TABLE orchestrator_claim_candidates");
      sql.exec("DROP TABLE orchestrator_execution_leases");
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
      sql.exec(`
        CREATE TABLE orchestrator_execution_leases (
          task_id TEXT PRIMARY KEY,
          worker_id TEXT,
          lease_generation INTEGER NOT NULL CHECK(lease_generation >= 0),
          lease_until INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
      sql.exec("DELETE FROM orchestrator_schema_migrations WHERE version BETWEEN 8 AND 12");
      sql.exec(
        "INSERT INTO orchestrator_tasks (task_id, idempotency_key, input_hash, state, version, task_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        task.taskId, "v8-rollback-idem", "9".repeat(64), task.state,
        task.version, JSON.stringify(task), task.createdAt, task.updatedAt,
      );
      sql.exec(
        "INSERT INTO orchestrator_execution_leases (task_id, worker_id, lease_generation, lease_until, updated_at) VALUES (?, ?, ?, ?, ?)",
        task.taskId, "worker-rollback", 1, 1200, 902,
      );
      sql.exec(`
        CREATE TRIGGER reject_v8_migration_marker
        BEFORE INSERT ON orchestrator_schema_migrations
        WHEN NEW.version = 8
        BEGIN
          SELECT RAISE(ABORT, 'forced v8 marker failure');
        END
      `);

      expect(() => instance.ensureSchema()).toThrow(/forced v8 marker failure/);
      const taskColumnsAfterRollback = new Set(
        sql.exec("PRAGMA table_info(orchestrator_tasks)").toArray().map(column => column.name),
      );
      const leaseColumnsAfterRollback = new Set(
        sql.exec("PRAGMA table_info(orchestrator_execution_leases)").toArray().map(column => column.name),
      );
      expect(taskColumnsAfterRollback.has("tenant_id")).toBe(false);
      expect(taskColumnsAfterRollback.has("project_id")).toBe(false);
      expect(leaseColumnsAfterRollback.has("tenant_id")).toBe(false);
      expect(leaseColumnsAfterRollback.has("project_id")).toBe(false);
      expect(sql.exec(
        "SELECT task_json FROM orchestrator_tasks WHERE task_id = ?",
        task.taskId,
      ).toArray()[0]?.task_json).toBe(JSON.stringify(task));
      expect(sql.exec(
        "SELECT version FROM orchestrator_schema_migrations WHERE version = 8",
      ).toArray()[0]).toBeUndefined();

      sql.exec("DROP TRIGGER reject_v8_migration_marker");
      instance.ensureSchema();
      expect(sql.exec(
        "SELECT tenant_id, project_id FROM orchestrator_tasks WHERE task_id = ?",
        task.taskId,
      ).toArray()[0]).toEqual({ tenant_id: task.tenantId, project_id: task.projectId });
      expect(sql.exec(
        "SELECT tenant_id, project_id FROM orchestrator_execution_leases WHERE task_id = ?",
        task.taskId,
      ).toArray()[0]).toEqual({ tenant_id: task.tenantId, project_id: task.projectId });
      expect(sql.exec(
        "SELECT version FROM orchestrator_schema_migrations WHERE version = 8",
      ).toArray()[0]?.version).toBe(8);
      expect(instance.ping().schemaVersion).toBe(12);
    });
  });

  it("upgrades a populated schema-v8 ledger through v12 in order", async () => {
    const ledger = ledgerFor("tenant-scope-v8-to-v12-upgrade");
    await runInDurableObject(ledger, async instance => {
      const sql = instance.ctx.storage.sql;
      const task = {
        taskId: "v8-upgrade-task",
        tenantId: "tenant-v8",
        projectId: "project-v8",
        state: "SCHEDULED",
        version: 1,
        createdAt: 800,
        updatedAt: 801,
      };
      sql.exec(
        "INSERT INTO orchestrator_tasks (task_id, idempotency_key, input_hash, state, version, task_json, created_at, updated_at, tenant_id, project_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        task.taskId, "v8-idempotency-key", "8".repeat(64), task.state,
        task.version, JSON.stringify(task), task.createdAt, task.updatedAt,
        task.tenantId, task.projectId,
      );

      // Reconstruct v8: preserve v8 scope and task data, remove all later indexes/markers.
      sql.exec("DROP INDEX IF EXISTS orchestrator_tasks_by_tenant_project_idempotency");
      sql.exec("DROP INDEX IF EXISTS orchestrator_outbox_by_tenant_project_idempotency");
      sql.exec("DROP INDEX IF EXISTS orchestrator_claim_candidates_by_scope_executor_order");
      sql.exec("DROP INDEX IF EXISTS orchestrator_tasks_by_scope_executor_created");
      sql.exec("DROP INDEX IF EXISTS orchestrator_tasks_by_scope_state_executor_created");
      sql.exec("DELETE FROM orchestrator_schema_migrations WHERE version IN (9, 10, 11, 12)");
      sql.exec("CREATE INDEX IF NOT EXISTS orchestrator_tasks_by_tenant_project ON orchestrator_tasks(tenant_id, project_id)");
      expect(sql.exec("SELECT version FROM orchestrator_schema_migrations WHERE version = 8").toArray()[0]?.version).toBe(8);

      instance.ensureSchema();

      const row = sql.exec(
        "SELECT task_id, idempotency_key, task_json, tenant_id, project_id FROM orchestrator_tasks WHERE task_id = ?",
        task.taskId,
      ).toArray()[0];
      expect(row.task_id).toBe(task.taskId);
      expect(row.idempotency_key).not.toBe("v8-idempotency-key");
      expect(row.task_json).toBe(JSON.stringify(task));
      expect(row.tenant_id).toBe(task.tenantId);
      expect(row.project_id).toBe(task.projectId);
      for (const version of [8, 9, 10, 11, 12]) {
        expect(sql.exec(
          "SELECT version FROM orchestrator_schema_migrations WHERE version = ?",
          version,
        ).toArray()[0]?.version).toBe(version);
      }
      expect(instance.ping().schemaVersion).toBe(12);
      expect(sql.exec(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?",
        "orchestrator_tasks_by_tenant_project",
      ).toArray()[0]).toBeUndefined();
    });
  });

  it("upgrades a schema-v10 ledger through v12 without replaying v10", async () => {
    const ledger = ledgerFor("tenant-scope-v10-to-v12-upgrade");
    await runInDurableObject(ledger, async instance => {
      const sql = instance.ctx.storage.sql;
      sql.exec("DROP INDEX IF EXISTS orchestrator_tasks_by_scope_state_executor_created");
      sql.exec("DELETE FROM orchestrator_schema_migrations WHERE version IN (11, 12)");
      sql.exec("CREATE INDEX IF NOT EXISTS orchestrator_tasks_by_tenant_project ON orchestrator_tasks(tenant_id, project_id)");
      const v10AppliedAt = sql.exec(
        "SELECT applied_at FROM orchestrator_schema_migrations WHERE version = 10",
      ).toArray()[0]?.applied_at;

      instance.ensureSchema();

      expect(sql.exec("SELECT applied_at FROM orchestrator_schema_migrations WHERE version = 10").toArray()[0]?.applied_at).toBe(v10AppliedAt);
      expect(sql.exec("SELECT version FROM orchestrator_schema_migrations WHERE version = 11").toArray()[0]?.version).toBe(11);
      expect(sql.exec("SELECT version FROM orchestrator_schema_migrations WHERE version = 12").toArray()[0]?.version).toBe(12);
      expect(sql.exec(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?",
        "orchestrator_tasks_by_scope_state_executor_created",
      ).toArray()[0]?.name).toBe("orchestrator_tasks_by_scope_state_executor_created");
      expect(sql.exec(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?",
        "orchestrator_tasks_by_tenant_project",
      ).toArray()[0]).toBeUndefined();
      expect(instance.ping().schemaVersion).toBe(12);
    });
  });

  it("upgrades a schema-v11 ledger through v12 without replaying v10 or v11", async () => {
    const ledger = ledgerFor("tenant-scope-v11-to-v12-upgrade");
    await runInDurableObject(ledger, async instance => {
      const sql = instance.ctx.storage.sql;
      sql.exec("DELETE FROM orchestrator_schema_migrations WHERE version = 12");
      sql.exec("CREATE INDEX IF NOT EXISTS orchestrator_tasks_by_tenant_project ON orchestrator_tasks(tenant_id, project_id)");
      const appliedBefore = sql.exec(
        "SELECT version, applied_at FROM orchestrator_schema_migrations WHERE version IN (10, 11) ORDER BY version",
      ).toArray();

      instance.ensureSchema();

      expect(sql.exec(
        "SELECT version, applied_at FROM orchestrator_schema_migrations WHERE version IN (10, 11) ORDER BY version",
      ).toArray()).toEqual(appliedBefore);
      expect(sql.exec("SELECT version FROM orchestrator_schema_migrations WHERE version = 12").toArray()[0]?.version).toBe(12);
      expect(sql.exec(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?",
        "orchestrator_tasks_by_tenant_project",
      ).toArray()[0]).toBeUndefined();
      expect(instance.ping().schemaVersion).toBe(12);
    });
  });

  it("rolls back the v12 index drop when its migration marker cannot be recorded", async () => {
    const ledger = ledgerFor("tenant-scope-v12-rollback-on-marker-failure");
    await runInDurableObject(ledger, async instance => {
      const sql = instance.ctx.storage.sql;
      sql.exec("CREATE INDEX IF NOT EXISTS orchestrator_tasks_by_tenant_project ON orchestrator_tasks(tenant_id, project_id)");
      sql.exec("DELETE FROM orchestrator_schema_migrations WHERE version = 12");
      sql.exec(`
        CREATE TRIGGER reject_v12_migration_marker
        BEFORE INSERT ON orchestrator_schema_migrations
        WHEN NEW.version = 12
        BEGIN
          SELECT RAISE(ABORT, 'forced v12 marker failure');
        END
      `);

      expect(() => instance.ensureSchema()).toThrow(/forced v12 marker failure/);
      expect(sql.exec(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?",
        "orchestrator_tasks_by_tenant_project",
      ).toArray()[0]?.name).toBe("orchestrator_tasks_by_tenant_project");
      expect(sql.exec(
        "SELECT version FROM orchestrator_schema_migrations WHERE version = 12",
      ).toArray()[0]).toBeUndefined();

      sql.exec("DROP TRIGGER reject_v12_migration_marker");
      instance.ensureSchema();
      expect(sql.exec(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?",
        "orchestrator_tasks_by_tenant_project",
      ).toArray()[0]).toBeUndefined();
      expect(sql.exec(
        "SELECT version FROM orchestrator_schema_migrations WHERE version = 12",
      ).toArray()[0]?.version).toBe(12);
      expect(instance.ping().schemaVersion).toBe(12);
    });
  });

  it("fails closed when a later schema marker exists but v9 is missing", async () => {
    const ledger = ledgerFor("tenant-scope-migration-marker-gap");
    await runInDurableObject(ledger, async instance => {
      const sql = instance.ctx.storage.sql;
      const task = {
        taskId: "marker-gap-task",
        tenantId: "tenant",
        projectId: "project",
        state: "SCHEDULED",
        version: 1,
        createdAt: 1500,
        updatedAt: 1500,
      };
      const taskKey = "tp1:6:tenant:7:project:8:idem-key";
      const eventKey = "tp1:6:tenant:7:project:7:out-key";
      sql.exec(
        "INSERT INTO orchestrator_tasks (task_id, idempotency_key, input_hash, state, version, task_json, created_at, updated_at, tenant_id, project_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        task.taskId, taskKey, "a".repeat(64), task.state, task.version,
        JSON.stringify(task), task.createdAt, task.updatedAt, task.tenantId, task.projectId,
      );
      sql.exec(
        "INSERT INTO orchestrator_outbox_events (event_id, idempotency_key, task_id, event_type, payload_json, status, attempts, lease_worker_id, lease_generation, lease_until, created_at, updated_at, tenant_id, project_id) VALUES (?, ?, ?, ?, ?, 'PENDING', 0, NULL, 0, 0, ?, ?, ?, ?)",
        "marker-gap-event", eventKey, task.taskId, "TASK_CREATED", "{}",
        task.createdAt, task.updatedAt, task.tenantId, task.projectId,
      );

      // Simulate an inconsistent restore: v9's data transformation is already
      // present, but its marker is absent while later migrations are recorded.
      sql.exec("DELETE FROM orchestrator_schema_migrations WHERE version = 9");
      const markerVersionsBefore = sql.exec(
        "SELECT version FROM orchestrator_schema_migrations ORDER BY version",
      ).toArray().map(row => row.version);

      let errorMessage = null;
      try {
        instance.ensureSchema();
      } catch (error) {
        errorMessage = error instanceof Error ? error.message : String(error);
      }

      const markerVersionsAfter = sql.exec(
        "SELECT version FROM orchestrator_schema_migrations ORDER BY version",
      ).toArray().map(row => row.version);
      const taskKeyAfter = sql.exec(
        "SELECT idempotency_key FROM orchestrator_tasks WHERE task_id = ?",
        task.taskId,
      ).toArray()[0]?.idempotency_key;
      const eventKeyAfter = sql.exec(
        "SELECT idempotency_key FROM orchestrator_outbox_events WHERE event_id = ?",
        "marker-gap-event",
      ).toArray()[0]?.idempotency_key;

      expect({
        errorMessage,
        markerVersionsBefore,
        markerVersionsAfter,
        taskKeyAfter,
        eventKeyAfter,
      }).toEqual({
        errorMessage: expect.stringMatching(/schema migration history.*(?:gap|missing|inconsistent)/i),
        markerVersionsBefore: [8, 10, 11, 12],
        markerVersionsAfter: [8, 10, 11, 12],
        taskKeyAfter: taskKey,
        eventKeyAfter: eventKey,
      });
    });
  });

  it("maps non-string legacy tenant/project attributes to the reserved legacy scope", async () => {
    const ledger = ledgerFor("tenant-scope-v8-invalid-attribute-fallback");
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
      sql.exec("DELETE FROM orchestrator_schema_migrations WHERE version BETWEEN 8 AND 12");

      const task = {
        taskId: "invalid-scope-task",
        tenantId: 0,
        projectId: false,
        state: "SCHEDULED",
        version: 1,
        createdAt: 1700,
        updatedAt: 1700,
      };
      sql.exec(
        "INSERT INTO orchestrator_tasks (task_id, idempotency_key, input_hash, state, version, task_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        task.taskId, "legacy-key", "b".repeat(64), task.state, task.version,
        JSON.stringify(task), task.createdAt, task.updatedAt,
      );
      const malformedStringTask = {
        taskId: "invalid-string-scope-task",
        tenantId: "tenant with spaces",
        projectId: "project-valid",
        state: "SCHEDULED",
        version: 1,
        createdAt: 1701,
        updatedAt: 1701,
      };
      sql.exec(
        "INSERT INTO orchestrator_tasks (task_id, idempotency_key, input_hash, state, version, task_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        malformedStringTask.taskId, "invalid-string-key", "c".repeat(64),
        malformedStringTask.state, malformedStringTask.version,
        JSON.stringify(malformedStringTask), malformedStringTask.createdAt, malformedStringTask.updatedAt,
      );

      instance.ensureSchema();

      const rows = sql.exec(
        "SELECT task_id, tenant_id, project_id, idempotency_key, task_json FROM orchestrator_tasks WHERE task_id IN (?, ?) ORDER BY task_id",
        task.taskId, malformedStringTask.taskId,
      ).toArray();
      expect(rows).toEqual([
        {
          task_id: "invalid-scope-task",
          tenant_id: "__legacy__",
          project_id: "__legacy__",
          idempotency_key: "tp1:10:__legacy__:10:__legacy__:10:legacy-key",
          task_json: JSON.stringify(task),
        },
        {
          task_id: "invalid-string-scope-task",
          tenant_id: "__legacy__",
          project_id: "project-valid",
          idempotency_key: "tp1:10:__legacy__:13:project-valid:18:invalid-string-key",
          task_json: JSON.stringify(malformedStringTask),
        },
      ]);
    });
  });

  it("fails closed when the migration marker table is lost after v8 schema changes", async () => {
    const ledger = ledgerFor("tenant-scope-migration-marker-table-loss");
    await runInDurableObject(ledger, async instance => {
      const sql = instance.ctx.storage.sql;
      const task = {
        taskId: "marker-table-loss-task",
        tenantId: "tenant",
        projectId: "project",
        state: "SCHEDULED",
        version: 1,
        createdAt: 1800,
        updatedAt: 1800,
      };
      const taskKey = "tp1:6:tenant:7:project:8:idem-key";
      sql.exec(
        "INSERT INTO orchestrator_tasks (task_id, idempotency_key, input_hash, state, version, task_json, created_at, updated_at, tenant_id, project_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        task.taskId, taskKey, "d".repeat(64), task.state, task.version,
        JSON.stringify(task), task.createdAt, task.updatedAt, task.tenantId, task.projectId,
      );
      sql.exec("DROP TABLE orchestrator_schema_migrations");

      let errorMessage = null;
      try {
        instance.ensureSchema();
      } catch (error) {
        errorMessage = error instanceof Error ? error.message : String(error);
      }

      const taskKeyAfter = sql.exec(
        "SELECT idempotency_key FROM orchestrator_tasks WHERE task_id = ?",
        task.taskId,
      ).one().idempotency_key;
      const markerTable = sql.exec(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'orchestrator_schema_migrations'",
      ).toArray()[0];

      expect({
        errorMessage,
        taskKeyAfter,
        markerTable,
      }).toEqual({
        errorMessage: expect.stringMatching(/schema migration history.*(?:missing|inconsistent).*v8|v8.*(?:missing|inconsistent)/i),
        taskKeyAfter: taskKey,
        markerTable: undefined,
      });
    });
  });


});
