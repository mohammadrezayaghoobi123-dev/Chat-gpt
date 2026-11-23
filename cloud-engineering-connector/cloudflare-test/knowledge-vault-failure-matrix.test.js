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

async function readProposalState(proposalId, idempotencyKey, keyHash, writeControlName = "create-change-pr-global") {
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
    env.WRITE_CONTROL.idFromName(writeControlName),
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

  it("deduplicates an Outbox retry when the Durable Object committed but the RPC acknowledgement was lost", async () => {
    const proposalId = "vault-outbox-ack-loss-atomicity-20261123";
    const path = "knowledge/tenants/owner/outbox-ack-loss.md";
    const content = "# Outbox acknowledgement loss\nA deterministic commit-before-error fixture.\n";
    const marker = "SENSITIVE_OUTBOX_ACK_LOSS";
    const originalFetch = globalThis.fetch;
    const github = createGitHubWriteMock({
      filePath: path,
      blobSha: await gitBlobSha(content),
      baseBranch: "main",
      prNumber: 988,
    });
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
          async enqueueOutbox(input) {
            calls.enqueueOutbox += 1;
            const committed = await actual.enqueueOutbox(input);
            if (calls.enqueueOutbox === 1) throw new Error(marker);
            return committed;
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
        proposalId, path, content, id: 9501,
      }), authenticatedEnv({ KNOWLEDGE_STORE: knowledgeBinding }));
      firstBody = await firstResponse.json();
      firstWire = JSON.stringify(firstBody);

      const afterFirst = await readProposalState(
        proposalId,
        "vault-" + proposalId,
        keyHash,
      );

      secondResponse = await worker.fetch(proposalRequest({
        proposalId, path, content, id: 9502,
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
        secondHttpStatus: secondResponse.status,
        secondIsToolError: secondBody.result?.isError === true,
        secondProposalStatus: secondResult.proposal_status,
        secondOutboxStatus: secondResult.outbox_status,
        firstOutboxEventId: afterFirst.knowledge.outbox[0]?.event_id,
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
          pull_request_url: "https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/pull/988",
        },
        rawProviderFailureLeaked: false,
        afterFirstProposalRows: [{
          proposal_id: proposalId,
          status: "proposed",
          pr_number: 988,
          pr_url: "https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/pull/988",
        }],
        afterFirstOutboxRows: [{
          event_id: expect.stringMatching(/^evt_[a-f0-9]{32}$/),
          idempotency_key: "vault-" + proposalId,
          status: "pending",
          attempts: 0,
        }],
        secondHttpStatus: 200,
        secondIsToolError: false,
        secondProposalStatus: "proposed",
        secondOutboxStatus: "pending",
        firstOutboxEventId: expect.stringMatching(/^evt_[a-f0-9]{32}$/),
        finalProposalRows: [{
          proposal_id: proposalId,
          status: "proposed",
          pr_number: 988,
          pr_url: "https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/pull/988",
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
          pr_number: 988,
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
      expect(afterSecond.knowledge.outbox[0].event_id)
        .toBe(afterFirst.knowledge.outbox[0].event_id);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });



  it("recovers a pre-commit proposal-record failure without repeating GitHub writes and rejects payload drift", async () => {
    const proposalId = "vault-proposal-record-prewrite-20261123";
    const path = "knowledge/tenants/owner/proposal-record-prewrite.md";
    const content = "# Proposal record pre-write failure\nA deterministic retry fixture.\n";
    const marker = "SENSITIVE_PROPOSAL_RECORD_PREWRITE_FAILURE";
    const prNumber = 989001;
    const originalFetch = globalThis.fetch;
    const github = createGitHubWriteMock({
      filePath: path,
      blobSha: await gitBlobSha(content),
      baseBranch: "main",
      prNumber,
    });
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
            if (calls.recordVaultProposal === 1) throw new Error(marker);
            return actual.recordVaultProposal(input);
          },
          enqueueOutbox(input) {
            calls.enqueueOutbox += 1;
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
    let driftResponse;
    let driftBody;
    try {
      firstResponse = await worker.fetch(proposalRequest({
        proposalId, path, content, id: 9601,
      }), authenticatedEnv({ KNOWLEDGE_STORE: knowledgeBinding }));
      firstBody = await firstResponse.json();
      firstWire = JSON.stringify(firstBody);
      const afterFirst = await readProposalState(
        proposalId,
        "vault-" + proposalId,
        keyHash,
      );
      const writesAfterFirst = github.calls.filter(call => call.method === "POST").length;
      const githubCallsAfterFirst = github.calls.length;

      secondResponse = await worker.fetch(proposalRequest({
        proposalId, path, content, id: 9602,
      }), authenticatedEnv({ KNOWLEDGE_STORE: knowledgeBinding }));
      secondBody = await secondResponse.json();
      const afterSecond = await readProposalState(
        proposalId,
        "vault-" + proposalId,
        keyHash,
      );
      const replayCalls = github.calls.slice(githubCallsAfterFirst).map(call => ({
        method: call.method,
        path: new URL(call.url).pathname,
      }));
      const callsBeforeDrift = github.calls.length;

      driftResponse = await worker.fetch(proposalRequest({
        proposalId,
        path,
        content: content + "changed payload must not be rebound\n",
        id: 9603,
      }), authenticatedEnv({ KNOWLEDGE_STORE: knowledgeBinding }));
      driftBody = await driftResponse.json();
      const afterDrift = await readProposalState(
        proposalId,
        "vault-" + proposalId,
        keyHash,
      );
      const githubWrites = github.calls
        .filter(call => call.method === "POST")
        .map(call => new URL(call.url).pathname);
      const firstError = JSON.parse(firstBody.result.content[0].text);
      const secondResult = JSON.parse(secondBody.result.content[0].text);
      const driftError = JSON.parse(driftBody.result.content[0].text);

      expect(afterDrift).toEqual(afterSecond);
      expect({
        firstHttpStatus: firstResponse.status,
        firstIsToolError: firstBody.result?.isError === true,
        firstError,
        rawProviderFailureLeaked: firstWire.includes(marker),
        afterFirstProposals: afterFirst.knowledge.proposals,
        afterFirstOutbox: afterFirst.knowledge.outbox,
        afterFirstWrite: afterFirst.writes.operations,
        writesAfterFirst,
        secondHttpStatus: secondResponse.status,
        secondIsToolError: secondBody.result?.isError === true,
        secondProposalStatus: secondResult.proposal_status,
        secondOutboxStatus: secondResult.outbox_status,
        secondReplayed: secondResult.replayed,
        secondPullRequestNumber: secondResult.pull_request?.number,
        finalProposals: afterSecond.knowledge.proposals,
        finalOutbox: afterSecond.knowledge.outbox,
        finalWrite: afterSecond.writes.operations,
        replayCalls,
        driftHttpStatus: driftResponse.status,
        driftIsToolError: driftBody.result?.isError === true,
        driftError,
        driftCausedNoGitHubCall: github.calls.length === callsBeforeDrift,
        recordVaultProposalCalls: calls.recordVaultProposal,
        enqueueOutboxCalls: calls.enqueueOutbox,
        githubWrites,
        deleteAttempted: github.deleteAttempted,
      }).toEqual({
        firstHttpStatus: 200,
        firstIsToolError: true,
        firstError: {
          error: "KNOWLEDGE_VAULT_PROPOSAL_RECORD_FAILED",
          pull_request_url: "https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/pull/989001",
        },
        rawProviderFailureLeaked: false,
        afterFirstProposals: [],
        afterFirstOutbox: [],
        afterFirstWrite: [{
          status: "SUCCEEDED",
          phase: "PR_CREATED",
          branch_name: "assistant/mcp-" + keyHash,
          commit_sha: "d".repeat(40),
          pr_number: prNumber,
        }],
        writesAfterFirst: 4,
        secondHttpStatus: 200,
        secondIsToolError: false,
        secondProposalStatus: "proposed",
        secondOutboxStatus: "pending",
        secondReplayed: true,
        secondPullRequestNumber: prNumber,
        finalProposals: [{
          proposal_id: proposalId,
          status: "proposed",
          pr_number: prNumber,
          pr_url: "https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/pull/989001",
        }],
        finalOutbox: [{
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
          pr_number: prNumber,
        }],
        replayCalls: [{
          method: "GET",
          path: "/repos/mohammadrezayaghoobi123-dev/Chat-gpt/pulls/989001",
        }],
        driftHttpStatus: 200,
        driftIsToolError: true,
        driftError: { error: "IDEMPOTENCY_CONFLICT" },
        driftCausedNoGitHubCall: true,
        recordVaultProposalCalls: 2,
        enqueueOutboxCalls: 1,
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

  it("recovers a committed proposal record when its RPC acknowledgement is lost", async () => {
    const proposalId = "vault-proposal-record-ack-loss-20261123";
    const path = "knowledge/tenants/owner/proposal-record-ack-loss.md";
    const content = "# Proposal record acknowledgement loss\nCommit before error fixture.\n";
    const marker = "SENSITIVE_PROPOSAL_RECORD_ACK_LOSS";
    const prNumber = 990001;
    const originalFetch = globalThis.fetch;
    const github = createGitHubWriteMock({
      filePath: path,
      blobSha: await gitBlobSha(content),
      baseBranch: "main",
      prNumber,
    });
    const calls = { recordVaultProposal: 0, enqueueOutbox: 0 };
    const knowledgeBinding = {
      idFromName(name) {
        return env.KNOWLEDGE_STORE.idFromName(name);
      },
      get(id) {
        const actual = env.KNOWLEDGE_STORE.get(id);
        return {
          async recordVaultProposal(input) {
            calls.recordVaultProposal += 1;
            const committed = await actual.recordVaultProposal(input);
            if (calls.recordVaultProposal === 1) throw new Error(marker);
            return committed;
          },
          enqueueOutbox(input) {
            calls.enqueueOutbox += 1;
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
        proposalId, path, content, id: 9701,
      }), authenticatedEnv({ KNOWLEDGE_STORE: knowledgeBinding }));
      firstBody = await firstResponse.json();
      firstWire = JSON.stringify(firstBody);
      const afterFirst = await readProposalState(
        proposalId,
        "vault-" + proposalId,
        keyHash,
      );
      const writesAfterFirst = github.calls.filter(call => call.method === "POST").length;
      const githubCallsAfterFirst = github.calls.length;

      secondResponse = await worker.fetch(proposalRequest({
        proposalId, path, content, id: 9702,
      }), authenticatedEnv({ KNOWLEDGE_STORE: knowledgeBinding }));
      secondBody = await secondResponse.json();
      const afterSecond = await readProposalState(
        proposalId,
        "vault-" + proposalId,
        keyHash,
      );
      const replayCalls = github.calls.slice(githubCallsAfterFirst).map(call => ({
        method: call.method,
        path: new URL(call.url).pathname,
      }));
      const firstError = JSON.parse(firstBody.result.content[0].text);
      const secondResult = JSON.parse(secondBody.result.content[0].text);

      expect({
        firstHttpStatus: firstResponse.status,
        firstIsToolError: firstBody.result?.isError === true,
        firstError,
        rawProviderFailureLeaked: firstWire.includes(marker),
        afterFirstProposals: afterFirst.knowledge.proposals,
        afterFirstOutbox: afterFirst.knowledge.outbox,
        afterFirstWrite: afterFirst.writes.operations,
        writesAfterFirst,
        secondHttpStatus: secondResponse.status,
        secondIsToolError: secondBody.result?.isError === true,
        secondProposalStatus: secondResult.proposal_status,
        secondOutboxStatus: secondResult.outbox_status,
        secondReplayed: secondResult.replayed,
        secondPullRequestNumber: secondResult.pull_request?.number,
        finalProposals: afterSecond.knowledge.proposals,
        finalOutbox: afterSecond.knowledge.outbox,
        finalWrite: afterSecond.writes.operations,
        replayCalls,
        recordVaultProposalCalls: calls.recordVaultProposal,
        enqueueOutboxCalls: calls.enqueueOutbox,
        githubWrites: github.calls
          .filter(call => call.method === "POST")
          .map(call => new URL(call.url).pathname),
        deleteAttempted: github.deleteAttempted,
      }).toEqual({
        firstHttpStatus: 200,
        firstIsToolError: true,
        firstError: {
          error: "KNOWLEDGE_VAULT_PROPOSAL_RECORD_FAILED",
          pull_request_url: "https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/pull/990001",
        },
        rawProviderFailureLeaked: false,
        afterFirstProposals: [{
          proposal_id: proposalId,
          status: "proposed",
          pr_number: prNumber,
          pr_url: "https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/pull/990001",
        }],
        afterFirstOutbox: [],
        afterFirstWrite: [{
          status: "SUCCEEDED",
          phase: "PR_CREATED",
          branch_name: "assistant/mcp-" + keyHash,
          commit_sha: "d".repeat(40),
          pr_number: prNumber,
        }],
        writesAfterFirst: 4,
        secondHttpStatus: 200,
        secondIsToolError: false,
        secondProposalStatus: "proposed",
        secondOutboxStatus: "pending",
        secondReplayed: true,
        secondPullRequestNumber: prNumber,
        finalProposals: [{
          proposal_id: proposalId,
          status: "proposed",
          pr_number: prNumber,
          pr_url: "https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/pull/990001",
        }],
        finalOutbox: [{
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
          pr_number: prNumber,
        }],
        replayCalls: [{
          method: "GET",
          path: "/repos/mohammadrezayaghoobi123-dev/Chat-gpt/pulls/990001",
        }],
        recordVaultProposalCalls: 2,
        enqueueOutboxCalls: 1,
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



  function createPartyGate(parties) {
    let arrivals = 0;
    let release;
    let resolveFirst;
    let resolveAll;
    const opened = new Promise(resolve => { release = resolve; });
    const firstArrived = new Promise(resolve => { resolveFirst = resolve; });
    const allArrived = new Promise(resolve => { resolveAll = resolve; });
    return {
      firstArrived,
      allArrived,
      release,
      async arrive() {
        arrivals += 1;
        if (arrivals === 1) resolveFirst();
        if (arrivals === parties) resolveAll();
        await opened;
      },
    };
  }

  const observeRequest = promise => promise.then(
    async response => ({ response, body: await response.json() }),
    error => ({ error }),
  );

  it("serializes concurrent identical proposals into one durable Proposal and one Outbox event", async () => {
    const proposalId = "vault-proposal-concurrent-identical-20261123";
    const path = "knowledge/tenants/owner/proposal-concurrent-identical.md";
    const content = "# Concurrent identical proposal\nBoth callers carry the exact same payload.\n";
    const prNumber = 991001;
    const writeControlName = "create-change-pr-global:" + proposalId;
    const writeControlBinding = {
      idFromName(name) {
        if (name !== "create-change-pr-global") throw new Error("Unexpected WriteControl binding name.");
        return env.WRITE_CONTROL.idFromName(writeControlName);
      },
      get(id) {
        return env.WRITE_CONTROL.get(id);
      },
    };
    const originalFetch = globalThis.fetch;
    const github = createGitHubWriteMock({
      filePath: path,
      blobSha: await gitBlobSha(content),
      baseBranch: "main",
      prNumber,
    });
    const recordGate = createPartyGate(2);
    const outboxGate = createPartyGate(2);
    const calls = { recordVaultProposal: 0, enqueueOutbox: 0 };
    const knowledgeBinding = {
      idFromName(name) {
        return env.KNOWLEDGE_STORE.idFromName(name);
      },
      get(id) {
        const actual = env.KNOWLEDGE_STORE.get(id);
        return {
          async recordVaultProposal(input) {
            calls.recordVaultProposal += 1;
            await recordGate.arrive();
            return actual.recordVaultProposal(input);
          },
          async enqueueOutbox(input) {
            calls.enqueueOutbox += 1;
            await outboxGate.arrive();
            return actual.enqueueOutbox(input);
          },
        };
      },
    };
    const keyHash = await sha256Hex(
      "create_change_pr\nmohammadrezayaghoobi123-dev/chat-gpt\n" + proposalId,
    );

    globalThis.fetch = github.fetch;
    let firstPromise;
    let secondPromise;
    try {
      firstPromise = observeRequest(worker.fetch(proposalRequest({
        proposalId, path, content, id: 9801,
      }), authenticatedEnv({ KNOWLEDGE_STORE: knowledgeBinding, WRITE_CONTROL: writeControlBinding })));

      await recordGate.firstArrived;
      const githubCallsBeforeReplay = github.calls.length;

      secondPromise = observeRequest(worker.fetch(proposalRequest({
        proposalId, path, content, id: 9802,
      }), authenticatedEnv({ KNOWLEDGE_STORE: knowledgeBinding, WRITE_CONTROL: writeControlBinding })));

      await recordGate.allArrived;
      const replayCalls = github.calls.slice(githubCallsBeforeReplay).map(call => ({
        method: call.method,
        path: new URL(call.url).pathname,
      }));
      recordGate.release();

      await outboxGate.allArrived;
      outboxGate.release();

      const [first, second] = await Promise.all([firstPromise, secondPromise]);
      const state = await readProposalState(
        proposalId,
        "vault-" + proposalId,
        keyHash,
        writeControlName,
      );
      const firstResult = first.error
        ? null
        : JSON.parse(first.body.result.content[0].text);
      const secondResult = second.error
        ? null
        : JSON.parse(second.body.result.content[0].text);

      expect({
        firstThrown: Boolean(first.error),
        secondThrown: Boolean(second.error),
        firstHttpStatus: first.response?.status,
        secondHttpStatus: second.response?.status,
        firstIsToolError: first.body?.result?.isError === true,
        secondIsToolError: second.body?.result?.isError === true,
        firstProposalStatus: firstResult?.proposal_status,
        secondProposalStatus: secondResult?.proposal_status,
        firstOutboxStatus: firstResult?.outbox_status,
        secondOutboxStatus: secondResult?.outbox_status,
        firstPullRequestNumber: firstResult?.pull_request?.number,
        secondPullRequestNumber: secondResult?.pull_request?.number,
        firstReplayed: firstResult?.replayed ?? false,
        secondReplayed: secondResult?.replayed ?? false,
        proposals: state.knowledge.proposals,
        outbox: state.knowledge.outbox,
        operations: state.writes.operations,
        admissions: state.writes.admissions,
        recordVaultProposalCalls: calls.recordVaultProposal,
        enqueueOutboxCalls: calls.enqueueOutbox,
        replayCalls,
        githubWrites: github.calls
          .filter(call => call.method === "POST")
          .map(call => new URL(call.url).pathname),
        deleteAttempted: github.deleteAttempted,
      }).toEqual({
        firstThrown: false,
        secondThrown: false,
        firstHttpStatus: 200,
        secondHttpStatus: 200,
        firstIsToolError: false,
        secondIsToolError: false,
        firstProposalStatus: "proposed",
        secondProposalStatus: "proposed",
        firstOutboxStatus: "pending",
        secondOutboxStatus: "pending",
        firstPullRequestNumber: prNumber,
        secondPullRequestNumber: prNumber,
        firstReplayed: false,
        secondReplayed: true,
        proposals: [{
          proposal_id: proposalId,
          status: "proposed",
          pr_number: prNumber,
          pr_url: "https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/pull/991001",
        }],
        outbox: [{
          event_id: expect.stringMatching(/^evt_[a-f0-9]{32}$/),
          idempotency_key: "vault-" + proposalId,
          status: "pending",
          attempts: 0,
        }],
        operations: [{
          status: "SUCCEEDED",
          phase: "PR_CREATED",
          branch_name: "assistant/mcp-" + keyHash,
          commit_sha: "d".repeat(40),
          pr_number: prNumber,
        }],
        admissions: [{ key_hash: keyHash }],
        recordVaultProposalCalls: 2,
        enqueueOutboxCalls: 2,
        replayCalls: [{
          method: "GET",
          path: "/repos/mohammadrezayaghoobi123-dev/Chat-gpt/pulls/991001",
        }],
        githubWrites: [
          "/repos/mohammadrezayaghoobi123-dev/Chat-gpt/git/trees",
          "/repos/mohammadrezayaghoobi123-dev/Chat-gpt/git/commits",
          "/repos/mohammadrezayaghoobi123-dev/Chat-gpt/git/refs",
          "/repos/mohammadrezayaghoobi123-dev/Chat-gpt/pulls",
        ],
        deleteAttempted: false,
      });
    } finally {
      recordGate.release();
      outboxGate.release();
      await Promise.allSettled([firstPromise, secondPromise].filter(Boolean));
      globalThis.fetch = originalFetch;
    }
  }, 15000);

  it("rejects a concurrent payload mutation before GitHub or Knowledge Store side effects", async () => {
    const proposalId = "vault-proposal-concurrent-drift-20261123";
    const path = "knowledge/tenants/owner/proposal-concurrent-drift.md";
    const content = "# Concurrent proposal identity\nThe original operation remains authoritative.\n";
    const changedContent = content + "Conflicting concurrent payload.\n";
    const prNumber = 992001;
    const writeControlName = "create-change-pr-global:" + proposalId;
    const writeControlBinding = {
      idFromName(name) {
        if (name !== "create-change-pr-global") throw new Error("Unexpected WriteControl binding name.");
        return env.WRITE_CONTROL.idFromName(writeControlName);
      },
      get(id) {
        return env.WRITE_CONTROL.get(id);
      },
    };
    const originalFetch = globalThis.fetch;
    const github = createGitHubWriteMock({
      filePath: path,
      blobSha: await gitBlobSha(content),
      baseBranch: "main",
      prNumber,
    });
    const recordGate = createPartyGate(1);
    const calls = { recordVaultProposal: 0, enqueueOutbox: 0 };
    const knowledgeBinding = {
      idFromName(name) {
        return env.KNOWLEDGE_STORE.idFromName(name);
      },
      get(id) {
        const actual = env.KNOWLEDGE_STORE.get(id);
        return {
          async recordVaultProposal(input) {
            calls.recordVaultProposal += 1;
            await recordGate.arrive();
            return actual.recordVaultProposal(input);
          },
          async enqueueOutbox(input) {
            calls.enqueueOutbox += 1;
            return actual.enqueueOutbox(input);
          },
        };
      },
    };
    const keyHash = await sha256Hex(
      "create_change_pr\nmohammadrezayaghoobi123-dev/chat-gpt\n" + proposalId,
    );

    globalThis.fetch = github.fetch;
    let firstPromise;
    try {
      firstPromise = observeRequest(worker.fetch(proposalRequest({
        proposalId, path, content, id: 9811,
      }), authenticatedEnv({ KNOWLEDGE_STORE: knowledgeBinding, WRITE_CONTROL: writeControlBinding })));

      await recordGate.firstArrived;
      const githubCallsBeforeConflict = github.calls.length;
      const conflict = await observeRequest(worker.fetch(proposalRequest({
        proposalId, path, content: changedContent, id: 9812,
      }), authenticatedEnv({ KNOWLEDGE_STORE: knowledgeBinding, WRITE_CONTROL: writeControlBinding })));
      const stateBeforeRelease = await readProposalState(
        proposalId,
        "vault-" + proposalId,
        keyHash,
        writeControlName,
      );
      const conflictError = conflict.error
        ? null
        : JSON.parse(conflict.body.result.content[0].text);

      recordGate.release();
      const first = await firstPromise;
      const firstResult = first.error
        ? null
        : JSON.parse(first.body.result.content[0].text);
      const finalState = await readProposalState(
        proposalId,
        "vault-" + proposalId,
        keyHash,
        writeControlName,
      );

      expect({
        conflictThrown: Boolean(conflict.error),
        conflictHttpStatus: conflict.response?.status,
        conflictIsToolError: conflict.body?.result?.isError === true,
        conflictError,
        conflictMadeNoGitHubCall: github.calls.length === githubCallsBeforeConflict,
        preReleaseProposals: stateBeforeRelease.knowledge.proposals,
        preReleaseOutbox: stateBeforeRelease.knowledge.outbox,
        preReleaseWrite: stateBeforeRelease.writes.operations,
        firstThrown: Boolean(first.error),
        firstHttpStatus: first.response?.status,
        firstIsToolError: first.body?.result?.isError === true,
        firstProposalStatus: firstResult?.proposal_status,
        firstOutboxStatus: firstResult?.outbox_status,
        finalProposals: finalState.knowledge.proposals,
        finalOutbox: finalState.knowledge.outbox,
        finalWrite: finalState.writes.operations,
        finalAdmissions: finalState.writes.admissions,
        recordVaultProposalCalls: calls.recordVaultProposal,
        enqueueOutboxCalls: calls.enqueueOutbox,
        githubWrites: github.calls
          .filter(call => call.method === "POST")
          .map(call => new URL(call.url).pathname),
        deleteAttempted: github.deleteAttempted,
      }).toEqual({
        conflictThrown: false,
        conflictHttpStatus: 200,
        conflictIsToolError: true,
        conflictError: { error: "IDEMPOTENCY_CONFLICT" },
        conflictMadeNoGitHubCall: true,
        preReleaseProposals: [],
        preReleaseOutbox: [],
        preReleaseWrite: [{
          status: "SUCCEEDED",
          phase: "PR_CREATED",
          branch_name: "assistant/mcp-" + keyHash,
          commit_sha: "d".repeat(40),
          pr_number: prNumber,
        }],
        firstThrown: false,
        firstHttpStatus: 200,
        firstIsToolError: false,
        firstProposalStatus: "proposed",
        firstOutboxStatus: "pending",
        finalProposals: [{
          proposal_id: proposalId,
          status: "proposed",
          pr_number: prNumber,
          pr_url: "https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/pull/992001",
        }],
        finalOutbox: [{
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
          pr_number: prNumber,
        }],
        finalAdmissions: [{ key_hash: keyHash }],
        recordVaultProposalCalls: 1,
        enqueueOutboxCalls: 1,
        githubWrites: [
          "/repos/mohammadrezayaghoobi123-dev/Chat-gpt/git/trees",
          "/repos/mohammadrezayaghoobi123-dev/Chat-gpt/git/commits",
          "/repos/mohammadrezayaghoobi123-dev/Chat-gpt/git/refs",
          "/repos/mohammadrezayaghoobi123-dev/Chat-gpt/pulls",
        ],
        deleteAttempted: false,
      });
    } finally {
      recordGate.release();
      await Promise.allSettled([firstPromise].filter(Boolean));
      globalThis.fetch = originalFetch;
    }
  }, 15000);

});
