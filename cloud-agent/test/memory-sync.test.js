import test from "node:test";
import assert from "node:assert/strict";

const { validateMemoryRecord, mergeMemoryRecords, MEMORY_LIMITS } = await import("../src/memory-sync.js");

const NOW = 1_800_000_000_000;
const rec = (over = {}) => ({ id: "decision-0001", kind: "decision", text: "Use a single repository for the MVP.", source: "openclaw", created_at: NOW - 5_000, updated_at: NOW - 1_000, ...over });

test("a well-formed record is accepted unchanged", () => {
  assert.deepEqual(validateMemoryRecord(rec(), NOW), { ok: true, record: rec() });
});

test("every field is validated and failures carry a reason code, never the offending text", () => {
  const cases = {
    "not-an-object": [null, "x", 3, [], undefined],
    "unknown-field": [rec({ extra: 1 }), rec({ "__proto__x": 1 })],
    "bad-id": [rec({ id: "x" }), rec({ id: "A".repeat(10) }), rec({ id: "has space 123" }), rec({ id: "a".repeat(65) }), rec({ id: "../etc/passwd1" })],
    "bad-kind": [rec({ kind: "secret" }), rec({ kind: undefined })],
    "bad-source": [rec({ source: "web" }), rec({ source: undefined })],
    "bad-text": [rec({ text: "" }), rec({ text: "a".repeat(MEMORY_LIMITS.maxTextChars + 1) }), rec({ text: 5 }), rec({ text: "line\u0000nul" }), rec({ text: "esc\u001b[31m" })],
    "bad-time": [rec({ created_at: -1 }), rec({ created_at: 1.5 }), rec({ updated_at: NOW - 10_000 }), rec({ updated_at: NOW + MEMORY_LIMITS.maxClockSkewMs + 1 }), rec({ created_at: "1" })],
    "bad-deleted": [rec({ deleted: "yes" }), rec({ deleted: false, text: "" })]
  };
  for (const [code, inputs] of Object.entries(cases)) {
    for (const input of inputs) {
      const result = validateMemoryRecord(input, NOW);
      assert.equal(result.ok, false, code + ": " + JSON.stringify(input));
      assert.equal(result.reason, code, JSON.stringify(input));
      assert.deepEqual(Object.keys(result).sort(), ["ok", "reason"], "result must not echo input");
    }
  }
});

test("text that looks like a credential is rejected (secrets must never be synchronised)", () => {
  const secretLike = [
    "token is Bearer abcdefghijklmnopqrstuvwxyz0123456789",
    "key sk-" + "a".repeat(32),
    "ghp_" + "A1b2C3d4E5".repeat(4),
    "AKIA" + "ABCDEFGHIJKLMNOP",
    "-----BEGIN PRIVATE KEY-----",
    "hex " + "0123456789abcdef".repeat(4),
    "b64 " + "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo".repeat(2),
    "authorization: basic dXNlcjpwYXNz",
    "api_key = 'abcd1234efgh5678'"
  ];
  for (const text of secretLike) assert.deepEqual(validateMemoryRecord(rec({ text }), NOW), { ok: false, reason: "secret-like-content" }, text);
  assert.equal(validateMemoryRecord(rec({ text: "Commit 4f2a9c1 fixed the retry bug; see PR 192." }), NOW).ok, true);
});

test("a tombstone is a deleted record with empty text", () => {
  assert.equal(validateMemoryRecord(rec({ deleted: true, text: "" }), NOW).ok, true);
  assert.equal(validateMemoryRecord(rec({ deleted: true, text: "still here" }), NOW).reason, "bad-deleted");
});

test("merge: the newer update wins, regardless of argument order", () => {
  const older = rec({ text: "old", updated_at: NOW - 2_000 });
  const newer = rec({ text: "new", updated_at: NOW - 500, source: "cloud-agent" });
  for (const [a, b] of [[[older], [newer]], [[newer], [older]]]) {
    const { records } = mergeMemoryRecords(a, b, NOW);
    assert.equal(records.length, 1);
    assert.equal(records[0].text, "new");
  }
});

