# RELEASE_EVIDENCE

## Current Staging candidate — 2026-11-03

Candidate source branch: `integration/unify-main-and-integrated-2026-11-02`
Candidate source SHA: `f3a60d6420a4987e46c0e50caddcafabdc641537`

This SHA is the current unified branch head observed during the 2026-11-03 GitHub audit. The release carrier branch is based on this exact SHA and adds only this evidence-document update. The resulting carrier PR head must be reviewed independently; it is not deployment authorization.

### Exact-head CI evidence on candidate source SHA

All seven listed workflow runs completed with conclusion `success`:

- Full History Secret Scan: run `41599628330`
- Cloud Agent CI: run `41599628323`
- Cloud Engineering Connector CI: run `41599628382`
- Master Brain MVP tests: run `41599628333`
- Dev Container Security: run `41599628336`
- CTP Evidence Lab Checks: run `41599628324`
- Lost BTC Scout: run `41599628353`

Important qualification: the Connector CI job `post-deploy-staging-smoke` was skipped. These CI results do not establish live Staging acceptance, live Claude interoperability, or Cloudflare deployment provenance.

### Direct Cloudflare audit — 2026-11-03

Read-only inspection of the connected Cloudflare account; no secret values were read and no Cloudflare resources were changed.

- Production `chat-gpt111`: Version 34 (`c6d24ebd-4ce9-425d-9b22-fc8d1d7b1362`) receives 100% traffic via deployment `dbd3391c-9130-466c-bb29-74120a3ce0e4`; version source is `dash`, created 2026-11-02T19:22:40Z. No Git commit SHA annotation is present.
- Staging `chat-gpt111-staging`: Version 32 (`2a3283f0-f443-4d51-885c-e30e4ff7434a`) receives 100% traffic via deployment `ea057836-238f-49e1-87e0-455fe01f0913`; version source is `dash`, created 2026-11-02T19:15:04Z. No Git commit SHA annotation is present.
- Production bindings include `GITHUB_TOKEN`, `GITHUB_READONLY_TOKEN`, `MCP_AUTH_TOKEN`, `MCP_ALLOWED_ORIGINS`, `PUBLIC_READ_ONLY`, `SERVICE_MODE`, and `MCP_RATE_LIMITER` namespace `78294163`.
- Staging bindings include the same named GitHub/MCP credentials, `MCP_RATE_LIMITER` namespace `78294164`, and SQLite Durable Object `WRITE_CONTROL` namespace `1d0f4257b609483eba4fc5fdb39ed781`. Secret values were not read.
- Deployed Production code contains the public read-only allowlist and rate-limiter references, but lacks `GITHUB_READONLY_TOKEN`, `architecture_analyze`, and MCP tool annotation fields such as `readOnlyHint`.
- Deployed Staging code contains `architecture_analyze`, tool annotations, and `WriteControl`, but also lacks `GITHUB_READONLY_TOKEN`.
- Both deployed bundles build GitHub API Authorization from `env.GITHUB_TOKEN`; the separately configured `GITHUB_READONLY_TOKEN` binding is not referenced by either active bundle.
- The current unified GitHub source file `cloud-engineering-connector/worker.js` (blob `fce247b3393944ddb95924333501e78909e83216`) contains the `READ_ONLY_GITHUB` path that selects `GITHUB_READONLY_TOKEN`. That source behavior is not present in the inspected active Production or Staging bundles.
- Both active Worker versions have a distinct `MCP_RATE_LIMITER` binding. The account-level `http_ratelimit` entrypoint lookup returned 404; this does not establish whether zone-level or other edge controls exist.

Disposition: `provenance: NOT_VERIFIED`. Active deployments are dashboard-originated and not tied to an immutable Git commit. Production and Staging are not verified as running the current unified candidate source. The read-only GitHub token separation is configured as a binding but unused by both inspected deployed bundles. Issue #67 was updated with this evidence and must remain open.

### Release blockers — still open

- Independent review: no review was recorded on the previous carrier PR #135. A reviewer other than the PR author must approve the refreshed carrier PR #139.
- Staging acceptance: NOT VERIFIED for this exact candidate. Do not deploy until the independent approval gate passes and the owner explicitly triggers the Staging-only release workflow.
- Issue #117: remains OPEN. Durable Object retention/idempotency source work exists in the separate write-control line, but this evidence does not prove post-deployment acceptance for this candidate. Do not close #117 without exact-candidate Staging evidence.
- Issue #67: NOT_VERIFIED. The current active Production and Staging bundles lack the read-only GitHub credential separation present in the current unified source; exact deployed-source provenance and live MCP interoperability remain unverified.
- main protection: NOT VERIFIED in this run. The prior repository audit recorded `main` as unprotected with no rulesets; an owner/admin must verify and configure required review and status-check rules before any merge to `main`.
- Production: NOT AUTHORIZED. No Production deployment, Worker mutation, secret change, route change, or `main` mutation was performed.

### Carrier refresh rationale

Previous carrier PR #135 points to base SHA `c623f22ce1bd61c690566da2f78bba716c6ece97` and head SHA `6c2fc77f86f8ee63a9ecf55225103242aa9da713`. The current unified branch head is now `f3a60d6420a4987e46c0e50caddcafabdc641537`; the comparison of the previous PR head against the current unified head reports divergence (current unified side: 4 commits ahead; previous carrier side: 2 commits ahead). The previous carrier therefore must not be treated as the current exact-candidate approval artifact.

### Safety disposition

Keep this candidate isolated. Require an independent review, verify branch protection, perform exact-SHA Staging deployment and acceptance, reconcile Issue #67 provenance, and close Issue #117 only with evidence. Production promotion requires a separate explicit owner authorization.
