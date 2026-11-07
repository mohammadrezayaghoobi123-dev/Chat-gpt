# P2 — GitHub-Native Intake and Bounded Execution Plan

**Status:** Planning only. This document does not authorize deployment, production traffic, secret changes, merges, or live task execution.

## Goal

Add a GitHub-native task-intake and bounded execution path that can accept only explicitly authorized GitHub events, normalize them into the P1 task/message contracts, and run isolated, task-scoped checks on GitHub-hosted Actions. GitHub remains the source of truth for issues, branches, pull requests, commits, CI, and review evidence.

## Baseline and known constraints

- P1 implementation is on `feature/orchestrator-p1-core-2026-11-04`, PR #151, currently Draft.
- P1 deterministic core and local Durable Object contract tests passed on head `460794ed97dcce1c38af9e873733d7ca70c172bd`.
- P1's `ORCHESTRATOR_LEDGER` binding/migration exists only in source configuration; no live namespace migration or deployment is authorized or proven.
- Existing Connector Worker is public-read-only by default. P2 must not expose a new public write endpoint.
- Existing GitHub Actions workflows use minimal permissions in the Connector CI. Any new workflow must declare permissions per job and default to read-only.
- Open PRs #149 and #150 overlap P1 design/implementation. They remain untouched; resolve architectural overlap before merging P1 or stacking production-bound work.
- No verified sustainable zero-cost official ChatGPT API or Claude API invocation path exists. Both provider adapters remain disabled.
- No independently verified reviewer identity, branch-protection state, external audit checkpoint, or successful backup/restore drill is established.

## Non-goals and hard prohibitions

- No merge to `main`, protected branches, or Production.
- No Staging/Production deployment, Cloudflare binding migration, traffic shift, or live Worker mutation.
- No public MCP write route and no anonymous write capability.
- No GitHub App installation, OAuth scope change, repository permission change, branch-protection change, or secret mutation.
- No paid API, paid runner, paid hosting, plan upgrade, billing enablement, quota bypass, or paid fallback.
- No browser-session scraping, cookies, passwords, or consumer-subscription automation.
- No live ChatGPT/Claude invocation and no claim that mock adapters are real collaboration.
- No automatic task execution from free-form issue text or comments. Repository text is untrusted input.
- No task can write outside its immutable allowlisted branch/path scope. `main`, secrets, workflow definitions, CODEOWNERS, repository settings, billing, and deployment controls are excluded by default.
- Never rely on labels or issue authorship alone as authorization for a side effect.

## Proposed event and identity model

### Intake event source

Prefer GitHub-native Actions event payloads over a new public webhook server for the first iteration. Supported candidate triggers:

- `issues: opened, edited, labeled, reopened`
- `issue_comment: created` only if a later reviewed command grammar is approved
- `pull_request: opened, synchronize, reopened` for evidence collection only, not task creation by default

The first implementation must select exactly one task-creation trigger and one explicit allowlisted label. Until the project owner approves the exact label and authorized actor policy, intake remains dry-run only.

### Authenticity and authorization

- Use GitHub Actions event context and provider-delivered event payload; do not accept a caller-supplied actor ID as proof.
- If a raw webhook endpoint is introduced later, verify HMAC-SHA256 over the exact raw body with constant-time comparison, validate the GitHub delivery ID, enforce a replay window, and durably deduplicate delivery IDs before parsing or side effects.
- Separate GitHub's authenticated event actor from the project authorization decision. An authenticated GitHub user is not automatically an authorized task requester.
- Require a versioned owner-maintained allowlist of GitHub actor IDs (numeric immutable IDs preferred) and allowed event/action/label combinations. Unknown actor, missing actor ID, unknown event/action, stale payload, or allowlist unavailability must deny.
- Do not store or log webhook secrets, GitHub tokens, installation tokens, or authorization headers.
- Never use display names, email addresses, issue body text, or self-declared agent names as identity proof.

### Task envelope

Map an accepted event into a P1-compatible immutable task envelope:

