import test from "node:test";
import assert from "node:assert/strict";
import {
  boundedHistory,
  extractAssistantText,
  isAuthorized,
  isSafeRef,
  isSafeRepoPath,
  isSessionId,
  parseToolArguments,
  readTextBounded
} from "../src/core.js";

test("accepts UUID session identifiers and rejects path-like identifiers", () => {
  assert.equal(isSessionId("550e8400-e29b-41d4-a716-446655440000"), true);
  assert.equal(isSessionId("../../main"), false);
  assert.equal(isSessionId("not-a-uuid"), false);
});

test("accepts ordinary refs and rejects traversal refs", () => {
  assert.equal(isSafeRef("master-brain/integrated"), true);
  assert.equal(isSafeRef("feature/cloud-engineering-connector"), true);
  assert.equal(isSafeRef("../main"), false);
  assert.equal(isSafeRef("main//secret"), false);
});

test("allows ordinary source paths and blocks credential or traversal paths", () => {
  assert.equal(isSafeRepoPath("src/master_brain/serve.py"), true);
  assert.equal(isSafeRepoPath("cloud-engineering-connector/worker.js"), true);
  assert.equal(isSafeRepoPath("../../.env"), false);
  assert.equal(isSafeRepoPath(".github/workflows/deploy.yml"), false);
  assert.equal(isSafeRepoPath("secrets/token.txt"), false);
  assert.equal(isSafeRepoPath("C:\\Users\\user\\secret.txt"), false);
});

test("requires an exact bearer token and a sufficiently long configured secret", () => {
  const token = "a".repeat(40);
  assert.equal(isAuthorized("Bearer " + token, token), true);
  assert.equal(isAuthorized(token, token), false);
  assert.equal(isAuthorized("Bearer wrong", token), false);
  assert.equal(isAuthorized("Bearer " + token, "short"), false);
});

test("bounds persisted history to user and assistant messages only", () => {
  const history = [
    { role: "system", content: "must not persist" },
    { role: "tool", content: "tool output" },
    ...Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: String(i) }))
  ];
  const result = boundedHistory(history);
  assert.equal(result.length, 16);
  assert.equal(result[0].content, "4");
  assert.equal(result.at(-1).content, "19");
});

test("rejects malformed or unexpected tool arguments", () => {
  assert.deepEqual(parseToolArguments('{"path":"README.md"}', ["path"]), { path: "README.md" });
  assert.equal(parseToolArguments("not-json", ["path"]), null);
  assert.equal(parseToolArguments('{"path":"README.md","shell":"id"}', ["path"]), null);
  assert.equal(parseToolArguments("[]", ["path"]), null);
});

test("extracts only user-facing text from model message content", () => {
  assert.equal(extractAssistantText({ content: "answer" }), "answer");
  assert.equal(extractAssistantText({ content: [{ type: "text", text: "one" }, { type: "image" }, { type: "text", text: "two" }] }), "one\ntwo");
  assert.equal(extractAssistantText({ content: null, reasoning: "private reasoning" }), "");
});

test("reads a stream within its byte limit", async () => {
  assert.equal(await readTextBounded(new Response("hello").body, null, 5), "hello");
});

test("rejects a declared oversized body before reading it", async () => {
  await assert.rejects(
    readTextBounded(new Response("oversized").body, "9", 8),
    /Body exceeds configured limit/
  );
});

test("rejects an oversized streamed body even when content length is absent or false", async () => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("four"));
      controller.close();
    }
  });
  await assert.rejects(readTextBounded(stream, null, 3), /Body exceeds configured limit/);
  await assert.rejects(readTextBounded(new Response("é").body, "1", 1), /Body exceeds configured limit/);
});
