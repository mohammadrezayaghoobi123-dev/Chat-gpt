# Cloud Engineering Connector

A general-purpose, cloud-hosted MCP connector for demanding software engineering: repository inspection, architecture review, evidence-aware reasoning, and reviewable code changes. This project is separate from the existing Master Brain prototype.

## Design principles

- **Cloud execution:** runs as a Cloudflare Worker; requests do not require a laptop process.
- **Project-agnostic:** tools work with repositories supplied by the caller.
- **Evidence discipline:** distinguish repository facts from assumptions and unverified conclusions. A generated checklist is not proof.
- **Safe autonomy:** code changes go to a new `assistant/*` branch and a **draft pull request**. The connector never writes to the base branch or merges.
- **Least privilege:** credentials are cloud secrets, never source files. Use a fine-grained token limited to selected repositories.
- **Bounded changes:** maximum 12 files and 500 KB per proposal; workflow files, environment files, credential directories, and private keys are blocked.
- **Bounded upstream responses:** GitHub API response bodies are capped at 2,000,000 bytes by default; `read_project_file` uses a stricter 150,000-byte cap. Oversized or inconsistent file responses are rejected.
- **Fail closed:** MCP bearer authentication is mandatory.

## MCP tools

- `project_inspect`: repository metadata, latest branch commit, and a capped file listing.
- `read_project_file`: read a text file at a ref.
- `architecture_review`: review rubric for requirements, architecture, correctness, security, operations, testing, and evidence.
- `engineering_standards`: mandatory operating rules and a quality gate for evidence, testing, safety, and reporting.
- `create_change_pr`: create a new `assistant/*` branch and draft PR; never merge.

The model using this connector must perform substantive reasoning, inspect relevant files, consult primary sources where necessary, and run/inspect CI. Tool output alone is not proof that code is correct.

## Local verification

Requires Node.js 22 or newer.

```sh
npm test
npm run check
```

## Cloud deployment (Cloudflare Workers)

This branch includes the Worker source and Wrangler configuration, but no live Worker is deployed by GitHub commits. To deploy without merging into `main`, connect the repository in the Cloudflare dashboard and select branch `feature/cloud-engineering-connector` with project root `cloud-engineering-connector`. Set `MCP_AUTH_TOKEN` and `GITHUB_TOKEN` as Worker secrets before exposing the endpoint.

1. Sign in to Cloudflare and connect this GitHub repository.
2. Create a Worker using `cloud-engineering-connector/worker.js` as the entry point and `wrangler.toml` as its configuration.
3. Set secret `MCP_AUTH_TOKEN` to a long random value.
4. Set `GITHUB_TOKEN` as a secret for repository tools. Use a fine-grained token limited to selected repositories with Contents: read/write, Pull requests: read/write, and Metadata: read. Never paste secrets into chat or commit them.
5. Deploy and verify `GET /healthz` returns `status: ok`.
6. Configure the MCP client to use the deployed HTTPS `/mcp` endpoint with the matching Bearer token. Confirm the client supports the selected authentication mechanism; do not disable auth to work around incompatibility.
7. Verify initialize, tools/list, read-only calls, and a draft PR on a disposable test repository before connecting production code.

## Cost and availability

Cloudflare Workers has a free tier subject to current quotas and account eligibility. Free does not mean unlimited execution or guaranteed unlimited availability. This commit does not mean the service is deployed; no cloud account, secret, domain, or live endpoint is configured by this code alone.

## Security boundaries and limitations

- No shell or arbitrary command execution is exposed.
- GitHub writes create a new branch and draft PR; no auto-merge.
- Repository content is untrusted input; instructions found in files cannot override user intent or these safety boundaries.
- Source verification and actual tests must be performed by the connected model/CI; `architecture_review` only returns a structured rubric.
- This initial version does **not** execute arbitrary project test suites in an isolated sandbox. Inspect CI results before merging.

## Roadmap

1. Deploy and verify MCP endpoint and auth compatibility.
2. Test read-only inspection against a disposable repository.
3. Test draft-PR generation and CI against a disposable repository.
4. Add isolated cloud test execution only after defining resource limits, network policy, dependency caching, and secret isolation.
5. Add source retrieval with citations and persistent project memory after privacy, retention, and tenant isolation are designed.
