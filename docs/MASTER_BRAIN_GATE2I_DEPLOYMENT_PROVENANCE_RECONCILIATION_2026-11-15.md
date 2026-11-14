# Master Brain — Gate 2I Deployment Provenance and Write-Control Reconciliation
**Date:** 2026-11-15  
**Mission:** MB-G2I-DEPLOYMENT-PROVENANCE-RECONCILIATION-2026-11-15-001  
**Scope:** Read-only deployment provenance review and target architecture specification  
**Status:** SPECIFICATION REQUIRED — NO DEPLOYMENT AUTHORIZED  
**Source inputs:** Gate 2H live Cloudflare audit; latest Chat-gpt main source; deployed staging/production script content.

## 1. Decision

The live Workers cannot currently be mapped to an exact reviewed Git commit. Cloudflare version metadata exposes version number, timestamp, upload source, script ETag, and binding inventory, but no Git commit SHA or build attestation was identified.

Production and staging also have different write-safety controls:
- Production has the older direct draft-PR path with no durable idempotency/write-control binding.
- Staging has a global WRITE_CONTROL Durable Object with idempotency, admission, leases, UNKNOWN state, and reconciliation.
- The latest repository main source instead has Tenant Directory membership/project authorization and does not match either deployed bundle.

Do not deploy, merge, or cut over until source provenance and the combined authorization/write-control design are resolved.

## 2. Exact live version metadata

| Worker | Version number | Version ID | Script ETag | Upload source | Created |
|---|---:|---|---|---|---|
| chat-gpt111 | 35 | b4667a11-aa74-49ca-8d29-2f7b62608de0 | 8782194bbd0c59c692e073d5f35d0b300ae585ac15269cd5212482e1b9cd8621 | api | 2026-11-03T14:29:40.273955Z |
| chat-gpt111-staging | 32 | 2a3283f0-f443-4d51-885c-e30e4ff7434a | d5389c31c0a4216d0d4e5bde0e928b84074d488e6ae396fb11697d68ad0bfbf3 | dash | 2026-11-02T19:15:04.279819Z |
| master-brain-cloud-agent | 5 | b5a8f54d-e2bc-4e3f-8a4b-b2172b739e2c | 404eeca6c9405e5eb8804bd37fc9a317bc884a341609dcb0e5c24174defdcb0d | api | 2026-11-03T14:17:53.102542Z |

Cloudflare version metadata contains a creator identifier but this report deliberately omits it. It does not expose a Git commit SHA, source branch, lockfile digest, build artifact digest, or independent build attestation in the inspected version response.

**Provenance status: UNKNOWN.** A script ETag identifies a deployed script artifact; it is not a verified Git commit mapping.

## 3. Write-control path comparison

### 3.1 Production

The deployed chat-gpt111 createChangePr path:
- validates base branch, file paths, file sizes, title, and summary;
- uses GitHub API to create a tree, commit, assistant branch, and draft PR;
- uses shared MCP_AUTH_TOKEN authentication at the Worker request boundary;
- has no idempotency_key in the observed tool schema;
- has no WRITE_CONTROL Durable Object binding or write-control call;
- has no Tenant Directory membership or project policy check in the deployed createChangePr function.

The exact current PUBLIC_READ_ONLY value was not inspected. Do not infer it from the binding's existence.

### 3.2 Staging

The deployed staging createChangePr path:
- requires a client-generated idempotency_key;
- uses WRITE_CONTROL Durable Object named create-change-pr-global;
- hashes the operation key using action name, normalized owner/repo, and idempotency_key;
- hashes request data separately;
- records admission, lease generation, stale-operation UNKNOWN state, rate limits, replay, and reconciliation transitions;
- fails closed if the Durable Object or required methods are unavailable.

The observed key derivation is equivalent to:
SHA256("create_change_pr\n" + owner + "/" + repo + "\n" + idempotency_key)

The key does not include authenticated principal ID, principal type, tenant ID, or project ID. The request schema and canonical request hash also do not include tenant/project identity.

### 3.3 Required correction before multi-tenant integration

Once tenant/project authorization is added, the idempotency scope must be explicitly defined. Candidate v2 scope:

- action identifier;
- principal type and principal ID;
- tenant ID;
- project ID;
- canonical repository identity;
- idempotency key.

The request digest must include every security-relevant operation field, including base branch, exact file path/content digests, title, summary, and the authorized resource context.

The Durable Object namespace key must be partitioned so that one tenant cannot read, replay, collide with, or infer another tenant's operation record. A single global DO may remain the physical coordinator only if every record is cryptographically and logically tenant-scoped and every method checks the authenticated scope; otherwise use tenant-scoped Durable Object instances.

