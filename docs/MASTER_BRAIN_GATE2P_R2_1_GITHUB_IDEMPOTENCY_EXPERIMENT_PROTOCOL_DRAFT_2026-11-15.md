# Gate 2P — R2.1 GitHub Idempotency Experiment Protocol (DRAFT)

**Status:** TEST PROTOCOL DRAFT — NOT EXECUTED.  
**Purpose:** investigate D-04 and phase-specific GitHub API behavior.  
**Execution authority:** repository owner only, after explicit approval of the exact disposable repository and exact script bytes.  
**Production status:** no R2 result implies production retry permission.

## 1. Questions and hypotheses

R2 is an empirical characterization of selected GitHub API behaviors. It cannot prove general Exactly-Once semantics.

| ID | Hypothesis | Experiment | Positive result proves | Does not prove |
|---|---|---|---|---|
| R2-TREE | Identical tree payloads yield identical tree SHAs | POST same tree payload twice | Object identity for tested payload/API version | Exactly-once processing or safety for arbitrary payloads |
| R2-COMMIT | Identical commit payloads, including parents/tree/message/author/committer/timestamps, yield identical commit SHAs | POST same commit payload twice | Deterministic object identity for tested inputs | Safe retry after every lost-response scenario |
| R2-REF | Repeating creation of the same ref has stable behavior | POST same ref twice; GET exact ref | Observed duplicate-ref behavior in tested repository | Safe retry after one 404 or timeout |
| R2-PR | Repeating PR creation for same head/base has stable behavior | POST same PR twice; paginate exact PR query | Observed duplicate-PR behavior | No notifications or secondary rate-limit impact |
| R2-RECON | Read-only reconciliation identifies exact objects | GET tree/commit/ref and fully paginate PRs | Completeness for tested query and pagination | Universal completeness under all indexing/permission conditions |
| R2-LOSS | Lost-response windows can be distinguished from no-effect outcomes | Fault injection after transmission and before persistence | Observed ambiguity at tested cut points | All possible network/server/process failures |

## 2. Preconditions — hard stop unless all pass

Target MUST be a newly created, private, disposable repository used only for this experiment. Do not use Master Brain, production, or a repository containing valuable data.

Before writes, record and verify:
- exact owner/repo;
- numeric repository ID;
- private=true and archived=false;
- repository creation timestamp;
- default branch and exact baseline SHA;
- exact human confirmation string matching owner/repo;
- unique high-entropy R2 run ID;
- exact script SHA-256 and version;
- GitHub API version and gh CLI version;
- credential identity and effective least-privilege permissions, without recording token.

Abort if repository identity, visibility, ID, baseline SHA or confirmation differs from operator-supplied values. Repository name alone is insufficient because names can be renamed or transferred.

Use a credential restricted to this disposable repository with only metadata, contents and pull-request permissions needed. Never print, persist or log token or authorization header.

## 3. Write guard design

A real-write script must:
1. Default to dry-run.
2. Require explicit write switch and exact repository-name confirmation.
3. Require expected numeric repository ID and expected baseline SHA.
4. Require fresh unique run ID with sufficient entropy; second-resolution timestamps alone are insufficient.
5. Generate unique branch, path and marker names scoped to run ID.
6. Refuse protected production repository by explicit denylist and exact ID checks.
7. Perform read-only preflight before first write and print the full planned object list.
8. Require a second explicit operator confirmation immediately before first POST.
9. Never automatically clean up branches, commits, refs or PRs.
10. Stop on unexpected status, malformed response, identity mismatch, rate limit, permission failure or ambiguous transport result.
11. Write append-only JSONL observations with no secrets.
12. Preserve exact request payload digests and response metadata for every attempt.

Dry-run and syntax validation are useful checks but are not API behavior evidence.

## 4. Error handling and observation schema

The pattern that suppresses all nonzero API exit statuses is prohibited. It conflates duplicate conflicts with 401/403, rate limits, 5xx, network failures and CLI errors.

For every API attempt capture:
- run_id;
- test_id and attempt number;
- UTC timestamp;
- method and canonical endpoint path (never auth headers);
- repository numeric ID and owner/repo;
- API version;
- request payload SHA-256;
- process exit code;
- HTTP status, if a response was received;
- GitHub request ID, if present;
- sanitized response body digest and bounded sanitized excerpt;
- transport error class;
- elapsed time;
- interpretation: CONFIRMED_SUCCESS, CONFIRMED_REJECTION, AMBIGUOUS, NOT_SENT or UNKNOWN.

Do not infer HTTP status from CLI text. Do not convert nonzero exit code to success. Store only minimum response fields; never store credentials.

## 5. Exact test procedure

### R2-TREE
- Construct fixed tree payload with unique run-specific path(s), explicit modes and exact blob SHAs.
- Record exact payload digest.
- POST once and record status, request ID and returned SHA.
- POST identical payload a second time and record independently.
- GET returned tree SHA and verify every path, mode, type and blob SHA.
- Matching SHA passes only for deterministic object identity under this exact payload/API version.

