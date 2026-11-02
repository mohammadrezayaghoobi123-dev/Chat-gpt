# Staging deployment preflight

Candidate base: `1145b29fffec2e533e8d5d9d90534d40cfb8fd75`.

This branch exists only to execute the gated Staging deployment preflight. The workflow must stop before upload if either `CLOUDFLARE_API_TOKEN` or the Cloudflare Worker secret `GITHUB_READONLY_TOKEN` is absent. No Production deployment is permitted.
