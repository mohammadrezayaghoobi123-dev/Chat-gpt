import { appendFile, readFile } from "node:fs/promises";

export const BOOTSTRAP_OWNER_ID = "335530603";
const GITHUB_API_VERSION = "2022-11-28";
const MAX_RESPONSE_BYTES = 1024 * 1024;
const SHA_PATTERN = /^[a-f0-9]{40}$/i;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function rejected(reasonCode) {
  return { status: "REJECTED", reasonCode };
}

function unknown(reasonCode) {
  return { status: "UNKNOWN", reasonCode };
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function canonicalDispatchNumber(value) {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function trustedRepository(payload, repository, repositoryId) {
  if (!REPOSITORY_PATTERN.test(repository ?? "") ||
      !Number.isSafeInteger(Number(repositoryId)) || Number(repositoryId) < 1) return false;
  const eventRepository = payload?.repository;
  return Number.isSafeInteger(Number(eventRepository?.id)) && Number(eventRepository.id) > 0 &&
    Number(eventRepository?.id) === Number(repositoryId) &&
    typeof eventRepository?.full_name === "string" &&
    eventRepository.full_name.toLowerCase() === repository.toLowerCase();
}

function resolveEventTarget({ eventName, payload, actorId, ref, repositoryId }) {
  const currentActorId = String(actorId ?? "");

  if (eventName === "issue_comment") {
    if (currentActorId !== BOOTSTRAP_OWNER_ID) return rejected("ACTOR_NOT_ALLOWLISTED");
    if (payload?.action !== "created") return rejected("COMMENT_ACTION_NOT_CREATED");
    if (!payload?.issue?.pull_request) return rejected("COMMENT_TARGET_IS_NOT_PULL_REQUEST");
    const body = payload?.comment?.body;
    const firstLine = typeof body === "string" ? body.split(/\r?\n/, 1)[0] : null;
    if (firstLine !== "/review-canary") return rejected("COMMENT_COMMAND_NOT_EXACT");
    if (String(payload?.comment?.user?.id ?? "") !== currentActorId ||
        String(payload?.sender?.id ?? "") !== currentActorId) {
      return rejected("COMMENT_ACTOR_MISMATCH");
    }
    const number = positiveInteger(payload?.issue?.number);
    return number ? { status: "TARGET", number, eventSnapshot: null } : rejected("PR_NUMBER_INVALID");
  }

  if (eventName === "workflow_dispatch") {
    if (currentActorId !== BOOTSTRAP_OWNER_ID) return rejected("ACTOR_NOT_ALLOWLISTED");
    if (ref !== "refs/heads/main") return rejected("DISPATCH_REF_NOT_MAIN");
    const number = canonicalDispatchNumber(payload?.inputs?.pull_request_number);
    return number ? { status: "TARGET", number, eventSnapshot: null } : rejected("DISPATCH_PR_NUMBER_INVALID");
  }

  if (eventName === "pull_request_target") {
    const allowedActions = new Set(["opened", "reopened", "synchronize", "ready_for_review"]);
    if (!allowedActions.has(payload?.action)) return rejected("PULL_REQUEST_ACTION_NOT_ALLOWED");
    const pr = payload?.pull_request;
    const number = positiveInteger(pr?.number);
    if (!number) return rejected("PR_NUMBER_INVALID");
    const headSha = pr?.head?.sha;
    const baseSha = pr?.base?.sha;
    if (!SHA_PATTERN.test(headSha ?? "") || !SHA_PATTERN.test(baseSha ?? "")) {
      return rejected("EVENT_SHA_INVALID");
    }
    if (Number(pr?.head?.repo?.id) !== Number(repositoryId) ||
        Number(pr?.base?.repo?.id) !== Number(repositoryId)) {
      return rejected("EVENT_FORK_OR_FOREIGN_REPOSITORY");
    }
    return {
      status: "TARGET",
      number,
      eventSnapshot: {
        headSha: headSha.toLowerCase(),
        baseSha: baseSha.toLowerCase(),
        baseRef: pr?.base?.ref,
      },
    };
  }

  return rejected("EVENT_TYPE_NOT_ALLOWED");
}

async function readBoundedJson(response) {
  const contentLength = response.headers?.get?.("content-length");
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > MAX_RESPONSE_BYTES) {
    throw new Error("RESPONSE_TOO_LARGE");
  }

  const reader = response.body?.getReader?.();
  if (!reader) throw new Error("RESPONSE_BODY_UNREADABLE");
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new Error("RESPONSE_BODY_UNREADABLE");
      totalBytes += value.byteLength;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error("RESPONSE_TOO_LARGE");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let body;
  try {
    body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(body);
  } catch {
    throw new Error("RESPONSE_INVALID_JSON");
  }
}

function validateLivePullRequest(live, { repository, repositoryId, pullRequest, eventSnapshot }) {
  if (!live || typeof live !== "object" || Array.isArray(live)) return rejected("LIVE_PR_SHAPE_INVALID");
  if (Number(live.number) !== pullRequest) return rejected("LIVE_PR_NUMBER_MISMATCH");
  if (live.state !== "open" || live.merged !== false) return rejected("LIVE_PR_NOT_OPEN");
  if (live.draft !== false) return rejected("LIVE_PR_DRAFT_STATE_UNKNOWN_OR_TRUE");
  if (live.locked !== false) return rejected("LIVE_PR_LOCK_STATE_UNKNOWN_OR_TRUE");

  const baseRepo = live.base?.repo;
  const headRepo = live.head?.repo;
  if (!baseRepo || !headRepo) return rejected("LIVE_PR_REPOSITORY_MISSING");
  const baseRepoId = Number(baseRepo.id);
  const headRepoId = Number(headRepo.id);
  if (baseRepoId !== Number(repositoryId) || headRepoId !== Number(repositoryId)) {
    return rejected("LIVE_PR_FORK_OR_FOREIGN_REPOSITORY");
  }
  if (typeof baseRepo.full_name !== "string" || typeof headRepo.full_name !== "string" ||
      baseRepo.full_name.toLowerCase() !== repository.toLowerCase() ||
      headRepo.full_name.toLowerCase() !== repository.toLowerCase()) {
    return rejected("LIVE_PR_REPOSITORY_NAME_MISMATCH");
  }

  const headSha = live.head?.sha;
  const baseSha = live.base?.sha;
  const baseRef = live.base?.ref;
  if (!SHA_PATTERN.test(headSha ?? "") || !SHA_PATTERN.test(baseSha ?? "")) {
    return rejected("LIVE_PR_SHA_INVALID");
  }
  if (typeof baseRef !== "string" || baseRef.length < 1 || baseRef.length > 255 || /[\u0000-\u001f\u007f]/.test(baseRef)) {
    return rejected("LIVE_PR_BASE_REF_INVALID");
  }

  const normalized = {
    repositoryId: Number(repositoryId),
    repository,
    pullRequest,
    headRepositoryId: headRepoId,
    baseRepositoryId: baseRepoId,
    headSha: headSha.toLowerCase(),
    baseSha: baseSha.toLowerCase(),
    baseRef,
  };

  if (eventSnapshot && (
    eventSnapshot.headSha !== normalized.headSha ||
    eventSnapshot.baseSha !== normalized.baseSha ||
    eventSnapshot.baseRef !== normalized.baseRef
  )) return rejected("EVENT_LIVE_SNAPSHOT_MISMATCH");

  return { status: "RESOLVED", target: normalized };
}

export async function resolvePullRequest({
  eventName,
  payload,
  actorId,
  ref,
  repository,
  repositoryId,
  token,
  fetchImpl = globalThis.fetch,
}) {
  if (!trustedRepository(payload, repository, repositoryId)) return rejected("EVENT_REPOSITORY_MISMATCH");
  const target = resolveEventTarget({ eventName, payload, actorId, ref, repositoryId });
  if (target.status !== "TARGET") return target;
  if (typeof token !== "string" || token.length === 0) return unknown("GITHUB_TOKEN_UNAVAILABLE");
  if (typeof fetchImpl !== "function") return unknown("FETCH_UNAVAILABLE");

  const [owner, repoName] = repository.split("/");
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/pulls/${target.number}`;
  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": GITHUB_API_VERSION,
      },
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    return unknown("GITHUB_API_TRANSPORT_FAILURE");
  }

  if (!response || response.ok !== true) {
    const status = Number(response?.status);
    return unknown(Number.isInteger(status) && status > 0 ? `GITHUB_API_HTTP_${status}` : "GITHUB_API_RESPONSE_INVALID");
  }

  let live;
  try {
    live = await readBoundedJson(response);
  } catch (error) {
    return unknown(error?.message === "RESPONSE_TOO_LARGE" ? "GITHUB_API_RESPONSE_TOO_LARGE" : "GITHUB_API_RESPONSE_INVALID");
  }

  return validateLivePullRequest(live, {
    repository,
    repositoryId,
    pullRequest: target.number,
    eventSnapshot: target.eventSnapshot,
  });
}

async function main() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!eventPath || !outputPath) {
    console.error("Resolver stopped: REQUIRED_GITHUB_CONTEXT_MISSING");
    process.exitCode = 1;
    return;
  }

  let payload;
  try {
    payload = JSON.parse(await readFile(eventPath, "utf8"));
  } catch {
    console.error("Resolver stopped: EVENT_PAYLOAD_INVALID");
    process.exitCode = 1;
    return;
  }

  const result = await resolvePullRequest({
    eventName: process.env.EVENT_NAME,
    payload,
    actorId: process.env.ACTOR_ID,
    ref: process.env.REF,
    repository: process.env.REPOSITORY,
    repositoryId: process.env.REPOSITORY_ID,
    token: process.env.GH_TOKEN,
  });

  if (result.status !== "RESOLVED") {
    await appendFile(outputPath, "resolved=false\n", "utf8");
    console.error(`Resolver stopped: ${result.status}:${result.reasonCode}`);
    process.exitCode = 1;
    return;
  }

  const { target } = result;
  const output = [
    "resolved=true",
    `repository=${target.repository}`,
    `repository_id=${target.repositoryId}`,
    `pull_request=${target.pullRequest}`,
    `head_sha=${target.headSha}`,
    `base_sha=${target.baseSha}`,
    `base_ref=${target.baseRef}`,
  ].join("\n") + "\n";
  await appendFile(outputPath, output, "utf8");
  console.log("Resolver result: RESOLVED; only repository and immutable PR snapshot identifiers were emitted.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(() => {
    console.error("Resolver stopped: INTERNAL_FAILURE");
    process.exitCode = 1;
  });
}
