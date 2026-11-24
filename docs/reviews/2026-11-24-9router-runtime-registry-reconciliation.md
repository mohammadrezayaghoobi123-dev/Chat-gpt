# DCP-01P — Runtime-to-Registry Reconciliation and Build-Lineage Audit

**Date:** 2026-11-24  
**Status:** Registry tuple corroborated; release-to-build lineage incomplete; user runtime identity UNKNOWN  
**Target:** Public 9Router release `v0.5.123` and Docker Hub artifact `decolua/9router`  
**Repository scope:** Documentation-only continuation on the existing PR head branch.  
**Safety:** No endpoint request, model/provider inference, secret read, process mutation, container pull/restart, deployment, permission change, merge, or default-branch mutation.

## 1. Executive decision

The public registry-side artifact for `decolua/9router:0.5.123` is now independently corroborated at the OCI index and per-platform manifest level. The release page also links the version to source commit prefix `5ae63d2`, matching the previously pinned full commit.

This establishes a useful **release/artifact correlation**, not a cryptographically authenticated build lineage and not the user's deployed runtime identity.

The three proof obligations remain distinct:

1. **Artifact identity:** What exact bytes are published? — registry digest tuple observed.
2. **Build lineage:** Which exact source and workflow/Dockerfile revisions produced those bytes? — partially specified by workflow source; exact workflow execution and authenticated provenance remain UNKNOWN.
3. **Runtime identity:** Which immutable artifact is actually running in the user's environment? — UNKNOWN.

No inference is allowed across these boundaries.

## 2. Immutable reference tuple

### 2.1 Source release

- Release: `v0.5.123`
- Release page date: `2026-11-22`
- Tag event shown by GitHub: `2026-11-23 02:13 UTC`
- Full source commit: `5ae63d22847e07042e235b40e1d926b65e509013`
- Package: `9router-app`
- Package version at that commit: `0.5.123`

The GitHub release page displays the matching short SHA `5ae63d2`; the full SHA was fetched independently from the repository commit endpoint. The pinned package manifest reports `name=9router-app` and `version=0.5.123`.

### 2.2 Docker Hub registry metadata

A direct read-only Docker Hub tag API extraction returned:

| Field | Value |
|---|---|
| Repository | `decolua/9router` |
| Version tag | `0.5.123` |
| Media type | `application/vnd.oci.image.index.v1+json` |
| OCI index digest | `sha256:b5f68a9d0f89a805f574b32ed00103a7f205ae0ddaa4e508ad6440e58a9bd07b` |
| amd64 child | `sha256:8c0c9644f3707810f616fecc527d50e73ce7e7698126d993a73aa594171c27a6` |
| arm64 child | `sha256:011f257753857e18db323d0770dc2a9feee620907ed9d5246ada0f17d2707987` |
| Tag last pushed | `2026-11-23T02:21:57.760034Z` |
| Tag status | `active` |

The Docker Hub API response for `latest` returned the same OCI index digest and the same two child digests in the observed snapshot. This is only a point-in-time equality. `latest` is mutable and must never be the deployment identity anchor.

The Docker Hub layer detail for the amd64 child exposes:
- `APP_VERSION=0.5.123`
- `org.opencontainers.image.title=9router`
- `org.opencontainers.image.version=0.5.123`
- Runtime defaults including `PORT=20128` and `DATA_DIR=/app/data`.

The extracted Docker Hub layer view did **not** expose `org.opencontainers.image.revision`. Do not treat the displayed package version as a substitute for that missing source-revision label.

### 2.3 Registry consistency check

The direct API response for the version tag and the direct API response for `latest` matched on:
- OCI index digest;
- amd64 child digest;
- arm64 child digest;
- platform set.

Result: **PASS — observed registry reference consistency**.

This does not prove that the tags will remain equal, that the tag cannot be republished, or that a user runtime uses either digest.

## 3. Build-lineage reconstruction

The pinned `.github/workflows/docker-publish.yml` at source commit `5ae63d22847e07042e235b40e1d926b65e509013` specifies:

