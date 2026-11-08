import { REPO_FULL, REPO_NAME, REPO_OWNER } from "./config.js";

/**
 * Repositories the agent may read. Exactly one today (single-repository MVP).
 * Supporting more repositories means extending this list in config-reviewed code
 * and deliberately exposing a repository argument to the tools; the model can not
 * widen it on its own, because tool arguments are validated against a fixed key set.
 */
export const REPOSITORY_ALLOWLIST = Object.freeze([REPO_FULL]);

/**
 * Resolve the repository a tool call applies to. No request means the configured
 * default. Anything not on the allowlist is rejected with a fixed message that does
 * not echo the input.
 */
export function resolveRepository(requested) {
  if (requested === undefined || requested === null || requested === "") {
    return { owner: REPO_OWNER, repo: REPO_NAME, full: REPO_FULL };
  }
  if (typeof requested === "string") {
    const match = REPOSITORY_ALLOWLIST.find(entry => entry.toLowerCase() === requested.toLowerCase());
    if (match === REPO_FULL) return { owner: REPO_OWNER, repo: REPO_NAME, full: REPO_FULL };
  }
  throw new TypeError("Repository is not allowed.");
}
