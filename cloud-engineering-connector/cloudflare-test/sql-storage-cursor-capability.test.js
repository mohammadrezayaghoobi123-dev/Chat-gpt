import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

function ledgerFor(name) {
  return env.ORCHESTRATOR_LEDGER.get(env.ORCHESTRATOR_LEDGER.idFromName(name));
}

describe("SQLite cursor and staging capability for migration v9", () => {
  it("iterates rows through SqlStorageCursor and enforces staging uniqueness", async () => {
    const ledger = ledgerFor("v9-cursor-capability-iteration");
    await runInDurableObject(ledger, async instance => {
      const sql = instance.ctx.storage.sql;
      sql.exec(`
        CREATE TEMP TABLE v9_cursor_capability_rows (
          row_id INTEGER PRIMARY KEY,
          final_key TEXT NOT NULL UNIQUE
        )
      `);

      const expectedRows = 512;
      for (let rowId = 1; rowId <= expectedRows; rowId += 1) {
        sql.exec(
          "INSERT INTO v9_cursor_capability_rows (row_id, final_key) VALUES (?, ?)",
          rowId,
          "final-" + rowId,
        );
      }

      const cursor = sql.exec(
        "SELECT row_id, final_key FROM v9_cursor_capability_rows ORDER BY row_id",
      );
      expect(cursor).toBeDefined();
      expect(typeof cursor.next).toBe("function");
      expect(typeof cursor[Symbol.iterator]).toBe("function");

      const first = cursor.next();
      expect(first.done).toBe(false);
      expect(first.value).toMatchObject({ row_id: 1, final_key: "final-1" });

      let rowsSeen = 1;
      let checksum = first.value.row_id;
      for (const row of cursor) {
        rowsSeen += 1;
        checksum += row.row_id;
      }

      expect(rowsSeen).toBe(expectedRows);
      expect(checksum).toBe((expectedRows * (expectedRows + 1)) / 2);
      expect(Number.isInteger(cursor.rowsRead)).toBe(true);
      expect(cursor.rowsRead).toBeGreaterThanOrEqual(expectedRows);

      expect(() => sql.exec(
        "INSERT INTO v9_cursor_capability_rows (row_id, final_key) VALUES (?, ?)",
        expectedRows + 1,
        "final-1",
      )).toThrow();

      const count = sql.exec(
        "SELECT COUNT(*) AS count FROM v9_cursor_capability_rows",
      ).toArray()[0].count;
      expect(count).toBe(expectedRows);
    });
  });

  it("rolls back temporary staging DDL and writes when transactionSync throws", async () => {
    const ledger = ledgerFor("v9-cursor-capability-rollback");
    await runInDurableObject(ledger, async instance => {
      const sql = instance.ctx.storage.sql;
      expect(() => instance.ctx.storage.transactionSync(() => {
        sql.exec(`
          CREATE TEMP TABLE v9_cursor_capability_rollback (
            row_id INTEGER PRIMARY KEY,
            final_key TEXT NOT NULL UNIQUE
          )
        `);
        sql.exec(
          "INSERT INTO v9_cursor_capability_rollback (row_id, final_key) VALUES (?, ?)",
          1,
          "staged-key",
        );
        throw new Error("intentional capability-spike rollback");
      })).toThrow("intentional capability-spike rollback");

      const table = sql.exec(
        "SELECT name FROM sqlite_temp_master WHERE type = 'table' AND name = ?",
        "v9_cursor_capability_rollback",
      ).toArray();
      expect(table).toHaveLength(0);
    });
  });
});
