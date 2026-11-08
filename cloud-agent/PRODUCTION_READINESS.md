# Master Brain Cloud Agent — Production Readiness Checklist

This document turns the current MVP into a deployable, operable cloud service.
Treat every item as a hard gate. Do not claim “production ready” until the checklist is green.

## 1. Identity & Secrets

- [ ] `AGENT_AUTH_TOKEN` is a cryptographically random 32-byte value stored only as a Cloudflare Worker secret.
- [ ] `AGENT_USER_KEYS` (if used) contains only SHA-256 digests; raw tokens never appear in source, CI, or chat.
- [ ] Owner token rotation procedure is documented and tested (old sessions become invalid).
- [ ] No secret is present in git history, wrangler.toml, or logs.

## 2. Repository Boundary

- [ ] `REPO_OWNER` / `REPO_NAME` in `src/config.js` still match the only allowed repository.
- [ ] GitHub tools remain read-only; no write credential is bound to the Cloud Agent Worker.
- [ ] Path blocklist in `core.js` is reviewed after any new sensitive path patterns appear in the repo.

## 3. Budget & Cost Control

- [ ] Daily neuron cap (`DAILY_NEURON_BUDGET`) is still appropriate for the free/paid plan in use.
- [ ] Reserve → settle path is verified with a live model call.
- [ ] Alarm path for expired reservations is confirmed in a long-running Durable Object.
- [ ] Account-wide Workers AI usage is monitored so other projects cannot silently exhaust the allocation.

## 4. Observability

- [ ] Cloudflare observability is enabled; sampling rate is acceptable for the traffic volume.
- [ ] Tool-call outcomes, neuron consumption, and authentication failures are visible in logs.
- [ ] `/healthz` returns service, version, model, and binding presence without leaking secrets.

## 5. Authentication & Session Security

- [ ] Session capability is one-time returned and only its SHA-256 verifier is stored.
- [ ] Principal isolation (owner vs additional users) is tested with both valid and rotated tokens.
- [ ] Rate limits (session, principal, aggregate, IP) reject excess traffic with correct `Retry-After`.

## 6. Deployment Discipline

- [ ] Worker name remains `master-brain-cloud-agent` (never share Production/Staging of the Connector).
- [ ] Deployed version ID, commit SHA, and rollback target are recorded for every release.
- [ ] Live acceptance: `GET /healthz` → authenticated `POST /api/sessions` → `POST .../chat` with a real model response.
- [ ] CI (Cloud Agent CI) is green on the exact commit that is deployed.

## 7. Failure Modes

- [ ] Budget ledger corruption fails closed (inference blocked).
- [ ] Invalid `AGENT_USER_KEYS` fails closed (HTTP 503).
- [ ] Missing AI binding or Durable Object binding fails closed.
- [ ] GitHub API timeouts and oversized responses are bounded and do not crash the Worker.

## 8. OpenClaw / Connector Integration (future)

- [ ] Cloud Agent remains independent; any future shared memory must respect privacy boundaries.
- [ ] Connector write path (draft PR only) stays on a separate Worker with its own secrets.

## Release Decision

Only when sections 1–7 are checked may the service be treated as a production cloud component.
Until then it remains a hardened staging/MVP candidate.
