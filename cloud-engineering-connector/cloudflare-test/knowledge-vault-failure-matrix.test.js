import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../worker.js";
import { createGitHubWriteMock } from "../test/helpers/write-control-mocks.js";

const authToken = "test-owner-mcp-auth-token-0000000000000001";

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

async function gitBlobSha(value) {
  const bytes = new TextEncoder().encode(value);
  const header = new TextEncoder().encode("blob " + bytes.byteLength + "\0");
  const object = new Uint8Array(header.byteLength + bytes.byteLength);
  object.set(header);
  object.set(bytes, header.byteLength);
  const digest = await crypto.subtle.digest("SHA-1", object);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

function proposalRequest({ proposalId, path, content, id }) {
  return new Request("https://connector.test/mcp", {
    method: "POST",
    headers: {
      authorization: "Bearer " + authToken,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "cf-connecting-ip": "198.51.100.45",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: {
        name: "knowledge_document_propose",
        arguments: {
          proposalId,
          path,
          content,
          title: "Knowledge Vault failure-boundary verification",
          summary: "Verify proposal identity preflight and recoverable Outbox insertion.",
          expectedBlobSha: "ABSENT",
        },
      },
    }),
  });
}

function authenticatedEnv(overrides = {}) {
  return {
    ...env,
    PUBLIC_READ_ONLY: "true",
    MCP_AUTH_TOKEN: authToken,
    GITHUB_TOKEN: "write-only-test-token",
    GITHUB_READONLY_TOKEN: "read-only-test-token",
    MCP_RATE_LIMITER: { limit: async () => ({ success: true }) },
    ...overrides,
  };
}

async function readProposalState(proposalId, idempotencyKey, keyHash) {
  const knowledgeStore = env.KNOWLEDGE_STORE.get(
    env.KNOWLEDGE_STORE.idFromName("tenant:owner"),
  );
  const knowledge = await runInDurableObject(knowledgeStore, instance => ({
    proposals: instance.ctx.storage.sql.exec(
      "SELECT proposal_id, status, pr_number, pr_url FROM knowledge_vault_proposals WHERE tenant_id=? AND proposal_id=?",
      "owner",
      proposalId,
    ).toArray(),
    outbox: instance.ctx.storage.sql.exec(
      "SELECT event_id, idempotency_key, status, attempts FROM knowledge_outbox WHERE tenant_id=? AND idempotency_key=?",
      "owner",
      idempotencyKey,
    ).toArray(),
  }));

  const writeControl = env.WRITE_CONTROL.get(
    env.WRITE_CONTROL.idFromName("create-change-pr-global"),
  );
  const writes = await runInDurableObject(writeControl, instance => ({
    operations: instance.ctx.storage.sql.exec(
      "SELECT status, phase, branch_name, commit_sha, pr_number FROM write_operations WHERE key_hash=?",
      keyHash,
    ).toArray(),
    admissions: instance.ctx.storage.sql.exec(
      "SELECT key_hash FROM write_admissions WHERE key_hash=?",
      keyHash,
    ).toArray(),
  }));
  return { knowledge, writes };
}

const preflightCases = [
  {
    label: "document identifier digest",
    proposalId: "vault-preflight-path-failure-20261123",
    path: "knowledge/tenants/owner/preflight-path.md",
    content: "# Path digest boundary\n",
    targetPreimage: "knowledge/tenants/owner/preflight-path.md",
    expectedDigestCalls: 1,
  },
  {
    label: "proposed content digest",
    proposalId: "vault-preflight-content-failure-20261123",
    path: "knowledge/tenants/owner/preflight-content.md",
    content: "# Content digest boundary\n",
    targetPreimage: "# Content digest boundary\n",
    expectedDigestCalls: 2,
  },
  {
    label: "Outbox event identifier digest",
    proposalId: "vault-preflight-event-failure-20261123",
    path: "knowledge/tenants/owner/preflight-event.md",
    content: "# Event digest boundary\n",
    targetPreimage: "owner\\n" + "vault-preflight-event-failure-20261123",
    expectedDigestCalls: 3,
  },
];

