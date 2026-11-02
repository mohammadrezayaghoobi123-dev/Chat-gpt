# Staging acceptance rerun 3

Run the post-deploy live health, MCP authentication, and Durable Object checks against the current Staging deployment.

Acceptance target: the active Staging version now returns `mcp: ok` only after an internal authenticated JSON-RPC `tools/list` call using the existing secret binding; the token is not logged or exposed.
