export function createWriteControlBinding() {
  const operations = new Map();
  const events = [];
  let backlogFull = false;
  const storageStats = () => ({ unknownCount: backlogFull ? 1000 : 0, inProgressCount: 0, terminalCount: 0, unresolvedCount: backlogFull ? 1000 : 0, unresolvedLimit: 1000, unresolvedRemaining: backlogFull ? 0 : 1000, oldestUnresolvedUpdatedAt: null, operationCount: operations.size, admissionCount: operations.size, operationLogicalBytes: 4096, admissionLogicalBytes: 256, logicalPayloadBytes: 4352, logicalPayloadUtilization: 4352 / 1073741824, storageLimitBytes: 1073741824, retentionMs: 2592000000 });
  const stub = {
    async ping() { events.push({ type: "ping" }); return { ok: true, schemaVersion: 1 }; },
    async getAdmissionStats() { events.push({ type: "get-admission-stats" }); const stats = storageStats(); return { unknownCount: stats.unknownCount, inProgressCount: 0, unresolvedCount: stats.unresolvedCount, retentionMs: stats.retentionMs }; },
    async admitWrite(input) {
      if (backlogFull) return { admitted: false, reason: "UNKNOWN_BACKLOG_FULL", storageStats: storageStats() };
      const current = operations.get(input.keyHash);
      if (current) {
        if (current.requestHash !== input.requestHash) return { admitted: false, reason: "IDEMPOTENCY_CONFLICT" };
        return { admitted: true, replay: true, operation: { ...current, gitMetadata: { ...current.gitMetadata } }, storageStats: storageStats() };
      }
      const operation = {
        keyHash: input.keyHash, requestHash: input.requestHash, status: "IN_PROGRESS",
        phase: "RESERVED", leaseGeneration: 1, createdAt: input.now, updatedAt: input.now,
        gitMetadata: {}
      };
      operations.set(input.keyHash, operation);
      events.push({ type: "admit", keyHash: input.keyHash });
      return { admitted: true, replay: false, operation: { ...operation, gitMetadata: {} }, storageStats: storageStats() };
    },
    async transitionOperation(input) {
      const op = operations.get(input.keyHash);
      if (!op || op.status !== "IN_PROGRESS" || op.phase !== input.expectedPhase ||
          op.leaseGeneration !== input.leaseGeneration) {
        return { updated: false, reason: "PHASE_CONFLICT", operation: op ? { ...op } : null };
      }
      op.phase = input.nextPhase;
      op.status = input.status ?? "IN_PROGRESS";
      op.updatedAt = input.now ?? Date.now();
      for (const [key, value] of Object.entries(input.metadata ?? {})) {
        if (["baseTreeSha", "parentSha", "treeSha", "commitDate", "commitMessage", "authorName", "authorEmail", "committerName", "committerEmail"].includes(key)) {
          op.gitMetadata[key] = value;
        } else {
          op[key] = value;
        }
      }
      events.push({ type: "transition", phase: op.phase, status: op.status });
      return { updated: true, operation: { ...op, gitMetadata: { ...op.gitMetadata } } };
    },
    async markOperationStatus(input) {
      const op = operations.get(input.keyHash);
      if (!op || op.status !== "IN_PROGRESS" || op.leaseGeneration !== input.leaseGeneration) {
        return { updated: false, reason: "STATUS_CONFLICT", operation: op ? { ...op } : null };
      }
      op.status = input.status;
      op.updatedAt = input.now ?? Date.now();
      op.errorCode = input.errorCode ?? null;
      op.leaseGeneration += 1;
      events.push({ type: "mark-status", status: input.status, phase: op.phase });
      return { updated: true, operation: { ...op, gitMetadata: { ...op.gitMetadata } } };
    },
    async markStaleOperationsUnknown() { return 0; },
    async getStorageStats() { return storageStats(); },
    async getOperation(keyHash) {
      const op = operations.get(keyHash);
      return op ? { ...op, gitMetadata: { ...op.gitMetadata } } : null;
    },
    async reconcilePrCreated(input) {
      const op = operations.get(input.keyHash);
      if (!op || op.status !== "UNKNOWN" || op.phase !== "PR_DISPATCHED") return { updated: false, operation: op ? { ...op } : null };
      Object.assign(op, { status: "SUCCEEDED", phase: "PR_CREATED", prNumber: input.prNumber, prUrl: input.prUrl, updatedAt: input.now ?? Date.now(), leaseGeneration: op.leaseGeneration + 1 });
      events.push({ type: "reconcile-pr-created" });
      return { updated: true, operation: { ...op } };
    },
    async reopenReserved(input) {
      const op = operations.get(input.keyHash);
      if (!op || op.status !== "UNKNOWN" || op.phase !== "RESERVED" || op.leaseGeneration !== input.leaseGeneration) return { updated: false };
      op.status = "IN_PROGRESS"; op.updatedAt = Date.now(); op.leaseGeneration += 1;
      return { updated: true, operation: { ...op } };
    },
    async reconcileTreeWritten() { return { updated: false }; },
    async reconcileCommitWritten() { return { updated: false }; },
    async reconcileBranchWritten() { return { updated: false }; }
  };
  return { idFromName: name => name, get: () => stub, __test: { events, operations, setBacklogFull(value) { backlogFull = Boolean(value); } } };
}

