import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createScheduledWorkerAssertion, verifyWorkerAssertion } from "../orchestrator-worker-identity.js";

const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
const keySet = JSON.stringify({ "worker-v1": key });
const nowMs = 1_800_000_000_000;

test("scheduled signer issues a short-lived publisher assertion bound to one Ledger operation", async () => {
  const token = await createScheduledWorkerAssertion(keySet, "worker-v1", {
    subject: "orchestrator-outbox-publisher",
    role: "publisher",
    operation: "claimOutbox",
    nowMs,
  });
  const verified = await verifyWorkerAssertion(keySet, token, {
    subject: "orchestrator-outbox-publisher",
    role: "publisher",
    operation: "claimOutbox",
    nowMs,
  });
  assert.equal(verified.subject, "orchestrator-outbox-publisher");
  assert.equal(verified.role, "publisher");
  assert.equal(verified.operation, "claimOutbox");
  assert.equal(verified.expiresAt - verified.issuedAt, 60);
});

test("scheduled signer cannot mint agent identities or caller-selected principals", async () => {
  await assert.rejects(
    createScheduledWorkerAssertion(keySet, "worker-v1", {
      subject: "agent:attacker",
      role: "agent",
      operation: "claimTask",
      nowMs,
    }),
    error => error?.code === "AUTHENTICATED_WORKER_REQUIRED",
  );
  await assert.rejects(
    createScheduledWorkerAssertion(keySet, "worker-v1", {
      subject: "orchestrator-executor",
      role: "agent",
      operation: "claimTask",
      nowMs,
    }),
    error => error?.code === "AUTHENTICATED_WORKER_REQUIRED",
  );
  await assert.rejects(
    createScheduledWorkerAssertion(keySet, "worker-v1", {
      subject: "orchestrator-outbox-publisher",
      role: "system",
      operation: "createTask",
      nowMs,
    }),
    error => error?.code === "AUTHENTICATED_WORKER_REQUIRED",
  );
});

test("scheduled signer rejects missing active key, weak key material, and invalid time", async () => {
  await assert.rejects(
    createScheduledWorkerAssertion(keySet, "unknown-kid", {
      subject: "orchestrator-outbox-publisher", role: "publisher", operation: "claimOutbox", nowMs,
    }),
    error => error?.code === "AUTHENTICATED_WORKER_REQUIRED",
  );
  await assert.rejects(
    createScheduledWorkerAssertion(JSON.stringify({ "worker-v1": "abcd" }), "worker-v1", {
      subject: "orchestrator-outbox-publisher", role: "publisher", operation: "claimOutbox", nowMs,
    }),
    error => error?.code === "AUTHENTICATED_WORKER_REQUIRED",
  );
  await assert.rejects(
    createScheduledWorkerAssertion(keySet, "worker-v1", {
      subject: "orchestrator-outbox-publisher", role: "publisher", operation: "claimOutbox", nowMs: 0,
    }),
    error => error?.code === "AUTHENTICATED_WORKER_REQUIRED",
  );
});


test("scheduled signer issues a consumer assertion only for durable receipt recording", async () => {
  const expected = {
    subject: "orchestrator-outbox-consumer",
    role: "consumer",
    operation: "recordOutboxReceipt",
    nowMs,
  };
  const token = await createScheduledWorkerAssertion(keySet, "worker-v1", expected);
  const verified = await verifyWorkerAssertion(keySet, token, expected);
  assert.equal(verified.subject, expected.subject);
  assert.equal(verified.role, "consumer");
  assert.equal(verified.operation, "recordOutboxReceipt");
  await assert.rejects(
    createScheduledWorkerAssertion(keySet, "worker-v1", {
      ...expected,
      operation: "claimTask",
    }),
    error => error?.code === "AUTHENTICATED_WORKER_REQUIRED",
  );
});


test("scheduled signer authorizes only the dedicated DLQ archiver principal and operation", async () => {
  const expected = {
    subject: "orchestrator-outbox-dlq-archiver",
    role: "consumer",
    operation: "recordOutboxDeadLetter",
    nowMs,
  };
  const token = await createScheduledWorkerAssertion(keySet, "worker-v1", expected);
  const verified = await verifyWorkerAssertion(keySet, token, expected);
  assert.equal(verified.subject, expected.subject);
  assert.equal(verified.role, "consumer");
  assert.equal(verified.operation, "recordOutboxDeadLetter");
  await assert.rejects(
    createScheduledWorkerAssertion(keySet, "worker-v1", {
      ...expected,
      operation: "recordOutboxReceipt",
    }),
    error => error?.code === "AUTHENTICATED_WORKER_REQUIRED",
  );
});


test("legacy HMAC signer refuses to mint Executor assertions", async () => {
  const { createExecutorWorkerAssertion } = await import("../orchestrator-worker-identity.js");
  assert.equal(typeof createExecutorWorkerAssertion, "function");
  await assert.rejects(
    createExecutorWorkerAssertion(keySet, "worker-v1", {
      operation: "claimTask",
      nowMs,
      subject: "attacker-selected-principal",
      role: "system",
    }),
    error => error?.code === "AUTHENTICATED_WORKER_REQUIRED",
  );
});

const connectorRoot = fileURLToPath(new URL("../", import.meta.url));
const excludedProductionScanDirectories = new Set([".git", ".wrangler", "cloudflare-test", "node_modules", "test"]);

async function collectProductionJavaScriptFiles(directory = connectorRoot) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!excludedProductionScanDirectories.has(entry.name)) {
        files.push(...await collectProductionJavaScriptFiles(join(directory, entry.name)));
      }
      continue;
    }
    if (entry.isFile() && /\\.(?:cjs|js|mjs)$/.test(entry.name)) {
      files.push(relative(connectorRoot, join(directory, entry.name)).replaceAll("\\\\", "/"));
    }
  }
  return files.sort();
}

test("production source keeps the dormant Scheduler createTask grant free of runtime mint call sites", async () => {
  const files = await collectProductionJavaScriptFiles();
  const sources = await Promise.all(files.map(async path => ({
    path,
    source: await readFile(join(connectorRoot, path), "utf8"),
  })));
  const signerReferences = sources
    .filter(({ source }) => source.includes("createScheduledWorkerAssertion"))
    .map(({ path }) => path);

  assert.deepEqual(
    signerReferences,
    ["orchestrator-worker-identity.js", "worker.js"],
    "Only the signer implementation and the reviewed Worker entrypoint may reference the internal signer.",
  );

  const workerSource = sources.find(({ path }) => path === "worker.js")?.source;
  assert.ok(workerSource, "The production Worker source must be present in the scanned runtime.");
  const signerCalls = workerSource.match(/\\bcreateScheduledWorkerAssertion\\s*\\(/g) ?? [];

  assert.equal(
    signerCalls.length,
    3,
    "Only the publisher, receipt consumer, and DLQ archiver may mint internal Worker assertions in the current runtime.",
  );
  assert.doesNotMatch(
    workerSource,
    /orchestrator-scheduler/,
    "The dormant Scheduler createTask grant must not acquire a Worker runtime caller without a separately reviewed Scheduler contract.",
  );
  assert.match(workerSource, /const workerId = "orchestrator-outbox-publisher"/);
  assert.match(workerSource, /const consumerId = "orchestrator-outbox-consumer"/);
  assert.match(workerSource, /const archiverId = "orchestrator-outbox-dlq-archiver"/);
});
