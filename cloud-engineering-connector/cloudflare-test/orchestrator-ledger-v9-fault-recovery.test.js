import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

function ledgerFor(name) {
  return env.ORCHESTRATOR_LEDGER.get(env.ORCHESTRATOR_LEDGER.idFromName(name));
}

const originalRows = {
  tasks: [
    { task_id: "fault-task-a", idempotency_key: "legacy-task-a", tenant_id: "tenant-a", project_id: "project-a" },
    { task_id: "fault-task-b", idempotency_key: "legacy-task-b", tenant_id: "tenant-b", project_id: "project-b" },
  ],
  events: [
    { event_id: "fault-event-a", idempotency_key: "legacy-event-a", tenant_id: "tenant-a", project_id: "project-a" },
    { event_id: "fault-event-b", idempotency_key: "legacy-event-b", tenant_id: "tenant-b", project_id: "project-b" },
  ],
};

function readMigrationRows(sql) {
  return {
    tasks: sql.exec(
      "SELECT task_id, idempotency_key, tenant_id, project_id FROM orchestrator_tasks ORDER BY task_id",
    ).toArray(),
    events: sql.exec(
      "SELECT event_id, idempotency_key, tenant_id, project_id FROM orchestrator_outbox_events ORDER BY event_id",
    ).toArray(),
  };
}

function installFault(sql, fault) {
  const triggerName = "v9_fault_injection_" + fault.name;
  sql.exec(`DROP TRIGGER IF EXISTS ${triggerName}`);
  sql.exec(fault.createSql);
  return () => sql.exec(`DROP TRIGGER IF EXISTS ${triggerName}`);
}

function assertPreMigrationState(sql) {
  const rows = readMigrationRows(sql);
  expect(rows.tasks).toEqual(originalRows.tasks);
  expect(rows.events).toEqual(originalRows.events);
  expect(sql.exec(
    "SELECT version FROM orchestrator_schema_migrations WHERE version = 9",
  ).toArray()).toHaveLength(0);
  expect(sql.exec(
    "SELECT name FROM sqlite_master WHERE type = 'index' AND name IN (?, ?, ?)",
    "orchestrator_tasks_by_tenant_project_idempotency",
    "orchestrator_outbox_by_tenant_project_idempotency",
    "orchestrator_claim_candidates_by_scope_executor_order",
  ).toArray()).toHaveLength(0);
  expect(sql.exec(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?)",
    "orchestrator_v9_task_key_staging",
    "orchestrator_v9_outbox_key_staging",
  ).toArray()).toHaveLength(0);

  // A failed v9 transaction must stop the constructor's sequential migration
  // chain at the v8 boundary. No later migration marker or schema artifact may
  // be visible, and the v12 removal must not have run.
  expect(sql.exec(
    "SELECT version FROM orchestrator_schema_migrations WHERE version BETWEEN 8 AND 12 ORDER BY version",
  ).toArray().map(row => row.version)).toEqual([8]);
  expect(sql.exec(
    "SELECT name FROM sqlite_master WHERE type = 'index' AND name IN (?, ?, ?)",
    "orchestrator_tasks_by_scope_executor_created",
    "orchestrator_tasks_by_scope_state_executor_created",
    "orchestrator_tasks_by_tenant_project",
  ).toArray().map(row => row.name).sort()).toEqual([
    "orchestrator_tasks_by_tenant_project",
  ]);
}

