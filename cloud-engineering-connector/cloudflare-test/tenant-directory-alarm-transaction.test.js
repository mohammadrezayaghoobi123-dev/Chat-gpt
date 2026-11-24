import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

function directoryFor(tenantId) {
  return env.TENANT_DIRECTORY.get(env.TENANT_DIRECTORY.idFromName(tenantId));
}

describe("TenantDirectory Outbox alarm transaction boundary", () => {
  it("rolls back the alarm and SQL work item together when transactionSync aborts", async () => {
    const tenantId = "outbox-alarm-rollback-" + crypto.randomUUID();
    const stub = directoryFor(tenantId);

    const outcome = await runInDurableObject(stub, async instance => {
      const storage = instance.ctx.storage;
      const sql = storage.sql;
      sql.exec(
        "CREATE TABLE IF NOT EXISTS alarm_transaction_probe (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL)",
      );
      expect(await storage.getAlarm()).toBeNull();

      let rejected = false;
      try {
        storage.transactionSync(() => {
          sql.exec(
            "INSERT INTO alarm_transaction_probe(id, created_at) VALUES(?, ?)",
            "rollback-probe",
            Date.now(),
          );
          storage.setAlarm(Date.now() + 60_000);
          throw new Error("TEST_ALARM_TRANSACTION_ABORT");
        });
      } catch (error) {
        rejected = error.message === "TEST_ALARM_TRANSACTION_ABORT";
      }

      await Promise.resolve();
      return {
        rejected,
        rowCount: sql.exec(
          "SELECT COUNT(*) AS count FROM alarm_transaction_probe",
        ).one().count,
        alarm: await storage.getAlarm(),
      };
    });

    expect(outcome).toEqual({
      rejected: true,
      rowCount: 0,
      alarm: null,
    });
  });

  it("commits the alarm and SQL work item together and preserves both across a later object invocation", async () => {
    const tenantId = "outbox-alarm-commit-" + crypto.randomUUID();
    const stub = directoryFor(tenantId);
    const dueAt = Date.now() + 60_000;

    const committed = await runInDurableObject(stub, instance => {
      const storage = instance.ctx.storage;
      const sql = storage.sql;
      sql.exec(
        "CREATE TABLE IF NOT EXISTS alarm_transaction_probe (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL)",
      );
      storage.transactionSync(() => {
        sql.exec(
          "INSERT INTO alarm_transaction_probe(id, created_at) VALUES(?, ?)",
          "commit-probe",
          Date.now(),
        );
        storage.setAlarm(dueAt);
      });
    });

    const observed = await runInDurableObject(stub, async instance => ({
      rowCount: instance.ctx.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM alarm_transaction_probe WHERE id = ?",
        "commit-probe",
      ).one().count,
      alarm: await instance.ctx.storage.getAlarm(),
    }));

    expect(observed.rowCount).toBe(1);
    expect(observed.alarm).toBe(dueAt);

    await runInDurableObject(stub, async instance => {
      await instance.ctx.storage.deleteAlarm();
    });
  });
});
