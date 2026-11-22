import { appendFileSync } from "node:fs";
import { readSignalReceiptFile, resolveWorkflowRunTarget, verifySignalTargetWithGitHub } from "./signal-receipt.js";

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(name + " is invalid.");
  return parsed;
}

try {
  const receiptPath = process.env.SIGNAL_RECEIPT_PATH;
  if (!receiptPath) throw new Error("Signal receipt path is missing.");
  const receipt = readSignalReceiptFile(receiptPath);
  const context = {
    eventName: process.env.GITHUB_EVENT_NAME,
    workflowPath: process.env.WORKFLOW_PATH,
    triggerEvent: process.env.TRIGGER_EVENT,
    workflowConclusion: process.env.WORKFLOW_CONCLUSION,
    repository: process.env.REPOSITORY,
    repositoryId: positiveInteger(process.env.REPOSITORY_ID, "Repository ID"),
    headRepository: process.env.RUN_HEAD_REPOSITORY,
    runId: positiveInteger(process.env.RUN_ID, "Workflow run ID"),
    runAttempt: positiveInteger(process.env.RUN_ATTEMPT, "Workflow run attempt"),
    runHeadSha: process.env.RUN_HEAD_SHA,
    workflowId: positiveInteger(process.env.WORKFLOW_ID, "Workflow ID"),
    signalReceipt: receipt,
  };
  const target = resolveWorkflowRunTarget(context);
  await verifySignalTargetWithGitHub({
    target,
    repository: context.repository,
    repositoryId: context.repositoryId,
    runId: context.runId,
    runAttempt: context.runAttempt,
    runHeadSha: context.runHeadSha,
    workflowId: context.workflowId,
    githubToken: process.env.GITHUB_TOKEN,
  });
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) throw new Error("GitHub output path is missing.");
  appendFileSync(outputPath, "pull_request=" + target.pullRequest + "\nhead_sha=" + target.expectedHeadSha + "\nbase_sha=" + target.expectedBaseSha + "\n");
  console.log("Verified signal receipt for PR #" + target.pullRequest + "; model inference has not started.");
} catch (error) {
  console.error("Signal verification stopped safely: " + error.message);
  process.exitCode = 1;
}
