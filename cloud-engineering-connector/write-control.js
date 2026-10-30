import { DurableObject } from "cloudflare:workers";

const PHASES = [
  "RESERVED",
  "TREE_DISPATCHED",
  "TREE_WRITTEN",
  "COMMIT_DISPATCHED",
  "COMMIT_WRITTEN",
  "BRANCH_WRITTEN",
  "PR_DISPATCHED",
  "PR_CREATED",
];
const STATUSES = new Set(["IN_PROGRESS", "SUCCEEDED", "FAILED", "UNKNOWN"]);
const METADATA_FIELDS = new Set([
  "branchName",
  "commitSha",
  "prNumber",
  "prUrl",
  "errorCode",
  "baseTreeSha",
  "parentSha",
  "treeSha",
  "commitDate",
  "commitMessage",
  "authorName",
  "authorEmail",
  "committerName",
  "committerEmail",
]);

function assertHash(value, field) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new TypeError(field + " must be a lowercase SHA-256 hex digest.");
  }
}
function isPullRequestUrl(url,number) {
  if(typeof url!=="string"||url.length>2048)return false;
  try{
    const parsed=new URL(url);
    if(parsed.protocol!=="https:"||parsed.hostname!=="github.com"||parsed.port!==""||
       parsed.username!==""||parsed.password!==""||parsed.search!==""||parsed.hash!=="")return false;
    const match=/^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]*)$/.exec(parsed.pathname);
    return Boolean(match&&Number(match[3])===number&&String(number)===match[3]);
  }catch{return false;}
}

function operationFromRow(row) {
  if (!row) return null;
  return {
    keyHash: row.key_hash,
    requestHash: row.request_hash,
    status: row.status,
    phase: row.phase,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    leaseGeneration: row.lease_generation,
    branchName: row.branch_name,
    commitSha: row.commit_sha,
    prNumber: row.pr_number,
    prUrl: row.pr_url,
    errorCode: row.error_code,
    gitMetadata: row.git_metadata ? JSON.parse(row.git_metadata) : {},
  };
}

