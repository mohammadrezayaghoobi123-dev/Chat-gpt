import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createAgentWorkerAssertion } from "../orchestrator-worker-identity.js";

function ledgerFor(name) {
  return env.ORCHESTRATOR_LEDGER.get(env.ORCHESTRATOR_LEDGER.idFromName(name));
}

describe("OrchestratorLedger reconciliation evidence pruning", () => {
  it("prunes expired evidence only inside the requesting tenant/project scope", async () => {
    const ledger = ledgerFor("reconciliation-evidence-prune-scope");
    await runInDurableObject(ledger, async instance => {
      const now = 1_800_000_000_000;
      const keySet = JSON.stringify({ test: "6".repeat(64) });
      instance.env.LEDGER_WORKER_ASSERTION_KEYS = keySet;
      const sql = instance.ctx.storage.sql;
      const evidence = [
        ["expired-alpha", "tenant-alpha", "project-red"],
        ["expired-beta", "tenant-beta", "project-blue"],
      ];
      for (const [id, tenantId, projectId] of evidence) {
        sql.exec(
          "INSERT INTO orchestrator_consumed_reconciliation_evidence (evidence_id, evidence_hash, task_id, prior_generation, issuer, issued_at, expires_at, consumed_at, tenant_id, project_id) VALUES (?, ?, ?, 1, ?, ?, 1, ?, ?, ?)",
          id, "a".repeat(64), "task-" + id, "reconciler-a", now - 10, now - 5, tenantId, projectId,
        );
      }

      const workerAssertion = await createAgentWorkerAssertion(keySet, "test", {
        subject: "worker-a",
        operation: "claimTask",
        tenantId: "tenant-alpha",
        projectId: "project-red",
        taskId: null,
        nowMs: now,
      });
      const result = await instance.claimTask({
        workerId: "worker-a",
        workerAssertion,
        leaseMs: 5_000,
        now,
        tenantId: "tenant-alpha",
        projectId: "project-red",
      });
      expect(result).toMatchObject({ claimed: false, reason: "NO_TASK_AVAILABLE" });
      const remaining = sql.exec(
        "SELECT evidence_id, tenant_id, project_id FROM orchestrator_consumed_reconciliation_evidence ORDER BY evidence_id",
      ).toArray();
      expect(remaining).toEqual([{
        evidence_id: "expired-beta",
        tenant_id: "tenant-beta",
        project_id: "project-blue",
      }]);
    });
  });
});
