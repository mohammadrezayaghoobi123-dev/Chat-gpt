import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

function ledgerFor(name) {
  return env.ORCHESTRATOR_LEDGER.get(env.ORCHESTRATOR_LEDGER.idFromName(name));
}

describe("OrchestratorLedger tenant/project query plans", () => {
  it("uses a tenant/project/sequence index for bounded audit-head lookup", async () => {
    const ledger = ledgerFor("audit-chain-scope-query-plan");
    await runInDurableObject(ledger, async instance => {
      const plan = instance.ctx.storage.sql.exec(
        `EXPLAIN QUERY PLAN
         SELECT event_hash
         FROM orchestrator_audit_events
         WHERE tenant_id = ? AND project_id = ?
         ORDER BY sequence DESC
         LIMIT 1`,
        "tenant-alpha", "project-red",
      ).toArray();
      const details = plan.map(row => row.detail).join("\\n");
      expect(details).toContain("orchestrator_audit_events_by_tenant_project");
      expect(details).not.toContain("USE TEMP B-TREE FOR ORDER BY");
    });
  });

  it("uses a scope-leading index for bounded executor claim-candidate selection", async () => {
    const ledger = ledgerFor("claim-candidate-scope-query-plan");
    await runInDurableObject(ledger, async instance => {
      const plan = instance.ctx.storage.sql.exec(
        `EXPLAIN QUERY PLAN
         SELECT task.task_id
         FROM orchestrator_claim_candidates AS candidate
         INNER JOIN orchestrator_tasks AS task ON task.task_id = candidate.task_id
         WHERE candidate.executor_id = ?
           AND candidate.tenant_id = ?
           AND candidate.project_id = ?
           AND task.tenant_id = ?
           AND task.project_id = ?
         ORDER BY candidate.created_at, candidate.task_id
         LIMIT 1`,
        "worker-a", "tenant-alpha", "project-red", "tenant-alpha", "project-red",
      ).toArray();
      const details = plan.map(row => row.detail).join("\n");
      expect(details).toContain("orchestrator_claim_candidates_by_scope_executor_order");
    });
  });
  it("uses a tenant/project/executor-leading index for bounded legacy candidate backfill", async () => {
    const ledger = ledgerFor("claim-candidate-backfill-scope-query-plan");
    await runInDurableObject(ledger, async instance => {
      const plan = instance.ctx.storage.sql.exec(
        `EXPLAIN QUERY PLAN
         SELECT task_id, created_at
         FROM orchestrator_tasks
         WHERE tenant_id = ?
           AND project_id = ?
           AND COALESCE(json_extract(task_json, '$.executorId'), json_extract(task_json, '$.assignedAgentId')) = ?
           AND (created_at, task_id) > (?, ?)
         ORDER BY created_at, task_id
         LIMIT ?`,
        "tenant-alpha", "project-red", "worker-a", 0, "", 32,
      ).toArray();
      const details = plan.map(row => row.detail).join("\\n");
      expect(details).toContain("orchestrator_tasks_by_scope_executor_created");
      expect(details).not.toContain("USE TEMP B-TREE FOR ORDER BY");
    });
  });

});