const faults = [
  {
    name: "task_staging",
    message: "injected task staging failure",
    createSql: `
      CREATE TRIGGER v9_fault_injection_task_staging
      BEFORE UPDATE OF idempotency_key ON orchestrator_tasks
      WHEN NEW.idempotency_key LIKE '~migration-v9-stage-%'
      BEGIN SELECT RAISE(ABORT, 'injected task staging failure'); END
    `,
  },
  {
    name: "event_staging",
    message: "injected event staging failure",
    createSql: `
      CREATE TRIGGER v9_fault_injection_event_staging
      BEFORE UPDATE OF idempotency_key ON orchestrator_outbox_events
      -- This fault is reachable only after every task key has been rewritten.
      WHEN NEW.idempotency_key LIKE '~migration-v9-stage-%'
       AND NOT EXISTS (
         SELECT 1 FROM orchestrator_tasks
         WHERE idempotency_key NOT LIKE 'tp1:%'
       )
      BEGIN SELECT RAISE(ABORT, 'injected event staging failure after task rewrite'); END
    `,
  },
  {
    name: "task_final_assignment",
    message: "injected task final assignment failure",
    createSql: `
      CREATE TRIGGER v9_fault_injection_task_final_assignment
      BEFORE UPDATE OF idempotency_key ON orchestrator_tasks
      WHEN NEW.idempotency_key LIKE 'tp1:%'
      BEGIN SELECT RAISE(ABORT, 'injected task final assignment failure'); END
    `,
  },
  {
    name: "event_final_assignment",
    message: "injected event final assignment failure",
    createSql: `
      CREATE TRIGGER v9_fault_injection_event_final_assignment
      BEFORE UPDATE OF idempotency_key ON orchestrator_outbox_events
      WHEN NEW.idempotency_key LIKE 'tp1:%'
      BEGIN SELECT RAISE(ABORT, 'injected event final assignment failure'); END
    `,
  },
  {
    name: "marker_commit",
    message: "injected v9 marker failure",
    createSql: `
      CREATE TRIGGER v9_fault_injection_marker_commit
      BEFORE INSERT ON orchestrator_schema_migrations
      WHEN NEW.version = 9
      BEGIN SELECT RAISE(ABORT, 'injected v9 marker failure'); END
    `,
  },
];