describe("Knowledge Vault hostile failure matrix", () => {
  it.each(preflightCases)(
    "contains $label failure before every GitHub or Durable Object effect",
    async scenario => {
      const subtle = crypto.subtle;
      const originalDigest = subtle.digest.bind(subtle);
      const hadOwnDigest = Object.prototype.hasOwnProperty.call(subtle, "digest");
      const originalDescriptor = Object.getOwnPropertyDescriptor(subtle, "digest");
      const originalFetch = globalThis.fetch;
      const github = createGitHubWriteMock({
        filePath: scenario.path,
        blobSha: await gitBlobSha(scenario.content),
        baseBranch: "main",
      });
      const marker = "SENSITIVE_VAULT_PREFLIGHT_FAILURE_" + scenario.expectedDigestCalls;
      let matchingDigestCalls = 0;
      let injected = false;
      let totalSha256Calls = 0;
      let nativeSha256Calls = 0;

      globalThis.fetch = github.fetch;
      Object.defineProperty(subtle, "digest", {
        configurable: true,
        writable: true,
        value: (algorithm, data) => {
          if (algorithm === "SHA-256") {
            totalSha256Calls += 1;
            const bytes = data instanceof ArrayBuffer
              ? new Uint8Array(data)
              : ArrayBuffer.isView(data)
                ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
                : new Uint8Array(data);
            const preimage = new TextDecoder().decode(bytes);
            if (!injected && preimage === scenario.targetPreimage) {
              matchingDigestCalls += 1;
              injected = true;
              return Promise.reject(new Error(marker));
            }
            nativeSha256Calls += 1;
          }
          return originalDigest(algorithm, data);
        },
      });

      let response;
      let body;
      let wire;
      try {
        response = await worker.fetch(proposalRequest({
          proposalId: scenario.proposalId,
          path: scenario.path,
          content: scenario.content,
          id: 9300 + scenario.expectedDigestCalls,
        }), authenticatedEnv());
        body = await response.json();
        wire = JSON.stringify(body);
      } finally {
        globalThis.fetch = originalFetch;
        if (hadOwnDigest) Object.defineProperty(subtle, "digest", originalDescriptor);
        else delete subtle.digest;
      }

      const keyHash = await sha256Hex(
        "create_change_pr\nmohammadrezayaghoobi123-dev/chat-gpt\n" + scenario.proposalId,
      );
      const state = await readProposalState(
        scenario.proposalId,
        "vault-" + scenario.proposalId,
        keyHash,
      );
      const error = JSON.parse(body.result.content[0].text);

      expect({
        httpStatus: response.status,
        isToolError: body.result?.isError === true,
        toolError: error,
        rawProviderFailureLeaked: wire.includes(marker),
        matchingDigestCalls,
        injected,
        nativeSha256Calls,
        githubRequests: github.calls.length,
        githubMutations: github.calls.filter(call => call.method === "POST").length,
        durableProposals: state.knowledge.proposals,
        durableOutboxRows: state.knowledge.outbox,
        writeOperations: state.writes.operations,
        writeAdmissions: state.writes.admissions,
      }).toEqual({
        httpStatus: 200,
        isToolError: true,
        toolError: { error: "KNOWLEDGE_VAULT_CRYPTO_UNAVAILABLE" },
        rawProviderFailureLeaked: false,
        matchingDigestCalls: 1,
        injected: true,
        nativeSha256Calls: scenario.expectedDigestCalls - 1,
        githubRequests: 0,
        githubMutations: 0,
        durableProposals: [],
        durableOutboxRows: [],
        writeOperations: [],
        writeAdmissions: [],
      });
      expect(totalSha256Calls).toBeGreaterThanOrEqual(scenario.expectedDigestCalls);
    },
  );

  it("recovers an Outbox insert failure by replaying the same idempotent Vault proposal", async () => {
    const proposalId = "vault-outbox-retry-atomicity-20261123";
    const path = "knowledge/tenants/owner/outbox-retry-atomicity.md";
    const content = "# Outbox retry boundary\nA deterministic recovery fixture.\n";
    const marker = "SENSITIVE_OUTBOX_INSERT_FAILURE";
    const originalFetch = globalThis.fetch;
    const github = createGitHubWriteMock({
      filePath: path,
      blobSha: await gitBlobSha(content),
      baseBranch: "main",
    });
    const actualStore = env.KNOWLEDGE_STORE.get(
      env.KNOWLEDGE_STORE.idFromName("tenant:owner"),
    );
    const calls = { recordVaultProposal: 0, enqueueOutbox: 0 };
    const knowledgeBinding = {
      idFromName(name) {
        return env.KNOWLEDGE_STORE.idFromName(name);
      },
      get(id) {
        const actual = env.KNOWLEDGE_STORE.get(id);
        return {
          recordVaultProposal(input) {
            calls.recordVaultProposal += 1;
            return actual.recordVaultProposal(input);
          },
          enqueueOutbox(input) {
            calls.enqueueOutbox += 1;
            if (calls.enqueueOutbox === 1) {
              throw new Error(marker);
            }
            return actual.enqueueOutbox(input);
          },
        };
      },
    };
    const keyHash = await sha256Hex(
      "create_change_pr\nmohammadrezayaghoobi123-dev/chat-gpt\n" + proposalId,
    );

    globalThis.fetch = github.fetch;
    let firstResponse;
    let firstBody;
    let firstWire;
    let secondResponse;
    let secondBody;
    try {
      firstResponse = await worker.fetch(proposalRequest({
        proposalId, path, content, id: 9401,
      }), authenticatedEnv({ KNOWLEDGE_STORE: knowledgeBinding }));
      firstBody = await firstResponse.json();
      firstWire = JSON.stringify(firstBody);

      const afterFirst = await readProposalState(
        proposalId,
        "vault-" + proposalId,
        keyHash,
      );

      secondResponse = await worker.fetch(proposalRequest({
        proposalId, path, content, id: 9402,
      }), authenticatedEnv({ KNOWLEDGE_STORE: knowledgeBinding }));
      secondBody = await secondResponse.json();

      const afterSecond = await readProposalState(
        proposalId,
        "vault-" + proposalId,
        keyHash,
      );
      const firstError = JSON.parse(firstBody.result.content[0].text);
      const secondResult = JSON.parse(secondBody.result.content[0].text);
      const githubWrites = github.calls
        .filter(call => call.method === "POST")
        .map(call => new URL(call.url).pathname);

      expect({
        firstHttpStatus: firstResponse.status,
        firstIsToolError: firstBody.result?.isError === true,
        firstError,
        rawProviderFailureLeaked: firstWire.includes(marker),
        afterFirstProposalRows: afterFirst.knowledge.proposals,
        afterFirstOutboxRows: afterFirst.knowledge.outbox,
        afterFirstWrite: afterFirst.writes.operations,
        secondHttpStatus: secondResponse.status,
        secondIsToolError: secondBody.result?.isError === true,
        secondProposalStatus: secondResult.proposal_status,
        secondOutboxStatus: secondResult.outbox_status,
        secondPullRequestNumber: secondResult.pull_request?.number,
        finalProposalRows: afterSecond.knowledge.proposals,
        finalOutboxRows: afterSecond.knowledge.outbox,
        finalWrite: afterSecond.writes.operations,
        recordVaultProposalCalls: calls.recordVaultProposal,
        enqueueOutboxCalls: calls.enqueueOutbox,
        githubWrites,
        deleteAttempted: github.deleteAttempted,
      }).toEqual({
        firstHttpStatus: 200,
        firstIsToolError: true,
        firstError: {
          error: "KNOWLEDGE_VAULT_OUTBOX_FAILED",
          pull_request_url: "https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/pull/987",
        },
        rawProviderFailureLeaked: false,
        afterFirstProposalRows: [{
          proposal_id: proposalId,
          status: "proposed",
          pr_number: 987,
          pr_url: "https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/pull/987",
        }],
        afterFirstOutboxRows: [],
        afterFirstWrite: [{
          status: "SUCCEEDED",
          phase: "PR_CREATED",
          branch_name: "assistant/mcp-" + keyHash,
          commit_sha: "d".repeat(40),
          pr_number: 987,
        }],
        secondHttpStatus: 200,
        secondIsToolError: false,
        secondProposalStatus: "proposed",
        secondOutboxStatus: "pending",
        secondPullRequestNumber: 987,
        finalProposalRows: [{
          proposal_id: proposalId,
          status: "proposed",
          pr_number: 987,
          pr_url: "https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/pull/987",
        }],
        finalOutboxRows: [{
          event_id: expect.stringMatching(/^evt_[a-f0-9]{32}$/),
          idempotency_key: "vault-" + proposalId,
          status: "pending",
          attempts: 0,
        }],
        finalWrite: [{
          status: "SUCCEEDED",
          phase: "PR_CREATED",
          branch_name: "assistant/mcp-" + keyHash,
          commit_sha: "d".repeat(40),
          pr_number: 987,
        }],
        recordVaultProposalCalls: 2,
        enqueueOutboxCalls: 2,
        githubWrites: [
          "/repos/mohammadrezayaghoobi123-dev/Chat-gpt/git/trees",
          "/repos/mohammadrezayaghoobi123-dev/Chat-gpt/git/commits",
          "/repos/mohammadrezayaghoobi123-dev/Chat-gpt/git/refs",
          "/repos/mohammadrezayaghoobi123-dev/Chat-gpt/pulls",
        ],
        deleteAttempted: false,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
