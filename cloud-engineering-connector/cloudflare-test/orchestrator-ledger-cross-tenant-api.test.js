import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../orchestrator-protocol.js";

function ledgerFor(name) {
  return env.ORCHESTRATOR_LEDGER.get(env.ORCHESTRATOR_LEDGER.idFromName(name));
}

function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("=", "").replaceAll("+", "-").replaceAll("/", "_");
}

async function mintAgentAssertion(keyHex, operation, nowMs) {
  const issuedAt = Math.floor(nowMs / 1000);
  const claims = {
    v: 1,
    iss: "chat-gpt111-worker",
    aud: "orchestrator-ledger",
    sub: "worker-a",
    role: "agent",
    op: operation,
    iat: issuedAt,
    exp: issuedAt + 60,
    jti: "jti-" + crypto.randomUUID().replace(/-/g, ""),
  };
  const payload = base64Url(new TextEncoder().encode(canonicalJson(claims)));
  const signingInput = "v1.test." + payload;
  const keyBytes = Uint8Array.from(keyHex.match(/.{2}/g), pair => Number.parseInt(pair, 16));
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign(
    "HMAC", key, new TextEncoder().encode(signingInput),
  ));
  return signingInput + "." + base64Url(signature);
}

describe("OrchestratorLedger cross-tenant API isolation", () => {
  it("rejects foreign-scope task mutations and does not alter the owning tenant's rows", async () => {
    const ledger = ledgerFor("cross-tenant-task-api-isolation");
    await runInDurableObject(ledger, async instance => {
      const now = 1_800_000_000_000;
      const keyHex = "c".repeat(64);
      instance.env.LEDGER_WORKER_ASSERTION_KEYS = JSON.stringify({ test: keyHex });
      const sql = instance.ctx.storage.sql;
      const task = {
        taskId: "tenant-alpha-task",
        tenantId: "tenant-alpha",
        projectId: "project-red",
        executorId: "worker-a",
        agentRound: 0,
        state: "SCHEDULED",
        version: 1,
        createdAt: now - 100,
        updatedAt: now - 50,
      };
      sql.exec(
        "INSERT INTO orchestrator_tasks (task_id, idempotency_key, input_hash, state, version, task_json, created_at, updated_at, tenant_id, project_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        task.taskId, "tenant-alpha-idem", "d".repeat(64), task.state, task.version,
        JSON.stringify(task), task.createdAt, task.updatedAt, task.tenantId, task.projectId,
      );
      sql.exec(
        "INSERT INTO orchestrator_execution_leases (task_id, worker_id, lease_generation, lease_until, updated_at, tenant_id, project_id) VALUES (?, ?, 1, ?, ?, ?, ?)",
        task.taskId, "worker-a", now + 10_000, now - 40, task.tenantId, task.projectId,
      );

      const assertion = async operation => mintAgentAssertion(keyHex, operation, now);
      const [transition, claim, advance, renew, release, enqueue, audit] = await Promise.all([
        instance.transitionTask({
          taskId: task.taskId, tenantId: "tenant-beta", projectId: "project-blue",
          expectedVersion: 1, expectedState: "SCHEDULED", nextState: "RUNNING",
          actor: { id: "worker-a", role: "agent" }, workerId: "worker-a",
          workerAssertion: await assertion("transitionTask"), leaseGeneration: 1, now,
        }),
        instance.claimTask({
          taskId: task.taskId, tenantId: "tenant-beta", projectId: "project-blue",
          workerId: "worker-a", workerAssertion: await assertion("claimTask"),
          leaseMs: 5_000, now,
        }),
        instance.advanceAgentRound({
          taskId: task.taskId, tenantId: "tenant-beta", projectId: "project-blue",
          expectedVersion: 1, expectedRound: 0, nextRound: 1, workerId: "worker-a",
          workerAssertion: await assertion("advanceAgentRound"), leaseGeneration: 1, now,
        }),
        instance.renewLease({
          taskId: task.taskId, tenantId: "tenant-beta", projectId: "project-blue",
          workerId: "worker-a", workerAssertion: await assertion("renewLease"),
          leaseGeneration: 1, leaseMs: 5_000, now,
        }),
        instance.releaseLease({
          taskId: task.taskId, tenantId: "tenant-beta", projectId: "project-blue",
          workerId: "worker-a", workerAssertion: await assertion("releaseLease"),
          leaseGeneration: 1, now,
        }),
        instance.enqueueOutbox({
          eventId: "foreign-event", idempotencyKey: "foreign-outbox-idem",
          taskId: task.taskId, tenantId: "tenant-beta", projectId: "project-blue",
          eventType: "task.created", payload: { taskId: task.taskId, version: 1 },
          workerId: "worker-a", workerAssertion: await assertion("enqueueOutbox"), now,
        }),
        instance.appendAuditEvent({
          eventId: "foreign-audit", taskId: task.taskId,
          tenantId: "tenant-beta", projectId: "project-blue",
          actor: { id: "worker-a", role: "agent" }, workerId: "worker-a",
          workerAssertion: await assertion("appendAuditEvent"),
          eventType: "TASK_NOTE", details: { note: "must not cross tenant" }, now,
        }),
      ]);

      expect(transition.reason).toBe("NOT_FOUND");
      expect(claim.claimed).toBe(false);
      expect(claim.reason).toBe("NO_TASK_AVAILABLE");
      expect(advance.reason).toBe("NOT_FOUND");
      expect(renew.renewed).toBe(false);
      expect(release.released).toBe(false);
      expect(enqueue.reason).toBe("TASK_NOT_FOUND");
      expect(audit.reason).toBe("TASK_NOT_FOUND");

      const storedTask = sql.exec("SELECT state, version, tenant_id, project_id FROM orchestrator_tasks WHERE task_id = ?", task.taskId).one();
      expect(storedTask).toEqual({
        state: "SCHEDULED", version: 1, tenant_id: "tenant-alpha", project_id: "project-red",
      });
      const storedLease = sql.exec("SELECT worker_id, lease_generation, lease_until, tenant_id, project_id FROM orchestrator_execution_leases WHERE task_id = ?", task.taskId).one();
      expect(storedLease).toEqual({
        worker_id: "worker-a", lease_generation: 1, lease_until: now + 10_000,
        tenant_id: "tenant-alpha", project_id: "project-red",
      });
      expect(sql.exec("SELECT COUNT(*) AS count FROM orchestrator_outbox_events").one().count).toBe(0);
      expect(sql.exec("SELECT COUNT(*) AS count FROM orchestrator_audit_events").one().count).toBe(0);
      expect(sql.exec("SELECT COUNT(*) AS count FROM orchestrator_processed_messages").one().count).toBe(0);
    });
  });
});
