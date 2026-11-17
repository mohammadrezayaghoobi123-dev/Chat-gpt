import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

function ledgerFor(name) {
  return env.ORCHESTRATOR_LEDGER.get(env.ORCHESTRATOR_LEDGER.idFromName(name));
}

const expectedTasks = [
  {
    task_id: "eviction-task-a",
    idempotency_key: "tp1:8:tenant-a:9:project-a:13:legacy-task-a",
    tenant_id: "tenant-a",
    project_id: "project-a",
  },
  {
    task_id: "eviction-task-b",
    idempotency_key: "tp1:8:tenant-b:9:project-b:13:legacy-task-b",
    tenant_id: "tenant-b",
    project_id: "project-b",
  },
];

const expectedEvents = [
  {
    event_id: "eviction-event-a",
    idempotency_key: "tp1:8:tenant-a:9:project-a:14:legacy-event-a",
    tenant_id: "tenant-a",
    project_id: "project-a",
  },
  {
    event_id: "eviction-event-b",
    idempotency_key: "tp1:8:tenant-b:9:project-b:14:legacy-event-b",
    tenant_id: "tenant-b",
    project_id: "project-b",
  },
];

function readRows(sql) {
  return {
    tasks: sql.exec(
      "SELECT task_id, idempotency_key, tenant_id, project_id FROM orchestrator_tasks ORDER BY task_id",
    ).toArray(),
    events: sql.exec(
      "SELECT event_id, idempotency_key, tenant_id, project_id FROM orchestrator_outbox_events ORDER BY event_id",
    ).toArray(),
  };
}

function seedV8Boundary(sql) {
  sql.exec("DROP INDEX IF EXISTS orchestrator_tasks_by_tenant_project_idempotency");
  sql.exec("DROP INDEX IF EXISTS orchestrator_outbox_by_tenant_project_idempotency");
  sql.exec("DROP INDEX IF EXISTS orchestrator_claim_candidates_by_scope_executor_order");
  sql.exec("DROP INDEX IF EXISTS orchestrator_tasks_by_scope_executor_created");
  sql.exec("DROP INDEX IF EXISTS orchestrator_tasks_by_scope_state_executor_created");
  sql.exec("DELETE FROM orchestrator_schema_migrations WHERE version >= 9");
  // v8 still owns this task scope index; v12 removes it later.
  sql.exec("CREATE INDEX IF NOT EXISTS orchestrator_tasks_by_tenant_project ON orchestrator_tasks(tenant_id, project_id)");

  sql.exec(
    "INSERT INTO orchestrator_tasks (task_id, idempotency_key, input_hash, state, version, task_json, created_at, updated_at, tenant_id, project_id) VALUES (?, ?, ?, 'SCHEDULED', 1, '{}', 1, 1, ?, ?)",
    "eviction-task-a", "legacy-task-a", "0".repeat(64), "tenant-a", "project-a",
  );
  sql.exec(
    "INSERT INTO orchestrator_tasks (task_id, idempotency_key, input_hash, state, version, task_json, created_at, updated_at, tenant_id, project_id) VALUES (?, ?, ?, 'SCHEDULED', 1, '{}', 2, 2, ?, ?)",
    "eviction-task-b", "legacy-task-b", "0".repeat(64), "tenant-b", "project-b",
  );
  sql.exec(
    "INSERT INTO orchestrator_outbox_events (event_id, idempotency_key, task_id, event_type, payload_json, status, attempts, lease_worker_id, lease_generation, lease_until, created_at, updated_at, tenant_id, project_id) VALUES (?, ?, ?, 'TASK_CREATED', '{}', 'PENDING', 0, NULL, 0, 0, 1, 1, ?, ?)",
    "eviction-event-a", "legacy-event-a", "eviction-task-a", "tenant-a", "project-a",
  );
  sql.exec(
    "INSERT INTO orchestrator_outbox_events (event_id, idempotency_key, task_id, event_type, payload_json, status, attempts, lease_worker_id, lease_generation, lease_until, created_at, updated_at, tenant_id, project_id) VALUES (?, ?, ?, 'TASK_CREATED', '{}', 'PENDING', 0, NULL, 0, 0, 2, 2, ?, ?)",
    "eviction-event-b", "legacy-event-b", "eviction-task-b", "tenant-b", "project-b",
  );

  expect(sql.exec(
    "SELECT version FROM orchestrator_schema_migrations WHERE version = 8",
  ).toArray()).toHaveLength(1);
  expect(sql.exec(
    "SELECT version FROM orchestrator_schema_migrations WHERE version = 9",
  ).toArray()).toHaveLength(0);
  expect(readRows(sql)).toEqual({
    tasks: [
      { task_id: "eviction-task-a", idempotency_key: "legacy-task-a", tenant_id: "tenant-a", project_id: "project-a" },
      { task_id: "eviction-task-b", idempotency_key: "legacy-task-b", tenant_id: "tenant-b", project_id: "project-b" },
    ],
    events: [
      { event_id: "eviction-event-a", idempotency_key: "legacy-event-a", tenant_id: "tenant-a", project_id: "project-a" },
      { event_id: "eviction-event-b", idempotency_key: "legacy-event-b", tenant_id: "tenant-b", project_id: "project-b" },
    ],
  });
}

function assertMigratedState(sql) {
  expect(readRows(sql)).toEqual({ tasks: expectedTasks, events: expectedEvents });
  const markers = sql.exec(
    "SELECT version FROM orchestrator_schema_migrations WHERE version BETWEEN 8 AND 12 ORDER BY version",
  ).toArray().map(row => row.version);
  expect(markers).toEqual([8, 9, 10, 11, 12]);
  expect(sql.exec(
    "SELECT COUNT(*) AS count FROM orchestrator_tasks",
  ).one().count).toBe(2);
  expect(sql.exec(
    "SELECT COUNT(*) AS count FROM orchestrator_outbox_events",
  ).one().count).toBe(2);
}

describe("Schema v9 migration recovery after Durable Object eviction", () => {
  it("reconstructs the object and completes migration from persisted v8 SQLite state", async () => {
    const ledger = ledgerFor("v9-migration-eviction-recovery");

    await runInDurableObject(ledger, async instance => {
      instance.__testOnlyVolatileEvictionSentinel = "must-disappear";
      seedV8Boundary(instance.ctx.storage.sql);
    });

    // This tears down the Durable Object instance while preserving its SQLite
    // storage. The next RPC must construct a fresh instance and run ensureSchema.
    await evictDurableObject(ledger);
    const afterFirstEviction = await ledger.ping();
    expect(afterFirstEviction.ok).toBe(true);
    expect(afterFirstEviction.schemaVersion).toBe(12);

    await runInDurableObject(ledger, async instance => {
      expect(instance.__testOnlyVolatileEvictionSentinel).toBeUndefined();
      assertMigratedState(instance.ctx.storage.sql);
    });

    // A second eviction checks that the migrated state remains stable across
    // another constructor/schema pass, not merely across one warm RPC sequence.
    await evictDurableObject(ledger);
    const afterSecondEviction = await ledger.ping();
    expect(afterSecondEviction.ok).toBe(true);
    expect(afterSecondEviction.schemaVersion).toBe(12);

    await runInDurableObject(ledger, async instance => {
      expect(instance.__testOnlyVolatileEvictionSentinel).toBeUndefined();
      assertMigratedState(instance.ctx.storage.sql);
    });
  });
});
