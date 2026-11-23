# Master Brain — Unified Write Execution Contract: v2.2 AMENDMENTS (DRAFT)

> **Provenance:** pinned connector blobs and the eight reviewed Gate 2K–2O documents were verified byte-identical at integration heads `5d8ae8c`, `5a68a4d` and `7f7abd2` (relative to audited `5d55336`). Documentation only; all tests NOT_RUN.

**Status:** DRAFT, not frozen. Documentation only; nothing implemented; all tests NOT_RUN.
**Applies to:** `…CONTRACT_V2_1_DRAFT_2026-11-15.md`. Each amendment **replaces or extends** the named v2.1 section; v2.1 text not mentioned stays. A consolidated v2.3 is to be produced only after the owner answers the open decisions (§Z).
**Source:** independent read-only reviewer pass on v2.1 (verdict **CONDITIONAL**; C-01..C-15: CLOSED 7 / PARTIAL 8 as judged by that reviewer; findings F-01..F-19 below are *that reviewer's* IDs, prefixed `V21-`). The reviewer ran no tests and could not verify GitHub/Cloudflare behaviour; everything about those platforms stays **UNVERIFIED** here.
**Correction of my own error (V21-F-16):** v2.1 §13 claimed the upstream review's C-13 text was truncated at "External". It was not; the truncation came from my own `cut` when displaying the line. The full sentence ends "External anchoring remains a separate future control." The note is withdrawn.

## A-01 (V21-F-02, F-03) — pinned inputs and two digests · replaces v2.1 §5 digest scope, §10, §12
- `request_digest` = JCS digest of **client intent** only: canonical action, resource descriptor (`repository_id`, `base_branch`), title, summary/body, draft flag, file list (`path`, `mode`, `type`, `content_length`, `content_sha256` over raw bytes). Used for idempotency conflict detection. It contains **no** base SHA and **no** timestamps.
- `execution_digest` = JCS digest of the server-pinned execution plan: `request_digest`, `base_commit_sha`, `base_tree_sha`, `resolved_full_name`, fixed author/committer identity, **fixed author/committer timestamp**, commit message with trailers, branch name, API version. Per-phase digests = SHA-256 of the **JCS of the exact request body sent** for that phase.
- **Server-pinned at admission, never re-resolved:** `base_commit_sha`, `base_tree_sha` (resolved once before the admission transaction, outside it, together with `repository_id`), and the author/committer timestamp (taken from the DO clock at admission, UTC, second precision). After UNKNOWN, takeover or reconcile, the pinned values are reused; the base branch having moved never changes the plan.
- Clients MUST NOT supply timestamps or base SHAs (`INVALID_REQUEST`). Without a fixed timestamp the commit SHA is non-deterministic, so a missing/changed value is a defect, not a retry.
- **Rationale to verify (UNVERIFIED):** deterministic commit SHA also needs identical tree, parents, message, author and committer; R2.1 trial E2 tests this.

## A-02 (V21-F-04) — Option A ticket hardened · extends v2.1 §7
Ticket fields add `ticket_id` (unique), `operation_key` binding, **single use per admission**. For every `*_DISPATCHED`, WriteControl requires `ticket.expires_at > now + HTTP_TIMEOUT + CLOCK_SKEW_MARGIN` (**PARAMs**); otherwise it obtains a new ticket (fresh authorization). The ticket id is recorded per phase. The stated authorization gap is: *max ticket age + time from re-read to the `*_DISPATCHED` commit + time to send + any in-flight HTTP request.* Expiry is compared across two DO clocks; skew margin is a PARAM. Ticket authentication unresolved ⇒ **admission closed** (fail-closed). OD-1 remains the owner's decision.

## A-03 (V21-F-05) — repository identity through the operation · extends v2.1 §3, §4
Persist `repository_id` **and** `resolved_full_name` in the operation record. Before every `*_DISPATCHED`, read the repository and require the same `repository_id`; mismatch ⇒ `REPOSITORY_ID_MISMATCH`, no dispatch (narrows, cannot close, the delete-and-recreate window). The request digest uses `repository_id`, not the slug. A replay whose slug no longer resolves to the stored `repository_id` is a different scope and is authorized afresh; whether stored results stay readable after a rename is decided by that fresh authorization. Slug comparison on stored bytes is stricter than GitHub's case-insensitive slugs; this is intentional fail-closed behaviour. Whether endpoints redirect after rename/transfer, and whether id-based Git Data endpoints exist: **UNVERIFIED**.

## A-04 (V21-F-06, F-07, F-18, F-19) — status model completed · replaces v2.1 §8
| operation_status | external_effect_state | entered when |
|---|---|---|
| IN_PROGRESS | NOT_DISPATCHED | admitted, no `*_DISPATCHED` yet |
| IN_PROGRESS | INDETERMINATE | a `*_DISPATCHED` is outstanding (no `*_WRITTEN`) |
| IN_PROGRESS | PRESENT_PARTIAL | one or more phases confirmed written, none outstanding |
| SUCCEEDED | PRESENT_COMPLETE | PR verified (A-08) |
| FAILED_NO_EFFECT | NONE_PROVEN | **only** if no phase was ever dispatched (denial/validation/quota/audit failure before the first `*_DISPATCHED`) or the first-phase attempt got a definitive endpoint rejection per the §15 table |
| PARTIAL_ORPHAN | PRESENT_PARTIAL | witness shows exact artifacts exist but the operation cannot complete |
| UNKNOWN | INDETERMINATE | effect not uniquely determinable, incl. dispatch-window crash and DISPUTED reconcile |
| **ADMIN_CLOSED** | unchanged (stays INDETERMINATE/PRESENT_PARTIAL) | terminal administrative closure of UNKNOWN/PARTIAL_ORPHAN |
Rules: (1) UNKNOWN→SUCCEEDED only via a unique exact witness; (2) UNKNOWN→PARTIAL_ORPHAN only via a witness of exact existing artifacts; (3) absence of evidence **never** yields FAILED_NO_EFFECT after any dispatch; (4) unreferenced tree/commit objects cannot be enumerated, so they are recorded as `UNREFERENCED_OBJECTS_POSSIBLE` (informational) and whether they count as "external effect" is **OD-9**; until decided, any operation with an accepted or ambiguous tree/commit dispatch cannot become FAILED_NO_EFFECT; (5) **ADMIN_CLOSED** requires capability `project.admin_close`, a named actor, a reason, and an audit event; it is never presented as success or failure and its tombstone keeps blocking the key.

## A-05 (V21-F-08, F-14 partial) — quota and idempotency window · extends v2.1 §11, §14
- Idempotency-window clock starts when the operation **enters a terminal status** (SUCCEEDED, FAILED_NO_EFFECT, ADMIN_CLOSED). IN_PROGRESS, UNKNOWN and PARTIAL_ORPHAN never expire and never get a tombstone-only response; replays return their real state (after fresh authorization).
- Add transitions: UNKNOWN→SUCCEEDED: UNKNOWN cap −1; UNKNOWN→PARTIAL_ORPHAN: UNKNOWN −1, ORPHAN +1; UNKNOWN→ADMIN_CLOSED: UNKNOWN −1; PARTIAL_ORPHAN→ADMIN_CLOSED: ORPHAN −1.
- **Double-release guard:** a boolean `concurrency_held` per operation; concurrency is released exactly once (at the first transition that releases it); later resolution never releases again.
- Admission closes when any counter is **at or above** its cap; state transitions always proceed even above a cap (counters may exceed it).
- Replays reserve no concurrency and consume no rate.

## A-06 (V21-F-09, F-10) — clock, lease and durability · extends v2.1 §9, §10
- `last_observed_now` is persisted in the same transaction as every use. PARAM `MAX_FORWARD_CLOCK_JUMP`: an observed jump above it ⇒ no new dispatch (fail closed) and an audit event.
- Invariant: `HTTP_TIMEOUT + MARGIN < lease_duration` (PARAMs). A taker may reconcile while an original request may still be in flight; this is safe only because absence of evidence never concludes anything (A-04 rule 3) — stated explicitly.
- `lease_holder` = identifier of the **dispatcher** that issues the HTTP request. Where the dispatcher runs (inside the WriteControl DO or in a Worker presenting a holder id) is **OD-10**.
- **Durability barrier:** the sender MUST await confirmation that the `*_DISPATCHED` transaction is durable before issuing the request. The Cloudflare mechanism (e.g. output-gate behaviour, `storage.sync()`) is **UNVERIFIED** and must be confirmed from primary documentation before implementation.

## A-07 (V21-F-11) — paths and digests · extends v2.1 §5
Minimum rules (the owner's SR-02/FC3 profile may be stricter; that profile was **not reviewed** here and is a tracked dependency): reject duplicate paths, case-only duplicates, file-versus-directory prefix conflicts, empty or `.`/`..` components, any `.git` component, and invalid UTF-8. Duplicate JSON keys are rejected **during parsing, before any value is used**. v1 accepts only content representable as UTF-8 text unless the owner adds a separate blob-creation phase (**OD-11**; inline-content behaviour **UNVERIFIED**).

## A-08 (V21-F-12, F-19) — success witness and reconciliation · replaces v2.1 §12 tail
- The happy path does **not** accept a PR `201` alone. After PR creation the dispatcher verifies by `GET` using the same witness rules; SUCCEEDED needs that verification. If verification cannot complete, the operation stays IN_PROGRESS and becomes UNKNOWN on lease expiry; the recorded PR number is a *hint* for reconcile.
- Witness preference: **immutable first** — commit fetched by SHA (parent, tree, trailers), tree entries and content digests, PR number, PR `created_at` within `[admission, observation]`, PR author = the expected service GitHub identity (id recorded). Mutable fields (state, body, `head.sha` as read from the PR) are recorded as evidence. Acceptable PR states: open, closed, merged — state is recorded, not a match criterion. Behaviour after head-branch deletion: **UNVERIFIED**.
- Raw response digests and request ids are evidence, not match criteria (volatile fields).
- Reconcile credential MUST be read-only unless OD-4 grants a documented exception. Reconcile on an IN_PROGRESS operation whose lease is valid under another holder is **not allowed**. If the reconcile credential is revoked ⇒ `RECONCILE_NOT_AUTHORIZED`, record stays UNKNOWN; the exit is ADMIN_CLOSED (A-04).

## A-09 (V21-F-13, F-14) — audit details · extends v2.1 §13, §10
One global WriteControl chain; genesis `prev_hash` = 64 zero hex characters; pruning a prefix requires a retained checkpoint `(seq, hash)`. If the audit append fails in a `*_WRITTEN` transaction, the transaction rolls back and the phase falls back to its `*_DISPATCHED` state and becomes UNKNOWN (safe, stated). A fenced-off (stale) worker's response is never applied to phase state, but MAY be appended as an append-only `LATE_OBSERVATION` audit event, usable only as a reconcile hint.

## A-10 (V21-F-15, F-17) — errors and naming · extends v2.1 §15, §4, §6
Add codes: `TICKET_EXPIRED`, `TICKET_MISMATCH`, `REPOSITORY_ID_MISMATCH`, `OPERATION_IN_PROGRESS`, `INVALID_REQUEST`, `ADMIN_CLOSED`. The per-endpoint outcome table is **PENDING** (needs R2.1 evidence and primary GitHub documentation); until then every unlisted outcome is `GITHUB_RESPONSE_AMBIGUOUS`. Naming: operation-key field is `key_schema = 1` (independent of document version); branch hex is lowercase; the phase vocabulary is defined once: tree, commit, branch (ref), pr → states `RESERVED, TREE_DISPATCHED, TREE_WRITTEN, COMMIT_DISPATCHED, COMMIT_WRITTEN, BRANCH_DISPATCHED, BRANCH_WRITTEN, PR_DISPATCHED, PR_CREATED, PR_VERIFIED`. The review text used by v2.1 is commit `a69d94f` (still present in the integration branch history at `5a68a4d`).

## Z. Open owner decisions after v2.2
OD-1 authorization A/B (blocker) · OD-2 canonical action id · OD-3 branch suffix/marker · OD-4 credential lifecycle and reconcile credential exception · OD-5 capacity evidence · OD-6 anchoring · OD-7 legal/deletion · OD-8 PARAM values (now incl. ticket age, skew margin, HTTP timeout, lease duration/margin, max clock jump, window lengths, quotas) · **OD-9** unreferenced objects vs "external effect" · **OD-10** dispatcher location · **OD-11** blob phase vs UTF-8-only v1. D-04 stays UNVERIFIED (R2.1 not yet run; E6 NOT RUN).

## Test additions (all NOT_RUN)
T-22 pinned base/timestamp reuse after takeover · T-23 two digests (base move does not break replay) · T-24 ticket single-use/expiry at later phase · T-25 repository delete-recreate mid-operation · T-26 UNKNOWN→ADMIN_CLOSED accounting and no double release · T-27 non-terminal never tombstoned · T-28 clock forward jump fail-closed · T-29 durable-before-send barrier · T-30 late observation never mutates phase · T-31 PR 201 without verification ⇒ not SUCCEEDED · T-32 reconcile credential revoked ⇒ UNKNOWN.