describe("Schema v9 migration fault injection and recovery", () => {
  it("rolls back every injected failure and safely retries the real migration", async () => {
    const ledger = ledgerFor("v9-migration-fault-recovery");
    await runInDurableObject(ledger, async instance => {
      const sql = instance.ctx.storage.sql;

      // The Durable Object constructor has applied the current schema. Rebuild
      // the exact v8 boundary in this isolated test instance so ensureSchema()
      // executes the real v9 migration again, without touching application data.
      sql.exec("DROP INDEX IF EXISTS orchestrator_tasks_by_tenant_project_idempotency");
      sql.exec("DROP INDEX IF EXISTS orchestrator_outbox_by_tenant_project_idempotency");
      sql.exec("DROP INDEX IF EXISTS orchestrator_claim_candidates_by_scope_executor_order");
      sql.exec("DROP INDEX IF EXISTS orchestrator_tasks_by_scope_executor_created");
      sql.exec("DROP INDEX IF EXISTS orchestrator_tasks_by_scope_state_executor_created");
      sql.exec("CREATE INDEX IF NOT EXISTS orchestrator_tasks_by_tenant_project ON orchestrator_tasks(tenant_id, project_id)");
      sql.exec("DELETE FROM orchestrator_schema_migrations WHERE version >= 9");

      sql.exec(
        "INSERT INTO orchestrator_tasks (task_id, idempotency_key, input_hash, state, version, task_json, created_at, updated_at, tenant_id, project_id) VALUES (?, ?, ?, 'SCHEDULED', 1, '{}', 1, 1, ?, ?)",
        "fault-task-a", "legacy-task-a", "0".repeat(64), "tenant-a", "project-a",
      );
      sql.exec(
        "INSERT INTO orchestrator_tasks (task_id, idempotency_key, input_hash, state, version, task_json, created_at, updated_at, tenant_id, project_id) VALUES (?, ?, ?, 'SCHEDULED', 1, '{}', 2, 2, ?, ?)",
        "fault-task-b", "legacy-task-b", "0".repeat(64), "tenant-b", "project-b",
      );
      sql.exec(
        "INSERT INTO orchestrator_outbox_events (event_id, idempotency_key, task_id, event_type, payload_json, status, attempts, lease_worker_id, lease_generation, lease_until, created_at, updated_at, tenant_id, project_id) VALUES (?, ?, ?, 'TASK_CREATED', '{}', 'PENDING', 0, NULL, 0, 0, 1, 1, ?, ?)",
        "fault-event-a", "legacy-event-a", "fault-task-a", "tenant-a", "project-a",
      );
      sql.exec(
        "INSERT INTO orchestrator_outbox_events (event_id, idempotency_key, task_id, event_type, payload_json, status, attempts, lease_worker_id, lease_generation, lease_until, created_at, updated_at, tenant_id, project_id) VALUES (?, ?, ?, 'TASK_CREATED', '{}', 'PENDING', 0, NULL, 0, 0, 2, 2, ?, ?)",
        "fault-event-b", "legacy-event-b", "fault-task-b", "tenant-b", "project-b",
      );

      expect(readMigrationRows(sql)).toEqual(originalRows);
      assertPreMigrationState(sql);

      for (const fault of faults) {
        const removeFault = installFault(sql, fault);
        try {
          expect(() => instance.ensureSchema()).toThrow(fault.message);
        } finally {
          removeFault();
        }

        // The failure must leave both tables byte-for-byte at their v8 key
        // values, omit the v9 marker, and roll back v9 index creation.
        assertPreMigrationState(sql);
      }

      // Recovery: with the injected fault removed, the actual production
      // ensureSchema/v9 migration must complete, preserve every row, and add
      // the marker in the same transaction as its key/index changes.
      instance.ensureSchema();

      const migrated = readMigrationRows(sql);
      expect(migrated.tasks).toEqual([
        {
          task_id: "fault-task-a",
          idempotency_key: "tp1:8:tenant-a:9:project-a:13:legacy-task-a",
          tenant_id: "tenant-a",
          project_id: "project-a",
        },
        {
          task_id: "fault-task-b",
          idempotency_key: "tp1:8:tenant-b:9:project-b:13:legacy-task-b",
          tenant_id: "tenant-b",
          project_id: "project-b",
        },
      ]);
      expect(migrated.events).toEqual([
        {
          event_id: "fault-event-a",
          idempotency_key: "tp1:8:tenant-a:9:project-a:14:legacy-event-a",
          tenant_id: "tenant-a",
          project_id: "project-a",
        },
        {
          event_id: "fault-event-b",
          idempotency_key: "tp1:8:tenant-b:9:project-b:14:legacy-event-b",
          tenant_id: "tenant-b",
          project_id: "project-b",
        },
      ]);

      const markers = sql.exec(
        "SELECT version FROM orchestrator_schema_migrations WHERE version BETWEEN 8 AND 12 ORDER BY version",
      ).toArray().map(row => row.version);
      expect(markers).toEqual([8, 9, 10, 11, 12]);

      const firstSuccessfulResult = readMigrationRows(sql);
      const firstSuccessfulMarkers = sql.exec(
        "SELECT version FROM orchestrator_schema_migrations WHERE version BETWEEN 8 AND 12 ORDER BY version",
      ).toArray().map(row => row.version);
      const firstSuccessfulIndexes = sql.exec(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name IN (?, ?, ?) ORDER BY name",
        "orchestrator_tasks_by_tenant_project_idempotency",
        "orchestrator_outbox_by_tenant_project_idempotency",
        "orchestrator_claim_candidates_by_scope_executor_order",
      ).toArray().map(row => row.name);
      const firstSuccessfulStagingTables = sql.exec(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?) ORDER BY name",
        "orchestrator_v9_task_key_staging",
        "orchestrator_v9_outbox_key_staging",
      ).toArray().map(row => row.name);
      instance.ensureSchema();
      expect(readMigrationRows(sql)).toEqual(firstSuccessfulResult);
      expect(sql.exec(
        "SELECT version FROM orchestrator_schema_migrations WHERE version BETWEEN 8 AND 12 ORDER BY version",
      ).toArray().map(row => row.version)).toEqual(firstSuccessfulMarkers);
      expect(sql.exec(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name IN (?, ?, ?) ORDER BY name",
        "orchestrator_tasks_by_tenant_project_idempotency",
        "orchestrator_outbox_by_tenant_project_idempotency",
        "orchestrator_claim_candidates_by_scope_executor_order",
      ).toArray().map(row => row.name)).toEqual(firstSuccessfulIndexes);
      expect(sql.exec(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?) ORDER BY name",
        "orchestrator_v9_task_key_staging",
        "orchestrator_v9_outbox_key_staging",
      ).toArray().map(row => row.name)).toEqual(firstSuccessfulStagingTables);
      expect(sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_tasks",
      ).one().count).toBe(2);
      expect(sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_outbox_events",
      ).one().count).toBe(2);
    });
  });

  it("recovers from a rolled-back mid-migration failure after Durable Object eviction", async () => {
    const ledger = ledgerFor("v9-migration-fault-then-eviction-recovery");

    await runInDurableObject(ledger, async instance => {
      const sql = instance.ctx.storage.sql;
      instance.__testOnlyPreEvictionSentinel = "must-disappear";

      sql.exec("DROP INDEX IF EXISTS orchestrator_tasks_by_tenant_project_idempotency");
      sql.exec("DROP INDEX IF EXISTS orchestrator_outbox_by_tenant_project_idempotency");
      sql.exec("DROP INDEX IF EXISTS orchestrator_claim_candidates_by_scope_executor_order");
      sql.exec("DROP INDEX IF EXISTS orchestrator_tasks_by_scope_executor_created");
      sql.exec("DROP INDEX IF EXISTS orchestrator_tasks_by_scope_state_executor_created");
      sql.exec("CREATE INDEX IF NOT EXISTS orchestrator_tasks_by_tenant_project ON orchestrator_tasks(tenant_id, project_id)");
      sql.exec("DELETE FROM orchestrator_schema_migrations WHERE version >= 9");

      sql.exec(
        "INSERT INTO orchestrator_tasks (task_id, idempotency_key, input_hash, state, version, task_json, created_at, updated_at, tenant_id, project_id) VALUES (?, ?, ?, 'SCHEDULED', 1, '{}', 1, 1, ?, ?)",
        "fault-task-a", "legacy-task-a", "0".repeat(64), "tenant-a", "project-a",
      );
      sql.exec(
        "INSERT INTO orchestrator_tasks (task_id, idempotency_key, input_hash, state, version, task_json, created_at, updated_at, tenant_id, project_id) VALUES (?, ?, ?, 'SCHEDULED', 1, '{}', 2, 2, ?, ?)",
        "fault-task-b", "legacy-task-b", "0".repeat(64), "tenant-b", "project-b",
      );
      sql.exec(
        "INSERT INTO orchestrator_outbox_events (event_id, idempotency_key, task_id, event_type, payload_json, status, attempts, lease_worker_id, lease_generation, lease_until, created_at, updated_at, tenant_id, project_id) VALUES (?, ?, ?, 'TASK_CREATED', '{}', 'PENDING', 0, NULL, 0, 0, 1, 1, ?, ?)",
        "fault-event-a", "legacy-event-a", "fault-task-a", "tenant-a", "project-a",
      );
      sql.exec(
        "INSERT INTO orchestrator_outbox_events (event_id, idempotency_key, task_id, event_type, payload_json, status, attempts, lease_worker_id, lease_generation, lease_until, created_at, updated_at, tenant_id, project_id) VALUES (?, ?, ?, 'TASK_CREATED', '{}', 'PENDING', 0, NULL, 0, 0, 2, 2, ?, ?)",
        "fault-event-b", "legacy-event-b", "fault-task-b", "tenant-b", "project-b",
      );

      expect(readMigrationRows(sql)).toEqual(originalRows);
      const fault = faults.find(item => item.name === "event_staging");
      const removeFault = installFault(sql, fault);
      try {
        // The trigger fires only after all Tasks have been rewritten and Outbox
        // staging begins, exercising rollback at the cross-table boundary.
        expect(() => instance.ensureSchema()).toThrow(
          "injected event staging failure after task rewrite",
        );
      } finally {
        removeFault();
      }
      assertPreMigrationState(sql);
    });

    // The transaction has rolled back and the fault trigger is gone. Evict the
    // instance before retrying so the next constructor must recover from the
    // persisted v8 boundary rather than in-memory state.
    await evictDurableObject(ledger);
    const recovered = await ledger.ping();
    expect(recovered.ok).toBe(true);
    expect(recovered.schemaVersion).toBe(12);

    await runInDurableObject(ledger, async instance => {
      expect(instance.__testOnlyPreEvictionSentinel).toBeUndefined();
      const sql = instance.ctx.storage.sql;
      expect(readMigrationRows(sql)).toEqual({
        tasks: [
          { task_id: "fault-task-a", idempotency_key: "tp1:8:tenant-a:9:project-a:13:legacy-task-a", tenant_id: "tenant-a", project_id: "project-a" },
          { task_id: "fault-task-b", idempotency_key: "tp1:8:tenant-b:9:project-b:13:legacy-task-b", tenant_id: "tenant-b", project_id: "project-b" },
        ],
        events: [
          { event_id: "fault-event-a", idempotency_key: "tp1:8:tenant-a:9:project-a:14:legacy-event-a", tenant_id: "tenant-a", project_id: "project-a" },
          { event_id: "fault-event-b", idempotency_key: "tp1:8:tenant-b:9:project-b:14:legacy-event-b", tenant_id: "tenant-b", project_id: "project-b" },
        ],
      });
      expect(sql.exec(
        "SELECT version FROM orchestrator_schema_migrations WHERE version BETWEEN 8 AND 12 ORDER BY version",
      ).toArray().map(row => row.version)).toEqual([8, 9, 10, 11, 12]);
      expect(sql.exec(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?)",
        "orchestrator_v9_task_key_staging",
        "orchestrator_v9_outbox_key_staging",
      ).toArray()).toHaveLength(0);
    });
  });
});
