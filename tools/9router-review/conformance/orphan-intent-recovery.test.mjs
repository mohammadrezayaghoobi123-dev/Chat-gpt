import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

function runNode(source, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", source, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

test("T57.1: durable INTENT acknowledgement survives writer termination and independent-process reopen", async () => {
  const root = await mkdtemp(join(tmpdir(), "9router-t57-"));
  const ledgerPath = join(root, "effect-ledger.sqlite");
  const reservationPath = join(root, "reservation-store.sqlite");
  const operation = {
    operation_id: "t57-stage1-operation",
    reservation_key: { repository_id: 424242, pull_request_number: 57, head_sha: "a".repeat(40), base_sha: "b".repeat(40) },
    stage: "MODEL",
    attempt_id: "t57-stage1-attempt",
    request_digest: "sha256:test-model-request",
    protocol_version: "9router-orphan-recovery-v1",
  };
  const payloadJson = JSON.stringify(operation);
  const payloadDigest = createHash("sha256").update(payloadJson).digest("hex");

  const writer = `
    import { DatabaseSync } from "node:sqlite";
    import { createHash } from "node:crypto";
    const ledger = new DatabaseSync(process.argv[1]);
    ledger.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
    ledger.exec("CREATE TABLE IF NOT EXISTS events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, operation_id TEXT NOT NULL, kind TEXT NOT NULL, payload_json TEXT NOT NULL, payload_digest TEXT NOT NULL, UNIQUE(operation_id, kind)) STRICT;");
    const payload = process.argv[3];
    const operation = JSON.parse(payload);
    const digest = createHash("sha256").update(payload).digest("hex");
    ledger.prepare("INSERT INTO events (event_id, operation_id, kind, payload_json, payload_digest) VALUES (?, ?, ?, ?, ?)").run("t57-intent-event", operation.operation_id, "INTENT", payload, digest);
    const reservation = new DatabaseSync(process.argv[2]);
    reservation.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
    reservation.exec("CREATE TABLE IF NOT EXISTS attempt_boundaries (operation_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL) STRICT;");
    process.stdout.write(JSON.stringify({ status: "ACK", event_id: "t57-intent-event", operation_id: operation.operation_id, payload_digest: digest }) + "\\n", () => process.exit(73));
  `;
  const reader = `
    import { DatabaseSync } from "node:sqlite";
    const ledger = new DatabaseSync(process.argv[1]);
    const reservation = new DatabaseSync(process.argv[2]);
    const event = ledger.prepare("SELECT event_id, operation_id, kind, payload_json, payload_digest, sequence FROM events WHERE operation_id = ?").get(process.argv[3]);
    const boundaryCount = reservation.prepare("SELECT COUNT(*) AS n FROM attempt_boundaries WHERE operation_id = ?").get(process.argv[3]).n;
    process.stdout.write(JSON.stringify({ event, boundary_count: boundaryCount }) + "\\n");
  `;

  try {
    const writerResult = await runNode(writer, [ledgerPath, reservationPath, payloadJson]);
    assert.equal(writerResult.code, 73, `writer must terminate at the injected crash boundary; stderr=${writerResult.stderr}`);
    const acknowledgement = JSON.parse(writerResult.stdout.trim());
    assert.equal(acknowledgement.status, "ACK");
    assert.equal(acknowledgement.event_id, "t57-intent-event");
    assert.equal(acknowledgement.payload_digest, payloadDigest);

    const readerResult = await runNode(reader, [ledgerPath, reservationPath, operation.operation_id]);
    assert.equal(readerResult.code, 0, `independent reader failed; stderr=${readerResult.stderr}`);
    const reopened = JSON.parse(readerResult.stdout.trim());
    assert.equal(reopened.event.event_id, acknowledgement.event_id);
    assert.equal(reopened.event.operation_id, operation.operation_id);
    assert.equal(reopened.event.kind, "INTENT");
    assert.equal(reopened.event.payload_json, payloadJson);
    assert.equal(reopened.event.payload_digest, payloadDigest);
    assert.equal(reopened.boundary_count, 0, "writer must terminate before any attempt-boundary invocation");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
