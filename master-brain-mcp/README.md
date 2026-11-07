# Master Brain Cloud MCP (starter)

A read-only MCP service with in-memory protocol sessions, designed to run separately from the Windows/OpenClaw machine. It does not persist user evidence or application data.

## Included tools

- `master_brain_status` — service health and safety boundaries.
- Web interface at `/app` (also the `/` landing page) for status, architecture, and proof-audit template.
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

The service listens on `PORT` (default `3000`). Web interface: `GET /app` (or `/`). Health check: `GET /healthz`. MCP endpoint: `POST /mcp`.

## Cloud deployment

### Deno Deploy (candidate no-card path)

A `deno.json` deployment configuration is included for the Deno Deploy dashboard. The current Node/Express app is intended to run as a dynamic app; compatibility and public health/MCP calls must still be verified after deployment.

1. Sign in at https://console.deno.com/ and create an organization/application.
2. Choose deploy from GitHub and select this repository.
3. Select branch `feature/master-brain-cloud-mcp` and set the project root / working directory to `master-brain-mcp`.
4. Use the included `deno.json` configuration and deploy as a dynamic application.
5. Open the generated HTTPS URL. Verify `/healthz` returns HTTP 200 and `/app` loads, then test MCP initialization and all three tools.

Deno Deploy documents a Free plan, but free organizations have restricted limits until an organization is verified with a payment card. Do not enter a card if you want to remain strictly no-card; if the service cannot be used under the unverified limits, stop rather than upgrade. See https://docs.deno.com/deploy/ and https://docs.deno.com/deploy/changelog/.

### Docker

From the repository root:

```sh
docker build -f master-brain-mcp/Dockerfile -t master-brain-mcp .
docker run --rm -p 3000:3000 -e PORT=3000 master-brain-mcp
```

Render configuration remains in the repository for portability, but Render is not the current deployment path because the user encountered a card request. Do not treat the service as deployed until a real public HTTPS URL has passed the verification checklist below.

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