export function createGitHubWriteMock({ filePath, blobSha, prMode = "success" }) {
  const calls = [];
  const parentSha = "a".repeat(40);
  const baseTreeSha = "b".repeat(40);
  const treeSha = "c".repeat(40);
  const commitSha = "d".repeat(40);
  let commitPayload = null;
  let branchName = null;
  let createdPr = null;
  let deleteAttempted = false;

  const json = (body, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json" }
  });

  async function fetch(input, init = {}) {
    const url = String(input);
    const method = init.method ?? "GET";
    calls.push({ url, method, body: init.body });
    const path = new URL(url).pathname;

    if (path.endsWith("/repos/mohammadrezayaghoobi123-dev/Chat-gpt")) {
      return json({ full_name: "mohammadrezayaghoobi123-dev/Chat-gpt", default_branch: "main" });
    }
    if (path.endsWith("/git/ref/heads/feature/cloud-engineering-connector")) {
      return json({ ref: "refs/heads/feature/cloud-engineering-connector", object: { sha: parentSha } });
    }
    if (path.endsWith("/git/commits/" + parentSha)) {
      return json({ sha: parentSha, tree: { sha: baseTreeSha } });
    }
    if (path.endsWith("/git/trees") && method === "POST") {
      return json({ sha: treeSha }, 201);
    }
    if (path.endsWith("/git/trees/" + treeSha) && url.includes("?recursive=1")) {
      return json({ sha: treeSha, truncated: false, tree: [{ path: filePath, mode: "100644", type: "blob", sha: blobSha }] });
    }
    if (path.endsWith("/git/commits") && method === "POST") {
      commitPayload = JSON.parse(init.body);
      return json({ sha: commitSha }, 201);
    }
    if (path.endsWith("/git/commits/" + commitSha)) {
      return json({
        sha: commitSha, message: commitPayload.message, tree: { sha: treeSha },
        parents: [{ sha: parentSha }], author: commitPayload.author, committer: commitPayload.committer
      });
    }
    if (path.endsWith("/git/refs") && method === "POST") {
      const body = JSON.parse(init.body);
      branchName = body.ref.replace(/^refs\/heads\//, "");
      return json({ ref: body.ref, object: { sha: commitSha } }, 201);
    }
    if (branchName && path.endsWith("/git/ref/heads/" + branchName)) {
      return json({ ref: "refs/heads/" + branchName, object: { sha: commitSha } });
    }
    if (path.endsWith("/pulls") && method === "POST") {
      if (prMode === "reject") return json({ message: "simulated PR validation failure" }, 422);
      if (prMode === "timeout") throw new Error("simulated upstream timeout");
      const body = JSON.parse(init.body);
      const number = 987;
      createdPr = {
        number, html_url: "https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/pull/" + number,
        draft: true, state: "open",
        head: { ref: body.head, sha: commitSha },
        base: { ref: body.base },
        body: body.body
      };
      return json(createdPr, 201);
    }
    if (createdPr && path.endsWith("/pulls/" + createdPr.number)) return json(createdPr);
    if (path.includes("/git/refs/heads/") && method === "DELETE") {
      deleteAttempted = true;
      return json({});
    }
    return json({ message: "unhandled mock route: " + method + " " + path }, 404);
  }

  return { fetch, calls, get deleteAttempted() { return deleteAttempted; } };
}
