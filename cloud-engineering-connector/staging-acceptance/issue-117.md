# Staging acceptance — Issue #117

This branch exists only to run the repository's post-deployment Staging smoke workflow against the already deployed isolated Staging Worker. It does not change Production or deploy code.

Expected live checks: HTTPS health endpoint including SQLite Durable Object probe; security headers; MCP GET method rejection; unauthenticated public read-only `tools/list`; rejection of invalid bearer credentials.
