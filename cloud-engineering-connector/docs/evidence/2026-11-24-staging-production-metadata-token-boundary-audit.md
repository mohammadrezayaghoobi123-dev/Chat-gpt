# Staging Production Metadata Credential Boundary Audit

Date: 2026-11-24

## Finding

The Staging release workflow must compare the Production and Staging OrchestratorLedger namespace IDs. That comparison requires reading Production Worker settings. Reusing the Staging deployment credential for that read couples two trust domains and can require granting the Staging credential access beyond its deployment target.

Cloudflare's current Workers authorization model supports both product-level and individual-Worker scopes. The Worker settings API accepts the `Individual Workers Metadata Read-Only` permission. Cloudflare documents Metadata Read-Only as access to Worker settings and observability metadata without access to Worker code or secret values.

## Least-privilege design

The workflow now uses two distinct credentials:

- `CLOUDFLARE_API_TOKEN`: remains the Staging deployment and Staging/account-operation credential. It is used for Staging Worker settings, Staging deployments, account checks, and Queue inventory.
- `CLOUDFLARE_PRODUCTION_METADATA_TOKEN`: used only by the `productionApi` helper to read `chat-gpt111/settings` for the Production OrchestratorLedger namespace comparison.

The dedicated Production metadata token must be a separate credential. The workflow fails closed if it is missing or equal to the Staging deployment credential. A 401/403 from the Production metadata endpoint also blocks Staging preflight or post-deploy verification.

## Required GitHub Environment configuration

The GitHub Environment named `staging` must contain a secret named:

`CLOUDFLARE_PRODUCTION_METADATA_TOKEN`

Recommended Cloudflare account-owned API token policy:

- Scope: Specified Workers / Individual Worker.
- Selected Worker: `chat-gpt111` only.
- Role: Metadata Read-Only.
- No Worker Editor, Admin, script write, or product-wide Worker access for this read-only token.

This role/scope combination is intended to authorize the Production settings read without granting the Staging release process a Production deployment capability. The staging deploy credential remains separate.

## Verification

Tests extract and execute the actual Node scripts embedded in the Staging workflow with a deterministic mock at the HTTP boundary. They assert:

1. Production settings calls use the Production metadata credential class.
2. Staging settings and other Staging/account operations continue to use the Staging deployment credential.
3. The Staging deployment credential is never sent to the Production Worker settings endpoint.
4. Missing Production metadata credential blocks preflight.
5. Reusing the Staging deploy credential as the Production metadata credential is rejected.
6. A denied Production metadata request blocks preflight and post-deploy verification.
7. Neither credential value is written to test output.

The test fixtures contain only non-secret sentinel strings. No actual token value, fingerprint, key ID, or credential metadata is read or recorded by this audit.

## Operational limitation

The actual GitHub `staging` environment secret's existence and the Cloudflare token's configured scope were not inspected. Those remain **Unknown**. The connector's GitHub read surface did not expose the environment configuration endpoints required to verify secret metadata. No live Cloudflare API call was performed using the GitHub environment credential.

Until `CLOUDFLARE_PRODUCTION_METADATA_TOKEN` is configured with the specified Worker-scoped Metadata Read-Only role, the Staging release workflow will fail closed. This is an explicit prerequisite, not a verified live configuration.

## Safety disposition

- Change is limited to the Staging release workflow and evidence/test files on an isolated Draft PR.
- No Cloudflare resource, Worker, namespace, Queue, Secret, or account setting was changed.
- No GitHub Environment secret was created, modified, or read.
- No deployment, merge, or main-branch modification was performed.
