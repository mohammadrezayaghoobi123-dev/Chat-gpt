import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

function ledgerFor(name) {
  return env.ORCHESTRATOR_LEDGER.get(env.ORCHESTRATOR_LEDGER.idFromName(name));
}

describe("OrchestratorLedger readiness and integrity diagnostics", () => {
  it("keeps deep SQLite integrity scans off the readiness path", async () => {
    const ledger = ledgerFor("readiness-bounded-check");
    await runInDurableObject(ledger, async instance => {
      const execSpy = vi.spyOn(instance.ctx.storage.sql, "exec");
      const result = instance.ping();

      expect(result.ok).toBe(true);
      expect(result.schemaVersion).toBe(7);
      expect(result.storage.requiredTables).toBe(true);
      expect(result.storage).not.toHaveProperty("integrityCheck");
      expect(execSpy.mock.calls.some(([statement]) =>
        String(statement).toLowerCase().includes("quick_check")
      )).toBe(false);

      execSpy.mockRestore();
    });
  });

  it("runs the deep SQLite integrity check only through an explicit diagnostic", async () => {
    const ledger = ledgerFor("explicit-integrity-diagnostic");
    await runInDurableObject(ledger, async instance => {
      const execSpy = vi.spyOn(instance.ctx.storage.sql, "exec");
      const result = instance.checkIntegrity();

      expect(result.ok).toBe(true);
      expect(result.integrityCheck).toBe("ok");
      expect(execSpy.mock.calls.some(([statement]) =>
        String(statement).toLowerCase().includes("quick_check")
      )).toBe(true);

      execSpy.mockRestore();
    });
  });
});