1. Build workflow is triggered by a `v*` tag push or manual `workflow_dispatch`.
2. The prepare job checks out the release tag, validates root and CLI package versions against the tag, and computes the checked-out source commit.
3. Each platform build checks out application source at that validated commit.
4. The Dockerfile is checked out separately from `github.workflow_sha`; therefore source revision and build recipe revision are separate materials.
5. The build passes OCI labels for source repository, source revision, and version.
6. The build runs for `linux/amd64` and `linux/arm64`, captures each platform digest, and smoke-tests each platform image before digest publication.
7. A later job assembles the multi-platform manifest and smoke-tests the resolved version manifest.
8. The workflow explicitly configures `provenance: false` and `sbom: false`.

The workflow therefore defines a plausible source-to-artifact process and emits useful OCI labels, but the inspected workflow itself does not emit BuildKit provenance or an SBOM. A label written by the build process is corroborating metadata, not a signed statement binding the artifact digest to all build materials.

### 3.1 Workflow execution identity

The public release page and registry timestamp correlate the release and image publication in time. However, an exact GitHub Actions run ID for this release was not recovered in this audit.

The connected GitHub workflow-run lookup used here is documented to return only pull-request-triggered runs; it returned an empty list for the upstream release commit. That empty result is not evidence that no release workflow ran.

The exact values below therefore remain UNKNOWN:
- release workflow run ID;
- `github.workflow_sha` used by that run;
- exact Dockerfile blob SHA used by that run;
- workflow job outputs linking each child digest to the assembled index digest;
- authenticated provenance statement binding the final index digest to the source and workflow materials.

## 4. Hostile hypotheses and falsification criteria

| ID | Hypothesis | Current evidence | Discriminating test |
|---|---|---|---|
| H1 | The version tag was built from the matching source commit | Release page short SHA matches pinned full SHA prefix; workflow source checks out validated tag commit; image version agrees | Retrieve exact release workflow run and verify its source commit, workflow SHA, and digest outputs |
| H2 | A different source commit was used while preserving version 0.5.123 | Same version alone cannot rule this out; runtime revision label not exposed by current extraction | Inspect actual image config label and compare full revision SHA |
| H3 | The Dockerfile/build recipe differed from the source revision | Workflow explicitly checks out Dockerfile at `github.workflow_sha` | Recover exact run and workflow SHA; hash the Dockerfile blob at that SHA |
| H4 | The image was republished after initial publication | Workflow supports manual republish; docs state numbered tags can be republished | Compare registry digest snapshots over time and exact run IDs; registry API alone cannot reconstruct history |
| H5 | The user's runtime is running the observed registry image | No runtime image ID/RepoDigest has been collected | Read-only container inspection and exact digest comparison |
| H6 | A mutable tag moved after the observation | `latest` is mutable; current API snapshot matched the version tag | Re-query tag metadata at the time of deployment and use immutable digest pinning |

No hypothesis is promoted to PROVEN based solely on package version, image tag, build workflow source, or temporal proximity.

## 5. Evidence ledger

| Claim | Status | Basis |
|---|---|---|
| Release v0.5.123 points to source SHA prefix 5ae63d2 | PASS | GitHub release page |
| Full source commit is 5ae63d22847e07042e235b40e1d926b65e509013 | PASS | GitHub commit lookup |
| Package manifest reports version 0.5.123 | PASS | Pinned package.json |
| Version tag maps to the recorded OCI index digest | PASS | Direct Docker Hub tag API |
| Index maps to the recorded amd64 and arm64 child digests | PASS | Direct Docker Hub tag API |
| Latest matched the same digest tuple in the observed API response | PASS — point-in-time only | Direct Docker Hub tag API |
| Docker Hub layer metadata reports APP_VERSION and title/version labels | PASS | amd64 layer detail |
| OCI revision label equals full source SHA | UNKNOWN | Label not exposed by extracted layer metadata |
| Exact release workflow run ID | UNKNOWN | Not recovered |
| Exact workflow_sha and Dockerfile blob SHA for the publication | UNKNOWN | Run metadata unavailable |
| Signed build provenance/SBOM for this publication | UNKNOWN / NOT ESTABLISHED | Pinned workflow disables provenance and SBOM; no independent attestation was retrieved |
| User's live runtime digest equals the registry digest | UNKNOWN | No runtime identity record |
| User's live runtime is source commit 5ae63d2... | UNKNOWN | No runtime revision evidence |