- task ID, source event ID/delivery ID, repository ID and full name;
- authenticated GitHub actor ID and separate policy authorization result;
- issue/PR number and URL as evidence references;
- task objective and user-supplied text stored as untrusted data;
- input SHA-256 over canonicalized event/task inputs;
- base branch and immutable base SHA;
- dedicated non-protected task branch name;
- explicit allowed path patterns and denied path patterns;
- expiry/created timestamps, correlation ID, and protocol version;
- policy decision, policy version, and evidence references.

Do not copy arbitrary issue body content into executable shell, workflow expressions, filenames, branch names, or tool arguments.

## Execution model

### Workflow isolation

- Use standard GitHub-hosted runners only when the repository's actual free allowance is sufficient; otherwise pause. No larger or paid runner fallback.
- Set `permissions: contents: read` by default. Grant `contents: write` only to a narrowly scoped job that demonstrably needs to create a dedicated branch/commit, and only after a separately approved token/identity design.
- Never grant `issues: write`, `pull-requests: write`, `actions: write`, `deployments: write`, `administration: write`, or `secrets: write` in the first execution milestone.
- Pin every third-party Action to a full commit SHA. Do not use floating tags.
- Use explicit `timeout-minutes`, bounded matrix size, concurrency groups, cancellation behavior, and maximum artifact size/retention.
- Do not run untrusted pull-request code in a privileged `pull_request_target` workflow. Do not check out or execute fork code with write credentials.
- Keep untrusted task content as data. Use static command templates and validated structured inputs only.
- Restrict working directory, allowed paths, branch naming, and artifact paths. Reject symlinks/path traversal and unexpected generated files.
- Re-check the P1 stop switch and policy immediately before every write-capable side effect. If the stop switch cannot be read, stop.
- The first P2 milestone runs in dry-run/read-only mode and emits a sanitized intake decision artifact only.

### Side-effect sequence (future gated milestone)

1. Receive provider-authenticated event.
2. Validate event schema, action, repository ID, delivery ID, timestamp, actor ID, and deduplication state.
3. Evaluate actor/event/label allowlist and P1 policy; fail closed.
4. Create immutable task record and audit intent.
5. Resolve exact base ref/SHA and verify it is not a protected target.
6. Allocate a dedicated task branch/workspace under an approved namespace.
7. Run bounded checks in an isolated GitHub Actions job.
8. Verify resulting diff against path allowlist, denylist, size ceilings, and exact base SHA.
9. Publish sanitized artifacts and exact run/commit evidence.
10. Create/update a PR only after separate authorization is implemented and verified.
11. Require independent review on the exact head SHA; never self-approve or auto-merge.

P2 must not implement steps 5–10 with write permissions until the owner-approved actor allowlist, GitHub token strategy, branch-protection evidence, and independent reviewer are verified.

## Persistence and replay

- P1 OrchestratorLedger remains separate from KnowledgeStore. Do not place coordination tables in KnowledgeStore.
- Until a live ledger binding is separately approved and verified, the first milestone uses GitHub-native event/run artifacts only as non-authoritative diagnostic evidence; it must not pretend this is a durable transactional task ledger.
- Do not enable live ledger calls against an unproven namespace.
- Deduplicate provider deliveries by immutable delivery ID and normalized task inputs by deterministic idempotency key.
- Same idempotency key + same input hash is a replay/no-op. Same key + different hash is a conflict and quarantine.
- Unknown external outcome must be reconciled against GitHub's authoritative issue/branch/commit/run state before retry.
- Never claim global exactly-once delivery. State the guarantee as at-most-once effect through durable deduplication and reconciliation.

## Threat model and required controls

