# 9Router Local Bridge Preflight and Security Gate

**Audit date:** 2026-11-25  
**Disposition:** `PARTIALLY_VERIFIED / BLOCKED`  
**Scope:** Local Windows 9Router preflight for a future Master Brain bridge  
**Repository base:** `main@919b19ca3d3887352cdef06b03c668ead04fbce7`  
**Branch:** `docs/9router-local-bridge-preflight-2026-11-25`

## 1. Executive result

The installed 9Router process was restarted with an explicit loopback bind and verified to listen only on `127.0.0.1:20128`. The API's model-list route responds without an API key, while the chat-completions route rejects missing and deliberately invalid credentials.

No authenticated upstream key was provisioned, retrieved, or validated in this work. The local file named `auth/cli-secret` is not an OpenAI-compatible API key: inspection of the installed package's authentication helper shows it participates in a machine-authentication digest when the `9r-cli-auth` salt is selected. It must not be repurposed as an upstream API credential.

Accordingly, the authentication gateway, Cloudflare Quick Tunnel, and remote MCP adapter were **not** implemented or started. Exposing the current API directly would be an unacceptable bypass because `GET /v1/models` is unauthenticated.

## 2. Observed host state

| Item | Observation |
|---|---|
| Desktop Commander device | `DESKTOP-28HGRFT`, online |
| 9Router package | `9router@0.5.119`, globally installed |
| 9Router executable | `%APPDATA%\npm\node_modules\9router` |
| 9Router CLI | Supports explicit `--host` and `--port`; default host is `0.0.0.0` |
| cloudflared | Installed, version `2026.11.1` |
| 9Router listener | `127.0.0.1:20128`, process PID observed as `5792` |
| Proposed gateway listener | `127.0.0.1:20129`, absent |
| cloudflared process | Absent at final boundary check |
| 9Router scheduled task | None observed; only the existing OpenClaw Gateway task was present |
| 9Router database | Metadata and ACL only; database contents were not read |
| Secret material | No upstream API key, JWT secret, database contents, or provider credential was read or emitted. The local CLI-secret file was read into process memory and used as a Bearer value for one loopback-only diagnostic probe; its value was not printed, logged, persisted elsewhere, or committed |

The service was started with:

```powershell
9router --host 127.0.0.1 --port 20128 --no-browser --skip-update
```

The binding check showed only `127.0.0.1:20128`; it did not show `0.0.0.0:20128` or an IPv6 wildcard listener. The current process is not registered as a persistent Windows service or scheduled task.

## 3. Reproducible API observations

The following probes were made against the local loopback endpoint. Response bodies containing model/provider data were not copied into this record.

| Probe | Observed result | Interpretation |
|---|---|---|
| `GET /v1/models`, no Authorization header | HTTP `200`, response length 17,458 bytes | Model catalogue is unauthenticated; do not expose this route directly |
| `POST /v1/chat/completions`, body `{}`, no Authorization header | HTTP `401`, `Missing API key` | Inference endpoint rejects missing credentials |
| Same POST with a deliberately invalid synthetic Bearer value | HTTP `401`, `Invalid API key` | Invalid credential rejected |
| `POST /v1/chat/completions` using the local `auth/cli-secret` value in memory | No classifiable HTTP response; not accepted as proof of a valid API key | Credential purpose and API-key validity remain distinct; do not reuse this file |
| `GET /` and `GET /dashboard` | HTTP `307` | Dashboard routes redirect; they are not an API-health contract |
| `GET /health` and `GET /healthz` | HTTP `404` | No supported health endpoint was established by these probes |

No valid upstream API key was used. No provider request, model inference, paid request, or usage event is claimed.

## 4. Adversarial findings

### F-01 — unauthenticated model discovery

**Evidence:** `GET /v1/models` returned HTTP `200` without an Authorization header.

**Risk:** A direct tunnel or unrestricted reverse proxy would disclose model catalogue metadata to any reachable caller.

**Disposition:** Confirmed. All externally reachable routes must be authenticated at the gateway, including read-only model discovery.

### F-02 — upstream credential unavailable and unverified

**Evidence:** Missing and synthetic invalid credentials returned HTTP `401`. The installed helper treats `auth/cli-secret` as input to a machine-authentication digest, not as an OpenAI-compatible API key.

**Risk:** A gateway cannot safely invoke authenticated upstream endpoints without a valid server-side credential. Passing through arbitrary caller-supplied keys would move secret handling to every client and would not meet the intended integration boundary.

**Disposition:** Confirmed blocker. No credential was guessed, extracted from the database, printed, committed, or rotated.

### F-03 — unsafe default bind

**Evidence:** The CLI help declares `0.0.0.0` as the default host.

**Risk:** Starting the CLI without an explicit host could expose the service to network interfaces beyond loopback.

**Disposition:** Mitigated for this run by explicitly binding to `127.0.0.1`. The launch procedure must retain this explicit argument.

### F-04 — no verified remote MCP protocol surface

**Evidence:** The work verified OpenAI-compatible REST behavior only. No MCP transport, JSON-RPC `initialize`, `tools/list`, or tool invocation was exercised.

