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

### Release blockers — still open

- Independent review: no review was recorded on the previous carrier PR #135. A reviewer other than the PR author must approve the refreshed carrier PR.
- Staging acceptance: NOT VERIFIED for this exact candidate. Do not deploy until the independent approval gate passes and the owner explicitly triggers the Staging-only release workflow.
- Issue #117: remains OPEN. Durable Object retention/idempotency source work exists in the separate write-control line, but this evidence does not prove post-deployment acceptance for this candidate. Do not close #117 without exact-candidate Staging evidence.
- Issue #67: NOT_VERIFIED. This audit did not establish current deployed Worker version/source provenance or complete live MCP interoperability.
- main protection: NOT VERIFIED in this run. The prior repository audit recorded `main` as unprotected with no rulesets; an owner/admin must verify and configure required review and status-check rules before any merge to `main`.
- Production: NOT AUTHORIZED. No Production deployment, Worker mutation, secret change, route change, or `main` mutation was performed.

### Carrier refresh rationale

Previous carrier PR #135 points to base SHA `c623f22ce1bd61c690566da2f78bba716c6ece97` and head SHA `6c2fc77f86f8ee63a9ecf55225103242aa9da713`. The current unified branch head is now `f3a60d6420a4987e46c0e50caddcafabdc641537`; the comparison of the previous PR head against the current unified head reports divergence (current unified side: 4 commits ahead; previous carrier side: 2 commits ahead). The previous carrier therefore must not be treated as the current exact-candidate approval artifact.

### Safety disposition

Keep this candidate isolated. Require an independent review, verify branch protection, perform exact-SHA Staging deployment and acceptance, reconcile Issue #67 provenance, and close Issue #117 only with evidence. Production promotion requires a separate explicit owner authorization.