## 6. Acceptance policy for runtime reconciliation

The runtime may be classified as matching this reference only when all applicable conditions hold:

1. The already-running container's immutable image ID/RepoDigest is captured through an authorized read-only surface.
2. The runtime platform is known.
3. The runtime digest matches the corresponding platform child digest, or its immutable multi-platform index reference resolves to the exact index digest.
4. The runtime image config exposes the expected repository, version, and full source revision labels.
5. The source revision is the full pinned commit SHA, not merely a short prefix.
6. The exact build workflow revision is recovered and recorded separately from the application source revision.
7. Any missing provenance evidence is explicitly retained as a residual risk; no signed provenance claim is made.

If the runtime is native Node/npm rather than containerized, the equivalent must bind listener PID → executable → application root → package artifact/source identity without reading environment values or command-line arguments.

Stop conditions:
- any secret, token, environment value, command argument, or sensitive log would be exposed;
- runtime-to-process/container mapping is ambiguous;
- image digest differs from the expected immutable reference;
- the only match is a version string or mutable tag;
- a restart, pull, deployment, permission change, or production mutation is required.

## 7. DCP-01P result

**Registry identity:** PASS for the observed public tag/index/platform digest tuple.  
**Release/source correlation:** PASS at release-page short-SHA plus full commit and package-version level.  
**Build execution lineage:** UNKNOWN.  
**Runtime identity:** UNKNOWN.  
**Automatic reconciliation / provider dispatch:** NOT AUTHORIZED.

The next valid step is to obtain a sanitized, non-secret runtime identity record from an already-authorized operator surface. Do not issue an application POST or model request to prove image identity.

## 8. Sources

- [GitHub release v0.5.123](https://github.com/decolua/9router/releases/tag/v0.5.123)
- [Pinned source commit](https://github.com/decolua/9router/commit/5ae63d22847e07042e235b40e1d926b65e509013)
- [Pinned package.json](https://github.com/decolua/9router/blob/5ae63d22847e07042e235b40e1d926b65e509013/package.json)
- [Pinned Docker publish workflow](https://github.com/decolua/9router/blob/5ae63d22847e07042e235b40e1d926b65e509013/.github/workflows/docker-publish.yml)
- [Docker Hub tag API — 0.5.123](https://hub.docker.com/v2/repositories/decolua/9router/tags/0.5.123)
- [Docker Hub tag API — latest](https://hub.docker.com/v2/repositories/decolua/9router/tags/latest)
- [Docker Hub amd64 image detail](https://hub.docker.com/layers/decolua/9router/0.5.123/images/sha256-8c0c9644f3707810f616fecc527d50e73ce7e7698126d993a73aa594171c27a6)
- [Docker deployment guidance](https://github.com/decolua/9router/blob/master/DOCKER.md)
- [SLSA v1.2 — Distributing provenance](https://slsa.dev/spec/v1.2/distributing-provenance)

## 9. Safety boundary

This is a documentation-only audit record. It does not modify application code, CI workflows, secrets, repository settings, permissions, default branch, production services, Cloudflare, the local machine, or any running 9Router instance. The existing PR remains Draft and unmerged.


## 10. Adversarial source-cache conflict

A separate web-search index result for the Docker Hub repository overview / a `latest` layer page surfaced a different digest prefix, `sha256:12086f978...`. In the same audit, direct Docker Hub tag API extraction for both `0.5.123` and `latest` returned the full index digest `sha256:b5f68a9d0f89a805f574b32ed00103a7f205ae0ddaa4e508ad6440e58a9bd07b`.

The search-index snippet did not provide a reliable registry snapshot timestamp and may be cached or temporally stale; however, that explanation is not independently proven. Therefore:
- Exact version tag `0.5.123` → index digest `b5f68a9d...`: PASS based on direct tag API response.
- `latest` equals `0.5.123` across every public observation: UNKNOWN due to conflicting search-index evidence.
- `latest` is not accepted as a stable identity reference.
- No claim is made that the registry was compromised, that the tag moved, or that the search result is false.

This conflict is retained rather than suppressed. Runtime pinning must use the exact immutable digest, not `latest`.
