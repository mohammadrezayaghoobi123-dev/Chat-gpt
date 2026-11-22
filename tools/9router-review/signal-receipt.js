import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

const MAX_RECEIPT_BYTES = 16 * 1024;
const MAX_API_RESPONSE_BYTES = 1024 * 1024;
const SIGNAL_WORKFLOW_PATH = '.github/workflows/9router-pr-review-signal.yml';
const ALLOWED_ACTIONS = new Set(['opened', 'edited', 'synchronize', 'reopened', 'ready_for_review']);
const RECEIPT_KEYS = [
  'schemaVersion', 'repository', 'repositoryId', 'runId', 'runAttempt', 'eventName', 'action',
  'pullRequestNumber', 'headSha', 'baseSha', 'workflowSha', 'headRepository', 'baseRepository', 'baseRef',
].sort();

export function readSignalReceiptFile(receiptPath) {
  if (typeof receiptPath !== 'string' || receiptPath.length === 0 || basename(receiptPath) !== 'signal.json') {
    throw new Error('Signal artifact must contain the expected signal.json file.');
  }
  const absolutePath = resolve(receiptPath);
  const directoryPath = dirname(absolutePath);
  const directoryStat = lstatSync(directoryPath);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || realpathSync(directoryPath) !== directoryPath) {
    throw new Error('Signal artifact directory is not a canonical, regular directory.');
  }
  const entries = readdirSync(directoryPath);
  if (entries.length !== 1 || entries[0] !== 'signal.json') {
    throw new Error('Signal artifact directory must contain exactly one signal.json file.');
  }
  if (typeof fsConstants.O_NOFOLLOW !== 'number') {
    throw new Error('Platform does not support no-follow receipt file access.');
  }
  const descriptor = openSync(absolutePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const fileStat = fstatSync(descriptor);
    if (!fileStat.isFile() || fileStat.size < 1 || fileStat.size > MAX_RECEIPT_BYTES) {
      throw new Error('Signal receipt file is not a regular file or exceeds the 16 KiB size limit.');
    }
    return parseSignalReceipt(readFileSync(descriptor, 'utf8'));
  } finally {
    closeSync(descriptor);
  }
}

function isPositiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isSha(value) {
  return typeof value === 'string' && /^[a-f0-9]{40}$/i.test(value);
}

function sameText(left, right) {
  return typeof left === 'string' && typeof right === 'string' && left.toLowerCase() === right.toLowerCase();
}

function requireRepoName(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
}

export function parseSignalReceipt(input) {
  if (typeof input !== 'string' || input.length === 0) throw new Error('Signal receipt is missing or empty.');
  if (Buffer.byteLength(input, 'utf8') > MAX_RECEIPT_BYTES) throw new Error('Signal receipt exceeds the 16 KiB size limit.');
  let receipt;
  try {
    receipt = JSON.parse(input);
  } catch {
    throw new Error('Signal receipt contains invalid JSON.');
  }
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) throw new Error('Signal receipt must be a JSON object.');
  const keys = Object.keys(receipt).sort();
  if (keys.length !== RECEIPT_KEYS.length || keys.some((key, index) => key !== RECEIPT_KEYS[index])) {
    throw new Error('Signal receipt contains missing or unexpected schema fields.');
  }
  if (receipt.schemaVersion !== 1) throw new Error('Signal receipt schema version is unsupported.');
  requireRepoName(receipt.repository, 'Receipt repository');
  requireRepoName(receipt.headRepository, 'Receipt head repository');
  requireRepoName(receipt.baseRepository, 'Receipt base repository');
  if (!isPositiveSafeInteger(receipt.repositoryId)) throw new Error('Signal receipt repository ID is invalid.');
  if (!isPositiveSafeInteger(receipt.runId)) throw new Error('Signal receipt run ID is invalid.');
  if (!isPositiveSafeInteger(receipt.runAttempt)) throw new Error('Signal receipt run attempt is invalid.');
  if (receipt.eventName !== 'pull_request_target') throw new Error('Signal receipt event is not pull_request_target.');
  if (!ALLOWED_ACTIONS.has(receipt.action)) throw new Error('Signal receipt action is invalid.');
  if (!isPositiveSafeInteger(receipt.pullRequestNumber)) throw new Error('Signal receipt pull request number is invalid.');
  if (!isSha(receipt.headSha) || !isSha(receipt.baseSha) || !isSha(receipt.workflowSha)) throw new Error('Signal receipt head, base, or workflow SHA is invalid.');
  if (typeof receipt.baseRef !== 'string' || receipt.baseRef.length < 1 || receipt.baseRef.length > 255) {
    throw new Error('Signal receipt base ref is invalid.');
  }
  return receipt;
}

