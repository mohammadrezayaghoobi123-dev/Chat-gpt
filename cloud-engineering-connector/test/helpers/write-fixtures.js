export function createWriteControlBinding() {
  const operations = new Map();
  const events = [];
  const copy = (value) => value ? structuredClone(value) : value;
  const stub = {
    async markStaleOperationsUnknown() {
      events.push({ type: "mark-stale" });
      return 0;
    },
    async admitWrite({ keyHash, requestHash }) {
      const existing = operations.get(keyHash);
      if (existing) {
        if (existing.requestHash !== requestHash) {
          return { admitted: false, reason: "IDEMPOTENCY_CONFLICT" };
        }
        return { admitted: true, replay: true, operation: copy(existing) };
      }
      const now = Date.now();
      const operation = {
        keyHash, requestHash, status: "IN_PROGRESS", phase: "RESERVED",
        createdAt: now, updatedAt: now, leaseGeneration: 1,
        branchName: null, commitSha: null, prNumber: null, prUrl: null,
        errorCode: null, gitMetadata: {},
      };
      operations.set(keyHash, operation);
      events.push({ type: "admit", keyHash });
      return { admitted: true, replay: false, operation: copy(operation) };
    },
    async transitionOperation(input) {
      const operation = operations.get(input.keyHash);
      if (!operation) return { updated: false, reason: "NOT_FOUND" };
      if (operation.leaseGeneration !== input.leaseGeneration) {
        return { updated: false, reason: "LEASE_FENCE_MISMATCH", operation: copy(operation) };
      }
      if (operation.phase !== input.expectedPhase || operation.status !== "IN_PROGRESS") {
        return { updated: false, reason: "PHASE_CONFLICT", operation: copy(operation) };
      }
      operation.phase = input.nextPhase;
      operation.status = input.status ?? "IN_PROGRESS";
      operation.updatedAt = Date.now();
      const metadata = input.metadata ?? {};
      for (const field of ["branchName", "commitSha", "prNumber", "prUrl", "errorCode"]) {
        if (metadata[field] !== undefined) operation[field] = metadata[field];
      }
      for (const [field, value] of Object.entries(metadata)) {
        if (!["branchName", "commitSha", "prNumber", "prUrl", "errorCode"].includes(field)) {
          operation.gitMetadata[field] = value;
        }
      }
      events.push({ type: "transition", phase: operation.phase, status: operation.status });
      return { updated: true, operation: copy(operation) };
    },
    async markOperationStatus(input) {
      const operation = operations.get(input.keyHash);
      if (!operation) return { updated: false, reason: "NOT_FOUND" };
      if (operation.leaseGeneration !== input.leaseGeneration || operation.status !== "IN_PROGRESS") {
        return { updated: false, reason: "STATUS_CONFLICT", operation: copy(operation) };
      }
      operation.status = input.status;
      operation.errorCode = input.errorCode ?? null;
      operation.updatedAt = Date.now();
      operation.leaseGeneration += 1;
      events.push({ type: "mark-status", status: operation.status, phase: operation.phase });
      return { updated: true, operation: copy(operation) };
    },
    async getOperation(keyHash) {
      return copy(operations.get(keyHash) ?? null);
    },
    async reconcilePrCreated() {
      return { updated: false, reason: "RECONCILIATION_NOT_ALLOWED" };
    },
    async reopenReserved() {
      return { updated: false, reason: "RECONCILIATION_NOT_ALLOWED" };
    },
    async reconcileTreeWritten() {
      return { updated: false, reason: "RECONCILIATION_NOT_ALLOWED" };
    },
    async reconcileCommitWritten() {
      return { updated: false, reason: "RECONCILIATION_NOT_ALLOWED" };
    },
    async reconcileBranchWritten() {
      return { updated: false, reason: "RECONCILIATION_NOT_ALLOWED" };
    },
  };
  return {
    idFromName: () => "test-write-control",
    get: () => stub,
    __test: { events, operations },
  };
}

export function createGitHubWriteMock({
  filePath,
  blobSha,
  prMode = "success",
} = {}) {
  const calls = [];
  let commitPayload;
  let branchName;
  let pullBody;
  let pullRequest;
  const repositoryPath = "/repos/mohammadrezayaghoobi123-dev/Chat-gpt";
  const baseBranch = "feature/cloud-engineering-connector";
  const response = (body, status = 200) =>
    new Response(body === null ? null : JSON.stringify(body), { status });

  const fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    calls.push({ method, url: url.href, body: init.body });

    if (method === "GET" && url.pathname === repositoryPath) {
      return response({ full_name: "mohammadrezayaghoobi123-dev/Chat-gpt" });
    }
    if (method === "GET" && url.pathname === repositoryPath + "/git/ref/heads/" + baseBranch) {
      return response({ ref: "refs/heads/" + baseBranch, object: { sha: "base-sha" } });
    }
    if (method === "GET" && url.pathname === repositoryPath + "/git/commits/base-sha") {
      return response({ sha: "base-sha", tree: { sha: "base-tree" } });
    }
    if (method === "POST" && url.pathname === repositoryPath + "/git/trees") {
      return response({ sha: "new-tree" }, 201);
    }
    if (method === "GET" && url.pathname === repositoryPath + "/git/trees/new-tree") {
      return response({
        sha: "new-tree",
        truncated: false,
        tree: [{ path: filePath, type: "blob", mode: "100644", sha: blobSha }],
      });
    }
    if (method === "POST" && url.pathname === repositoryPath + "/git/commits") {
      commitPayload = JSON.parse(init.body);
      return response({ sha: "new-commit" }, 201);
    }
    if (method === "GET" && url.pathname === repositoryPath + "/git/commits/new-commit") {
      return response({
        sha: "new-commit",
        message: commitPayload.message,
        tree: { sha: commitPayload.tree },
        parents: commitPayload.parents.map((sha) => ({ sha })),
        author: commitPayload.author,
        committer: commitPayload.committer,
      });
    }
    if (method === "POST" && url.pathname === repositoryPath + "/git/refs") {
      const body = JSON.parse(init.body);
      branchName = body.ref.replace(/^refs\/heads\//, "");
      return response({ ref: body.ref, object: { sha: body.sha } }, 201);
    }
    if (method === "GET" && branchName &&
        url.pathname === repositoryPath + "/git/ref/heads/" + branchName) {
      return response({
        ref: "refs/heads/" + branchName,
        object: { sha: "new-commit" },
      });
    }
    if (method === "POST" && url.pathname === repositoryPath + "/pulls") {
      pullBody = JSON.parse(init.body);
      if (prMode === "reject") {
        return response({ message: "simulated PR validation failure" }, 422);
      }
      if (prMode === "timeout") {
        throw new TypeError("simulated network timeout after request dispatch");
      }
      pullRequest = {
        number: 1,
        html_url: "https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/pull/1",
        draft: true,
        state: "open",
        head: { ref: branchName, sha: "new-commit" },
        base: { ref: baseBranch },
        body: pullBody.body,
      };
      return response(pullRequest, 201);
    }
    if (method === "GET" && url.pathname === repositoryPath + "/pulls/1" && pullRequest) {
      return response(pullRequest);
    }
    throw new Error("Unexpected mocked GitHub request: " + method + " " + url.pathname);
  };

  return { fetch, calls, getPullBody: () => pullBody };
}