export class WriteControl extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => {
      const sql = this.ctx.storage.sql;
      sql.exec(`
        CREATE TABLE IF NOT EXISTS write_admissions (
          key_hash TEXT PRIMARY KEY,
          admitted_at INTEGER NOT NULL
        )
      `);
      sql.exec(`
        CREATE INDEX IF NOT EXISTS write_admissions_by_time
        ON write_admissions(admitted_at)
      `);
      sql.exec(`
        CREATE TABLE IF NOT EXISTS write_operations (
          key_hash TEXT PRIMARY KEY,
          request_hash TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('IN_PROGRESS','SUCCEEDED','FAILED','UNKNOWN')),
          phase TEXT NOT NULL CHECK (phase IN ('RESERVED','TREE_DISPATCHED','TREE_WRITTEN','COMMIT_DISPATCHED','COMMIT_WRITTEN','BRANCH_WRITTEN','PR_DISPATCHED','PR_CREATED')),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          lease_generation INTEGER NOT NULL DEFAULT 1,
          branch_name TEXT,
          commit_sha TEXT,
          pr_number INTEGER,
          pr_url TEXT,
          error_code TEXT,
          git_metadata TEXT
        )
      `);
      const operationColumns = sql.exec("PRAGMA table_info(write_operations)").toArray();
      if (!operationColumns.some((column) => column.name === "lease_generation")) {
        sql.exec("ALTER TABLE write_operations ADD COLUMN lease_generation INTEGER NOT NULL DEFAULT 1");
      }
      sql.exec(`
        CREATE INDEX IF NOT EXISTS write_operations_by_status_time
        ON write_operations(status, updated_at)
      `);
    });
  }

  readOperation(keyHash) {
    const row = this.ctx.storage.sql
      .exec("SELECT * FROM write_operations WHERE key_hash = ?", keyHash)
      .toArray()[0];
    return operationFromRow(row);
  }

  getOperation(keyHash) {
    assertHash(keyHash, "keyHash");
    return this.readOperation(keyHash);
  }

  admitWrite(input) {
    if (!input || typeof input !== "object") throw new TypeError("input must be an object.");
    const { keyHash, requestHash, windowMs, limit } = input;
    const now = Date.now();
    assertHash(keyHash, "keyHash");
    assertHash(requestHash, "requestHash");
    // Enforce the security policy at the Durable Object boundary; callers cannot widen it.
    if (windowMs !== 60_000) {
      throw new TypeError("windowMs must equal the fixed policy value 60000.");
    }
    if (limit !== 5) {
      throw new TypeError("limit must equal the fixed policy value 5.");
    }

    return this.ctx.storage.transactionSync(() => {
      const existing = this.readOperation(keyHash);
      if (existing) {
        if (existing.requestHash !== requestHash) {
          return { admitted: false, reason: "IDEMPOTENCY_CONFLICT" };
        }
        return { admitted: true, replay: true, operation: existing };
      }

      const cutoff = now - windowMs;
      this.ctx.storage.sql.exec(
        "DELETE FROM write_admissions WHERE admitted_at <= ?",
        cutoff,
      );
      const count = this.ctx.storage.sql
        .exec("SELECT COUNT(*) AS count FROM write_admissions")
        .one().count;

      if (count >= limit) {
        const oldest = this.ctx.storage.sql
          .exec("SELECT MIN(admitted_at) AS oldest FROM write_admissions")
          .one().oldest;
        const retryAfterSeconds = Math.max(
          1,
          Math.ceil((oldest + windowMs - now) / 1000),
        );
        return {
          admitted: false,
          reason: "RATE_LIMITED",
          retryAfterSeconds,
        };
      }

      this.ctx.storage.sql.exec(
        "INSERT INTO write_admissions (key_hash, admitted_at) VALUES (?, ?)",
        keyHash,
        now,
      );
      this.ctx.storage.sql.exec(
        `INSERT INTO write_operations
          (key_hash, request_hash, status, phase, created_at, updated_at)
         VALUES (?, ?, 'IN_PROGRESS', 'RESERVED', ?, ?)`,
        keyHash,
        requestHash,
        now,
        now,
      );
      return {
        admitted: true,
        replay: false,
        operation: this.readOperation(keyHash),
      };
    });
  }

  transitionOperation(input) {
    if (!input || typeof input !== "object") throw new TypeError("input must be an object.");
    const { keyHash, expectedPhase, nextPhase, leaseGeneration = 1 } = input;
    const now = Date.now();
    assertHash(keyHash, "keyHash");
    if (!Number.isSafeInteger(leaseGeneration) || leaseGeneration < 1) throw new TypeError("leaseGeneration must be a positive safe integer.");
    const expectedIndex = PHASES.indexOf(expectedPhase);
    if (expectedIndex < 0 || PHASES[expectedIndex + 1] !== nextPhase) {
      throw new TypeError("nextPhase must be the immediate successor of expectedPhase.");
    }
    const status = input.status ?? "IN_PROGRESS";
    if (!STATUSES.has(status)) throw new TypeError("Unsupported operation status.");
    if (nextPhase === "PR_CREATED" && status !== "SUCCEEDED") {
      throw new TypeError("PR_CREATED operations must be SUCCEEDED.");
    }
    if (status === "SUCCEEDED" && nextPhase !== "PR_CREATED") {
      throw new TypeError("Only PR_CREATED operations may be SUCCEEDED.");
    }

    const metadata = input.metadata ?? {};
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
      throw new TypeError("metadata must be an object.");
    }
    for (const key of Object.keys(metadata)) {
      if (!METADATA_FIELDS.has(key)) throw new TypeError("Unsupported operation metadata field.");
    }
    const branchName = metadata.branchName ?? null;
    const commitSha = metadata.commitSha ?? null;
    const prNumber = metadata.prNumber ?? null;
    const prUrl = metadata.prUrl ?? null;
    const errorCode = metadata.errorCode ?? null;
    const gitMetadata = {};
    for (const key of ["baseTreeSha", "parentSha", "treeSha", "commitDate", "commitMessage", "authorName", "authorEmail", "committerName", "committerEmail"]) {
      if (metadata[key] !== undefined) gitMetadata[key] = metadata[key];
    }
    for (const key of ["baseTreeSha", "parentSha", "treeSha"]) {
      if (gitMetadata[key] !== undefined && (typeof gitMetadata[key] !== "string" || !/^[a-f0-9]{40}$/.test(gitMetadata[key]))) {
        throw new TypeError(key + " must be a Git SHA.");
      }
    }
    if (gitMetadata.commitDate !== undefined && (typeof gitMetadata.commitDate !== "string" || !Number.isFinite(Date.parse(gitMetadata.commitDate)) || new Date(gitMetadata.commitDate).toISOString() !== gitMetadata.commitDate)) {
      throw new TypeError("commitDate must be a canonical UTC ISO timestamp.");
    }
    if (gitMetadata.commitMessage !== undefined && (typeof gitMetadata.commitMessage !== "string" || gitMetadata.commitMessage.length < 1 || gitMetadata.commitMessage.length > 500)) {
      throw new TypeError("commitMessage must contain 1-500 characters.");
    }
    for (const key of ["authorName", "committerName"]) {
      if (gitMetadata[key] !== undefined && (typeof gitMetadata[key] !== "string" || gitMetadata[key].length < 1 || gitMetadata[key].length > 100 || gitMetadata[key].includes("\r") || gitMetadata[key].includes("\n") || gitMetadata[key].includes("\0"))) {
        throw new TypeError(key + " is invalid.");
      }
    }
    for (const key of ["authorEmail", "committerEmail"]) {
      if (gitMetadata[key] !== undefined && (typeof gitMetadata[key] !== "string" || gitMetadata[key].length > 254 || !/^[^\s@]+@[^\s@]+$/.test(gitMetadata[key]))) {
        throw new TypeError(key + " is invalid.");
      }
    }
    if (nextPhase === "COMMIT_DISPATCHED") {
      for (const key of ["commitDate", "commitMessage", "authorName", "authorEmail", "committerName", "committerEmail"]) {
        if (typeof gitMetadata[key] !== "string" || !gitMetadata[key]) throw new TypeError("COMMIT_DISPATCHED requires persisted " + key + ".");
      }
    }
    if (branchName !== null && (typeof branchName !== "string" || branchName.length > 255)) {
      throw new TypeError("branchName is invalid.");
    }
    if (commitSha !== null && (typeof commitSha !== "string" || !/^[a-f0-9]{40}$/.test(commitSha))) {
      throw new TypeError("commitSha must be a Git SHA.");
    }
    if (prNumber !== null && (!Number.isSafeInteger(prNumber) || prNumber < 1)) {
      throw new TypeError("prNumber must be a positive integer.");
    }
    if (prUrl !== null && (typeof prUrl !== "string" || prUrl.length > 2048 || !isPullRequestUrl(prUrl,prNumber))) {
      throw new TypeError("pull URL must match the PR number.");
    }
    if (errorCode !== null && (typeof errorCode !== "string" || !/^[A-Z0-9_]{1,64}$/.test(errorCode))) {
      throw new TypeError("errorCode is invalid.");
    }

    return this.ctx.storage.transactionSync(() => {
      const current = this.readOperation(keyHash);
      if (!current) return { updated: false, reason: "NOT_FOUND" };
      const mergedGitMetadata = { ...(current.gitMetadata ?? {}), ...gitMetadata };
      if (current.leaseGeneration !== leaseGeneration) return { updated: false, reason: "LEASE_FENCE_MISMATCH", operation: current };
      if (current.phase !== expectedPhase) {
        return { updated: false, reason: "PHASE_CONFLICT", operation: current };
      }
      if (current.status !== "IN_PROGRESS") {
        return { updated: false, reason: "STATUS_CONFLICT", operation: current };
      }

      for (const [field,value] of Object.entries(gitMetadata)) {
        if (current.gitMetadata?.[field]!==undefined && current.gitMetadata[field]!==value) {
          return {updated:false,reason:"OPERATION_IDENTITY_MISMATCH",operation:current};
        }
      }
      const effectiveBranchName=branchName??current.branchName;
      const effectiveCommitSha=commitSha??current.commitSha;
      const effectivePrNumber=prNumber??current.prNumber;
      const effectivePrUrl=prUrl??current.prUrl;
      if (current.commitSha && commitSha && current.commitSha!==commitSha) {
        return { updated:false,reason:"OPERATION_IDENTITY_MISMATCH",operation:current };
      }
      if (current.branchName && branchName && current.branchName!==branchName) {
        return { updated:false,reason:"OPERATION_IDENTITY_MISMATCH",operation:current };
      }
      if (current.prNumber && prNumber && current.prNumber!==prNumber) {
        return { updated:false,reason:"OPERATION_IDENTITY_MISMATCH",operation:current };
      }
      if (current.prUrl && prUrl && current.prUrl!==prUrl) {
        return { updated:false,reason:"OPERATION_IDENTITY_MISMATCH",operation:current };
      }
      if (branchName!==null && branchName!=="assistant/mcp-"+keyHash) {
        throw new TypeError("branchName must match the deterministic operation identity.");
      }
      if (nextPhase==="TREE_DISPATCHED" && (!gitMetadata.baseTreeSha || !gitMetadata.parentSha)) {
        throw new TypeError("TREE_DISPATCHED requires baseTreeSha and parentSha.");
      }
      if (nextPhase==="TREE_WRITTEN" && (!gitMetadata.treeSha || !current.gitMetadata?.baseTreeSha || !current.gitMetadata?.parentSha)) {
        throw new TypeError("TREE_WRITTEN requires treeSha and persisted baseTreeSha and parentSha.");
      }
      if (nextPhase==="COMMIT_DISPATCHED" && (!current.gitMetadata?.treeSha || !current.gitMetadata?.parentSha)) {
        throw new TypeError("COMMIT_DISPATCHED requires persisted treeSha and parentSha.");
      }
      if (nextPhase==="COMMIT_WRITTEN" && (!commitSha || !current.gitMetadata?.treeSha || !current.gitMetadata?.parentSha)) {
        throw new TypeError("COMMIT_WRITTEN requires commitSha and persisted Git tree identity.");
      }
      if (nextPhase==="BRANCH_WRITTEN" && (effectiveBranchName!=="assistant/mcp-"+keyHash || !effectiveCommitSha)) {
        throw new TypeError("BRANCH_WRITTEN requires deterministic branchName and persisted commitSha.");
      }
      if (nextPhase==="PR_DISPATCHED" && (effectiveBranchName!=="assistant/mcp-"+keyHash || !effectiveCommitSha)) {
        throw new TypeError("PR_DISPATCHED requires deterministic branchName and persisted commitSha.");
      }
      if (nextPhase==="PR_CREATED") {
        if (effectiveBranchName!=="assistant/mcp-"+keyHash || !effectiveCommitSha || !effectivePrNumber || !effectivePrUrl) {
          throw new TypeError("PR_CREATED requires deterministic branch, commit, PR number and URL.");
        }
        if (!isPullRequestUrl(effectivePrUrl,effectivePrNumber)) {
          throw new TypeError("pull URL must match the PR number.");
        }
      }
      this.ctx.storage.sql.exec(
        `UPDATE write_operations
         SET phase = ?, status = ?, updated_at = ?,
             branch_name = COALESCE(?, branch_name),
             commit_sha = COALESCE(?, commit_sha),
             pr_number = COALESCE(?, pr_number),
             pr_url = COALESCE(?, pr_url),
             error_code = COALESCE(?, error_code),
             git_metadata = ?
         WHERE key_hash = ? AND phase = ? AND status = 'IN_PROGRESS'`,
        nextPhase,
        status,
        now,
        branchName,
        commitSha,
        prNumber,
        prUrl,
        errorCode,
        JSON.stringify(mergedGitMetadata),
        keyHash,
        expectedPhase,
      );
      const updatedOperation=this.readOperation(keyHash);
      const gitMetadataPersisted=updatedOperation && Object.entries(mergedGitMetadata).every(
        ([field,value])=>updatedOperation.gitMetadata?.[field]===value
      );
      if (!updatedOperation || updatedOperation.phase!==nextPhase || updatedOperation.status!==status ||
          !gitMetadataPersisted ||
          (commitSha && updatedOperation.commitSha!==commitSha) ||
          (branchName && updatedOperation.branchName!==branchName) ||
          (prNumber && updatedOperation.prNumber!==prNumber) ||
          (prUrl && updatedOperation.prUrl!==prUrl)) {
        return { updated:false,reason:"PERSISTENCE_VERIFICATION_FAILED",operation:updatedOperation };
      }
      return { updated: true, operation: updatedOperation };
    });
  }


  reconcileTreeWritten(input) {
    if (!input || typeof input !== "object") throw new TypeError("input must be an object.");
    const { keyHash, baseTreeSha, parentSha, treeSha , leaseGeneration } = input;
    if (!Number.isSafeInteger(leaseGeneration) || leaseGeneration < 1) throw new TypeError("leaseGeneration is required and must be a positive safe integer.");
    const now = Date.now();
    assertHash(keyHash, "keyHash");
    for (const [field, value] of Object.entries({ baseTreeSha, parentSha, treeSha })) {
      if (typeof value !== "string" || !/^[a-f0-9]{40}$/.test(value)) throw new TypeError(field + " must be a Git SHA.");
    }
    return this.ctx.storage.transactionSync(() => {
      const current = this.readOperation(keyHash);
      if (!current) return { updated: false, reason: "NOT_FOUND" };
      if (current.leaseGeneration !== leaseGeneration) return { updated: false, reason: "LEASE_FENCE_MISMATCH", operation: current };
      if (current.status !== "UNKNOWN" || !["TREE_DISPATCHED", "TREE_WRITTEN"].includes(current.phase)) {
        return { updated: false, reason: "RECONCILIATION_NOT_ALLOWED", operation: current };
      }
      if (current.gitMetadata?.baseTreeSha !== baseTreeSha || current.gitMetadata?.parentSha !== parentSha ||
          (current.phase === "TREE_WRITTEN" && current.gitMetadata?.treeSha !== treeSha)) {
        return { updated: false, reason: "OPERATION_IDENTITY_MISMATCH", operation: current };
      }
      const merged = { ...current.gitMetadata, treeSha };
      this.ctx.storage.sql.exec(
        `UPDATE write_operations
         SET phase = 'TREE_WRITTEN', status = 'IN_PROGRESS', updated_at = ?, git_metadata = ?, error_code = NULL, lease_generation = lease_generation + 1
         WHERE key_hash = ? AND status = 'UNKNOWN'`,
        now,
        JSON.stringify(merged),
        keyHash,
      );
      const updatedOperation = this.readOperation(keyHash);
      if (!updatedOperation || updatedOperation.status !== "IN_PROGRESS" || updatedOperation.phase !== "TREE_WRITTEN" || updatedOperation.gitMetadata?.treeSha !== treeSha || updatedOperation.leaseGeneration !== current.leaseGeneration + 1) {
        return { updated: false, reason: "RECONCILIATION_CONFLICT", operation: updatedOperation };
      }
      return { updated: true, operation: updatedOperation };
    });
  }

  reconcileCommitWritten(input) {
    if (!input || typeof input !== "object") throw new TypeError("input must be an object.");
    const { keyHash, treeSha, parentSha, commitSha , leaseGeneration } = input;
    if (!Number.isSafeInteger(leaseGeneration) || leaseGeneration < 1) throw new TypeError("leaseGeneration is required and must be a positive safe integer.");
    const now = Date.now();
    assertHash(keyHash, "keyHash");
    for (const [field, value] of Object.entries({ treeSha, parentSha, commitSha })) {
      if (typeof value !== "string" || !/^[a-f0-9]{40}$/.test(value)) throw new TypeError(field + " must be a Git SHA.");
    }
    return this.ctx.storage.transactionSync(() => {
      const current = this.readOperation(keyHash);
      if (!current) return { updated: false, reason: "NOT_FOUND" };
      if (current.leaseGeneration !== leaseGeneration) return { updated: false, reason: "LEASE_FENCE_MISMATCH", operation: current };
      if (current.status !== "UNKNOWN" || current.phase !== "COMMIT_DISPATCHED") {
        return { updated: false, reason: "RECONCILIATION_NOT_ALLOWED", operation: current };
      }
      if (current.gitMetadata?.treeSha !== treeSha || current.gitMetadata?.parentSha !== parentSha ||
          typeof current.gitMetadata?.commitDate !== "string" || typeof current.gitMetadata?.commitMessage !== "string" ||
          typeof current.gitMetadata?.authorName !== "string" || typeof current.gitMetadata?.authorEmail !== "string" ||
          typeof current.gitMetadata?.committerName !== "string" || typeof current.gitMetadata?.committerEmail !== "string") {
        return { updated: false, reason: "OPERATION_IDENTITY_MISMATCH", operation: current };
      }
      this.ctx.storage.sql.exec(
        `UPDATE write_operations
         SET phase = 'COMMIT_WRITTEN', status = 'IN_PROGRESS', updated_at = ?, commit_sha = ?, error_code = NULL, lease_generation = lease_generation + 1
         WHERE key_hash = ? AND status = 'UNKNOWN' AND phase = 'COMMIT_DISPATCHED'`,
        now,
        commitSha,
        keyHash,
      );
      const updatedOperation=this.readOperation(keyHash);
      if (!updatedOperation || updatedOperation.status!=="IN_PROGRESS" || updatedOperation.phase!=="COMMIT_WRITTEN" || updatedOperation.commitSha!==commitSha || updatedOperation.leaseGeneration!==current.leaseGeneration+1) {
        return { updated:false,reason:"RECONCILIATION_CONFLICT",operation:updatedOperation };
      }
      return { updated: true, operation: updatedOperation };
    });
  }

  reconcileBranchWritten(input) {
    if (!input || typeof input !== "object") throw new TypeError("input must be an object.");
    const { keyHash, branchName, commitSha , leaseGeneration } = input;
    if (!Number.isSafeInteger(leaseGeneration) || leaseGeneration < 1) throw new TypeError("leaseGeneration is required and must be a positive safe integer.");
    const now = Date.now();
    assertHash(keyHash, "keyHash");
    if (branchName !== "assistant/mcp-" + keyHash) throw new TypeError("branchName does not match the deterministic operation identity.");
    if (typeof commitSha !== "string" || !/^[a-f0-9]{40}$/.test(commitSha)) throw new TypeError("commitSha must be a Git SHA.");
    return this.ctx.storage.transactionSync(() => {
      const current = this.readOperation(keyHash);
      if (!current) return { updated: false, reason: "NOT_FOUND" };
      if (current.leaseGeneration !== leaseGeneration) return { updated: false, reason: "LEASE_FENCE_MISMATCH", operation: current };
      if (current.status !== "UNKNOWN" || !["COMMIT_WRITTEN", "BRANCH_WRITTEN"].includes(current.phase)) {
        return { updated: false, reason: "RECONCILIATION_NOT_ALLOWED", operation: current };
      }
      if (current.commitSha !== commitSha || (current.branchName && current.branchName!==branchName)) {
        return { updated: false, reason: "OPERATION_IDENTITY_MISMATCH", operation: current };
      }
      this.ctx.storage.sql.exec(
        `UPDATE write_operations
         SET phase = 'BRANCH_WRITTEN', status = 'IN_PROGRESS', updated_at = ?,
             branch_name = ?, error_code = NULL, lease_generation = lease_generation + 1
         WHERE key_hash = ? AND status = 'UNKNOWN' AND phase IN ('COMMIT_WRITTEN', 'BRANCH_WRITTEN')`,
        now,
        branchName,
        keyHash,
      );
      const updatedOperation=this.readOperation(keyHash);
      if (!updatedOperation || updatedOperation.status!=="IN_PROGRESS" || updatedOperation.phase!=="BRANCH_WRITTEN" ||
          updatedOperation.branchName!==branchName || updatedOperation.commitSha!==commitSha || updatedOperation.leaseGeneration!==current.leaseGeneration+1) {
        return { updated:false,reason:"RECONCILIATION_CONFLICT",operation:updatedOperation };
      }
      return { updated: true, operation: updatedOperation };
    });
  }

  reconcilePrCreated(input) {
    if (!input || typeof input !== "object") throw new TypeError("input must be an object.");
    const { keyHash, branchName, commitSha, prNumber, prUrl , leaseGeneration } = input;
    if (!Number.isSafeInteger(leaseGeneration) || leaseGeneration < 1) throw new TypeError("leaseGeneration is required and must be a positive safe integer.");
    const now = Date.now();
    assertHash(keyHash, "keyHash");
    if (branchName !== "assistant/mcp-" + keyHash) throw new TypeError("branchName does not match the deterministic operation identity.");
    if (typeof commitSha !== "string" || !/^[a-f0-9]{40}$/.test(commitSha)) throw new TypeError("commitSha must be a Git SHA.");
    if (!Number.isSafeInteger(prNumber) || prNumber < 1) throw new TypeError("prNumber must be a positive integer.");
    if (typeof prUrl !== "string" || prUrl.length > 2048 || !isPullRequestUrl(prUrl,prNumber)) {
      throw new TypeError("prUrl must be the canonical GitHub URL for prNumber.");
    }
    return this.ctx.storage.transactionSync(() => {
      const current = this.readOperation(keyHash);
      if (!current) return { updated: false, reason: "NOT_FOUND" };
      if (current.leaseGeneration !== leaseGeneration) return { updated: false, reason: "LEASE_FENCE_MISMATCH", operation: current };
      if (current.status !== "UNKNOWN" || current.phase !== "PR_DISPATCHED") {
        return { updated: false, reason: "RECONCILIATION_NOT_ALLOWED", operation: current };
      }
      if (current.branchName !== branchName || current.commitSha !== commitSha) {
        return { updated: false, reason: "OPERATION_IDENTITY_MISMATCH", operation: current };
      }
      this.ctx.storage.sql.exec(
        `UPDATE write_operations
         SET phase = 'PR_CREATED', status = 'SUCCEEDED', updated_at = ?, pr_number = ?, pr_url = ?, error_code = NULL, lease_generation = lease_generation + 1
         WHERE key_hash = ? AND status = 'UNKNOWN' AND phase = 'PR_DISPATCHED'`,
        now,
        prNumber,
        prUrl,
        keyHash,
      );
      const updatedOperation=this.readOperation(keyHash);
      if (!updatedOperation || updatedOperation.status!=="SUCCEEDED" || updatedOperation.phase!=="PR_CREATED" ||
          updatedOperation.prNumber!==prNumber || updatedOperation.prUrl!==prUrl || updatedOperation.leaseGeneration!==current.leaseGeneration+1) {
        return { updated:false,reason:"RECONCILIATION_CONFLICT",operation:updatedOperation };
      }
      return { updated: true, operation: updatedOperation };
    });
  }

  markOperationStatus(input) {
    if (!input || typeof input !== "object") throw new TypeError("input must be an object.");
    const { keyHash, status, errorCode, leaseGeneration = 1 } = input;
    const now = Date.now();
    assertHash(keyHash, "keyHash");
    if (!Number.isSafeInteger(leaseGeneration) || leaseGeneration < 1) throw new TypeError("leaseGeneration must be a positive safe integer.");
    if (status !== "FAILED" && status !== "UNKNOWN") {
      throw new TypeError("Only FAILED or UNKNOWN may be assigned outside a phase transition.");
    }
    if (errorCode !== undefined && (typeof errorCode !== "string" || !/^[A-Z0-9_]{1,64}$/.test(errorCode))) {
      throw new TypeError("errorCode is invalid.");
    }
    return this.ctx.storage.transactionSync(() => {
      const current = this.readOperation(keyHash);
      if (!current) return { updated: false, reason: "NOT_FOUND" };
      if (current.leaseGeneration !== leaseGeneration) return { updated: false, reason: "LEASE_FENCE_MISMATCH", operation: current };
      if (current.status !== "IN_PROGRESS") {
        return { updated: false, reason: "STATUS_CONFLICT", operation: current };
      }
      this.ctx.storage.sql.exec(
        "UPDATE write_operations SET status = ?, updated_at = ?, error_code = ?, lease_generation = lease_generation + 1 WHERE key_hash = ? AND status = 'IN_PROGRESS' AND lease_generation = ?",
        status,
        now,
        errorCode ?? null,
        keyHash,
        leaseGeneration,
      );
      const updatedOperation=this.readOperation(keyHash);
      if (!updatedOperation || updatedOperation.status!==status || updatedOperation.errorCode!==(errorCode??null) || updatedOperation.leaseGeneration!==leaseGeneration+1) {
        return { updated:false,reason:"PERSISTENCE_VERIFICATION_FAILED",operation:updatedOperation };
      }
      return { updated: true, operation: updatedOperation };
    });
  }

  reopenReserved(input) {
    if (!input || typeof input !== "object") throw new TypeError("input must be an object.");
    const { keyHash, leaseGeneration } = input;
    if (!Number.isSafeInteger(leaseGeneration) || leaseGeneration < 1) throw new TypeError("leaseGeneration is required and must be a positive safe integer.");
    const now = Date.now();
    assertHash(keyHash, "keyHash");
    if (leaseGeneration !== undefined && (!Number.isSafeInteger(leaseGeneration) || leaseGeneration < 1)) throw new TypeError("leaseGeneration must be a positive safe integer.");
    return this.ctx.storage.transactionSync(() => {
      const current = this.readOperation(keyHash);
      if (!current) return { updated: false, reason: "NOT_FOUND" };
      if (current.leaseGeneration !== leaseGeneration) return { updated: false, reason: "LEASE_FENCE_MISMATCH", operation: current };
      if (current.status !== "UNKNOWN" || current.phase !== "RESERVED") {
        return { updated: false, reason: "RECONCILIATION_NOT_ALLOWED", operation: current };
      }
      this.ctx.storage.sql.exec(
        "UPDATE write_operations SET status = 'IN_PROGRESS', updated_at = ?, error_code = NULL, lease_generation = lease_generation + 1 WHERE key_hash = ? AND status = 'UNKNOWN' AND phase = 'RESERVED'",
        now,
        keyHash,
      );
      const updatedOperation = this.readOperation(keyHash);
      if (!updatedOperation || updatedOperation.status !== "IN_PROGRESS" || updatedOperation.phase !== "RESERVED" || updatedOperation.leaseGeneration !== current.leaseGeneration + 1) {
        return { updated: false, reason: "PERSISTENCE_VERIFICATION_FAILED", operation: updatedOperation };
      }
      return { updated: true, operation: updatedOperation };
    });
  }

  markStaleOperationsUnknown(input) {
    if (!input || typeof input !== "object") throw new TypeError("input must be an object.");
    const { leaseMs } = input;
    const now = Date.now();
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 86_400_000) {
      throw new TypeError("leaseMs must be an integer between 1 and 86400000.");
    }
    return this.ctx.storage.transactionSync(() => {
      const result = this.ctx.storage.sql.exec(
        `UPDATE write_operations
         SET status = 'UNKNOWN', updated_at = ?, lease_generation = lease_generation + 1
         WHERE status = 'IN_PROGRESS' AND updated_at <= ?`,
        now,
        now - leaseMs,
      );
      return result.rowsWritten;
    });
  }
}
