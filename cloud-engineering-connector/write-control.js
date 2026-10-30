import { DurableObject } from "cloudflare:workers";

const PHASES = [
  "RESERVED",
  "TREE_WRITTEN",
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
]);

function assertHash(value, field) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new TypeError(field + " must be a lowercase SHA-256 hex digest.");
  }
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
    branchName: row.branch_name,
    commitSha: row.commit_sha,
    prNumber: row.pr_number,
    prUrl: row.pr_url,
    errorCode: row.error_code,
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
          phase TEXT NOT NULL CHECK (phase IN ('RESERVED','TREE_WRITTEN','COMMIT_WRITTEN','BRANCH_WRITTEN','PR_DISPATCHED','PR_CREATED')),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          branch_name TEXT,
          commit_sha TEXT,
          pr_number INTEGER,
          pr_url TEXT,
          error_code TEXT
        )
      `);
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
    if (!Number.isSafeInteger(windowMs) || windowMs < 1 || windowMs > 3_600_000) {
      throw new TypeError("windowMs must be an integer between 1 and 3600000.");
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
      throw new TypeError("limit must be an integer between 1 and 10000.");
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
    const { keyHash, expectedPhase, nextPhase } = input;
    const now = Date.now();
    assertHash(keyHash, "keyHash");
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
    if (branchName !== null && (typeof branchName !== "string" || branchName.length > 255)) {
      throw new TypeError("branchName is invalid.");
    }
    if (commitSha !== null && (typeof commitSha !== "string" || !/^[a-f0-9]{40}$/.test(commitSha))) {
      throw new TypeError("commitSha must be a Git SHA.");
    }
    if (prNumber !== null && (!Number.isSafeInteger(prNumber) || prNumber < 1)) {
      throw new TypeError("prNumber must be a positive integer.");
    }
    if (prUrl !== null && (typeof prUrl !== "string" || prUrl.length > 2048 || !/^https:\/\/github\.com\//.test(prUrl))) {
      throw new TypeError("prUrl must be a GitHub HTTPS URL.");
    }
    if (errorCode !== null && (typeof errorCode !== "string" || !/^[A-Z0-9_]{1,64}$/.test(errorCode))) {
      throw new TypeError("errorCode is invalid.");
    }

    return this.ctx.storage.transactionSync(() => {
      const current = this.readOperation(keyHash);
      if (!current) return { updated: false, reason: "NOT_FOUND" };
      if (current.phase !== expectedPhase) {
        return { updated: false, reason: "PHASE_CONFLICT", operation: current };
      }
      if (current.status !== "IN_PROGRESS") {
        return { updated: false, reason: "STATUS_CONFLICT", operation: current };
      }
      this.ctx.storage.sql.exec(
        `UPDATE write_operations
         SET phase = ?, status = ?, updated_at = ?,
             branch_name = COALESCE(?, branch_name),
             commit_sha = COALESCE(?, commit_sha),
             pr_number = COALESCE(?, pr_number),
             pr_url = COALESCE(?, pr_url),
             error_code = COALESCE(?, error_code)
         WHERE key_hash = ? AND phase = ? AND status = 'IN_PROGRESS'`,
        nextPhase,
        status,
        now,
        branchName,
        commitSha,
        prNumber,
        prUrl,
        errorCode,
        keyHash,
        expectedPhase,
      );
      return { updated: true, operation: this.readOperation(keyHash) };
    });
  }

  reconcileBranchWritten(input) {
    if (!input || typeof input !== "object") throw new TypeError("input must be an object.");
    const { keyHash, branchName, commitSha } = input;
    const now = Date.now();
    assertHash(keyHash, "keyHash");
    if (branchName !== "assistant/mcp-" + keyHash) throw new TypeError("branchName does not match the deterministic operation identity.");
    if (typeof commitSha !== "string" || !/^[a-f0-9]{40}$/.test(commitSha)) throw new TypeError("commitSha must be a Git SHA.");
    return this.ctx.storage.transactionSync(() => {
      const current = this.readOperation(keyHash);
      if (!current) return { updated: false, reason: "NOT_FOUND" };
      if (current.status !== "UNKNOWN" || !["COMMIT_WRITTEN", "BRANCH_WRITTEN"].includes(current.phase)) {
        return { updated: false, reason: "RECONCILIATION_NOT_ALLOWED", operation: current };
      }
      if (current.commitSha !== commitSha) {
        return { updated: false, reason: "OPERATION_IDENTITY_MISMATCH", operation: current };
      }
      this.ctx.storage.sql.exec(
        `UPDATE write_operations
         SET phase = 'BRANCH_WRITTEN', status = 'IN_PROGRESS', updated_at = ?,
             branch_name = ?, error_code = NULL
         WHERE key_hash = ? AND status = 'UNKNOWN' AND phase IN ('COMMIT_WRITTEN', 'BRANCH_WRITTEN')`,
        now,
        branchName,
        keyHash,
      );
      return { updated: true, operation: this.readOperation(keyHash) };
    });
  }

  reconcilePrCreated(input) {
    if (!input || typeof input !== "object") throw new TypeError("input must be an object.");
    const { keyHash, branchName, commitSha, prNumber, prUrl } = input;
    const now = Date.now();
    assertHash(keyHash, "keyHash");
    if (typeof branchName !== "string" || branchName.length > 255) throw new TypeError("branchName is invalid.");
    if (typeof commitSha !== "string" || !/^[a-f0-9]{40}$/.test(commitSha)) throw new TypeError("commitSha must be a Git SHA.");
    if (!Number.isSafeInteger(prNumber) || prNumber < 1) throw new TypeError("prNumber must be a positive integer.");
    if (typeof prUrl !== "string" || prUrl.length > 2048 || !/^https:\/\/github\.com\//.test(prUrl)) {
      throw new TypeError("prUrl must be a GitHub HTTPS URL.");
    }
    return this.ctx.storage.transactionSync(() => {
      const current = this.readOperation(keyHash);
      if (!current) return { updated: false, reason: "NOT_FOUND" };
      if (current.status !== "UNKNOWN" || current.phase !== "PR_DISPATCHED") {
        return { updated: false, reason: "RECONCILIATION_NOT_ALLOWED", operation: current };
      }
      if (current.branchName !== branchName || current.commitSha !== commitSha) {
        return { updated: false, reason: "OPERATION_IDENTITY_MISMATCH", operation: current };
      }
      this.ctx.storage.sql.exec(
        `UPDATE write_operations
         SET phase = 'PR_CREATED', status = 'SUCCEEDED', updated_at = ?, pr_number = ?, pr_url = ?, error_code = NULL
         WHERE key_hash = ? AND status = 'UNKNOWN' AND phase = 'PR_DISPATCHED'`,
        now,
        prNumber,
        prUrl,
        keyHash,
      );
      return { updated: true, operation: this.readOperation(keyHash) };
    });
  }

  markOperationStatus(input) {
    if (!input || typeof input !== "object") throw new TypeError("input must be an object.");
    const { keyHash, status, errorCode } = input;
    const now = Date.now();
    assertHash(keyHash, "keyHash");
    if (status !== "FAILED" && status !== "UNKNOWN") {
      throw new TypeError("Only FAILED or UNKNOWN may be assigned outside a phase transition.");
    }
    if (errorCode !== undefined && (typeof errorCode !== "string" || !/^[A-Z0-9_]{1,64}$/.test(errorCode))) {
      throw new TypeError("errorCode is invalid.");
    }
    return this.ctx.storage.transactionSync(() => {
      const current = this.readOperation(keyHash);
      if (!current) return { updated: false, reason: "NOT_FOUND" };
      if (current.status !== "IN_PROGRESS") {
        return { updated: false, reason: "STATUS_CONFLICT", operation: current };
      }
      this.ctx.storage.sql.exec(
        "UPDATE write_operations SET status = ?, updated_at = ?, error_code = ? WHERE key_hash = ? AND status = 'IN_PROGRESS'",
        status,
        now,
        errorCode ?? null,
        keyHash,
      );
      return { updated: true, operation: this.readOperation(keyHash) };
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
         SET status = 'UNKNOWN', updated_at = ?
         WHERE status = 'IN_PROGRESS' AND updated_at <= ?`,
        now,
        now - leaseMs,
      );
      return result.rowsWritten;
    });
  }
}
