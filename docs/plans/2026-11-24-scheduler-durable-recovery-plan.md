# Scheduler Durable Recovery Implementation Plan

**Branch:** `security/tenant-admission-version-fence-2026-11-24`  
**PR:** #426  
**Execution mode:** Atomic commits, guarded branch updates, test-first, no deploy/merge

## Tasks

- [x] Add a read-only Ledger admission receipt probe with safe projection, scope/digest matching, and explicit not-found/conflict outcomes.
- [x] Add Directory Grant renewal with exact membership/policy snapshot revalidation, five-second clock-skew fence, compare-and-swap reservation update, and append-only audit atomicity.
- [x] Add hostile Directory tests for revocation, concurrent renewal, early renewal, and audit failure rollback.
- [x] Extract canonical scheduler preflight, Workflow snapshot verification, and one-Task admission adapter; probe Ledger before Directory.
- [x] Add Cron-native Workflow execution using platform `event.schedule` metadata and durable preparation/Task steps.
- [x] Add test coverage for retry, replay deduplication, partial-batch failure, lost Ledger response after commit, Grant expiry, snapshot tampering, and missing schedule metadata.
- [x] Isolate scheduler Worker and Wrangler configuration from the public Worker; use remote `chat-gpt111` Durable Object namespace bindings.
- [x] Add CI syntax and Wrangler dry-run for both scheduler test and production configurations.
- [x] Verify CI for the source HEAD: 197 Node tests, 76 Durable Object tests, 5 Scheduler Workflow tests, npm audit, syntax checks, and all four Wrangler dry-runs passed. A docs-only evidence commit follows; its own CI is rechecked separately.
- [x] Review Full History Secret Scan findings: PR diff scan is clean; 13 historical detections remain unresolved and are not waived.
- [x] Verify PR remains Draft/open on the isolated branch with the original main base SHA.
- [x] Keep production schedule absent; activation requires separate authorization and staging review.
