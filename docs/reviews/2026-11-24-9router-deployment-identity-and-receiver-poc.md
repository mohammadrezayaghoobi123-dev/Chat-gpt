# DCP-01N — 9Router Deployment Identity and Receiver Fault Harness

**Date:** 2026-11-24  
**Disposition:** PARTIAL — PUBLIC UPSTREAM PINNED; DEPLOYED ENDPOINT UNKNOWN  
**Scope:** Read-only source audit plus isolated synthetic reference-model tests. No live inference, secret read, production request, workflow activation, ledger provisioning, merge, or deployment.

## 1. Pinned upstream identity

Public upstream was pinned to 9Router v0.5.123, immutable commit 5ae63d22847e07042e235b40e1d926b65e509013 (commit timestamp 2026-11-23T02:13:33Z). Its package manifest identifies package version 0.5.123, Node >=20.18.1, default service port 20127, and Undici ^7.30.2.

Sources:
- https://github.com/decolua/9router/tree/5ae63d22847e07042e235b40e1d926b65e509013
- https://github.com/decolua/9router/blob/5ae63d22847e07042e235b40e1d926b65e509013/package.json
- https://github.com/decolua/9router/releases/tag/v0.5.123

**Important boundary:** this pins public upstream source, not the user's local instance or the endpoint used by GitHub Actions. The workflow checks whether NINE_ROUTER_API_URL and NINE_ROUTER_API_KEY are configured, then injects them into the privileged job. Their values were not read or printed. Read-only local process inventory showed generic node.exe processes but did not map one to a router build or endpoint. Local and Actions deployment identities therefore remain UNKNOWN.

## 2. Chat dispatch and retry findings

At the pinned source revision:

- src/app/api/v1/chat/completions/route.js delegates POST requests to handleChat(request).
- open-sse/handlers/chatCore.js invokes executor.execute() for the selected provider. For HTTP 401/403 (except noAuth), it invokes refreshWithRetry; if credential refresh succeeds, it invokes executor.execute() again with the translated body.
- open-sse/services/tokenRefresh.js defaults refreshWithRetry to three credential-refresh attempts. This is not three model-inference attempts.
- open-sse/services/combo.js iterates combo candidates. It can continue to another model after configured request-scoped rejections or zero-content/incomplete results.

These findings reject the assumption that one inbound chat POST always equals one upstream provider-executor invocation. They do not prove each attempted upstream request was accepted or billed. Provider-side execution and billing remain UNKNOWN.

Sources:
- https://github.com/decolua/9router/blob/5ae63d22847e07042e235b40e1d926b65e509013/src/app/api/v1/chat/completions/route.js
- https://github.com/decolua/9router/blob/5ae63d22847e07042e235b40e1d926b65e509013/open-sse/handlers/chatCore.js
- https://github.com/decolua/9router/blob/5ae63d22847e07042e235b40e1d926b65e509013/open-sse/services/tokenRefresh.js
- https://github.com/decolua/9router/blob/5ae63d22847e07042e235b40e1d926b65e509013/open-sse/services/combo.js

## 3. Idempotency scope finding

At the pinned source revision, code search for Idempotency-Key returned the video-generation path: videoGeneration.js reads the header, videoCore.js forwards it, and xai-video-core.test.js asserts forwarding. The inspected chat route/chatCore path did not expose an equivalent atomic chat reservation. A search miss cannot prove absence from every indirect path; chat-completions idempotency remains UNKNOWN, not UNSUPPORTED.

Sources:
- https://github.com/decolua/9router/blob/5ae63d22847e07042e235b40e1d926b65e509013/src/sse/handlers/videoGeneration.js
- https://github.com/decolua/9router/blob/5ae63d22847e07042e235b40e1d926b65e509013/open-sse/handlers/videoCore.js
- https://github.com/decolua/9router/blob/5ae63d22847e07042e235b40e1d926b65e509013/tests/unit/xai-video-core.test.js

## 4. Isolated SQLite receiver reference model

A local-only SQLite reference model was built in scratch space, not in the 9Router repository or user's repository. It uses canonical JSON fingerprinting, the scoped tuple (principal, method, route, idempotency key), BEGIN IMMEDIATE, a unique primary key, durable reservation before a synthetic provider callback, explicit UNKNOWN states, and no automatic redispatch after an ambiguous outcome.

The unsafe starter failed the first 12-thread reservation regression: it returned 12 RESERVED outcomes where exactly one winner was required. The corrected model returned one RESERVED and 11 UNKNOWN. A separate three-process test returned one RESERVED and two UNKNOWN.

The first implementation run emitted ResourceWarning because SQLite connections were not closed. That defect was repaired with explicit finally-based closure. A first multiprocessing test version also had a barrier participant-count error; this was a test-harness setup failure and was corrected before the passing run.

Final command:

    python -W error::ResourceWarning -m unittest -v test_receiver_model

Result: 10 tests passed, 0 failures, 0 errors, exit code 0, with ResourceWarning promoted to errors.

Coverage: thread and process concurrency, in-flight duplicate, payload conflict, completed response replay, crash after reservation, lost response after provider acceptance, principal/route isolation, and fail-closed store unavailability before provider callback.

Limitations: SQLite prototype only; no replication across hosts, WORM/append-only trust, external CAS, retention/expiry, backup rollback detection, HMAC key management, live network/proxy test, real 9Router integration, provider billing proof, or exactly-once model execution. The model intentionally leaves ambiguous reservations UNKNOWN, sacrificing liveness to prevent automatic redispatch.

## 5. Gitleaks and branch reconciliation

- PR #431 candidate ancestry uses --full-history HEAD; exact hosted run 45380564141 passed the PR diff and candidate-ancestry scans.
- PR #324 still inherits the base workflow using --all; latest run 45381698577 passed the PR diff scan but failed all-fetched-ref history with 10 generic-api-key detections across 4,825 commits.
- Closed, unmerged negative-control PR #322 remains preserved. No allowlist, suppression, history rewrite, branch deletion, or finding adjudication was performed.

Sources:
- https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/45380564141
- https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/45381698577

## 6. Final dispositions

| Claim | Disposition |
|---|---|
| Public 9Router source pinned to v0.5.123 | SUPPORTED |
| Chat path may make another provider-executor call after 401/403 refresh | SUPPORTED |
| Combo path may try another model | SUPPORTED |
| One client POST always equals one provider attempt | REJECTED |
| One provider attempt always equals one billable model execution | UNKNOWN |
| Atomic Idempotency-Key on chat-completions | UNKNOWN |
| User's local router version | UNKNOWN |
| GitHub Actions endpoint router version | UNKNOWN |
| SQLite receiver reference model | PASS WITH LIMITS |
| Distributed ledger readiness | NOT ESTABLISHED |
| Exactly-once model execution | NOT ESTABLISHED |

## 7. Boundary

No repository source code or workflow was changed by the reference-model experiment. No secret was read, live router request sent, provider inference attempted, external ledger selected/provisioned, permission changed, workflow activated, PR merged, or Production operation performed. A separate approval and an exact deployed-build verification remain required before receiver integration.
