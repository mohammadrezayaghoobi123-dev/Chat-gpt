# Current-Main Scheduler Runtime Reachability Audit

**Audit date:** 2026-11-24  
**Repository:** `mohammadrezayaghoobi123-dev/Chat-gpt`  
**Baseline branch:** `main`  
**Baseline commit:** `919b19ca3d3887352cdef06b03c668ead04fbce7`  
**Baseline tree:** `a506f5afe64c97d94ae268a8c3ee74f3dd5a7a71`  
**Audit class:** Evidence-only source and configuration reachability audit  
**Disposition:** Runtime caller not demonstrated; tenant-scoping contract requires an owner decision  
**Production changes:** None  
**Deployment or Cloudflare mutations:** None

## 1. Executive finding

The current repository source does not demonstrate a production Scheduler runtime that invokes `OrchestratorLedger.createTask`.

The recursive Git tree at the pinned baseline contained 86 tracked files (blob entries). All 19 non-test JavaScript/TypeScript source files were fetched at the pinned commit and scanned for the relevant runtime symbols and call patterns, including:

- `createTask`
- `createScheduledWorkerAssertion`
- `orchestrator-scheduler`
- `LEDGER_WORKER_ASSERTION_KEYS`
- `ORCHESTRATOR_LEDGER`
- `OrchestratorLedger`
- scheduled-event handlers and Scheduler entry points

The production-source matches are declarations, verification logic, a class export, and configuration. No production call site for `createTask` or `createScheduledWorkerAssertion` was found outside their defining modules. The test suite does call these APIs directly; test invocation is not evidence of a deployed runtime caller.

This is a bounded repository finding, **not** proof that no external Worker, separately deployed service, or out-of-repository caller exists. The connected Cloudflare account was also inspected read-only: its three listed Workers had no Cron schedules or `scheduled` handlers, and the live `chat-gpt111` Worker did not expose the `ORCHESTRATOR_LEDGER` binding. Subsequent release-history correlation established that the deployed production version predates the commit that introduced the Ledger class and binding into the repository; this is therefore an unreleased-source delta, not by itself evidence of a failed or incorrect deployment. Another Cloudflare account or an external platform remains unexamined.

## 2. Pinned evidence and call graph

### 2.1 Worker entry point and exposed MCP surface

Evidence:

- `cloud-engineering-connector/index.js:2-5` exports `OrchestratorLedger` as a Durable Object class and exports the default Worker from `worker.js`.
- `cloud-engineering-connector/worker.js:12-18` declares the MCP tool surface. It contains project inspection, file reading, architecture review, engineering standards, and draft-PR creation; there is no task-admission or Scheduler tool.
- `cloud-engineering-connector/worker.js:212` dispatches only those declared tool names.
- `cloud-engineering-connector/worker.js:228` exports a default object with a `fetch` handler. The exported object has no `scheduled` handler.
- The production Worker source does not import `OrchestratorLedger`, reference `env.ORCHESTRATOR_LEDGER`, invoke `createTask`, or invoke `createScheduledWorkerAssertion`.

Interpretation:

The deployed entry point in this repository is an HTTP/MCP Worker. Its checked-in implementation does not contain the scheduled-event entry point or a call chain from an MCP request to task admission.

### 2.2 Durable Object registration is real, but does not establish a caller

Evidence:

- `cloud-engineering-connector/wrangler.toml:59-65` binds `ORCHESTRATOR_LEDGER` to `OrchestratorLedger` and declares the SQLite Durable Object migration.
- `cloud-engineering-connector/wrangler.toml:67-73` declares the corresponding staging binding and migration.
- The complete checked-in `wrangler.toml` contains no `[triggers]` / `crons` declaration.
- `index.js` exports the Durable Object class required by the binding.

Interpretation:

The binding and class registration establish that the repository provisions a Durable Object capability. They do not establish that any Worker calls that capability. The absence of a checked-in cron declaration is a source-configuration observation. Read-only Cloudflare API inspection of the connected account was subsequently performed; live schedules and binding results are recorded in Section 10.

### 2.3 Scheduler assertion implementation

Evidence in `cloud-engineering-connector/orchestrator-worker-identity.js`:

- Lines 7-9 define the base and Agent claim-key sets. Tenant, Project, and Task fields are included in Agent claims, not in the base claim set used for non-Agent roles.
- Lines 42-63 validate the exact claim set and enforce the tenant/project/task equality checks for Agent-role assertions.
- Lines 132-143 define the scheduled signer policy. The `orchestrator-scheduler` principal has the `system` role for `createTask`.
- Lines 151-155 describe the helper as intended for the Cloudflare scheduled-event execution path.
- Lines 156-184 implement `createScheduledWorkerAssertion`. The signed claim contains issuer, audience, subject, role, operation, issue/expiry times, and JTI. It does not contain Tenant ID, Project ID, Task ID, initiating Principal, correlation/request ID, policy version, or a normalized Task digest.
- The helper checks the supplied fixed principal/role/operation against an allowlist. It does not itself receive or validate a Cloudflare `ScheduledController` event or otherwise prove that the caller is executing from a scheduled event.
- The helper is exported from its module, but is not re-exported by `index.js`.

Interpretation:

The code has a narrowly named signing helper and a fixed principal/operation allowlist. The scheduled-event provenance requirement currently exists as a documented caller obligation, not as an event-context check within this helper. No production caller was found to discharge that obligation.

### 2.4 Ledger admission boundary

Evidence in `cloud-engineering-connector/orchestrator-ledger.js:730-798`:

- `createTask` requires a Task carrying syntactically valid Tenant and Project identifiers.
- It requires `workerId === "orchestrator-scheduler"`.
- It verifies a `system` assertion for subject `orchestrator-scheduler` and operation `createTask`.
- The expected assertion context passed to `verifyWorkerAssertion` contains subject, role, operation, and time. It does not pass Tenant ID, Project ID, or Task ID as expected claims.
- Once the assertion is verified, Tenant and Project values are taken from the supplied Task object and used for scoped idempotency and persistence.
- The method does not call the Tenant Directory membership or project-policy authority to establish that the scheduled task's Tenant/Project pair is authorized.

Interpretation:

The Ledger enforces Tenant/Project storage scoping and a fixed Scheduler service identity. It does not, at this boundary, cryptographically bind that Scheduler assertion to the specific Tenant, Project, Task, or authorized admission decision. This creates a **scope-free system admission capability** at the method contract level.

That observation is not, by itself, proof of an exploitable cross-tenant vulnerability. Exploitability depends on who can mint or obtain the Scheduler assertion, how the signing key is isolated, who can invoke the Durable Object method, and what the intended authority of a platform-global Scheduler is. Those facts are not established by this repository trace.

### 2.5 Tenant authorization path is separate

Evidence:

- `cloud-engineering-connector/identity/tenant-context.js:107-152` resolves a tenant membership for an opaque authenticated principal using the membership store.
- `cloud-engineering-connector/identity/tenant-context.js:155-201` binds project authorization to the authenticated principal and verified tenant context.
- `cloud-engineering-connector/worker.js` uses these helpers in the project-change-PR path.
- No production path forwards that verified tenant context or policy decision into `OrchestratorLedger.createTask`.

Interpretation:

A tenant membership and project-policy mechanism exists, but the reviewed Scheduler admission boundary is not connected to it in the current production source.

## 3. Test evidence and its limits

`cloud-engineering-connector/cloudflare-test/orchestrator-ledger-idempotency-scope.test.js:4-64` imports `createScheduledWorkerAssertion`, mints Scheduler assertions, and directly invokes `instance.createTask` for separate Tenant/Project scopes. This demonstrates that the current test harness can exercise the Durable Object method with the generic Scheduler capability across multiple scopes.

This is useful characterization of the current API contract. It does **not** prove that a production Scheduler exists, that a deployed caller can obtain the signing key, or that an untrusted tenant can mint the capability.

`cloud-engineering-connector/cloudflare-test/orchestrator-worker-identity-scope.test.js` characterizes tenant/project/task-bound Agent assertions. It does not provide equivalent scope-binding coverage for Scheduler assertions.

## 4. Architectural contract comparison

The repository's reference architecture states:

- `docs/architecture/REFERENCE_ARCHITECTURE_MULTI_TENANT_V1.md:100-107`: authenticate the caller, resolve tenant membership and project permissions server-side, carry integrity-protected internal context including principal, tenant, project, purpose, capability, expiry, correlation ID, and policy version, and persist/revalidate background-job context.
- `docs/architecture/REFERENCE_ARCHITECTURE_MULTI_TENANT_V1.md:126-132`: tenant-owned records and background workers must preserve tenant scope; tenant context is derived at a trusted boundary and propagated immutably.

The current Scheduler assertion and `createTask` method contract do not demonstrate those bindings. There are at least two materially different possible product contracts:

1. **Platform-global admission:** a platform Scheduler is intentionally authorized to create tasks in any tenant. This requires an explicit global admission policy, auditable authorization decision, constrained task sources, and a definition of who may request/trigger global admission.
2. **Tenant-scoped admission:** each task is created for a specific tenant/project under a server-derived authorization context. This requires the signed capability and admission decision to bind at least Tenant, Project, Task/request identity, and the canonical task/request digest, with revocation/policy-version semantics defined.

The repository does not establish which contract the owner has approved. The implementation must not silently choose one.

## 5. Adversarial hypotheses and falsification conditions

| Hypothesis | Current status | Evidence that would distinguish it |
|---|---|---|
| H1: A separate Worker or service invokes the Durable Object. | Unknown; not falsified. | Source for that runtime, its binding configuration, its call site, and an end-to-end trace to `createTask`. |
| H2: The Ledger is currently a registered but unused orchestration foundation. | Provisionally supported by repository source. | A verified external caller or deployment artifact showing active use would falsify this. |
| H3: The default MCP Worker handles scheduled execution through an undocumented route. | Contradicted by the checked-in dispatch and default export. | A separate deployed entry point or generated runtime not represented in the checked-in source. |
| H4: The generic Scheduler capability is intentionally platform-global. | Unknown; owner decision required. | Approved threat model and admission policy defining global cross-tenant task authority. |
| H5: Scheduler authorization must be tenant/project-scoped. | Supported by the reference architecture, but not yet mapped to an approved runtime contract. | A formally approved exception explicitly assigning platform-global authority to the Scheduler. |

## 6. Security disposition

| Property | Result |
|---|---|
| `OrchestratorLedger` class and binding exist | Verified |
| `createTask` method exists and requires fixed Scheduler identity | Verified |
| Checked-in default Worker has a scheduled-event handler | Not present |
| Checked-in production caller of `createTask` | Not found in 19/19 production JS/TS files inspected |
| Checked-in production caller of `createScheduledWorkerAssertion` | Not found in 19/19 production JS/TS files inspected |
| External/deployed Scheduler caller | Unknown |
| Scheduler assertion bound to Tenant/Project/Task | No |
| Scheduler admission authorized through Tenant Directory/policy at Ledger boundary | Not demonstrated |
| Production exploitability | Unknown; no Scheduler/Ledger runtime path was observed in the connected account, but external accounts/callers remain unexamined |
| Live `chat-gpt111` Cron schedules | Empty array from read-only Cloudflare API |
| Live `chat-gpt111` handlers | `fetch` only |
| Live `chat-gpt111` `ORCHESTRATOR_LEDGER` binding | Absent from returned Worker settings |
| Live `chat-gpt111` Durable Object exports | Empty exports map |
| Production vulnerability verdict | Not assigned |

Do not classify the unknown external runtime as safe or vulnerable. Do not treat a passing test that directly calls the Durable Object as proof of production reachability.

## 7. Required owner decision before implementation

The next implementation step is blocked on one explicit decision:

**Is Scheduler task admission a platform-global authority, or must every scheduled task carry an authorization context bound to its Tenant and Project?**

If platform-global, document the global admission policy and its allowed task sources before implementation.

If tenant-scoped, approve the minimum signed context and canonical request binding, including the source of the tenant/project identity and the policy/revocation semantics. Only then should a test-first characterization and isolated mutation test be added on top of the current `main` baseline.

## 8. Next falsification experiment

Once the runtime owner and intended authority are identified:

