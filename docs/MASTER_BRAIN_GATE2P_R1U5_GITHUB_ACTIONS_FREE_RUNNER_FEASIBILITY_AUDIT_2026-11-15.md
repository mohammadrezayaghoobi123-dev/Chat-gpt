# R1-U5 — GitHub Actions Free-Runner and Repository Feasibility Audit

> **Provenance note (added at publication):** the analysis in this document was performed against branch `integration/master-brain-unification-2026-11-15` at commit `5d55336feef7f27c3ec8b02bb7b8dab4dab0d768` (main `919b19ca3d3887352cdef06b03c668ead04fbce7`). That branch was force-updated before publication; its head at publication is `5d8ae8c5c096356f0f64a68a46f874374b5a34b8`, whose history does not contain `5d55336` and which contains 45 additional files (including `.github/workflows/unicode18-raw-byte-acquisition.yml`) that were **NOT reviewed**. No finding here is claimed for `5d8ae8c`. Status: documentation only; no code, no tests run (NOT_RUN).
Date: 2026-11-15
Repository: mohammadrezayaghoobi123-dev/Chat-gpt
Branch under audit: integration/master-brain-unification-2026-11-15
Scope: read-only feasibility assessment; no workflow creation, dispatch, code execution, secrets, merge, deployment, or main-branch modification.

## 1. Executive verdict

**PARTIAL PASS — GitHub Actions execution infrastructure is available for a narrowly scoped, no-secret raw-byte acquisition job on this public repository.**

This is a feasibility finding only. It does not establish that a new Unicode acquisition workflow exists, that any UCD raw bytes have been acquired, that source hashes or byte lengths are known, or that the SR-02 Unicode profile is ready to freeze.

No workflow YAML was created or modified. No new workflow was dispatched. No new test or Unicode download was executed in this audit.

## 2. Repository identity and visibility

GitHub repository metadata and repository search returned:
- Repository: `mohammadrezayaghoobi123-dev/Chat-gpt`
- Repository ID: `1398846697`
- Visibility: `public`
- Archived: `false`
- Default branch: `main`
- The audited integration branch exists.
- The connected primary GitHub identity has repository push/admin permissions; these permissions were not used for operational changes in this audit.

The repository's public visibility is the key billing determinant for standard GitHub-hosted runners. Do not infer that the repository should be made public as a cost optimization; it is already public, and its visibility should remain an owner-controlled security decision.

## 3. Workflow inventory: main versus integration branch

Read-only directory inspection of `.github/workflows` on both `main` and the integration branch returned the same four files and blob SHAs:

| Workflow | Blob SHA | Purpose / trigger observation |
|---|---|---|
| `cloud-agent-ci.yml` | `ea5cc3cd3c351dfffb43fa4e1c47d8cf0fa4ffe7` | Push on selected feature/hardening/security/integration branches, path-filtered to cloud-agent; pull_request path-filtered |
| `connector-ci.yml` | `5887842736763e1c507ef7911af21c10efd6cd86` | Push on selected branches including `integration/**`, path-filtered to connector files; pull_request path-filtered |
| `secret-history-scan.yml` | `34b25c31275f8fc3d941e43a35eb19bfb097052d` | Push on all branches, pull_request, and weekly schedule |
| `static.yml` | `460f782006e8bb929c92b9357c59c8b1d73f18c7` | Main-branch Pages deployment and manual dispatch; production-affecting; excluded from this audit |

No workflow file was added or altered.

### Existing secret-history workflow security observations

The existing `secret-history-scan.yml` declares:
- `permissions: contents: read`
- `ubuntu-24.04` standard GitHub-hosted runner
- a pinned Gitleaks action revision
- checkout with `fetch-depth: 0` and `persist-credentials: false`
- `GITHUB_TOKEN` is passed to the Gitleaks action through the built-in `secrets.GITHUB_TOKEN` context
- artifact upload and Gitleaks comments are disabled in its action environment
- a second scan covers fetched refs and reachable commits

This is not a zero-token workflow: it uses GitHub's automatically provided workflow token for the Gitleaks action. It does not require a user-created repository secret for the behavior inspected. The token's effective permission is bounded by the workflow's declared read-only permission. This workflow does not perform Unicode UCD acquisition or source hashing.

The connector and cloud-agent CI workflows also declare `contents: read`. The Pages workflow has write permissions for Pages and OIDC and is not suitable as a template for a no-side-effect audit job.

## 4. Live Actions execution evidence

GitHub Actions API read of branch workflow runs returned 56 runs for the branch (first page inspected). The latest run corresponded exactly to the latest recorded branch commit:

- Commit: `e7fd463a1250c784dd498d3e24d19f8d894ae5ba`
- Workflow: `Full History Secret Scan`
- Workflow run ID: `43725750245`
- Event: `push`
- Status: `completed`
- Conclusion: `success`
- Run number: `3813`

The job-level inspection returned one job, `Gitleaks PR diff and all fetched refs`, with conclusion `success`. Its checkout, PR-diff scan, and all-fetched-refs scan steps each completed successfully.

This is direct evidence that Actions is enabled and that a standard runner executed on the public repository's integration branch. It is not evidence that any Unicode source was downloaded, that a checksum was generated, or that a parser test passed.

## 5. Cost and quota assessment

Official GitHub documentation distinguishes standard GitHub-hosted runners from larger runners:
- Standard GitHub-hosted runners are free for public repositories.
- Larger runners are billed even for public repositories.
- Private-repository runner use is subject to the account's included compute allowance and possible additional billing.
- Artifact and cache storage have separate limits and billing behavior.

The inspected repository is public and the existing CI uses standard `ubuntu-24.04`, not a larger runner. Therefore, a small, bounded job using a standard runner is eligible for free execution under GitHub's published policy. The audit does not inspect the owner's billing settings or remaining account quota; however, public-repository standard-runner use is documented as free independently of private-repository included compute.

For the proposed acquisition job:
- use only a standard `ubuntu-24.04` runner;
- set a short job timeout (for example, 10 minutes);
- do not upload artifacts or use caches;
- print only file name, HTTP status, content type, byte length, and SHA-256;
- never print source file contents or environment variables;
- do not use larger runners, self-hosted runners, Codespaces, or paid cloud sandboxes.

The GitHub Actions system limits are not a substitute for budget controls. Keep the workflow bounded and do not enable paid runner classes.

## 6. Feasible no-secret execution design (proposal only)

A future isolated acquisition workflow can be designed without repository secrets or a checkout step:
1. Trigger only from a narrowly scoped integration-branch push (or another explicitly approved trigger).
2. Use `ubuntu-24.04` standard runner.
3. Declare `permissions: {}` if the job does not need repository API access.
4. Use only built-in OS tools / Python standard library; no third-party actions required.
5. Fetch the exact versioned Unicode 18.0.0 UCD URLs over HTTPS.
6. Preserve the response body as bytes; do not decode/re-encode before hashing.
7. Verify HTTP status, TLS transport, expected file header, content type, exact byte count, and SHA-256.
8. Independently reproduce the download and digest through a second acquisition path before accepting source-integrity evidence.
9. Keep all raw bytes and manifests ephemeral unless a separate owner-approved archival policy is established.
10. Emit only non-sensitive integrity metadata in logs.

Important trigger constraint: GitHub documents that `workflow_dispatch` is only received when the workflow file exists on the default branch. A new workflow kept only on the integration branch therefore cannot be assumed to be manually dispatchable from the Actions UI. A branch-only push trigger is technically feasible, but adding such a workflow would itself create and execute new automation. That action is outside this feasibility-only authorization and requires a separate explicit approval.

## 7. Security and operational constraints

- Public repository contents and workflow logs are publicly observable. Never place credentials, private data, or sensitive source material in logs or artifacts.
- A GitHub-hosted runner is ephemeral, but it is not an independent trust domain from GitHub Actions itself.
- The workflow's code and dependencies must be pinned/reviewed; avoid third-party actions for this narrow job.
- No checkout is needed if the workflow embeds a fixed source inventory and only downloads public versioned URLs.
- Do not use the existing Pages workflow; it can deploy from `main`.
- Do not change `main`, branch protections, repository visibility, secrets, Cloudflare, Supabase, or local machine state.

## 8. Evidence gaps and falsification criteria

The feasibility verdict must be downgraded if:
- GitHub changes its policy so standard runners for public repositories are no longer free;
- the repository becomes private or the runner selection changes to a billed larger runner;
- a billing or policy gate blocks execution;
- the workflow requires any user-created secret, write permission, artifact, or external paid service;
- the fetched bytes cannot be independently reproduced exactly.

The following remain **UNKNOWN / NOT RUN**:
- raw-byte acquisition for the nine-file Unicode 18.0.0 UCD inventory;
- exact byte lengths and SHA-256 values;
- deterministic parser/manifest reproduction;
- independent R1-G review;
- SR-02 complete profile freeze;
- implementation and tests.

## 9. Decision and next gate

**R1-U5 status: PARTIAL PASS — execution feasibility established; acquisition not authorized or performed.**

Next atomic gate: prepare a minimal workflow specification and threat model for owner review. Do not create the workflow or trigger another run until the owner explicitly authorizes that exact change and its automatic execution on the integration branch.

No source code, workflow, secret, PR, merge, deployment, or main-branch content was changed in this audit.