**Risk:** Treating an OpenAI-compatible endpoint as an MCP server would be a protocol-category error.

**Disposition:** Unknown / not implemented. A separate MCP adapter and authenticated host-to-cloud transport are required, followed by a real client interoperability test.

## 5. Required target boundary

The next implementation slice must preserve the following topology:

```text
ChatGPT / approved MCP client
        |
        | HTTPS + authenticated Streamable HTTP MCP
        v
Cloudflare Quick Tunnel (temporary hostname)
        |
        v
127.0.0.1:20129  local MCP adapter + authentication boundary
        |  - authenticate the remote caller
        |  - expose only the `/mcp` transport endpoint
        |  - implement MCP JSON-RPC and negotiated protocol version
        |  - publish only named, schema-validated tools
        |  - enforce size/time/rate/concurrency limits
        |  - redact credentials and sensitive request data
        |  - fail closed on missing or invalid configuration
        |
        | loopback-only, allowlisted REST calls
        | server-side 9Router API key
        v
127.0.0.1:20128  9Router
        |
        v
Configured providers
```

The diagram is a target design, not an implemented or verified deployment. Port `20129` is the MCP adapter boundary, not a generic REST reverse proxy.

The initial MCP surface should be deliberately narrow:
- `tools/list` may publish only named capabilities such as `router.list_models` and `router.chat_completion`.
- `tools/call` may invoke only those tools, with strict input schemas, bounded prompts/output, and explicit model/usage budgets.
- Internally, the adapter may call only `GET /v1/models` and `POST /v1/chat/completions` on loopback, using a server-side 9Router API key.
- Deny arbitrary upstream URLs, arbitrary REST paths, all unimplemented tool names, dashboard/admin/key-management/settings routes, WebSockets, and file operations.

The remote gateway token and upstream 9Router key are distinct credentials. The caller authenticates to the MCP adapter; the adapter keeps the upstream key server-side and never returns it in tool results or logs. Store credentials using a protected local mechanism (for example, Windows DPAPI with a restrictive ACL), never in Git, command-line arguments, plain-text logs, or chat.

A Quick Tunnel must target **only** the authenticated MCP adapter on port `20129`; it must never target port `20128` directly. The tunnel must remain off until the adapter's negative/positive authentication tests and MCP protocol tests pass. A temporary tunnel hostname is not an identity or authorization mechanism.

## 6. Atomic implementation gates

| Gate | Required evidence | Current state |
|---|---|---|
| G0 — local runtime | Exact package version, explicit loopback bind, process/listener check | `PASS` |
| G1 — route/auth characterization | Negative probes for model listing and inference; no secret disclosure | `PARTIAL`: inference rejects invalid credentials; models route is public |
| G2 — credential custody | Valid upstream key provisioned by the owner through the supported local UI/API and stored securely | `BLOCKED` |
| G3 — MCP adapter/auth boundary | Separate loopback listener, Streamable HTTP MCP, strict tool/input allowlist, dual credential separation, bounds, redaction | `NOT_STARTED` |
| G4 — adversarial MCP tests | Missing/invalid/rotated token; malformed JSON-RPC; invalid IDs; unsupported methods/tools; schema violations; oversized body; slow upstream; cancellation; replay; concurrency; log-redaction tests | `NOT_RUN` |
| G5 — tunnel | Quick Tunnel to gateway only; verify external unauthenticated requests receive `401/403` and cannot reach upstream | `NOT_STARTED` |
| G6 — client interoperability | MCP initialization, negotiated version, tool discovery/call, error semantics, and end-to-end invocation from a supported client | `NOT_STARTED` |
| G7 — integration qualification | Evidence-backed cost, rate, timeout, cancellation, idempotency, recovery, and audit behavior | `NOT_STARTED` |

Unknown results must remain `UNKNOWN`; they must not be relabelled as success or failure.

## 7. Rollback and safety invariants

- The only local runtime change in this slice is the explicit loopback-bound 9Router process. No 9Router configuration, password, API key, database content, provider connection, or startup task was changed.
- Rollback is to stop only the specifically re-identified 9Router process tree and then verify that port `20128` is no longer listening. Do not terminate all Node processes; the existing OpenClaw Gateway and other Node processes are unrelated.
- No Cloudflare tunnel process was started. No Worker, DNS zone, secret, binding, Durable Object, or deployment was changed.
- No GitHub `main` branch or existing 9Router PR/branch was changed. This record is isolated in a new documentation branch.
- No production or staging integration is authorized by this preflight.

## 8. Exit criteria for the blocked gate

G2 may be reconsidered only after the owner authenticates to the local 9Router dashboard using their existing credential and provisions a dedicated API key with the minimum required scope, without disclosing it to the chat or writing it to the repository. The key must then be verified in memory by a bounded local probe and placed in protected local storage. The gateway can then be implemented and tested independently before any tunnel starts.

The current result is **not an end-to-end integration**. It is a verified local runtime boundary and a reproducible security blocker, recorded to prevent unsafe exposure and to preserve the next atomic step.
