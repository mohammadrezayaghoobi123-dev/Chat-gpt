# OpenClaw

**Status:** bootstrap and architecture only. Not a deployable runtime in this repository.

## Boundary

OpenClaw is a **personal agent** design with staged capabilities. This directory holds:

- Architecture plan: [`OPENCLAW_ARCHITECTURE.md`](./OPENCLAW_ARCHITECTURE.md)
- Bootstrap policy templates: [`bootstrap/`](./bootstrap/)

It does **not** contain:

- Model credentials or API keys
- Private memory or user data
- A production gateway binary
- Coupling to `cloud-engineering-connector`

Runtime state belongs outside the public tree (e.g. `~/.openclaw/` or a private backup repository).

## Relationship to Cloud Engineering Connector

None at the code level. In a future phase an OpenClaw agent *may* call the connector as one MCP tool provider. Until then, treat the two as separate products under the same workspace governance.

## Phases (summary)

1. Core runtime + verified auth route  
2. Trusted capabilities (research, GitHub, files)  
3. Higher-risk capabilities (browser, shell, webhooks) with least privilege  
4. Persistence and periodic security audit  

See the architecture document for verification gates and open decisions.
