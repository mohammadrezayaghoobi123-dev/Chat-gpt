import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

function ledgerFor(name) {
  return env.ORCHESTRATOR_LEDGER.get(env.ORCHESTRATOR_LEDGER.idFromName(name));
}

describe("v9 SQLite cursor and temporary staging capability spike", () => {
  it("lazily consumes a SQLite cursor while staging rows into a TEMP table", async () => {
    const ledger = ledgerFor("v9-cursor-temp-staging-capability");
    await runInDurableObject(ledger, async instance => {
      const sql = instance.ctx.storage.sql;
      const rowCount = 1024;

      sql.exec("CREATE TEMP TABLE v9_capability_source (source_id INTEGER PRIMARY KEY, legacy_key TEXT NOT NULL)");
      sql.exec("CREATE TEMP TABLE v9_capability_stage (source_id INTEGER PRIMARY KEY, final_key TEXT NOT NULL UNIQUE)");

      for (let sourceId = 1; sourceId <= rowCount; sourceId += 1) {
        sql.exec(
          "INSERT INTO temp.v9_capability_source (source_id, legacy_key) VALUES (?, ?)",
          sourceId,
          "legacy-" + sourceId,
        );
      }

      const cursor = sql.exec(
        "SELECT source_id, legacy_key FROM temp.v9_capability_source ORDER BY source_id",
      );
      const first = cursor.next();

      expect(first.done).toBe(false);
      expect(first.value).toEqual({ source_id: 1, legacy_key: "legacy-1" });
      // This is the decisive capability assertion: reading one row must not
      // eagerly materialize the complete result set before staging can begin.
      expect(cursor.rowsRead).toBeLessThan(rowCount);

      let current = first;
      let stagedRows = 0;
      while (!current.done) {
        const row = current.value;
        sql.exec(
          "INSERT INTO temp.v9_capability_stage (source_id, final_key) VALUES (?, ?)",
          row.source_id,
          "final-" + row.source_id,
        );
        stagedRows += 1;
        current = cursor.next();
      }

      expect(stagedRows).toBe(rowCount);
      expect(cursor.rowsRead).toBe(rowCount);
      expect(sql.exec("SELECT COUNT(*) AS total FROM temp.v9_capability_stage").one().total).toBe(rowCount);

      // A real UNIQUE collision must be rejected by SQLite, not hidden by
      // application-side assumptions about generated staging/final keys.
      expect(() => sql.exec(
        "INSERT INTO temp.v9_capability_stage (source_id, final_key) VALUES (?, ?)",
        rowCount + 1,
        "final-1",
      )).toThrow();
      expect(sql.exec("SELECT COUNT(*) AS total FROM temp.v9_capability_stage").one().total).toBe(rowCount);
    });
  });

  it("rolls back TEMP-table DDL, staging writes, and source writes together", async () => {
    const ledger = ledgerFor("v9-temp-staging-transaction-rollback");
    await runInDurableObject(ledger, async instance => {
      const sql = instance.ctx.storage.sql;
      sql.exec("CREATE TEMP TABLE v9_rollback_source (source_id INTEGER PRIMARY KEY, state TEXT NOT NULL)");
      sql.exec(
        "INSERT INTO temp.v9_rollback_source (source_id, state) VALUES (1, 'original')",
      );

      expect(() => instance.ctx.storage.transactionSync(() => {
        sql.exec("CREATE TEMP TABLE v9_rollback_stage (source_id INTEGER PRIMARY KEY, staged_key TEXT NOT NULL UNIQUE)");
        sql.exec(
          "INSERT INTO temp.v9_rollback_stage (source_id, staged_key) VALUES (1, 'staged-1')",
        );
        sql.exec(
          "UPDATE temp.v9_rollback_source SET state = 'mutated' WHERE source_id = 1",
        );
        throw new Error("forced-v9-capability-rollback");
      })).toThrow("forced-v9-capability-rollback");

      expect(sql.exec(
        "SELECT state FROM temp.v9_rollback_source WHERE source_id = 1",
      ).one().state).toBe("original");
      expect(sql.exec(
        "SELECT name FROM sqlite_temp_master WHERE type = 'table' AND name = 'v9_rollback_stage'",
      ).toArray()).toEqual([]);
    });
  });
});
