import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { OrchestratorLedger } from "../index.js";
import worker from "../worker.js";

function createIsolatedLedgerBinding() {
  const namespace = env.ORCHESTRATOR_LEDGER;
  const id = namespace.idFromName("readiness-integration-" + crypto.randomUUID());
  const stub = namespace.get(id);

  return {
    stub,
    binding: {
      idFromName(name) {
        expect(name).toBe("orchestrator-ledger-global");
        return id;
      },
      get(requestedId) {
        expect(requestedId).toBe(id);
        return stub;
      },
    },
  };
}

function createReadinessEnvironment(ledgerBinding) {
  return {
    MCP_RATE_LIMITER: env.MCP_RATE_LIMITER,
    WRITE_CONTROL: env.WRITE_CONTROL,
    KNOWLEDGE_STORE: env.KNOWLEDGE_STORE,
    ORCHESTRATOR_LEDGER: ledgerBinding,
    ORCHESTRATOR_OUTBOX_QUEUE: env.ORCHESTRATOR_OUTBOX_QUEUE,
    ORCHESTRATOR_OUTBOX_QUEUE_NAME: env.ORCHESTRATOR_OUTBOX_QUEUE_NAME,
    ORCHESTRATOR_OUTBOX_DLQ_QUEUE: env.ORCHESTRATOR_OUTBOX_DLQ_QUEUE,
    LEDGER_WORKER_ASSERTION_KEYS: env.LEDGER_WORKER_ASSERTION_KEYS,
    LEDGER_WORKER_ASSERTION_ACTIVE_KID: env.LEDGER_WORKER_ASSERTION_ACTIVE_KID,
  };
}

describe("Worker readiness with the real OrchestratorLedger Durable Object", () => {
  it("reports ready when the actual SQLite schema matches the Worker contract", async () => {
    const { stub, binding } = createIsolatedLedgerBinding();

    const directProbe = await stub.ping();
    expect(directProbe).toEqual({ ok: true, schemaVersion: 8 });

    await runInDurableObject(stub, instance => {
      expect(instance).toBeInstanceOf(OrchestratorLedger);
    });

    const request = new Request("https://example.test/readyz", {
      method: "GET",
      headers: { "cf-connecting-ip": "203.0.113.24" },
    });
    const response = await worker.fetch(
      request,
      createReadinessEnvironment(binding),
    );
    const body = await response.json();

    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body).toMatchObject({
      status: "ready",
      durable_objects: "ok",
      knowledge_store: "ok",
      orchestrator_ledger: "ok",
      orchestrator_outbox_publisher: "ok",
      orchestrator_outbox_dlq_archiver: "ok",
    });
  });
});