export function resolveWorkflowRunTarget(context) {
  const receipt = context?.signalReceipt;
  if (
    context?.eventName !== 'workflow_run' ||
    context?.workflowPath !== SIGNAL_WORKFLOW_PATH ||
    context?.triggerEvent !== 'pull_request_target' ||
    context?.workflowConclusion !== 'success'
  ) {
    throw new Error('Untrusted workflow-run provenance; refusing privileged review.');
  }
  requireRepoName(context.repository, 'Workflow repository');
  requireRepoName(context.headRepository, 'Workflow head repository');
  if (!sameText(context.repository, context.headRepository)) throw new Error('Workflow run is not from the target repository');
  if (!isPositiveSafeInteger(context.repositoryId) || !isPositiveSafeInteger(context.runId) ||
      !isPositiveSafeInteger(context.runAttempt) || !isPositiveSafeInteger(context.workflowId)) {
    throw new Error('Workflow run identity metadata is invalid.');
  }
  if (!isSha(context.runHeadSha)) throw new Error('Workflow run SHA is invalid.');
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) throw new Error('Signal receipt is missing.');
  const validated = parseSignalReceipt(JSON.stringify(receipt));
  if (!sameText(validated.repository, context.repository) || validated.repositoryId !== context.repositoryId) {
    throw new Error('Signal receipt repository identity does not match the workflow run.');
  }
  if (validated.runId !== context.runId || validated.runAttempt !== context.runAttempt) {
    throw new Error('Signal receipt run ID or attempt does not match the triggering workflow run.');
  }
  if (validated.eventName !== context.triggerEvent) throw new Error('Signal receipt event does not match the workflow run.');
  if (!sameText(validated.headRepository, context.repository) || !sameText(validated.baseRepository, context.repository)) {
    throw new Error('Signal receipt head/base repository identity is not same-repository.');
  }
  if (context.runHeadSha.toLowerCase() !== validated.workflowSha.toLowerCase()) {
    throw new Error('Workflow run SHA does not match the trusted workflow revision SHA.');
  }
  return {
    pullRequest: validated.pullRequestNumber,
    expectedHeadSha: validated.headSha,
    expectedBaseSha: validated.baseSha,
    expectedWorkflowSha: validated.workflowSha,
    baseRef: validated.baseRef,
  };
}

async function readJsonLimited(response, maxBytes = MAX_API_RESPONSE_BYTES) {
  if (!response.body || typeof response.body.getReader !== 'function') throw new Error('GitHub API returned an unreadable response body.');
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error('GitHub API response exceeds the safe byte limit.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new Error('GitHub API returned invalid JSON');
  }
}

async function getGitHubJson(fetchImpl, url, token) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(120000),
    });
  } catch {
    throw new Error('GitHub API request failed; response details were suppressed.');
  }
  if (!response.ok) throw new Error(`GitHub API request failed with HTTP ${response.status}; response details were suppressed.`);
  return readJsonLimited(response);
}

export async function verifySignalTargetWithGitHub({
  target, repository, repositoryId, runId, runAttempt, runHeadSha, workflowId, githubToken,
  fetchImpl = fetch, githubApiBase = 'https://api.github.com',
}) {
  if (!target || !isPositiveSafeInteger(target.pullRequest) || !isSha(target.expectedHeadSha) || !isSha(target.expectedBaseSha) || !isSha(target.expectedWorkflowSha)) {
    throw new Error('Verified signal target is invalid.');
  }
  requireRepoName(repository, 'Repository');
  if (!isPositiveSafeInteger(repositoryId) || !isPositiveSafeInteger(runId) ||
      !isPositiveSafeInteger(runAttempt) || !isPositiveSafeInteger(workflowId) || !isSha(runHeadSha) ||
      typeof githubToken !== 'string' || githubToken.length === 0) {
    throw new Error('GitHub reconciliation configuration is invalid.');
  }
  const [owner, name] = repository.split('/');
  const baseUrl = new URL(githubApiBase);
  const isLoopbackHost = ['127.0.0.1', 'localhost', '[::1]'].includes(baseUrl.hostname);
  const isAllowedOrigin = baseUrl.protocol === 'https:' || (baseUrl.protocol === 'http:' && isLoopbackHost);
  if (!isAllowedOrigin || baseUrl.username || baseUrl.password || baseUrl.pathname !== '/' || baseUrl.search || baseUrl.hash) {
    throw new Error('GitHub API base URL must be an HTTPS origin; HTTP is allowed only for explicit loopback tests.');
  }
  const run = await getGitHubJson(fetchImpl, `${baseUrl.origin}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/actions/runs/${runId}`, githubToken);
  if (
    run.id !== runId || run.run_attempt !== runAttempt || run.event !== 'pull_request_target' ||
    run.path !== SIGNAL_WORKFLOW_PATH || run.conclusion !== 'success' || run.workflow_id !== workflowId ||
    run.head_sha?.toLowerCase() !== runHeadSha.toLowerCase() ||
    run.head_sha?.toLowerCase() !== target.expectedWorkflowSha.toLowerCase() ||
    run.repository?.id !== repositoryId || !sameText(run.repository?.full_name, repository) ||
    run.head_repository?.id !== repositoryId || !sameText(run.head_repository?.full_name, repository)
  ) {
    throw new Error('GitHub workflow-run API metadata does not match the verified signal receipt.');
  }
  const pull = await getGitHubJson(fetchImpl, `${baseUrl.origin}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${target.pullRequest}`, githubToken);
  if (
    pull.number !== target.pullRequest || pull.state !== 'open' || pull.draft !== false ||
    pull.head?.sha?.toLowerCase() !== target.expectedHeadSha.toLowerCase() ||
    pull.base?.sha?.toLowerCase() !== target.expectedBaseSha.toLowerCase() ||
    pull.base?.ref !== target.baseRef ||
    pull.head?.repo?.id !== repositoryId || !sameText(pull.head?.repo?.full_name, repository) ||
    pull.base?.repo?.id !== repositoryId || !sameText(pull.base?.repo?.full_name, repository)
  ) {
    throw new Error('Live pull-request API metadata does not match the verified signal receipt.');
  }
  return target;
}