1. Identify any Scheduler outside the three Workers returned by the connected Cloudflare account, including any other Cloudflare account or external platform; obtain its source and deployed binding/trigger configuration.
2. Trace one real scheduled invocation to the Durable Object RPC boundary.
3. Record the trusted origin of Tenant/Project, the signer key boundary, the assertion claims, and the Task canonicalization/hash procedure.
4. Reproduce the call in a controlled integration test.
5. Add one test that must fail when Tenant/Project/Task or request-digest binding is removed.
6. Kill that exact test with an isolated mutation; do not combine unrelated mutations.
7. Keep Production unchanged until the owner contract, evidence, CI, and rollback plan are independently reviewed.

## 9. Non-actions and safety boundary

This audit created no production-code change, did not alter `main`, did not change Worker configuration, bindings, triggers, Queues, secrets, or Cloudflare resources, and did not merge or deploy anything. No secret values or fingerprints were accessed or recorded.

## 10. Live Cloudflare account evidence (read-only, 2026-11-24)

A read-only Cloudflare API inspection was performed after the source-only audit. The connected account's Worker Scripts list returned exactly three scripts on the queried page (`per_page=100`, page 1):

| Script | Live default handlers | Named handlers / DO exports | Cron schedules |
|---|---|---|---|
| `chat-gpt111` | `fetch` | None; exports map empty | Empty |
| `chat-gpt111-staging` | `fetch` | `WriteControl` Durable Object | Empty |
| `master-brain-cloud-agent` | `fetch` | `AgentBudget`, `AgentSession` Durable Objects | Empty |

The following read-only API results were obtained:

- `GET /accounts/{account_id}/workers/scripts` returned the three script names above. The response did not include additional pagination metadata.
- `GET /accounts/{account_id}/workers/scripts/{script_name}/schedules` succeeded for all three scripts; each returned `schedules: []`.
- The script inventory reported only `fetch` in the default `handlers` array for all three scripts. No deployed `scheduled` handler was listed.
- `GET .../chat-gpt111/settings` succeeded. Its binding names/types did **not** include `ORCHESTRATOR_LEDGER`; the returned `exports` map in the script inventory was empty.
- The staging Worker had a `WRITE_CONTROL` Durable Object namespace binding and a `WriteControl` named Durable Object export, but no `ORCHESTRATOR_LEDGER` binding/export.
- The Master Brain cloud agent had `AgentBudget` and `AgentSession` Durable Object exports/bindings, but no Scheduler handler or cron schedule.
- The latest listed `chat-gpt111` deployment was created at `2026-11-03T14:29:40.273955Z`. The audited `main` head commit was authored/committed at `2026-11-09T18:07:14Z`. The deployed artifact therefore predates the audited `main` head by timestamp; the deployment source commit identity was not established from the metadata returned.

### 10.1 Consequence

The live metadata does not show an active Cron Trigger or Scheduler handler among the three Workers visible in the connected Cloudflare account. More materially, the live production Worker `chat-gpt111` does not expose the `ORCHESTRATOR_LEDGER` binding or Durable Object export that current `main` declares in `wrangler.toml`.

This is a **verified source-versus-live release delta** for the connected account at inspection time: current `main` contains a Ledger capability that is absent from the production deployment inspected. Section 11 establishes that the live production deployment predates the commit that first added the Ledger class and binding to the repository. The absence is therefore consistent with a feature added to source after the last production deployment; it is not, by itself, evidence of a failed deployment, accidental configuration loss, or a production regression. The exact source commit that produced deployed Version 35 remains unestablished. A separately configured Worker in another Cloudflare account, external service, or different execution platform remains outside this evidence.

### 10.2 Updated threat disposition

- **In-repository Scheduler caller:** not found in 19/19 production JS/TS source files.
- **Connected-account Cron triggers:** none returned for the three listed Workers.
- **Connected-account Scheduler event handlers:** none listed for the three Workers.
- **Live production `ORCHESTRATOR_LEDGER` binding:** absent from `chat-gpt111` settings.
- **Deployment provenance to current `main`:** not established; live deployment timestamp predates audited `main` head.
- **External runtime or another Cloudflare account:** unknown.
- **Production exploitability:** unknown; no active production Scheduler-to-Ledger path was demonstrated in the inspected repository/account.
- **Primary operational finding:** the Ledger feature added to `main` on 2026-11-08 is not present in the latest production Version created on 2026-11-03. Treat it as an unreleased source change until an explicit release decision is made. Do not deploy solely to eliminate this difference.

