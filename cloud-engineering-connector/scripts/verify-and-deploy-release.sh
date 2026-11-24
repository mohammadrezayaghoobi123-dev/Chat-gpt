#!/usr/bin/env bash
set -euo pipefail

: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${GITHUB_SHA:?GITHUB_SHA is required}"
: "${RELEASE_ENV:?RELEASE_ENV is required}"
: "${RELEASE_GITHUB_TOKEN:?RELEASE_GITHUB_TOKEN is required}"
: "${RELEASE_REVIEWER_IDS:?RELEASE_REVIEWER_IDS is required}"
: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is required}"
: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID is required}"

case "$RELEASE_ENV" in
  staging)
    deploy_args=(--env staging)
    ;;
  production)
    deploy_args=()
    ;;
  *)
    echo "::error::Unsupported release environment."
    exit 2
    ;;
esac

env -u CLOUDFLARE_API_TOKEN -u CLOUDFLARE_ACCOUNT_ID \
  node scripts/verify-release-approval.mjs

env -u RELEASE_GITHUB_TOKEN -u RELEASE_REVIEWER_IDS \
  npx wrangler deploy "${deploy_args[@]}"