### R2-COMMIT
- Use exact tree SHA from R2-TREE.
- Fix parent list, tree, message, author, committer, author date and committer date byte-for-byte.
- Record exact payload digest.
- POST twice as separate attempts; compare returned SHAs.
- GET commit and verify tree, parents, message, author/committer and timestamps.
- If second response is ambiguous, do not blindly POST a third time.

### R2-REF
- Use unique branch name derived from run_id.
- POST ref once and record all response fields.
- POST exact same ref/target again; record exact status/body/request ID/exit code.
- GET exact ref and verify target SHA.
- If GET returns 404 once, retry read-only with bounded backoff and preserve observations. One 404 does not establish no effect.
- Never force-update ref.

### R2-PR
- Use exact head repository, head branch and base branch.
- Include unique run marker in title/body and record exact payload digest.
- POST once; record PR number, URL, status, request ID and response digest.
- POST exact same PR request a second time; capture exact rejection or response.
- Reconcile with direct PR GET if number is known and fully paginated pulls?state=all filtered by exact head owner/branch, base and marker.
- Verify head SHA, base SHA/branch, title/body marker, repository ID, state, draft/merged status and creation time.
- PR creation is user-visible: it can notify participants and may contribute to secondary rate limiting. Use a private disposable repository with no unrelated collaborators or notification recipients.

## 6. Lost-response fault injection

Dry-run, normal duplicate POST, or simulated local exception before transmission is not a lost-response test.

Distinguish:
- F0: failure before request bytes are sent;
- F1: request fully transmitted, client drops response before reading it;
- F2: response received by client, process crashes before persisting observation;
- F3: GitHub accepted object, but local WriteControl phase transition is not committed;
- F4: reconciliation read is stale, delayed or permission-denied.

Use a controlled client/proxy shim that records whether request bytes were transmitted and deliberately drops response. Do not use a generic retrying HTTP client. Record exact fault cut point. If cut point cannot be established, mark R2-LOSS NOT_RUN or UNKNOWN, not PASS.

## 7. Reconciliation completeness

- Paginate until API indicates no next page; record page count and per-page request IDs.
- Use exact repository numeric ID, not only owner/repo text.
- Cross-check PR head repository ID, head ref, head SHA, base ref, title/body marker and timestamps.
- Verify exact tree/commit/ref chain by identifiers.
- Record missing, duplicate, stale or conflicting candidates as evidence.
- Marker alone is not proof; markers can be copied or edited.
- No DELETE/cleanup endpoint is part of R2. Manual cleanup, if needed, is a separate owner-approved operation after evidence capture.

## 8. Interpretation rules

- Identical tree SHAs: PASS_FOR_TESTED_TREE_IDENTITY_ONLY.
- Identical commit SHAs: PASS_FOR_TESTED_COMMIT_IDENTITY_ONLY.
- Duplicate ref/PR behavior: report exact observed HTTP status, response digest, request ID and follow-up GET result. Do not assume a specific status code.
- Any transport ambiguity: UNKNOWN.
- A single negative GET: insufficient evidence for no effect.
- One repository and one run: insufficient for a broad universal claim.
- R2 outcomes do not authorize automatic retries in production. Production retry policy requires a separate phase-specific safety case, fault-injection evidence and owner approval.

## 9. Minimum repeatability

For a repeatability claim, perform at least three fresh unique run IDs in the same disposable repository and, if possible, one second disposable repository. Preserve API version and tool versions. Any difference is a contradiction requiring investigation, not an average to smooth away.

This is a proposed minimum, not statistical proof of universal behavior.

## 10. D-04 decision table

| Observation | D-04 disposition |
|---|---|
| Tree and commit duplicate payloads return identical SHAs in all controlled trials, and exact GET confirms contents | PROVISIONALLY_SUPPORTED_FOR_TESTED_INPUTS; not universal |
| Any SHA mismatch or retrieved object mismatch | DISPUTED; no deterministic retry |
| Lost-response behavior cannot be injected or observed | UNVERIFIED |
| Script exits nonzero without captured HTTP response/request ID | UNKNOWN |
| Only dry-run/syntax checks completed | API behavior NOT_RUN |
| R2-REF or R2-PR duplicate behavior is consistent | Record separately; does not alter tree/commit conclusion |

## 11. Required evidence package

Include:
- exact script bytes and SHA-256;
- script version and static-review report;
- repository name, numeric ID, visibility and baseline SHA;
- unique run IDs;
- GitHub API version and CLI version;
- raw request payload digests (not secrets);
- sanitized JSONL observations;
- all HTTP statuses and request IDs;
- complete pagination evidence;
- fault-injection cut-point evidence;
- exact GET reconciliation results;
- contradictions, missing evidence and NOT_RUN items;
- operator and independent reviewer conclusions.

Do not publish credentials, unrelated private repository contents or unredacted response bodies.

## 12. Current status

- Claude reports syntax validation and dry-run: reported, not independently reproduced.
- Exact script bytes in reviewed commit tree: NOT FOUND.
- Real writes: NOT_RUN.
- Lost-response injection: NOT_RUN.
- R2 evidence package: NOT AVAILABLE.
- D-04: UNVERIFIED.
- Production retry permission: NOT GRANTED.

No experiment is to be executed until exact script is independently reviewed and the owner explicitly confirms the exact disposable repository and write window.
