import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { migrateV9IdempotencyKeys } from "../orchestrator-ledger.js";

const ROW_COUNT = 10_000;

function ledgerFor(name) {
  return env.ORCHESTRATOR_LEDGER.get(env.ORCHESTRATOR_LEDGER.idFromName(name));
}

function rejectUnboundedMigrationMaterialization(sql) {
  // Guard row-producing reads even when the source table is reached through
  // a JOIN or nested query. Permit only direct scalar COUNT(*) queries.
  const readsSourceRows = statement => {
    const normalized = String(statement).replace(/\s+/g, " ").trim();
    const referencesSource = /\b(?:FROM|JOIN)\s+(?:orchestrator_tasks|orchestrator_outbox_events)\b/i.test(normalized);
    const scalarCountOnly = /^SELECT\s+COUNT\s*\(\s*\*\s*\)(?:\s+AS\s+[A-Z_][A-Z0-9_]*)?\s+FROM\s+(?:orchestrator_tasks|orchestrator_outbox_events)(?:\s+WHERE\b[\s\S]*)?$/i.test(normalized);
    return /\bSELECT\b/i.test(normalized) && referencesSource && !scalarCountOnly;
  };
  let rejectedMaterializations = 0;
  const guardedSql = new Proxy(sql, {
    get(target, property) {
      if (property !== "exec") {
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (statement, ...bindings) => {
        const cursor = target.exec(statement, ...bindings);
        if (!readsSourceRows(statement)) return cursor;
        let rowsRead = 0;
        const readNext = () => {
          rowsRead += 1;
          if (rowsRead > 1) {
            rejectedMaterializations += 1;
            throw new Error("V9 migration must not iterate a source-table cursor beyond one row");
          }
          return cursor.next();
        };
        return new Proxy(cursor, {
          get(cursorTarget, key) {
            if (key === "toArray") {
              return () => {
                rejectedMaterializations += 1;
                throw new Error("V9 migration must not materialize a full-table row collection");
              };
            }
            if (key === "next") return readNext;
            if (key === Symbol.iterator) {
              return () => ({
                next: readNext,
                [Symbol.iterator]() { return this; },
              });
            }
            const value = Reflect.get(cursorTarget, key, cursorTarget);
            return typeof value === "function" ? value.bind(cursorTarget) : value;
          },
        });
      };
    },
  });
  return {
    sql: guardedSql,
    get rejectedMaterializations() {
      return rejectedMaterializations;
    },
  };
}

describe("OrchestratorLedger v9 migration JavaScript memory bound", () => {
  it("rejects unbounded cursor consumption through next() and for-of", async () => {
    const ledger = ledgerFor("v9-migration-cursor-guard");
    await runInDurableObject(ledger, async instance => {
      const sql = instance.ctx.storage.sql;
      sql.exec(
        "INSERT INTO orchestrator_tasks (task_id, idempotency_key, input_hash, state, version, task_json, created_at, updated_at, tenant_id, project_id) VALUES (?, ?, ?, 'SCHEDULED', 1, '{}', 1, 1, ?, ?)",
        "v9-cursor-guard-a", "cursor-guard-a", "a".repeat(64), "tenant-a", "project-a",
      );
      sql.exec(
        "INSERT INTO orchestrator_tasks (task_id, idempotency_key, input_hash, state, version, task_json, created_at, updated_at, tenant_id, project_id) VALUES (?, ?, ?, 'SCHEDULED', 1, '{}', 2, 2, ?, ?)",
        "v9-cursor-guard-b", "cursor-guard-b", "b".repeat(64), "tenant-a", "project-a",
      );

      const guard = rejectUnboundedMigrationMaterialization(sql);
      const directCursor = guard.sql.exec(
        "SELECT task_id FROM orchestrator_tasks ORDER BY task_id",
      );
      expect(directCursor.next().done).toBe(false);
      expect(() => directCursor.next()).toThrow(
        "V9 migration must not iterate a source-table cursor beyond one row",
      );

      const iteratorCursor = guard.sql.exec(
        "SELECT task_id FROM orchestrator_tasks ORDER BY task_id",
      );
      expect(() => {
        for (const row of iteratorCursor) void row;
      }).toThrow("V9 migration must not iterate a source-table cursor beyond one row");
      expect(guard.rejectedMaterializations).toBe(2);
    });
  });

  it("rejects raw cursor materialization for source-table reads", async () => {
    const ledger = ledgerFor("v9-migration-raw-cursor-guard");
    await runInDurableObject(ledger, async instance => {
      const sql = instance.ctx.storage.sql;
      sql.exec(
        "INSERT INTO orchestrator_tasks (task_id, idempotency_key, input_hash, state, version, task_json, created_at, updated_at, tenant_id, project_id) VALUES (?, ?, ?, 'SCHEDULED', 1, '{}', 1, 1, ?, ?)",
        "v9-raw-guard-a", "raw-guard-a", "a".repeat(64), "tenant-a", "project-a",
      );
      sql.exec(
        "INSERT INTO orchestrator_tasks (task_id, idempotency_key, input_hash, state, version, task_json, created_at, updated_at, tenant_id, project_id) VALUES (?, ?, ?, 'SCHEDULED', 1, '{}', 2, 2, ?, ?)",
        "v9-raw-guard-b", "raw-guard-b", "b".repeat(64), "tenant-a", "project-a",
      );

      const guard = rejectUnboundedMigrationMaterialization(sql);
      const rawCursor = guard.sql.exec(
        "SELECT task_id FROM orchestrator_tasks ORDER BY task_id",
      ).raw();
      expect(() => rawCursor.toArray()).toThrow(
        "V9 migration must not materialize a full-table row collection",
      );
      expect(guard.rejectedMaterializations).toBe(1);
    });
  });

  it("migrates 10k task and outbox keys without materializing full-table result arrays", async () => {
    const ledger = ledgerFor("v9-migration-js-memory-bound-10k");
    await runInDurableObject(ledger, async instance => {
      const storage = instance.ctx.storage;
      const sql = storage.sql;

      sql.exec(`
        WITH RECURSIVE seq(n) AS (
          SELECT 1
          UNION ALL SELECT n + 1 FROM seq WHERE n < ?
        )
        INSERT INTO orchestrator_tasks (
          task_id, idempotency_key, input_hash, state, version, task_json,
          created_at, updated_at, tenant_id, project_id
        )
        SELECT
          'v9-memory-task-' || n,
          'legacy-task-key-' || n,
          printf('%064d', n),
          'SCHEDULED',
          1,
          json_object(
            'taskId', 'v9-memory-task-' || n,
            'tenantId', 'tenant-' || (n % 10),
            'projectId', 'project-' || (n % 7),
            'state', 'SCHEDULED',
            'version', 1,
            'createdAt', n,
            'updatedAt', n
          ),
          n, n, 'tenant-' || (n % 10), 'project-' || (n % 7)
        FROM seq
      `, ROW_COUNT);

      sql.exec(`
        WITH RECURSIVE seq(n) AS (
          SELECT 1
          UNION ALL SELECT n + 1 FROM seq WHERE n < ?
        )
        INSERT INTO orchestrator_outbox_events (
          event_id, idempotency_key, task_id, event_type, payload_json, status,
          attempts, lease_worker_id, lease_generation, lease_until,
          created_at, updated_at, tenant_id, project_id
        )
        SELECT
          'v9-memory-event-' || n,
          'legacy-event-key-' || n,
          'v9-memory-task-' || n,
          'TASK_CREATED',
          '{}',
          'PENDING',
          0, NULL, 0, 0, n, n,
          'tenant-' || (n % 10), 'project-' || (n % 7)
        FROM seq
      `, ROW_COUNT);

      sql.exec("DROP INDEX IF EXISTS orchestrator_tasks_by_tenant_project_idempotency");
      sql.exec("DROP INDEX IF EXISTS orchestrator_outbox_by_tenant_project_idempotency");
      sql.exec("DROP INDEX IF EXISTS orchestrator_claim_candidates_by_scope_executor_order");
      sql.exec("DELETE FROM orchestrator_schema_migrations WHERE version = 9");

      const guard = rejectUnboundedMigrationMaterialization(sql);
      const guardedStorage = {
        sql: guard.sql,
        transactionSync: callback => storage.transactionSync(callback),
      };

      expect(() => migrateV9IdempotencyKeys(guardedStorage)).not.toThrow();
      expect(guard.rejectedMaterializations).toBe(0);

      const taskCount = sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_tasks WHERE task_id LIKE 'v9-memory-task-%'",
      ).one().count;
      const eventCount = sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_outbox_events WHERE event_id LIKE 'v9-memory-event-%'",
      ).one().count;
      expect(taskCount).toBe(ROW_COUNT);
      expect(eventCount).toBe(ROW_COUNT);
      expect(sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_tasks WHERE task_id LIKE 'v9-memory-task-%' AND idempotency_key NOT LIKE 'tp1:%'",
      ).one().count).toBe(0);
      expect(sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_outbox_events WHERE event_id LIKE 'v9-memory-event-%' AND idempotency_key NOT LIKE 'tp1:%'",
      ).one().count).toBe(0);

      const task = sql.exec(
        "SELECT idempotency_key FROM orchestrator_tasks WHERE task_id = ?",
        "v9-memory-task-1",
      ).one();
      const event = sql.exec(
        "SELECT idempotency_key FROM orchestrator_outbox_events WHERE event_id = ?",
        "v9-memory-event-1",
      ).one();
      expect(task.idempotency_key).toBe("tp1:8:tenant-1:9:project-1:17:legacy-task-key-1");
      expect(event.idempotency_key).toBe("tp1:8:tenant-1:9:project-1:18:legacy-event-key-1");

      expect(sql.exec(
        "SELECT version FROM orchestrator_schema_migrations WHERE version = 9",
      ).one().version).toBe(9);
      expect(sql.exec(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'orchestrator_v9_%_staging'",
      ).toArray()).toHaveLength(0);

      console.info("V9_MIGRATION_JS_MEMORY_BOUND " + JSON.stringify({
        tasksMigrated: taskCount,
        outboxEventsMigrated: eventCount,
        rejectedFullTableMaterializations: guard.rejectedMaterializations,
        peakMemoryBytes: null,
        peakMemoryLimitation: "Cloudflare Vitest Durable Object runtime does not expose per-isolate heap telemetry",
      }));
    });
  });

  it("vacates legacy keys that collide with another row's final scoped key before rewriting", async () => {
    const ledger = ledgerFor("v9-migration-legacy-final-key-collision");
    await runInDurableObject(ledger, async instance => {
      const sql = instance.ctx.storage.sql;
      const collidingTaskKey = "tp1:8:tenant-a:9:project-a:1:x";
      const collidingEventKey = "tp1:8:tenant-a:9:project-a:1:e";

      sql.exec(
        "INSERT INTO orchestrator_tasks (task_id, idempotency_key, input_hash, state, version, task_json, created_at, updated_at, tenant_id, project_id) VALUES (?, ?, ?, 'SCHEDULED', 1, '{}', 1, 1, ?, ?)",
        "v9-collision-task-a", "x", "a".repeat(64), "tenant-a", "project-a",
      );
      sql.exec(
        "INSERT INTO orchestrator_tasks (task_id, idempotency_key, input_hash, state, version, task_json, created_at, updated_at, tenant_id, project_id) VALUES (?, ?, ?, 'SCHEDULED', 1, '{}', 2, 2, ?, ?)",
        "v9-collision-task-b", collidingTaskKey, "b".repeat(64), "tenant-b", "project-b",
      );

      sql.exec(
        "INSERT INTO orchestrator_outbox_events (event_id, idempotency_key, task_id, event_type, payload_json, status, attempts, lease_worker_id, lease_generation, lease_until, created_at, updated_at, tenant_id, project_id) VALUES (?, ?, ?, 'TASK_CREATED', '{}', 'PENDING', 0, NULL, 0, 0, 1, 1, ?, ?)",
        "v9-collision-event-a", "e", "v9-collision-task-a", "tenant-a", "project-a",
      );
      sql.exec(
        "INSERT INTO orchestrator_outbox_events (event_id, idempotency_key, task_id, event_type, payload_json, status, attempts, lease_worker_id, lease_generation, lease_until, created_at, updated_at, tenant_id, project_id) VALUES (?, ?, ?, 'TASK_CREATED', '{}', 'PENDING', 0, NULL, 0, 0, 2, 2, ?, ?)",
        "v9-collision-event-b", collidingEventKey, "v9-collision-task-b", "tenant-b", "project-b",
      );

      sql.exec("DROP INDEX IF EXISTS orchestrator_tasks_by_tenant_project_idempotency");
      sql.exec("DROP INDEX IF EXISTS orchestrator_outbox_by_tenant_project_idempotency");
      sql.exec("DROP INDEX IF EXISTS orchestrator_claim_candidates_by_scope_executor_order");
      sql.exec("DELETE FROM orchestrator_schema_migrations WHERE version = 9");

      expect(() => migrateV9IdempotencyKeys(instance.ctx.storage)).not.toThrow();

      expect(sql.exec(
        "SELECT idempotency_key FROM orchestrator_tasks WHERE task_id = ?",
        "v9-collision-task-a",
      ).one().idempotency_key).toBe(collidingTaskKey);
      expect(sql.exec(
        "SELECT idempotency_key FROM orchestrator_tasks WHERE task_id = ?",
        "v9-collision-task-b",
      ).one().idempotency_key).toBe(`tp1:8:tenant-b:9:project-b:${collidingTaskKey.length}:${collidingTaskKey}`);
      expect(sql.exec(
        "SELECT idempotency_key FROM orchestrator_outbox_events WHERE event_id = ?",
        "v9-collision-event-a",
      ).one().idempotency_key).toBe(collidingEventKey);
      expect(sql.exec(
        "SELECT idempotency_key FROM orchestrator_outbox_events WHERE event_id = ?",
        "v9-collision-event-b",
      ).one().idempotency_key).toBe(`tp1:8:tenant-b:9:project-b:${collidingEventKey.length}:${collidingEventKey}`);
    });
  });

  it("rejects keys in the reserved staging namespace before any rewrite", async () => {
    const ledger = ledgerFor("v9-migration-reserved-staging-namespace");
    await runInDurableObject(ledger, async instance => {
      const storage = instance.ctx.storage;
      const sql = storage.sql;
      const reservedKey = "~migration-v9-stage-collision:1";
      sql.exec(
        "INSERT INTO orchestrator_tasks (task_id, idempotency_key, input_hash, state, version, task_json, created_at, updated_at, tenant_id, project_id) VALUES (?, ?, ?, 'SCHEDULED', 1, '{}', 1, 1, ?, ?)",
        "v9-reserved-prefix-task", reservedKey, "a".repeat(64), "tenant-a", "project-a",
      );
      sql.exec("DROP INDEX IF EXISTS orchestrator_tasks_by_tenant_project_idempotency");
      sql.exec("DROP INDEX IF EXISTS orchestrator_outbox_by_tenant_project_idempotency");
      sql.exec("DROP INDEX IF EXISTS orchestrator_claim_candidates_by_scope_executor_order");
      sql.exec("DELETE FROM orchestrator_schema_migrations WHERE version = 9");

      expect(() => migrateV9IdempotencyKeys(storage)).toThrow(
        "Schema v9 cannot encode every orchestrator_tasks idempotency key; source and staging row counts differ.",
      );
      expect(sql.exec(
        "SELECT idempotency_key FROM orchestrator_tasks WHERE task_id = ?",
        "v9-reserved-prefix-task",
      ).one().idempotency_key).toBe(reservedKey);
      expect(sql.exec(
        "SELECT version FROM orchestrator_schema_migrations WHERE version = 9",
      ).toArray()).toHaveLength(0);
      expect(sql.exec(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?)",
        "orchestrator_v9_task_key_staging",
        "orchestrator_v9_outbox_key_staging",
      ).toArray()).toHaveLength(0);
    });
  });

  it("rolls back task rewrites when an outbox key is in the reserved staging namespace", async () => {
    const ledger = ledgerFor("v9-migration-reserved-outbox-staging-namespace");
    await runInDurableObject(ledger, async instance => {
      const storage = instance.ctx.storage;
      const sql = storage.sql;
      const taskKey = "legacy-task-before-outbox-rejection";
      const reservedEventKey = "~migration-v9-stage-outbox-collision:1";

      sql.exec(
        "INSERT INTO orchestrator_tasks (task_id, idempotency_key, input_hash, state, version, task_json, created_at, updated_at, tenant_id, project_id) VALUES (?, ?, ?, 'SCHEDULED', 1, '{}', 1, 1, ?, ?)",
        "v9-reserved-outbox-task", taskKey, "b".repeat(64), "tenant-a", "project-a",
      );
      sql.exec(
        "INSERT INTO orchestrator_outbox_events (event_id, idempotency_key, task_id, event_type, payload_json, status, attempts, lease_worker_id, lease_generation, lease_until, created_at, updated_at, tenant_id, project_id) VALUES (?, ?, ?, 'TASK_CREATED', '{}', 'PENDING', 0, NULL, 0, 0, 1, 1, ?, ?)",
        "v9-reserved-outbox-event", reservedEventKey, "v9-reserved-outbox-task", "tenant-a", "project-a",
      );
      sql.exec("DROP INDEX IF EXISTS orchestrator_tasks_by_tenant_project_idempotency");
      sql.exec("DROP INDEX IF EXISTS orchestrator_outbox_by_tenant_project_idempotency");
      sql.exec("DROP INDEX IF EXISTS orchestrator_claim_candidates_by_scope_executor_order");
      sql.exec("DELETE FROM orchestrator_schema_migrations WHERE version = 9");

      expect(() => migrateV9IdempotencyKeys(storage)).toThrow(
        "Schema v9 cannot encode every orchestrator_outbox_events idempotency key; source and staging row counts differ.",
      );
      expect(sql.exec(
        "SELECT idempotency_key FROM orchestrator_tasks WHERE task_id = ?",
        "v9-reserved-outbox-task",
      ).one().idempotency_key).toBe(taskKey);
      expect(sql.exec(
        "SELECT idempotency_key FROM orchestrator_outbox_events WHERE event_id = ?",
        "v9-reserved-outbox-event",
      ).one().idempotency_key).toBe(reservedEventKey);
      expect(sql.exec(
        "SELECT version FROM orchestrator_schema_migrations WHERE version = 9",
      ).toArray()).toHaveLength(0);
      expect(sql.exec(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?)",
        "orchestrator_v9_task_key_staging",
        "orchestrator_v9_outbox_key_staging",
      ).toArray()).toHaveLength(0);
      expect(sql.exec(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name IN (?, ?, ?)",
        "orchestrator_tasks_by_tenant_project_idempotency",
        "orchestrator_outbox_by_tenant_project_idempotency",
        "orchestrator_claim_candidates_by_scope_executor_order",
      ).toArray()).toHaveLength(0);
    });
  });

  it("fails closed and rolls back when a legacy idempotency key is not encodable", async () => {
    const ledger = ledgerFor("v9-migration-invalid-idempotency-key");
    await runInDurableObject(ledger, async instance => {
      const storage = instance.ctx.storage;
      const sql = storage.sql;
      sql.exec(
        "INSERT INTO orchestrator_tasks (task_id, idempotency_key, input_hash, state, version, task_json, created_at, updated_at, tenant_id, project_id) VALUES (?, ?, ?, 'SCHEDULED', 1, '{}', 1, 1, ?, ?)",
        "v9-invalid-key-task", "legacy key with spaces", "a".repeat(64), "tenant-a", "project-a",
      );
      sql.exec("DROP INDEX IF EXISTS orchestrator_tasks_by_tenant_project_idempotency");
      sql.exec("DROP INDEX IF EXISTS orchestrator_outbox_by_tenant_project_idempotency");
      sql.exec("DROP INDEX IF EXISTS orchestrator_claim_candidates_by_scope_executor_order");
      sql.exec("DELETE FROM orchestrator_schema_migrations WHERE version = 9");

      expect(() => migrateV9IdempotencyKeys(storage)).toThrow(
        "Schema v9 cannot encode every orchestrator_tasks idempotency key; source and staging row counts differ.",
      );
      expect(sql.exec(
        "SELECT idempotency_key FROM orchestrator_tasks WHERE task_id = ?",
        "v9-invalid-key-task",
      ).one().idempotency_key).toBe("legacy key with spaces");
      expect(sql.exec(
        "SELECT version FROM orchestrator_schema_migrations WHERE version = 9",
      ).toArray()).toHaveLength(0);
      expect(sql.exec(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?)",
        "orchestrator_v9_task_key_staging",
        "orchestrator_v9_outbox_key_staging",
      ).toArray()).toHaveLength(0);
    });
  });
});