| Threat | Required control |
|---|---|
| Forged/replayed event | Provider signature or Actions event provenance, delivery ID deduplication, timestamp/replay policy |
| Unauthorized requester | Immutable actor-ID allowlist and explicit event/label policy |
| Prompt injection in issue/comment | Treat text as untrusted data; no command interpolation or policy override |
| Privileged workflow abuse | Least-privilege permissions, no `pull_request_target` execution of untrusted code |
| Token compromise | Short-lived least-privilege identity where available; no token in logs/artifacts |
| Branch/path escape | Dedicated branch, allowlist+denylist, diff validation, traversal/symlink checks |
| Concurrent duplicate runs | Concurrency group plus P1 idempotency/fencing when durable runtime is available |
| Stop-switch race | Re-check at side-effect boundary; unreadable means deny |
| Supply-chain compromise | SHA-pinned Actions, lockfile, dependency audit, restricted install scripts |
| Audit tampering | Immutable GitHub run/commit references plus later external audit anchor |
| Quota exhaustion | Bounded runs and immediate pause; no paid fallback |
| Reviewer collusion | Distinct verified reviewer identity and exact-SHA review gate |

## Implementation milestones and files

### P2-A — Read-only intake contract (first implementation)

Create:
- `.github/workflows/orchestrator-github-intake.yml`
- `cloud-engineering-connector/orchestrator-github-intake.js`
- `cloud-engineering-connector/test/orchestrator-github-intake.test.js`
- `docs/evidence/orchestrator-p2-intake-contract.md`

Tests:
- accept only the selected event/action/repository and schema version;
- reject missing or malformed delivery IDs, actor IDs, repository IDs, timestamps, and action names;
- reject unknown actor and unapproved label;
- reject replayed delivery ID;
- same task idempotency key with different input hash becomes conflict/quarantine;
- prove issue/comment text is not evaluated as shell, workflow expression, path, branch, or policy;
- reject protected branches, sensitive paths, traversal, symlink escape, and over-limit payloads;
- output sanitized decision with no credential-bearing fields;
- workflow permissions remain read-only and no deployment/write API is called.

Acceptance: all focused tests and Connector CI pass on exact SHA; workflow static audit proves only read permissions; no live side effect occurs.

### P2-B — Authorized task record and branch creation (separate approval gate)

Only after P2-A passes and the owner explicitly approves the exact actor-ID allowlist, event/label policy, and credential strategy:
- define short-lived task-scoped GitHub write identity;
- create a dedicated branch from an exact approved base SHA;
- persist task state and idempotency outcome in an approved durable ledger;
- re-check stop switch/policy before branch creation;
- add concurrency, replay, crash-recovery, and reconciliation tests.

No permission changes or token creation during P2-A.

### P2-C — Bounded execution and PR evidence (separate approval gate)

Only after P2-B and independent review identity are verified:
- run a fixed allowlisted test/build command set in isolated standard runners;
- enforce path/diff/size limits and no protected files;
- record exact SHA, workflow run ID, test commands/results, and sanitized artifact references;
- PR creation remains disabled until explicitly authorized and its identity scope reviewed;
- no merge or deployment.

## Required test commands

- `cd cloud-engineering-connector && node --test test/orchestrator-github-intake.test.js`
- `cd cloud-engineering-connector && npm run test:node`
- `cd cloud-engineering-connector && npm run check`
- Full GitHub Actions workflow and secret-history scan on the exact candidate SHA.
- Inspect job permissions and pinned Action SHAs from the rendered workflow, not just source review.

## Exit criteria

P2-A is complete only when read-only intake validation, replay rejection, authorization denial, prompt-injection resistance, workflow-permission audit, and full CI all pass on the exact final SHA.

P2-B and P2-C remain blocked until their separate owner authorization and external prerequisites are satisfied. P2 completion does not prove live ChatGPT/Claude adapters, Cloudflare namespace readiness, independent review, Staging acceptance, or Production readiness.

## Explicit open decisions (must not be guessed)

1. Exact authorized GitHub actor IDs and owner approval evidence.
2. Exact repository ID and allowed task-creation event/action.
3. Exact task label name and whether label addition itself requires owner authorization.
4. Whether a GitHub App installation is available and its minimum permissions, or whether Actions' built-in token is sufficient.
5. Approved task branch prefix and allowed path patterns per task type.
6. Durable ledger runtime and backup/restore evidence.
7. Independent reviewer identity and review policy.
8. Free Actions quota headroom and concurrency constraints.
9. Retention policy and independent audit checkpoint destination.

