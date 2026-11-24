# Reservation Contract Conformance Harness

This directory contains a non-production reference oracle and a backend-neutral conformance tranche.

- The reference adapter is an executable specification only. It is in-memory and is not durable.
- Passing these tests validates the contract harness against the reference model; it does not qualify Cloudflare Durable Objects, R2, Supabase, or any deployed backend.
- The candidate adapter must later run the same contract suite in an isolated environment with independent clients, process restarts, fault injection, and restore drills.
- No provider credentials, model calls, GitHub API calls, comments, or deployments are performed by this test suite.

Run with Node.js 22 from tools/9router-review:

`npm test`
