const RELEASE_ENVIRONMENTS = new Set(["staging", "production"]);
const MESSAGE_PREFIX = "release-evidence:v1";

function invalidIdentity() {
  throw new Error("Invalid release deployment identity.");
}

export function createReleaseDeploymentMessage(identity) {
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) {
    return invalidIdentity();
  }

  const {
    releaseEnvironment,
    candidateSha,
    workflowRunId,
    workflowRunAttempt,
  } = identity;

  if (
    !RELEASE_ENVIRONMENTS.has(releaseEnvironment)
    || typeof candidateSha !== "string"
    || !/^[a-f0-9]{40}$/.test(candidateSha)
    || typeof workflowRunId !== "string"
    || !/^[1-9][0-9]*$/.test(workflowRunId)
    || typeof workflowRunAttempt !== "string"
    || !/^[1-9][0-9]*$/.test(workflowRunAttempt)
  ) {
    return invalidIdentity();
  }

  const message = [
    MESSAGE_PREFIX,
    "environment=" + releaseEnvironment,
    "sha=" + candidateSha,
    "run_id=" + workflowRunId,
    "run_attempt=" + workflowRunAttempt,
  ].join(";");

  if (Buffer.byteLength(message, "utf8") > 1000) {
    return invalidIdentity();
  }

  return message;
}

export function findUniqueReleaseDeployment(deployments, expectedMessage) {
  if (
    !Array.isArray(deployments)
    || typeof expectedMessage !== "string"
    || expectedMessage.length === 0
    || Buffer.byteLength(expectedMessage, "utf8") > 1000
  ) {
    throw new Error("Invalid release deployment lookup input.");
  }

  const matches = deployments.filter(
    deployment => deployment?.annotations?.["workers/message"] === expectedMessage,
  );

  if (matches.length === 0) {
    throw new Error("No deployment matches the exact release identity.");
  }
  if (matches.length > 1) {
    throw new Error("Multiple deployments match the exact release identity.");
  }

  return matches[0];
}
