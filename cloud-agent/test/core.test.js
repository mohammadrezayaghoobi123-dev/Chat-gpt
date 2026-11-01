import test from "node:test";
import assert from "node:assert/strict";
import {
  boundedHistory,
  decodeGitHubBase64Text,
  createSerialExecutor,
  buildGitHubContentsApiUrl,
  extractAssistantText,
  isAuthorized,
  isSafeRef,
  isSafeRepoPath,
  isSessionId,
  isSessionExpired,
  SESSION_TTL_MS,
  parseToolArguments,
  readTextBounded,
  recordSessionActivity,
  validateToolCalls
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
  assert.equal(isSafeRepoPath("config/prod-secrets.yml"), false);
  assert.equal(isSafeRepoPath("config/api-token.json"), false);
  assert.equal(isSafeRepoPath("deployment/private-key.backup"), false);
  assert.equal(isSafeRepoPath("deploy/service-account.json"), false);
  assert.equal(isSafeRepoPath("config/firebase-adminsdk-prod.json"), false);
  assert.equal(isSafeRepoPath("ops/kubeconfig"), false);
  assert.equal(isSafeRepoPath(".npmrc"), false);
  assert.equal(isSafeRepoPath(".git-credentials"), false);
  assert.equal(isSafeRepoPath("terraform/prod.tfstate"), false);
  assert.equal(isSafeRepoPath("certs/client.crt"), false);
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
  await assert.rejects(readTextBounded(new Response(Uint8Array.from([0xc3, 0x28])).body, null, 2), /valid UTF-8/);
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

test("encodes slash-containing branch refs in the GitHub Contents API query, not the URL path", () => {
  assert.equal(
    buildGitHubContentsApiUrl(
      "mohammadrezayaghoobi123-dev",
      "Chat-gpt",
      "cloud-agent/src/worker.js",
      "feature/independent-cloud-agent"
    ),
    "https://api.github.com/repos/mohammadrezayaghoobi123-dev/Chat-gpt/contents/cloud-agent/src/worker.js?ref=feature%2Findependent-cloud-agent"
  );
});

test("decodes bounded UTF-8 GitHub base64 content and rejects malformed or oversized data", () => {
  const bytes = new TextEncoder().encode("café");
  const encoded = btoa(String.fromCharCode(...bytes));
  assert.equal(decodeGitHubBase64Text(encoded, 5), "café");
  assert.equal(decodeGitHubBase64Text(encoded.slice(0, 4) + "\n" + encoded.slice(4), 5), "café");
  assert.throws(() => decodeGitHubBase64Text(encoded, 4), /File exceeds/);
  assert.throws(() => decodeGitHubBase64Text("not base64!", 100), /invalid base64/i);
});

test("serial executor preserves per-session request order across awaited work", async () => {
  const execute = createSerialExecutor();
  const events = [];
  let releaseFirst;
  let active = 0;
  let maxActive = 0;

  const first = execute(async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    events.push("first:start");
    await new Promise(resolve => { releaseFirst = resolve; });
    events.push("first:end");
    active -= 1;
    return "first";
  });

  const second = execute(async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    events.push("second:start");
    active -= 1;
    events.push("second:end");
    return "second";
  });

  await Promise.resolve();
  assert.deepEqual(events, ["first:start"]);
  releaseFirst();
  assert.deepEqual(await Promise.all([first, second]), ["first", "second"]);
  assert.deepEqual(events, ["first:start", "first:end", "second:start", "second:end"]);
  assert.equal(maxActive, 1);
});

test("serial executor continues after a failed request", async () => {
  const execute = createSerialExecutor();
  await assert.rejects(execute(async () => { throw new Error("expected failure"); }), /expected failure/);
  assert.equal(await execute(async () => "next request"), "next request");
});

test("serial executor rejects excess queued work instead of growing without bound", async () => {
  const execute = createSerialExecutor(1);
  let releaseFirst;
  let secondRan = false;
  const first = execute(() => new Promise(resolve => { releaseFirst = resolve; }));
  await Promise.resolve();
  const second = execute(async () => {
    secondRan = true;
    return "must not run";
  });
  const outcome = await Promise.race([
    second.then(() => "ran", error => error?.code),
    new Promise(resolve => setImmediate(() => resolve("still-queued")))
  ]);
  releaseFirst("first");
  await Promise.allSettled([first, second]);
  assert.equal(outcome, "SESSION_QUEUE_FULL");
  assert.equal(secondRan, false);
});

test("session history expires after seven inactive days and when no timestamp exists", () => {
  const now = 2_000_000_000_000;
  assert.equal(SESSION_TTL_MS, 7 * 24 * 60 * 60 * 1000);
  assert.equal(isSessionExpired(now - SESSION_TTL_MS + 1, now), false);
  assert.equal(isSessionExpired(now - SESSION_TTL_MS, now), true);
  assert.equal(isSessionExpired(undefined, now), true);
});

test("accepted session activity refreshes the expiry timestamp before body processing", () => {
  const now = 2_000_000_000_000;
  assert.deepEqual(recordSessionActivity([], now), {
    allowed: true,
    activeRequests: [now],
    lastActivity: now
  });
});

test("session rate window discards expired entries and rejects the ninth request", () => {
  const now = 2_000_000_000_000;
  const sevenRecent = Array.from({ length: 7 }, (_, index) => now - index * 1_000);
  const allowed = recordSessionActivity([...sevenRecent, now - 60_001], now);
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.activeRequests.length, 8);
  const blocked = recordSessionActivity(allowed.activeRequests, now + 1);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.activeRequests.length, 8);
});

test("validates model tool-call envelopes before execution", () => {
  const valid = {
    id: "call_123-abc",
    type: "function",
    function: { name: "read_project_file", arguments: "{\"path\":\"README.md\"}" }
  };
  assert.deepEqual(validateToolCall(valid), valid);
  assert.throws(() => validateToolCall({ ...valid, id: "bad id" }), /identifier/);
  assert.throws(() => validateToolCalls([{ ...valid, type: "other" }], 1), /Malformed/);
  assert.throws(() => validateToolCalls([{ ...valid, function: { ...valid.function, name: "run_shell" } }], 1), /Unknown/);
  assert.throws(() => validateToolCalls([{ ...valid, function: { ...valid.function, arguments: "x".repeat(4097) } }], 1), /oversized/);
  assert.throws(() => validateToolCalls([valid, valid], 2), /Duplicate/);
  assert.throws(() => validateToolCalls([valid], 0), /excessive/);
});
