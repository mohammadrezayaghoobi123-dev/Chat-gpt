import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../worker.js";
import { createGitHubWriteMock } from "../test/helpers/write-control-mocks.js";

const authToken = "test-owner-mcp-auth-token-0000000000000001";
const proposalId = "vault-proposal-preflight-crypto-failure-0001";
const path = "knowledge/tenants/owner/failure-atomicity.md";
const content = "# Vault proposal failure atomicity\nA controlled test fixture.\n";

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

function proposalRequest() {
  return new Request("https://connector.test/mcp", {
    method: "POST",
    headers: {
      authorization: "Bearer " + authToken,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "cf-connecting-ip": "198.51.100.44",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 9101,
      method: "tools/call",
      params: {
        name: "knowledge_document_propose",
        arguments: {
          proposalId,
          path,
          content,
          title: "Vault proposal hash-preflight atomicity",
          summary: "Verify that event identity hashing precedes every external and durable write.",
          expectedBlobSha: "ABSENT",
        },
      },
    }),
  });
}

describe("Knowledge Vault proposal failure atomicity", () => {
  it("rejects the event-identity digest before GitHub writes or durable proposal admission", async () => {
    const subtle = crypto.subtle;
    const originalDigest = subtle.digest.bind(subtle);
    const hadOwnDigest = Object.prototype.hasOwnProperty.call(subtle, "digest");
    const originalDescriptor = Object.getOwnPropertyDescriptor(subtle, "digest");
    const originalFetch = globalThis.fetch;
    const blobSha = await gitBlobSha(content);
    const github = createGitHubWriteMock({ filePath: path, blobSha, baseBranch: "main" });
    const marker = "SENSITIVE_VAULT_EVENT_ID_DIGEST_FAILURE";
    let injected = false;
    let targetDigestAttempts = 0;

    globalThis.fetch = github.fetch;
    Object.defineProperty(subtle, "digest", {
      configurable: true,
      writable: true,
      value: (algorithm, data) => {
        const bytes = data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : ArrayBuffer.isView(data)
            ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
            : new Uint8Array(data);
        const preimage = new TextDecoder().decode(bytes);
        const isEventIdentity = preimage.startsWith("owner") &&
          preimage.endsWith(proposalId) &&
          !preimage.startsWith("create_change_pr");
        if (!injected && isEventIdentity) {
          injected = true;
          targetDigestAttempts += 1;
          return Promise.reject(new Error(marker));
        }
        return originalDigest(algorithm, data);
      },
    });

    let response;
    let body;
    let wire;
    try {
      response = await worker.fetch(proposalRequest(), {
        ...env,
        PUBLIC_READ_ONLY: "true",
        MCP_AUTH_TOKEN: authToken,
        GITHUB_TOKEN: "write-only-test-token",
        GITHUB_READONLY_TOKEN: "read-only-test-token",
        MCP_RATE_LIMITER: { limit: async () => ({ success: true }) },
      });
      body = await response.json();
      wire = JSON.stringify(body);
    } finally {
      globalThis.fetch = originalFetch;
      if (hadOwnDigest) Object.defineProperty(subtle, "digest", originalDescriptor);
      else delete subtle.digest;
    }

    const keyHash = await sha256Hex(
      "create_change_pr\nmohammadrezayaghoobi123-dev/chat-gpt\n" + proposalId,
    );
    const store = env.KNOWLEDGE_STORE.get(env.KNOWLEDGE_STORE.idFromName("tenant:owner"));
    const knowledgeState = await runInDurableObject(store, instance => ({
      proposals: instance.ctx.storage.sql.exec(
        "SELECT proposal_id, status, pr_number FROM knowledge_vault_proposals WHERE tenant_id=? AND proposal_id=?",
        "owner",
        proposalId,
      ).toArray(),
      outbox: instance.ctx.storage.sql.exec(
        "SELECT event_id, idempotency_key, status FROM knowledge_outbox WHERE tenant_id=? AND idempotency_key=?",
        "owner",
        "vault-" + proposalId,
      ).toArray(),
    }));

    const writeControl = env.WRITE_CONTROL.get(env.WRITE_CONTROL.idFromName("create-change-pr-global"));
    const writeState = await runInDurableObject(writeControl, instance => ({
      operations: instance.ctx.storage.sql.exec(
        "SELECT status, phase, branch_name, commit_sha, pr_number FROM write_operations WHERE key_hash=?",
        keyHash,
      ).toArray(),
      admissions: instance.ctx.storage.sql.exec(
        "SELECT key_hash FROM write_admissions WHERE key_hash=?",
        keyHash,
      ).toArray(),
    }));

    const githubMutations = github.calls
      .filter(call => call.method === "POST")
      .map(call => new URL(call.url).pathname);

    expect({
      httpStatus: response.status,
      jsonRpcId: body.id,
      isToolError: body.result?.isError === true,
      toolError: JSON.parse(body.result.content[0].text),
      rawProviderFailureLeaked: wire.includes(marker),
      eventIdentityDigestAttempts: targetDigestAttempts,
      githubRequestCount: github.calls.length,
      githubMutations,
      durableProposals: knowledgeState.proposals,
      durableOutboxRows: knowledgeState.outbox,
      writeOperations: writeState.operations,
      writeAdmissions: writeState.admissions,
    }).toEqual({
      httpStatus: 200,
      jsonRpcId: 9101,
      isToolError: true,
      toolError: { error: "KNOWLEDGE_VAULT_CRYPTO_UNAVAILABLE" },
      rawProviderFailureLeaked: false,
      eventIdentityDigestAttempts: 1,
      githubRequestCount: 0,
      githubMutations: [],
      durableProposals: [],
      durableOutboxRows: [],
      writeOperations: [],
      writeAdmissions: [],
    });
  });
});
