const SHA_PATTERN = /^[0-9a-f]{40}$/;

export function resolveCandidateRef(env = process.env) {
  const releaseEnvironment = env.RELEASE_ENV;
  if (releaseEnvironment !== "staging" && releaseEnvironment !== "production") {
    throw new Error("RELEASE_ENV must be explicitly set to staging or production.");
  }

  const candidateSha = env.GITHUB_SHA;
  if (typeof candidateSha !== "string" || !SHA_PATTERN.test(candidateSha)) {
    throw new Error("GITHUB_SHA must be the exact 40-character release candidate commit SHA.");
  }

  const candidateBranch = env.GITHUB_REF_NAME;
  const expectedBranch = `integration/${releaseEnvironment}-release-${candidateSha}`;
  if (candidateBranch !== expectedBranch) {
    throw new Error("GITHUB_REF_NAME must exactly match the immutable release branch for GITHUB_SHA.");
  }

  return Object.freeze({ candidateBranch, candidateSha });
}
