# Automated Project Orchestrator — Architecture Design

- **Date:** 2026-11-04
- **Status:** Design approved by project owner; implementation not yet authorized
- **Repository:** `mohammadrezayaghoobi123-dev/Chat-gpt`
- **Design branch:** `design/automated-project-orchestrator-2026-11-04`
- **Base branch:** `integration/unify-main-and-integrated-2026-11-02`
- **Decision class:** Architecture / security / operations
- **Cost constraint:** Strict zero-cost operation; no paid model APIs, no automatic upgrades, and no unapproved billable services

## 1. Executive decision

Build a project-wide, policy-enforced orchestrator using a hybrid architecture:

1. **GitHub** is the authoritative system for source code, task intake, branches, pull requests, CI evidence, and review records.
2. **Cloudflare Free services**, if their current quotas and required features are verified as sufficient, provide a lightweight coordination/control plane and durable state. No paid feature may be enabled automatically.
3. **GitHub Actions** executes bounded, isolated engineering jobs and verification workflows.
4. **KnowledgeStore** remains the canonical source of truth for project knowledge and approved engineering knowledge. The orchestrator may index references and evidence but must not silently replace or fork the canonical knowledge store.
5. **Notion** is a management projection only: portfolio status, priorities, owners, decisions, and sanitized links. It is not authoritative for code, task execution, approvals, or runtime state.
6. ChatGPT and Claude are modeled as independent agent adapters. Real autonomous invocation is enabled only through an official, authenticated, demonstrably zero-cost integration. A browser subscription is not treated as API access. If no qualifying free integration exists, the system pauses that agent-dependent stage and records a blocker rather than scraping sessions, sharing credentials, bypassing quotas, or inventing agent activity.

The design prioritizes preservation of the existing Master Brain project over speed or breadth of automation.

## 2. Goals

- Centralize intake and coordination for all project engineering work.
- Support architecture, implementation, bug fixing, security, testing, infrastructure, documentation, and release-readiness tasks.
- Make every task traceable from intake through execution, evidence, review, and closeout.
- Enforce atomic, idempotent, bounded, recoverable task execution.
- Keep execution isolated from protected branches and privileged environments.
- Support asynchronous ChatGPT/Claude collaboration where technically and contractually available at zero cost.
- Operate without paid model APIs or hidden billable infrastructure.
- Preserve existing source, branch, release, and KnowledgeStore boundaries.

## 3. Non-goals and explicit exclusions

The first release will not:

- Modify or merge into `main` automatically.
- Deploy to Staging or Production without the existing owner-controlled release gates and explicit authorization.
- Read, print, copy, rotate, or mutate production secret values.
- Grant agents organization-owner, repository-admin, billing, or unrestricted Cloudflare permissions.
- Treat a normal GitHub comment as an independent review approval.
- Claim autonomous ChatGPT/Claude execution until an end-to-end test proves authenticated invocation and attribution for both agents.
- Use paid OpenAI or Anthropic API calls, paid inference providers, paid hosting, or paid queue/database features.
- Scrape ChatGPT/Claude browser sessions, reuse browser cookies, share user credentials, or bypass service quotas.
- Replace Master Brain's deterministic core or KnowledgeStore.
- Perform broad refactoring unrelated to a specific approved task.

## 4. Architecture and service boundaries

### 4.1 Components

| Component | Responsibility | Trust boundary |
|---|---|---|
| GitHub Task Intake | Issues, approved PR comments, CI events, scheduled task definitions | All repository text is untrusted input until authority and scope are checked |
| Orchestrator Core | State transitions, dependency resolution, scheduling, retry policy | Trusted policy code; no direct secret or production access |
| Durable Task Ledger | Task state, idempotency keys, leases, event history, outbox | Persistent state; integrity and recovery must be tested |
| Policy Engine | Authorization, scope, stop-switch, risk and action decisions | Fail-closed enforcement point |
| Agent Dispatcher | Assigns bounded work to an eligible agent adapter | Cannot grant privileges |
| Agent Adapters | ChatGPT, Claude, and optional deterministic/local tools | Each adapter must expose verified identity and capability metadata |
| GitHub Actions Workers | Isolated implementation, tests, static analysis, artifact generation | Per-job permissions and isolated workspaces |
| Evidence Engine | Captures SHA, workflow run, test results, artifacts, provenance | Evidence is immutable by reference and linked to exact inputs |
| Review Gate | Enforces distinct reviewer identity and exact-SHA approval | No self-approval; no inferred independence |
| GitHub Adapter | Branch, commit, issue, PR, review and CI interactions | Narrow GitHub App/token permissions |
| Cloudflare Control Plane | Optional free-tier coordination API/state/queue | Only after current free-tier limits are verified |
| KnowledgeStore Adapter | Reads/writes approved canonical knowledge through its contract | No silent source-of-truth migration |
| Notion Adapter | Sanitized status projection and links | Non-authoritative; no raw secrets or sensitive logs |
| Audit Ledger | Append-only event records and integrity checkpoints | Hash chain is not a substitute for external anchoring |