No secret values, tokens, key material, or secret fingerprints were retrieved. Only binding names and types were inspected. All Cloudflare calls in this section were GET operations; no Worker, binding, trigger, secret, Durable Object, queue, or deployment was modified.

## 11. Release chronology and root-cause correlation

A separate read-only chronology check was completed to distinguish an incorrect deployment from a source change that had not yet been released.

### 11.1 Cloudflare production version history

The Cloudflare Versions API was queried with `page=1` and `per_page=100` for `chat-gpt111`:

- The API returned **35 versions** in total.
- The latest version was Version **35**, ID `b4667a11-aa74-49ca-8d29-2f7b62608de0`, created at `2026-11-03T14:29:40.273955Z`, source `api`.
- The Deployments API returned **25 deployments**.
- The latest deployment was created at `2026-11-03T14:29:40.273955Z` and routed **100%** of traffic to Version 35.
- Version 35 metadata showed `fetch` as its only default handler, an empty named-handler list, an empty Durable Object exports map, and no `ORCHESTRATOR_LEDGER` binding.
- The Version 35 metadata and deployment metadata do not identify the exact Git commit whose source produced the uploaded bundle.

### 11.2 Git introduction point for the Ledger

GitHub path history for `cloud-engineering-connector/wrangler.toml` and `cloud-engineering-connector/orchestrator-ledger.js` was inspected. The first current-main commit introducing the Ledger capability was:

- Commit: `5bf7f022e355f89a32e656ef056df94851c01592`
- Timestamp: `2026-11-08T10:27:29Z`
- Message: `feat(orchestration): port isolated Ledger with bounded readiness contract`

The commit added `cloud-engineering-connector/orchestrator-ledger.js`, added its export in `index.js`, and modified `wrangler.toml` to add the `ORCHESTRATOR_LEDGER` Durable Object binding plus the v2 SQLite migration for production and staging.

The Ledger-introduction commit occurred approximately **4 days and 20 hours after** the latest production Version 35 was created on 2026-11-03. The audited current `main` head is later still (`919b19ca3d3887352cdef06b03c668ead04fbce7`, 2026-11-09).

### 11.3 Root-cause assessment

The source/live difference is explained by chronology:

1. Production Version 35 was created on 2026-11-03.
2. The Ledger class and production/staging Durable Object binding were first added to the repository on 2026-11-08.
3. The connected Cloudflare account has no later `chat-gpt111` version or deployment than Version 35.
4. Therefore, the currently inspected production deployment predates the source change that introduced the Ledger.

**Finding:** the Ledger capability is present in current source but is not part of the latest production deployment observed. This is a **not-yet-released feature delta**, not evidence that an already-deployed Ledger binding was lost or that Cloudflare failed to apply a configuration that existed at deployment time.

The exact Git commit corresponding to Version 35 remains **unknown** because the deployment/version metadata returned no source commit identifier. This audit does not download or inspect Worker source bytes and does not make a source-equivalence claim beyond the verified version metadata, handler/export metadata, binding list, and Git introduction chronology.

### 11.4 Release gate

Do not create a corrective deployment solely to make Production match current `main`. Before any release:

1. Confirm whether the Ledger capability is approved for Production or remains an unreleased foundation.
2. Identify the intended release commit and compare its complete Worker code, binding set, Durable Object migrations, secrets-by-name, and rollback constraints.
3. Validate the real Scheduler runtime and its signer/key boundary; current evidence still shows no Scheduler handler or Cron trigger in the inspected account.
4. Run the approved staging integration and failure/recovery tests.
5. Obtain explicit release authorization before changing Production.

All Cloudflare calls for this chronology section were GET operations. No source bytes, secret values, or key material were retrieved. No deployment, version, binding, migration, trigger, or Worker setting was changed.
