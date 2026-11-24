# DCP-01O — Runtime Deployment Identity Proof

**Date:** 2026-11-24  
**Status:** Evidence design complete; deployed runtime identity remains UNKNOWN  
**Scope:** Read-only 9Router identity audit. No live endpoint requests, provider inference, host mutation, deployment, secret access, or production change.

## 1. Decision

A semantic version or healthy HTTP response does not identify the source revision executing in a deployed 9Router instance.

For a containerized runtime, the minimum identity tuple is:

`(runtime_instance, runtime_image_digest, platform_manifest_digest, source_revision, app_version, build_workflow_revision)`

For native Node/npm, replace image digests with an immutable package/artifact identity and a verified source/build mapping.

A mutable tag such as `latest` is a locator, not an identity. Accept a deployment identity only when the runtime artifact digest matches the registry artifact for the actual platform and the artifact's source revision is independently verified.

## 2. Pinned upstream evidence

All source observations below refer to public upstream release `v0.5.123`, commit `5ae63d22847e07042e235b40e1d926b65e509013`. This does not prove that the user's local or Actions endpoint runs this release.

### 2.1 Version and health endpoints

- `src/app/api/version/route.js` imports `package.json` and returns `currentVersion`, `latestVersion`, and `hasUpdate`.
- `currentVersion` is the package version. The endpoint does not return a Git commit, image digest, builder identity, or workflow revision.
- `src/app/api/health/route.js` returns only `{ ok: true }`; it is a health/liveness signal, not build identity evidence.

Consequently, `/api/health = 200` proves only that the handler responded. `/api/version.currentVersion = 0.5.123` is a version consistency signal, not commit or artifact identity proof. Two different images can report the same package version.

### 2.2 Docker build and publication workflow

Pinned `.github/workflows/docker-publish.yml` establishes:

1. The `prepare` job checks out the release tag, validates root and CLI package versions against the tag, and computes `git rev-parse HEAD` as the source commit.
2. The `build` job checks out application source at that validated commit under `source`.
3. Separately, it checks out the publishing Dockerfile from `github.workflow_sha` under `workflow`. Application source revision and build-workflow/Dockerfile revision are distinct provenance dimensions.
4. Buildx receives OCI labels for source repository, source revision, and application version. The revision label is populated from the validated source commit.
5. The workflow builds per-platform images, captures digests, smoke-tests platform images, uploads digest artifacts, assembles a multi-platform version manifest, and smoke-tests the resolved manifest.
6. The workflow explicitly sets `provenance: false` and `sbom: false`; the inspected workflow therefore does not establish a published SLSA build-provenance attestation or SBOM.
7. The workflow checks out the Dockerfile using `github.workflow_sha`, but the inspected steps do not persist that workflow SHA as an OCI label or a human-readable build summary field.

The OCI revision label is useful corroborating evidence, but it is not a cryptographically authenticated build-provenance statement. The source revision label does not prove which workflow/Dockerfile revision built the image.

## 3. Hostile hypotheses

| ID | Hypothesis | Supporting evidence | Falsifier |
|---|---|---|---|
| H1 | Runtime is exactly the claimed source revision | Runtime digest matches registry artifact; OCI revision equals claimed source SHA | Digest mismatch, missing label, or different revision |
| H2 | Runtime only reports the same semantic version | Version endpoint reports 0.5.123 while digest/revision are absent or disagree | Independent digest and revision match |
| H3 | Runtime uses a mutable tag that drifted | Runtime evidence contains only a tag such as `latest` | Immutable runtime digest matches registry manifest |
| H4 | Build recipe differs from source revision | Workflow SHA/Dockerfile revision is unknown or mismatched | Trusted attestation binds digest to source and builder/workflow materials |
| H5 | Local process inventory identifies the router | Listener, PID, executable, working directory, and app root uniquely correlate | Multiple candidate processes or unresolved listener ownership |

No hypothesis is accepted from version strings, process names, or health checks alone.

## 4. Read-only evidence protocol

### 4.1 Containerized deployment

Collect only non-secret metadata from the already-running container:

- Container identifier/name and runtime platform.
- Immutable image ID and registry RepoDigest, if available.
- OCI labels: source, revision, version.
- Registry manifest digest for the exact published tag or digest.
- Platform architecture and matching child-manifest digest.
- Release workflow run ID, source commit, workflow revision, and digest artifact, if retained.

Do not collect environment values, command arguments, mounted secret contents, logs containing credentials, or dashboard/API keys. Do not restart, pull, recreate, or mutate the container.

Acceptance requires:
1. Runtime image digest equals the selected registry manifest/child digest for the actual platform.
2. OCI source label identifies the expected repository.
3. OCI revision equals the exact source commit being claimed.
4. OCI version agrees with the package version.
5. Platform matches runtime architecture.
6. Associated release run's source commit and build-workflow revision are recorded.

Any missing or conflicting element remains UNKNOWN or becomes FAIL; it is never inferred from a neighboring field.

### 4.2 Native Node/npm deployment

Do not infer the router from a generic `node.exe` process. A safe read-only identity record must correlate listener PID, executable path, working directory, resolved application root, package version, package-lock identity, and immutable source/package artifact identity.

Do not inspect environment values or command-line arguments because they may contain secrets. If listener-to-process or application-root mapping is ambiguous, stop with UNKNOWN.

### 4.3 Remote Actions-backed endpoint

A repository secret's non-empty status is not endpoint identity. Do not read or print `NINE_ROUTER_API_URL` or `NINE_ROUTER_API_KEY`. A non-secret operator-supplied deployment identifier or separately approved read-only metadata source is required to correlate the remote endpoint with a release artifact. No endpoint request was made in this phase.