test("merge is commutative, idempotent and associative (convergence)", () => {
  const A = [rec({ id: "aaaaaaaa-1", text: "a1", updated_at: NOW - 900 }), rec({ id: "bbbbbbbb-1", text: "b1", updated_at: NOW - 800 })];
  const B = [rec({ id: "aaaaaaaa-1", text: "a2", updated_at: NOW - 700, source: "cloud-agent" }), rec({ id: "cccccccc-1", text: "c1", updated_at: NOW - 600 })];
  const C = [rec({ id: "bbbbbbbb-1", deleted: true, text: "", updated_at: NOW - 500 })];
  const m = (x, y) => mergeMemoryRecords(x, y, NOW).records;
  assert.deepEqual(m(A, B), m(B, A));
  assert.deepEqual(m(m(A, B), m(A, B)), m(A, B));
  assert.deepEqual(m(m(A, B), C), m(A, m(B, C)));
  assert.deepEqual(m(m(A, B), C), m(C, m(B, A)));
});

test("merge: equal timestamps resolve deterministically (tombstone first, then source name)", () => {
  const live = rec({ updated_at: NOW - 100, text: "live" });
  const dead = rec({ updated_at: NOW - 100, deleted: true, text: "" });
  assert.equal(mergeMemoryRecords([live], [dead], NOW).records[0].deleted, true);
  assert.equal(mergeMemoryRecords([dead], [live], NOW).records[0].deleted, true);
  const x = rec({ updated_at: NOW - 100, text: "from openclaw", source: "openclaw" });
  const y = rec({ updated_at: NOW - 100, text: "from cloud", source: "cloud-agent" });
  assert.deepEqual(mergeMemoryRecords([x], [y], NOW).records, mergeMemoryRecords([y], [x], NOW).records);
});

test("merge: invalid incoming records are rejected individually, valid ones still apply, local state is never lost", () => {
  const local = [rec({ id: "keepkeep-1", text: "keep me" })];
  const incoming = [rec({ id: "goodgood-1", text: "good" }), rec({ id: "badbad-1", text: "token Bearer abcdefghijklmnopqrstuvwxyz0123456789" }), "garbage"];
  const out = mergeMemoryRecords(local, incoming, NOW);
  assert.deepEqual(out.records.map(r => r.id).sort(), ["goodgood-1", "keepkeep-1"]);
  assert.deepEqual(out.rejected, [{ index: 1, reason: "secret-like-content" }, { index: 2, reason: "not-an-object" }]);
});

test("merge enforces batch and store size limits and does not mutate its inputs", () => {
  const many = n => Array.from({ length: n }, (_, i) => rec({ id: "bulk-" + String(i).padStart(6, "0"), text: "t" + i }));
  assert.throws(() => mergeMemoryRecords([], many(MEMORY_LIMITS.maxBatch + 1), NOW), RangeError);
  const full = many(MEMORY_LIMITS.maxStored);
  assert.throws(() => mergeMemoryRecords(full, [rec({ id: "overflow-1" })], NOW), RangeError);
  const local = [rec()]; const snapshot = JSON.stringify(local); const incoming = [rec({ text: "changed", updated_at: NOW - 10 })]; const snap2 = JSON.stringify(incoming);
  mergeMemoryRecords(local, incoming, NOW);
  assert.equal(JSON.stringify(local), snapshot);
  assert.equal(JSON.stringify(incoming), snap2);
});

test("merge output is sorted by id so every replica serialises identically", () => {
  const { records } = mergeMemoryRecords([rec({ id: "zzzzzzzz-1" })], [rec({ id: "aaaaaaaa-1" })], NOW);
  assert.deepEqual(records.map(r => r.id), ["aaaaaaaa-1", "zzzzzzzz-1"]);
});
