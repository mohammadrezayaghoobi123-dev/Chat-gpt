import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const workerPath = join(dirname(fileURLToPath(import.meta.url)), "orphan-intent-recovery-worker.mjs");
const operation = {
  operation_id: "t57-terminal-abort-operation",
  reservation_key: { repository_id: 424242, pull_request_number: 57, head_sha: "a".repeat(40), base_sha: "b".repeat(40) },
  stage: "MODEL",
  attempt_id: "t57-terminal-abort-attempt",
  request_digest: "sha256:test-model-request",
  protocol_version: "9router-orphan-recovery-v1",
};

function spawnWorker(mode, root, expectedGeneration = 0, owner = "worker", flag = "") {
  const child = spawn(process.execPath, [workerPath, mode, root, JSON.stringify(operation), String(expectedGeneration), owner, flag], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  const closed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { child, closed };
}

async function runWorker(mode, root, expectedGeneration = 0, owner = "worker", flag = "", expectedExit = 0) {
  const run = spawnWorker(mode, root, expectedGeneration, owner, flag);
  const result = await run.closed;
  assert.equal(result.code, expectedExit, `${mode} exit mismatch; stdout=${result.stdout}; stderr=${result.stderr}`);
  return result.stdout.trim() ? JSON.parse(result.stdout.trim().split("\n").at(-1)) : null;
}

async function seedIntent(root) {
  const result = await runWorker("seed-intent-crash", root, 0, "writer-A", "", 73);
  assert.equal(result.acknowledgement.status, "ACK");
  assert.equal(result.acknowledgement.operation_id, operation.operation_id);
  return result.acknowledgement;
}

test("T57.2: definitive absence creates one terminal tombstone and one final ledger event; late begin is denied", async () => {
  const root = await mkdtemp(join(tmpdir(), "9router-t57-abort-"));
  try {
    const intentAck = await seedIntent(root);
    const first = await runWorker("recover", root, 0, "recovery-A");
    assert.equal(first.result.status, "ABORTED_ORPHAN");
    assert.equal(first.result.tombstone.status, "ACK");
    assert.equal(first.result.terminal_event.status, "ACK");
    assert.equal(first.result.terminal_event.payload.disposition, "ORPHAN_INTENT_ABORTED");
    assert.equal(first.snapshot.tombstones, 1);
    assert.equal(first.snapshot.reservation_events, 1);
    assert.equal(first.snapshot.boundaries, 0);
    assert.equal(first.snapshot.permits, 0);
    assert.equal(first.snapshot.external_effects, 0);

    const late = await runWorker("late-begin", root);
    assert.equal(late.result.status, "ORPHAN_ABORTED");
    assert.equal(late.snapshot.permits, 0, "terminal tombstone must deny a late permit");
    assert.equal(late.snapshot.boundaries, 0);

    const repeated = await runWorker("recover", root, 1, "recovery-B");
    assert.equal(repeated.result.status, "ABORTED_ORPHAN");
    assert.equal(repeated.result.tombstone.tombstone_id, first.result.tombstone.tombstone_id);
    assert.equal(repeated.result.terminal_event.event_id, first.result.terminal_event.event_id);
    assert.equal(repeated.snapshot.tombstones, 1);
    assert.equal(repeated.snapshot.reservation_events, 1);
    assert.equal(repeated.result.terminal_event.payload.attempt_id, operation.attempt_id);
    assert.equal(intentAck.event_id, first.result.terminal_event.payload.intent_event_id);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("T57.3: restart after reservation tombstone but before ledger append converges without a duplicate terminal event", async () => {
  const root = await mkdtemp(join(tmpdir(), "9router-t57-interstore-crash-"));
  try {
    await seedIntent(root);
    const crashed = await runWorker("recover", root, 0, "recovery-B", "crash-after-tombstone", 74);
    assert.equal(crashed.result.status, "TOMBSTONE_COMMITTED");
    assert.equal(crashed.snapshot.tombstones, 1);
    assert.equal(crashed.history.events.filter(event => event.event_type === "ORPHAN_INTENT_ABORTED").length, 0);

    const reopened = await runWorker("inspect", root);
    assert.equal(reopened.tombstone.status, "ACK");
    assert.equal(reopened.history.events.filter(event => event.event_type === "INTENT").length, 1);
    assert.equal(reopened.history.events.filter(event => event.event_type === "ORPHAN_INTENT_ABORTED").length, 0);

    const recovered = await runWorker("recover", root, 1, "recovery-C");
    assert.equal(recovered.result.status, "ABORTED_ORPHAN");
    assert.equal(recovered.snapshot.tombstones, 1);
    assert.equal(recovered.result.terminal_event.payload.tombstone_id, reopened.tombstone.tombstone_id);
    assert.equal(recovered.history.events.filter(event => event.event_type === "ORPHAN_INTENT_ABORTED").length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("T57.4: a competing recovery process with a stale expected fence cannot mutate either durable store", async () => {
  const root = await mkdtemp(join(tmpdir(), "9router-t57-fence-"));
  let held;
  try {
    await seedIntent(root);
    held = spawnWorker("hold-fence", root, 0, "recovery-fence-owner");
    let line = "";
    const fence = await new Promise((resolve, reject) => {
      held.child.stdout.setEncoding("utf8").on("data", chunk => {
        line += chunk;
        if (line.includes("\n")) resolve(JSON.parse(line.trim().split("\n")[0]));
      });
      held.child.once("error", reject);
      held.child.once("close", code => reject(new Error(`fence holder exited before acquiring fence: ${code}; ${line}`)));
    });
    assert.equal(fence.fence.status, "ACK");
    assert.equal(fence.fence.generation, 1);

    const before = await runWorker("inspect", root);
    const competing = await runWorker("recover", root, 0, "recovery-stale");
    assert.equal(competing.result.status, "STALE_FENCE");
    const after = await runWorker("inspect", root);
    assert.deepEqual(after.snapshot, before.snapshot);
    assert.equal(after.tombstone.status, "NOT_FOUND");
    assert.equal(after.history.events.filter(event => event.event_type === "ORPHAN_INTENT_ABORTED").length, 0);

    const authorized = await runWorker("recover", root, 1, "recovery-current");
    assert.equal(authorized.result.status, "ABORTED_ORPHAN");
    assert.equal(authorized.result.tombstone.fence_generation, 2);
    assert.equal(authorized.snapshot.tombstones, 1);

    let staleOutput = "";
    const staleAttempt = new Promise((resolve, reject) => {
      held.child.stdout.setEncoding("utf8").on("data", chunk => {
        staleOutput += chunk;
        if (staleOutput.includes("\n")) resolve(JSON.parse(staleOutput.trim().split("\n").at(-1)));
      });
      held.child.once("error", reject);
    });
    held.child.stdin.write("abort\n");
    const stale = await staleAttempt;
    assert.equal(stale.abortResult.status, "STALE_FENCE");
    assert.equal(stale.snapshot.tombstones, 1);

    const holderExit = await held.closed;
    assert.equal(holderExit.code, 0);
    held = null;
    const final = await runWorker("inspect", root);
    assert.equal(final.snapshot.tombstones, 1);
    assert.equal(final.history.events.filter(event => event.event_type === "ORPHAN_INTENT_ABORTED").length, 1);
  } finally {
    if (held) { held.child.stdin.write("release\n"); await held.closed; }
    await rm(root, { recursive: true, force: true });
  }
});

test("T57.5: an incomplete ReservationStore read quarantines the orphan without mutating either store", async () => {
  const root = await mkdtemp(join(tmpdir(), "9router-t57-incomplete-"));
  try {
    await seedIntent(root);
    const before = await runWorker("inspect", root);
    const result = await runWorker("recover-incomplete", root, 0, "recovery-incomplete");
    assert.equal(result.result.status, "RECOVERY_QUARANTINED");
    assert.equal(result.result.reason, "UNKNOWN");
    const after = await runWorker("inspect", root);
    assert.deepEqual(after.snapshot, before.snapshot);
    assert.equal(after.tombstone.status, "NOT_FOUND");
    assert.deepEqual(after.history.events, before.history.events);
    
    const ledgerIncomplete = await runWorker("recover-ledger-incomplete", root, 0, "recovery-ledger-incomplete");
    assert.equal(ledgerIncomplete.result.status, "RECOVERY_QUARANTINED");
    assert.equal(ledgerIncomplete.result.reason, "INCOMPLETE_LEDGER_READ");
    const afterLedgerIncomplete = await runWorker("inspect", root);
    assert.deepEqual(afterLedgerIncomplete.snapshot, before.snapshot);
    assert.equal(afterLedgerIncomplete.tombstone.status, "NOT_FOUND");
    assert.deepEqual(afterLedgerIncomplete.history.events, before.history.events);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("T57.6: an already committed boundary is recovered, never terminally aborted", async () => {
  const root = await mkdtemp(join(tmpdir(), "9router-t57-boundary-committed-"));
  try {
    await seedIntent(root);
    const committed = await runWorker("seed-boundary", root);
    assert.equal(committed.result.status, "PERMIT");
    const recovery = await runWorker("recover", root, 0, "recovery-committed");
    assert.equal(recovery.result.status, "BOUNDARY_COMMITTED");
    assert.deepEqual(recovery.result.receipt, committed.result.receipt);
    assert.equal(recovery.snapshot.tombstones, 0);
    assert.equal(recovery.snapshot.permits, 1);
    assert.equal(recovery.snapshot.boundaries, 1);
    assert.equal(recovery.history.events.filter(event => event.event_type === "ORPHAN_INTENT_ABORTED").length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("T57.7: the final tombstone and ledger disposition remain singular after a second independent reopen", async () => {
  const root = await mkdtemp(join(tmpdir(), "9router-t57-final-reopen-"));
  try {
    await seedIntent(root);
    const committed = await runWorker("recover", root, 0, "recovery-first");
    assert.equal(committed.result.status, "ABORTED_ORPHAN");
    const initialEvent = committed.result.terminal_event;
    const initialWatermark = committed.result.ledger_watermark;

    const reopened = await runWorker("inspect", root);
    assert.equal(reopened.tombstone.status, "ACK");
    assert.equal(reopened.history.events.filter(event => event.event_type === "INTENT").length, 1);
    const terminalEvents = reopened.history.events.filter(event => event.event_type === "ORPHAN_INTENT_ABORTED");
    assert.equal(terminalEvents.length, 1);
    assert.equal(terminalEvents[0].event_id, initialEvent.event_id);
    assert.equal(terminalEvents[0].payload_digest, initialEvent.payload_digest);
    assert.equal(reopened.history.watermark, initialWatermark);
    assert.equal(reopened.snapshot.tombstones, 1);
    assert.equal(reopened.snapshot.permits, 0);
    assert.equal(reopened.snapshot.boundaries, 0);

    const repeated = await runWorker("recover", root, 1, "recovery-after-reopen");
    assert.equal(repeated.result.status, "ABORTED_ORPHAN");
    assert.equal(repeated.result.terminal_event.event_id, initialEvent.event_id);
    assert.equal(repeated.result.ledger_watermark, initialWatermark);
    assert.equal(repeated.snapshot.tombstones, 1);
    assert.equal(repeated.snapshot.reservation_events, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("T57.8: independent attempt-start and orphan-abort transactions serialize to exactly one terminal outcome", async () => {
  const root = await mkdtemp(join(tmpdir(), "9router-t57-start-abort-race-"));
  try {
    await seedIntent(root);
    const [begin, recovery] = await Promise.all([
      runWorker("seed-boundary", root),
      runWorker("recover", root, 0, "recovery-racer"),
    ]);
    const final = await runWorker("inspect", root);
    const terminalCount = final.history.events.filter(event => event.event_type === "ORPHAN_INTENT_ABORTED").length;

    if (begin.result.status === "PERMIT") {
      assert.equal(recovery.result.status, "BOUNDARY_COMMITTED");
      assert.deepEqual(recovery.result.receipt, begin.result.receipt);
      assert.equal(final.snapshot.boundaries, 1);
      assert.equal(final.snapshot.permits, 1);
      assert.equal(final.snapshot.tombstones, 0);
      assert.equal(terminalCount, 0);
    } else {
      assert.equal(recovery.result.status, "ABORTED_ORPHAN");
      assert.equal(begin.result.status, "ORPHAN_ABORTED");
      assert.equal(final.snapshot.boundaries, 0);
      assert.equal(final.snapshot.permits, 0);
      assert.equal(final.snapshot.tombstones, 1);
      assert.equal(terminalCount, 1);
    }
    assert.equal(final.snapshot.external_effects, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
