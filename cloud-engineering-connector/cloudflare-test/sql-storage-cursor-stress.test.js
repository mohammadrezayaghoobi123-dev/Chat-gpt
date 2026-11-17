import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

function ledgerFor(name) {
  return env.ORCHESTRATOR_LEDGER.get(env.ORCHESTRATOR_LEDGER.idFromName(name));
}

describe("SQLite cursor migration stress and resource-bound probe", () => {
  it("scans 1k, 10k, and 100k rows without retaining a JavaScript row collection", async () => {
    const ledger = ledgerFor("v9-migration-stress-resource-bound");
    await runInDurableObject(ledger, async instance => {
      const sql = instance.ctx.storage.sql;
      sql.exec("DROP TABLE IF EXISTS v9_cursor_stress_rows");
      sql.exec(`
        CREATE TABLE v9_cursor_stress_rows (
          row_id INTEGER PRIMARY KEY,
          final_key TEXT NOT NULL UNIQUE
        )
      `);

      const measurements = [];
      const rowCounts = [1_000, 10_000, 100_000];

      try {
        for (const rowCount of rowCounts) {
          sql.exec("DELETE FROM v9_cursor_stress_rows");

          const insertCursor = sql.exec(
            `WITH RECURSIVE seq(n) AS (
              SELECT 1
              UNION ALL
              SELECT n + 1 FROM seq WHERE n < ?
            )
            INSERT INTO v9_cursor_stress_rows (row_id, final_key)
            SELECT n, 'stress-' || n FROM seq`,
            rowCount,
          );
          expect(insertCursor.rowsWritten).toBe(rowCount);

          const startedAt = performance.now();
          const cursor = sql.exec(
            "SELECT row_id, final_key FROM v9_cursor_stress_rows ORDER BY row_id",
          );

          let rowsSeen = 0;
          let checksum = 0;
          for (const row of cursor) {
            rowsSeen += 1;
            checksum += row.row_id;
          }
          const elapsedMs = performance.now() - startedAt;

          expect(rowsSeen).toBe(rowCount);
          expect(checksum).toBe((rowCount * (rowCount + 1)) / 2);
          expect(cursor.rowsRead).toBe(rowCount);
          expect(Number.isFinite(elapsedMs)).toBe(true);
          expect(elapsedMs).toBeGreaterThanOrEqual(0);

          measurements.push({
            rows: rowCount,
            rowsWritten: insertCursor.rowsWritten,
            rowsRead: cursor.rowsRead,
            scanElapsedMs: Number(elapsedMs.toFixed(3)),
          });
        }

        console.info(
          "V9_CURSOR_STRESS_METRICS " + JSON.stringify({
            measurements,
            memoryBytes: null,
            memoryMeasurement: "not exposed by the Cloudflare Vitest Durable Object runtime",
          }),
        );
      } finally {
        sql.exec("DROP TABLE IF EXISTS v9_cursor_stress_rows");
      }
    });
  });
});