### 4.2 Deployment topology

Preferred topology:

- Cloudflare Worker: authenticated control-plane API and event ingress.
- Cloudflare D1: relational task metadata and state, only if free-tier capacity and transaction behavior pass preflight.
- Cloudflare Durable Objects or Queues: optional coordination primitives, only if their availability and limits are verified under the active zero-cost plan.
- GitHub Actions: execution workers and CI verification.
- GitHub repository: authoritative task and code records.
- KnowledgeStore: canonical project knowledge.
- Notion: sanitized operational dashboard.

**Free-tier fallback:** if any Cloudflare component is unavailable or insufficient without payment, task intake and durable coordination must degrade to GitHub Issues plus GitHub Actions and repository-backed state. No billing activation, automatic plan upgrade, or paid fallback is allowed. This fallback must preserve idempotency and auditability; if it cannot, execution pauses rather than weakening guarantees.

## 5. Task contract and atomicity

Every task is an independently addressable unit with:

- `task_id`: globally unique immutable identifier.
- `idempotency_key`: unique key for the requested effect.
- `project_id` and `parent_task_id`: project and decomposition lineage.
- `source_ref`: originating GitHub Issue, PR, workflow run, or approved schedule.
- `requester_identity`: authenticated event actor, not a self-declared message field.
- `task_type`, `priority`, `risk_level`, and `required_capabilities`.
- `scope`: explicit allowed paths, repositories, operations, and exclusions.
- `acceptance_criteria`: objective, testable conditions.
- `dependencies`: prerequisite task IDs and required evidence.
- `input_hash`: digest of the normalized task input.
- `attempt_count`, `lease_owner`, `lease_expires_at`.
- `state`, timestamps, and terminal reason.
- `evidence_refs`: exact commits, CI runs, test reports, and review records.

Atomicity rules:

1. One task addresses one coherent outcome and has one bounded scope.
2. A task may not expand its own scope. Scope changes require a new owner-authorized task or explicit owner approval.
3. A task runs in a dedicated branch/workspace and cannot write outside its allowlist.
4. A task's effects must be idempotent or protected by a durable idempotency record.
5. A retry must not duplicate commits, comments, deployments, or external side effects.
6. Multi-system workflows use a saga with explicit compensating actions; no global atomic transaction is assumed across GitHub and Cloudflare.
7. A task is complete only when acceptance criteria and required evidence are satisfied.
8. Failure, timeout, cancellation, and unknown outcomes are distinct from success.

## 6. Task state machine

Normal path:

`RECEIVED → VALIDATING → READY → SCHEDULED → RUNNING → VERIFYING → REVIEW_PENDING → COMPLETED`

Exception states:

- `BLOCKED`: a dependency, quota, approval, or integration is unavailable.
- `FAILED`: an execution or verification attempt failed and no automatic retry remains.
- `CANCELLED`: an authorized actor stopped the task.
- `DISPUTED`: agents or evidence disagree and an explicit resolution is required.
- `QUARANTINED`: suspected prompt injection, scope violation, identity ambiguity, or integrity failure.
- `RETRY_WAIT`: bounded backoff before an eligible retry.

Transitions are explicit and validated by the Orchestrator Core. Illegal transitions are rejected and audited. A task may not transition to `COMPLETED` from `RUNNING` or `FAILED` without the verification and review requirements defined for its risk class.

## 7. Agent message protocol

Every inter-agent message uses a versioned, schema-validated envelope:

- `protocol_version`
- `message_id` (unique; canonical handoff ID where compatible)
- `task_id`, `parent_task_id`, `correlation_id`
- `sender_identity`, `recipient_identity`
- `message_type`
- `created_at`, `expires_at`
- `scope_ref`, `input_hash`
- `payload_ref` or bounded structured payload
- `evidence_refs`
- `signature_or_authenticated_event_ref`

The self-declared `sender_identity` field is descriptive only. Authorization depends on independently authenticated provider identity or a trusted signed event. If that proof is unavailable, the message is advisory and cannot authorize a privileged action.

Required message types include task proposal, acknowledgement, progress, verification result, dispute, blocker, decision request, and closure. Message processing is at-most-once in effect through durable deduplication, even if transport delivery is at-least-once.

For one handoff item, no more than four automated agent-to-agent rounds are allowed before human participation. The round count is durable and cannot be reset by creating a new message or retry.

## 8. Zero-cost policy and agent feasibility

The cost policy is a hard invariant:

- No paid OpenAI API or Anthropic API calls.
- No paid inference service or paid third-party connector.
- No automatic billing enablement, plan upgrade, or usage-based fallback.
- All optional cloud components must be verified against the actual active free-tier limits before activation.
- Usage ceilings, quota monitoring, and a safe pause threshold must be defined for every external service.
- Quota exhaustion results in `BLOCKED` or `RETRY_WAIT`, never a paid fallback.

ChatGPT Plus/Free/Go/Pro subscriptions and Claude Free/Pro subscriptions are consumer product entitlements, not proof of API access or permission for unattended programmatic invocation. The system must not automate browser sessions, copy cookies, share passwords, or bypass usage limits.

Agent adapters therefore have capability states:

- `AVAILABLE_VERIFIED_FREE`
- `AVAILABLE_LIMITED_FREE`
- `UNAVAILABLE`
- `AUTHENTICATION_UNVERIFIED`
- `QUOTA_EXHAUSTED`
- `DISABLED_BY_POLICY`

Only the first two states can be scheduled, and only within documented limits. Until both ChatGPT and Claude have verified, independent, zero-cost invocation paths, full two-agent autonomy is a blocked acceptance criterion. The rest of the orchestrator may be tested with deterministic mock adapters, but mock success must never be reported as live model integration.

## 9. Security model and threat controls

| Threat | Required control |
|---|---|
| Forged webhook | Verify provider signature over raw request body; reject invalid signatures |
| Replay or duplicate delivery | Timestamp/replay window plus durable event and idempotency keys |
| Prompt injection in Issue/PR/docs | Treat repository text and artifacts as untrusted data; enforce owner-approved scope out of band |
| Agent identity spoofing | Provider-authenticated identity; self-declared names never authorize |
| Token compromise | Least privilege, short-lived credentials where supported, secret redaction, rotation procedure |
| Scope escape | Path/operation allowlists, diff inspection, isolated worker, fail-closed policy |
| Concurrent execution | Durable leases with fencing tokens and atomic compare-and-set semantics |
| Stop-switch race | Re-check stop state immediately before every side effect; fail closed if state is unavailable |
| Malicious dependency | Pinned versions, lockfiles, provenance checks, dependency scanning |
| Audit tampering | Append-only event model, hash chaining, periodic externally controlled checkpoint |
| Reviewer collusion/self-review | Distinct identity outside both agents' control; verify review actor and exact SHA |
| Quota exhaustion | Hard usage caps and pause; never auto-upgrade |
| Cloud/runtime outage | Durable state, bounded retry, recovery tests, safe pause |
| Secret exfiltration | No secret values in task payloads, logs, Notion, artifacts, or model prompts |

The existing Master Brain audit hash-chain primitive may inform offline integrity records but is not itself a production authorization boundary, trusted timestamp, or external anchor.

## 10. Authorization matrix

