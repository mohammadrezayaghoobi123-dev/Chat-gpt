import { REPOSITORY_ALLOWLIST, REPO_FULL, REPO_NAME, REPO_OWNER } from "./config.js";

export { REPOSITORY_ALLOWLIST };

function split(full) {
  const [owner, repo] = full.split("/");
  return { owner, repo, full };
}

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
    if (match) return split(match);
  }
  throw new TypeError("Repository is not allowed.");
}