## 5. Evidence ledger

| Evidence | Observation | Status |
|---|---|---|
| Public upstream tag/commit | `v0.5.123` / `5ae63d22847e07042e235b40e1d926b65e509013` | PASS — source pin only |
| Version API semantics | Package version only; no commit or digest | PASS — semantics inspected |
| Health API semantics | `{ ok: true }`; no build identity | PASS — semantics inspected |
| Docker source checkout | Validated release commit | PASS — workflow inspected |
| Dockerfile checkout | Uses `github.workflow_sha`, separate from source checkout | PASS — workflow inspected |
| OCI revision label | Set from validated source commit | PASS — configured in workflow |
| Build provenance/SBOM | Explicitly disabled in inspected workflow | PASS — absence confirmed |
| User's deployed runtime version | Not identified | UNKNOWN |
| Runtime image digest/package artifact | Not collected | UNKNOWN |
| Runtime OCI revision | Not collected | UNKNOWN |
| Build workflow revision | Not collected | UNKNOWN |
| Local router process-to-listener mapping | Prior inventory inconclusive | UNKNOWN |
| Remote Actions endpoint identity | Secret values not read; no non-secret binding found | UNKNOWN |

## 6. Acceptance gate and stop conditions

**DCP-01O is not deployment approval.** It is an evidence protocol and source-level gap analysis.

Stop if:
- identity collection would expose a secret, token, API URL, environment value, or sensitive command argument;
- the only evidence is a mutable tag, version string, process name, or health response;
- runtime digest and registry digest disagree;
- source revision or workflow revision is missing;
- target cannot be mapped to one unique process/container;
- any step requires restart, pull, deploy, permission change, secret access, or production mutation.

## 7. Next atomic step

Obtain one non-secret runtime identity record through an already-authorized read-only operator surface. For a container, collect image ID/RepoDigest and the three OCI labels. For native Node, collect a sanitized process-to-application-root mapping plus immutable package/source identity. Redact all environment values and command arguments.

Then compare that record independently with the pinned release manifest and GitHub release workflow evidence. Do not send a model request, provider inference request, or application POST to establish identity.

## 8. Sources

- [Pinned 9Router source tree](https://github.com/decolua/9router/tree/5ae63d22847e07042e235b40e1d926b65e509013)
- [Version endpoint](https://github.com/decolua/9router/blob/5ae63d22847e07042e235b40e1d926b65e509013/src/app/api/version/route.js)
- [Health endpoint](https://github.com/decolua/9router/blob/5ae63d22847e07042e235b40e1d926b65e509013/src/app/api/health/route.js)
- [Dockerfile](https://github.com/decolua/9router/blob/5ae63d22847e07042e235b40e1d926b65e509013/Dockerfile)
- [Docker publish workflow](https://github.com/decolua/9router/blob/5ae63d22847e07042e235b40e1d926b65e509013/.github/workflows/docker-publish.yml)
- [SLSA v1.2 — Distributing provenance](https://slsa.dev/spec/v1.2/distributing-provenance)
- [SLSA — Provenance](https://slsa.dev/provenance)

## 9. Safety boundary

Documentation-only. No application code, workflow file, repository setting, permission, secret, default branch, production service, Cloudflare resource, local machine, or running 9Router instance was changed. The PR must remain Draft and unmerged.


## 10. Public registry artifact snapshot

A read-only Docker Hub Registry API extraction was performed for the exact published tag `decolua/9router:0.5.123`. This is registry-side reference evidence, not evidence of the user's running container.

Observed snapshot:
- Multi-platform OCI index digest: `sha256:b5f68a9d0f89a805f574b32ed00103a7f205ae0ddaa4e508ad6440e58a9bd07b`.
- `linux/amd64` child manifest digest: `sha256:8c0c9644f3707810f616fecc527d50e73ce7e7698126d993a73aa594171c27a6`.
- `linux/arm64` child manifest digest: `sha256:011f257753857e18db323d0770dc2a9feee620907ed9d5246ada0f17d2707987`.
- Tag metadata reported last push at `2026-11-23T02:21:57.760034Z`; both platform images were active.
- At extraction time, the mutable `latest` tag returned the same index digest. This is a time-bounded observation only; do not use `latest` as the identity anchor.
- Docker Hub layer detail pages exposed `APP_VERSION=0.5.123` and OCI title/version labels for both platform images. They did not expose the OCI revision label in the extracted metadata.

Interpretation:
- PASS: a public, immutable digest tuple is now available as the expected registry-side reference for the 0.5.123 tag.
- UNKNOWN: whether any user runtime uses this index or either child digest.
- UNKNOWN: whether the published image's OCI revision label equals source commit `5ae63d22847e07042e235b40e1d926b65e509013`; Docker Hub's extracted layer view did not expose that label.
- UNKNOWN: the exact release workflow run and its `github.workflow_sha` for this publication; no provenance attestation was established by the inspected workflow.

Sources:
- [Docker Hub tag API — 0.5.123](https://hub.docker.com/v2/repositories/decolua/9router/tags/0.5.123)
- [Docker Hub tag API — latest](https://hub.docker.com/v2/repositories/decolua/9router/tags/latest)
- [linux/amd64 image detail](https://hub.docker.com/layers/decolua/9router/0.5.123/images/sha256-8c0c9644f3707810f616fecc527d50e73ce7e7698126d993a73aa594171c27a6)
- [linux/arm64 image detail](https://hub.docker.com/layers/decolua/9router/0.5.123/images/sha256-011f257753857e18db323d0770dc2a9feee620907ed9d5246ada0f17d2707987)

The runtime identity remains UNKNOWN until the already-running user's container image ID/RepoDigest and OCI labels are collected through an authorized read-only surface.