| Operation | Orchestrator | Execution agent | Independent reviewer | Project owner |
|---|---:|---:|---:|---:|
| Read approved repository content | Yes | Scoped | Yes | Yes |
| Create/update task records | Yes | No, unless explicitly delegated | No | Yes |
| Create dedicated branch | Yes, policy-bound | Yes, own task only | No | Yes |
| Commit within task scope | No | Yes | No | Yes |
| Open/update PR | Yes, policy-bound | Yes, own task only | No | Yes |
| Run CI/tests | Yes | Yes | Yes | Yes |
| Approve own changes | No | No | No | N/A |
| Independent GitHub approval | No | No | Yes, distinct identity | May appoint reviewer |
| Merge to protected branches | No | No | No | Explicit owner-controlled process |
| Read/write secrets | No | No | No | Explicit owner-controlled process |
| Deploy Staging/Production | No | No | No | Explicit owner-controlled process |
| Change billing, permissions, branch protection | No | No | No | Explicit owner-controlled process |

Any unknown role, actor, policy result, branch state, SHA, or approval state causes denial.

## 11. Data model

Initial relational entities:

- `projects`
- `tasks`
- `task_dependencies`
- `agents`
- `agent_capabilities`
- `agent_assignments`
- `messages`
- `processed_message_ids`
- `executions`
- `execution_leases`
- `artifacts`
- `approvals`
- `policy_decisions`
- `audit_events`
- `outbox_events`
- `quota_budgets`
- `service_health`

Important constraints:

- Unique index on `idempotency_key`.
- Unique index on `message_id` in the processed-message ledger.
- Foreign keys for project, task, dependency, execution, and artifact relationships.
- State transitions recorded as events; current state is a projection.
- Exact commit SHA and workflow run ID required for code-verification evidence.
- No secret values stored in these tables.
- Retention, deletion, and backup policy must be specified before production use.

## 12. Reliability, retries, and recovery

- Use leases with expiry and fencing tokens so a stale worker cannot commit effects after losing ownership.
- Retry only classified transient failures.
- Use exponential backoff with jitter and a strict per-task attempt ceiling.
- Never retry authorization failures, scope violations, invalid signatures, or stop-switch failures automatically.
- Persist the intent before publishing an external event (transactional outbox).
- Consumers must be idempotent.
- For multi-system operations, define compensating actions and record whether compensation succeeded.
- Unknown external outcome is reconciled by reading authoritative GitHub/Cloudflare state before any retry.
- Stop all new side effects when durable state or policy service is unavailable.

## 13. Observability and audit

Every execution record must include:

- task ID, execution ID, correlation ID, and message IDs;
- authenticated actor and agent adapter identity;
- repository, branch, base SHA, resulting SHA, and changed paths;
- policy decisions and stop-switch observations;
- exact CI workflow/run IDs and conclusions;
- test commands, sanitized results, and artifact references;
- retry count, lease owner, and terminal reason;
- review actor, review state, and exact SHA;
- cost/quota counters without secret or personal data.

Audit events are append-only at the application layer. Hash chaining detects changes relative to trusted checkpoints but does not prevent an administrator from rewriting and rehashing the entire store. Before production, checkpoints must be anchored outside the primary control plane and backup restoration must be tested.

## 14. Failure handling

| Failure | Required behavior |
|---|---|
| Invalid webhook or unknown actor | Reject and audit |
| Duplicate message | No-op; return prior processing result |
| Agent unavailable | Block task; preserve queue and evidence |
| Free quota exhausted | Pause affected adapter; no paid fallback |
| Worker crash | Expire lease; reconcile side effects; retry only if safe |
| D1/queue unavailable | Fail closed; do not run untracked work |
| Stop switch present or unreadable | Stop before side effect |
| Scope mismatch | Quarantine task and preserve diff/evidence |
| Conflicting agent findings | Mark disputed; require adjudication |
| Independent reviewer absent | Keep review gate blocked |
| Staging/Production state ambiguous | No deployment; require owner-led reconciliation |

## 15. Testing and acceptance criteria

### Unit and contract tests
- All legal state transitions accepted; illegal transitions rejected.
- Message schema validation rejects missing, malformed, expired, and oversized fields.
- Idempotency key and message ID uniqueness enforced.
- Policy engine denies unknown actors, unknown scopes, and unknown policy states.
- No secret values are included in serialized task/message/log schemas.

### Concurrency and recovery tests
- Deliver the same event 100 times: one effective task side effect.
- Run two workers concurrently: only one valid lease/fencing token can commit.
- Kill a worker at each side-effect boundary: recovery reconciles before retry.
- Expire a lease and resume the stale worker: stale worker is rejected.
- Restart control plane during outbox publication: event is neither lost nor duplicated in effect.

