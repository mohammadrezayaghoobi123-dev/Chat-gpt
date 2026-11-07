const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const SENSITIVE_VALUE = /\b(?:secret|token|password|credential|api[_-]?key|private[_-]?key)\b\s*[:=]/i;

/**
 * Parse the deliberately small Owner command language.
 * This function grants no authority; callers must independently authenticate
 * the GitHub webhook, repository, sender, comment author, and freshness.
 */
export function parseOwnerCommand(commentBody) {
  if (typeof commentBody !== "string" || commentBody.length > 2048) return null;
  const match = /^\/orchestrator (cancel|quarantine|release) ([A-Za-z0-9][A-Za-z0-9._:-]{0,159}) --reason "([^"\r\n]{1,240})"$/.exec(commentBody);
  if (!match) return null;
  const [, operation, taskId, reason] = match;
  if (!TASK_ID.test(taskId) || reason.trim() !== reason ||
      /[\u0000-\u001f\u007f]/.test(reason) || SENSITIVE_VALUE.test(reason)) return null;
  return Object.freeze({ operation, taskId, reason });
}
