# Langfuse tracing

Master Brain's Langfuse tracing is optional and fail-open: the core continues to
run unchanged when the SDK or credentials are absent, and telemetry failures do
not determine mission status.

## Enable tracing

Install the optional dependency from the repository root:

```bash
pip install -e ".[observability]"
```

Create a Langfuse project at https://langfuse.com/cloud, then configure these
environment variables in the runtime/secret manager (not in source control):

- `LANGFUSE_PUBLIC_KEY`
- `LANGFUSE_SECRET_KEY`
- `LANGFUSE_BASE_URL` (EU cloud: `https://cloud.langfuse.com`; use your project's region URL otherwise)
- `LANGFUSE_TRACING_ENVIRONMENT` (recommended: `development`, `staging`, or `production`)

Do not paste API keys into chat, commit them, or put them in tracked `.env`
files. Rotate a key immediately if it is exposed.

## What is recorded

- A root `agent` observation named `master-brain-mission`.
- Nested `agent` observations for specialist islands that actually execute.
- Allowlisted operational metadata: risk tier, configured/executed island IDs,
  counts of claims/evidence/errors/contradictions, and final mission status.
- Error type names rather than raw exception messages.

The instrumentation intentionally excludes the mission objective, constraints,
claim/evidence text, raw island summaries, and provider payloads. This avoids
sending potentially confidential business information to an external service by
default. Revisit the allowlist deliberately if richer trace context is required.

## Scope and limitations

The current MVP uses injected island executors and has no built-in LLM provider
integration. These spans trace orchestration and specialist execution boundaries;
they do not claim to capture model names, token usage, or provider generations that
the application does not yet invoke. When real model SDKs are integrated, add the
corresponding Langfuse framework integration so model, token, and generation
observations are captured automatically.

Run the test suite with tracing disabled to verify offline behavior. To verify
live ingestion, run a low-risk mission in a configured environment and inspect
the trace in the Langfuse Traces view. Never use production secrets in tests.