A replay must not bypass current authorization. Revalidate the caller's current principal, membership, and project policy before returning an existing operation result or continuing a replay. An authorization denial must not reveal another tenant's operation existence.

## 4. Required ordered request pipeline

The target design must enforce the following order:

1. Authenticate credential through the configured trusted authenticator.
2. Resolve a closed human/service principal.
3. Validate service capability or human token audience and lifecycle.
4. Resolve current tenant membership, when tenant-scoped.
5. Resolve current project/action/resource policy.
6. Validate request schema, resource digest, path restrictions, and base-branch policy.
7. Apply idempotency admission in the correct principal/tenant/project scope.
8. Persist operation reservation and audit provenance before external GitHub side effects.
9. Execute the external write under a bounded lease.
10. Persist confirmed result or explicit UNKNOWN outcome.
11. Reconcile UNKNOWN using independent evidence; do not auto-retry an ambiguous external write.

No GitHub API write may occur before steps 1–8 complete. A failed or unavailable policy decision must not reserve or dispatch an external write. A replay of an existing operation must still pass current authorization before the operation details are returned.

## 5. Provenance requirements for every future deployment

Each release candidate must have an immutable release record containing:
- repository and exact Git commit SHA;
- source branch and reviewed PR number;
- dependency lockfile hash;
- build toolchain and runtime versions;
- reproducible build command and build result;
- artifact/script ETag and Cloudflare version ID;
- exact Worker name and environment;
- binding names/types only (never secret values);
- Durable Object class names and migration tags;
- test run IDs and raw test result artifacts;
- independent reviewer identity and approval;
- deployment operator and deployment timestamp;
- active traffic percentage;
- rollback target version and rollback verification result.

If the build cannot be reproduced or the deployed artifact cannot be mapped to the reviewed commit, release status must be UNKNOWN and deployment must stop.

## 6. Safe staging convergence plan

Do not overwrite either live Worker as a first step. Prepare a new isolated release candidate from source control:

1. Identify and preserve the exact deployed staging bundle/version 32 and production version 35 as rollback references.
2. Recover the source lineage of staging's WRITE_CONTROL implementation; do not assume current main contains it.
3. Port or reimplement the write-control contract on an isolated branch with tests and independent review.
4. Integrate Tenant Directory authorization before write admission and before any GitHub side effect.
5. Add tenant/principal/project-scoped idempotency and replay isolation.
6. Preserve explicit UNKNOWN state and reconciliation; no ambiguous retry.
7. Define Durable Object migrations additively, with backward-compatible reads and tested rollback.
8. Build a staging candidate with commit provenance and a complete binding inventory.
9. Run unit, contract, negative, integration, concurrency, replay, and rollback tests.
10. Deploy only to a separately approved staging target after explicit authorization.
11. Verify active version, bindings, script content, and negative runtime behavior.
12. Require independent review before any production decision.

No step in this plan has been executed.

## 7. Release gates

| Gate | Acceptance condition | Current status |
|---|---|---|
| P0 source provenance | every deployed version maps to exact source SHA | BLOCKED |
| P1 write safety | production and staging use one reviewed write-control contract | NOT_ALIGNED |
| P2 authorization | human/service, tenant, project, action, resource enforced before side effect | NOT_DEPLOYED |
| P3 idempotency isolation | principal/tenant/project-scoped key and replay behavior | NOT_DEFINED |
| P4 UNKNOWN reconciliation | no blind retry; independent evidence and bounded quarantine | PARTIAL_IN_STAGING_ONLY |
| P5 migration safety | additive DO migrations, backup, restore, rollback evidence | NOT_VERIFIED |
| P6 runtime verification | actual staging negative and positive tests | NOT_RUN |
| P7 independent approval | separate reviewer signs exact artifact and test evidence | NOT_RUN |
| P8 production release | all prior gates passed and user explicitly authorizes | NO-GO |

## 8. Gate 2I verdict

**DEPLOYMENT_PROVENANCE_UNKNOWN / WRITE_CONTROL_RECONCILIATION_REQUIRED.**

The live staging Worker has useful write-control behavior, but it is not yet integrated with Tenant Directory authorization. Production lacks the staging write-control path. The current main source has Tenant Directory authorization but is not deployed. These are three distinct states and must not be merged by assumption.

## 9. Safety

Read-only inspection and documentation only. No Cloudflare Worker, binding, Durable Object, secret, environment variable, route, DNS record, deployment, GitHub PR, main branch, or production resource was changed. No secret value was read. No test or live application endpoint probe was executed. Production remains NO-GO.
