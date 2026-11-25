import { createInterface } from "node:readline";
import { join } from "node:path";
import { openSqliteOrphanRecoveryHarness, recoverOrphanIntent } from "./sqlite-orphan-recovery-adapter.mjs";

const [mode, root, operationJson, expectedRaw = "0", owner = "worker-default", flag = ""] = process.argv.slice(2);
if (!mode || !root) throw new Error("Usage: worker <mode> <root> [operation-json] [expected-generation] [owner] [flag]");
const ledgerPath = join(root, "effect-ledger.sqlite");
const reservationPath = join(root, "reservation-store.sqlite");
const stores = openSqliteOrphanRecoveryHarness({ ledgerPath, reservationPath });
const operation = operationJson ? JSON.parse(operationJson) : null;

function emit(value, exitCode = 0, close = true) {
  if (close) stores.close();
  process.stdout.write(JSON.stringify(value) + "\n", () => process.exit(exitCode));
}

if (mode === "seed-intent-crash") {
  const acknowledgement = stores.ledger.appendIntent(operation);
  emit({ acknowledgement }, 73, false);
} else if (mode === "recover") {
  const result = recoverOrphanIntent(stores, { operation, expectedFenceGeneration: Number(expectedRaw), owner, crashAfterTombstone: flag === "crash-after-tombstone" });
  emit({ result, snapshot: stores.reservations.snapshot(operation.operation_id), history: stores.ledger.readRecoveryHistory(operation.operation_id) }, result.status === "TOMBSTONE_COMMITTED" ? 74 : 0);
} else if (mode === "recover-incomplete") {
  const result = recoverOrphanIntent(stores, { operation, expectedFenceGeneration: Number(expectedRaw), owner, reservationReadComplete: false });
  emit({ result, snapshot: stores.reservations.snapshot(operation.operation_id), history: stores.ledger.readRecoveryHistory(operation.operation_id) });
} else if (mode === "recover-ledger-incomplete") {
  const result = recoverOrphanIntent(stores, { operation, expectedFenceGeneration: Number(expectedRaw), owner, ledgerReadComplete: false });
  emit({ result, snapshot: stores.reservations.snapshot(operation.operation_id), history: stores.ledger.readRecoveryHistory(operation.operation_id) });
} else if (mode === "inspect") {
  emit({
    intent: stores.ledger.readIntent(operation.operation_id),
    boundary: stores.reservations.readAttemptBoundary(operation),
    tombstone: stores.reservations.readOrphanAbort(operation.operation_id),
    history: stores.ledger.readRecoveryHistory(operation.operation_id),
    snapshot: stores.reservations.snapshot(operation.operation_id),
  });
} else if (mode === "late-begin") {
  const result = stores.reservations.beginAttempt(operation);
  emit({ result, snapshot: stores.reservations.snapshot(operation.operation_id) });
} else if (mode === "seed-boundary") {
  const result = stores.reservations.beginAttempt(operation);
  emit({ result, snapshot: stores.reservations.snapshot(operation.operation_id) });
} else if (mode === "hold-fence") {
  const fence = stores.reservations.acquireRecoveryFence({ operationId: operation.operation_id, expectedGeneration: Number(expectedRaw), owner });
  process.stdout.write(JSON.stringify({ fence }) + "\n");
  if (fence.status !== "ACK") { stores.close(); process.exitCode = 2; }
  else {
    const input = createInterface({ input: process.stdin });
    for await (const line of input) {
      if (line === "abort") {
        const intent = stores.ledger.readIntent(operation.operation_id);
        const absence = stores.reservations.readAttemptBoundary(operation);
        const abortResult = stores.reservations.abortOrphanAttempt({ operation, intentAck: intent, absenceEvidence: absence, fence });
        process.stdout.write(JSON.stringify({ abortResult, snapshot: stores.reservations.snapshot(operation.operation_id) }) + "\\n");
        break;
      }
      if (line === "release") break;
    }
    input.close();
    stores.close();
  }
} else {
  stores.close();
  throw new Error(`Unknown worker mode: ${mode}`);
}
