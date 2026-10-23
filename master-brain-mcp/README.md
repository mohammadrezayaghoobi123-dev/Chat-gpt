# Master Brain Cloud MCP (starter)

A stateless, read-only MCP service designed to run separately from the Windows/OpenClaw machine.

## Included tools

- `master_brain_status` — service health and safety boundaries.
- `master_brain_architecture` — the current Master Brain starter blueprint.
- `proof_audit_template` — structures supplied claims and evidence for review. It does **not** independently verify claims or fetch sources.

## Safety and scope

- No access to the laptop, filesystem, OpenClaw Gateway, Tailscale, or Ollama.
- No shell execution, writes, credentials, or destructive tools.
- No persistent storage; audit results are not saved.
- The architecture is a scaffold, not the complete Master Brain system.
- Deploy behind HTTPS. Do not add secrets to this repository.

## Run locally

Requires Node.js 20 or newer.

```sh
cd master-brain-mcp
npm install
npm run check
npm start
```

The service listens on `PORT` (default `3000`). Health check: `GET /healthz`. MCP endpoint: `POST /mcp`.

## Cloud deployment

### Docker

From the repository root:

```sh
docker build -f master-brain-mcp/Dockerfile -t master-brain-mcp .
docker run --rm -p 3000:3000 -e PORT=3000 master-brain-mcp
```

### Render

The included `render.yaml` is a starting point for a Docker web service. Connect the repository in Render and deploy the Blueprint. Review current plan limits and billing first. Free web services may sleep or have usage limits; this does not guarantee always-on hosting.

## Connect to ChatGPT

After deployment, use the HTTPS `/mcp` endpoint in a ChatGPT client that supports custom MCP connections. Availability depends on the ChatGPT plan, workspace settings, and current product support. The endpoint must be publicly reachable over HTTPS. Do not expose plain HTTP publicly.

## Verification checklist

- `npm run check`
- `GET /healthz` returns HTTP 200
- MCP client initializes and lists all three tools
- Tool calls return text and do not mutate external state
- Deployed URL uses HTTPS

## Next steps

Add persistent evidence storage, authentication, external source retrieval, and the full contradiction/proof engine only after defining the data model, privacy boundaries, and authentication. Keep write-capable tools disabled until separately reviewed.