### Security tests
- Invalid webhook signature rejected.
- Replay outside allowed window rejected.
- Prompt-injection content cannot expand scope or invoke tools.
- Path traversal and symlink escape blocked.
- Agent cannot alter branch protection, secrets, billing, or production.
- Stop switch blocks all subsequent actions, including after a prior successful check.
- Cross-task data leakage is prevented.

### End-to-end tests
- Create a GitHub Issue and observe authenticated intake, task record, policy decision, execution, evidence, PR, and review state.
- Verify exact SHA binding across CI, review, and task completion.
- Exercise stop, cancel, quota exhaustion, worker crash, and recovery.
- Verify Notion contains only sanitized projection data.
- Verify KnowledgeStore remains canonical and no silent duplicate knowledge source is created.
- Verify independent reviewer is outside both agent identities.
- Verify ChatGPT and Claude invocation separately through real official zero-cost paths. Deterministic mocks do not satisfy this test.

### Release acceptance
No production release unless every required gate passes with inspectable evidence. A passing test suite alone is insufficient.

## 16. Delivery phases

1. **P0 — Feasibility and repository preflight:** verify current branch topology, existing handoff contract, free-tier quotas, available official agent integrations, and KnowledgeStore interface. No implementation changes.
2. **P1 — Contract and deterministic core:** schema, state machine, policy engine, idempotency, leases, outbox, and audit events using deterministic adapters.
3. **P2 — GitHub-native intake and execution:** signed event intake, Issues/PR integration, dedicated branches, GitHub Actions workers, CI evidence.
4. **P3 — Optional Cloudflare free control plane:** implement only after quota, transaction, concurrency, and recovery proofs; retain GitHub-native fallback.
5. **P4 — Agent adapters:** enable only official authenticated zero-cost integrations; otherwise leave the relevant adapter disabled and report the blocker.
6. **P5 — Security and resilience:** adversarial tests, replay, concurrency, stop-switch, recovery, backup, and external audit checkpoint.
7. **P6 — Staging evaluation:** owner-authorized Staging deployment and live acceptance only after independent review and all prior gates.
8. **P7 — Production readiness:** separate security sign-off, independent review, cost review, operational runbook, rollback drill, and explicit owner authorization.

Each phase has a separate implementation plan, acceptance criteria, and review. No phase may silently expand the approved scope.

## 17. Repository preservation and change policy

- `main` remains unchanged unless the project owner explicitly authorizes a specific operation.
- Existing open PRs #145, #146, and #147 are not modified by this design task.
- All implementation work uses new, dedicated branches and narrowly scoped PRs.
- No force push, branch deletion, merge, deployment, traffic shift, secret mutation, or repository-settings change without explicit authorization.
- Existing Master Brain components remain intact unless a separately reviewed migration plan proves a necessary change.
- KnowledgeStore remains the canonical knowledge source under the previously selected Option C.
- The orchestrator is an additional coordination layer, not a replacement for domain logic or evidence verification.
- Any migration is versioned, reversible, and tested against a backup before production use.

## 18. Open feasibility gates (explicit blockers, not assumptions)

1. Confirm the actual Cloudflare Free plan limits and availability for each proposed service at implementation time.
2. Confirm GitHub Actions quotas and permissions for this repository and its actual visibility/plan.
3. Prove a supported, authenticated, zero-cost invocation path for ChatGPT and for Claude independently. Subscription UI access alone does not satisfy this requirement.
4. Inspect the actual KnowledgeStore contract, persistence model, and current deployment before defining an adapter.
5. Verify independent reviewer availability and identity separation.
6. Define backup retention and external audit checkpoint ownership.

If any blocker cannot be resolved without cost or weakening security, the affected capability remains disabled. The project must not be represented as fully autonomous or production-ready while these blockers remain.

## 19. Definition of done for this design

This design is ready to transition to implementation planning when:

- The project owner has reviewed this complete specification.
- All zero-cost and preservation constraints are retained.
- Each delivery phase has a bounded scope and measurable acceptance criteria.
- Open feasibility gates are explicit and are not misrepresented as completed.
- The implementation plan begins with P0 preflight and does not modify `main`, open PRs, secrets, or Production.

**Current status:** Architecture design approved. Specification prepared for owner review. No orchestrator implementation, deployment, or production operation is claimed.
