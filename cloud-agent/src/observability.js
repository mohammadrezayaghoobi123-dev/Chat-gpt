/**
 * Structured logging for Master Brain Cloud Agent.
 *
 * Policy (issue #189): events describe what happened and how much it cost, never
 * the content involved. A field is dropped when its name suggests a credential or
 * user/model content, when its value is not a primitive, and long strings are
 * truncated. Callers pass bounded labels (tool name from the allowlist, status,
 * stage), never raw prompts, tool arguments, tool results or error text.
 */

const MAX_STRING_LENGTH = 200;

// Field names that may carry credentials or conversation/repository content.
const SENSITIVE_FIELD = /(authorization|token|secret|password|passwd|bearer|capabilit|cookie|credential|api[_-]?key|private|hash|prompt|message|argument|content|body|payload|output|result|error_text|stack)/i;

function sanitizeFields(fields) {
  const safe = {};
  if (!fields || typeof fields !== "object") return safe;
  for (const [key, value] of Object.entries(fields)) {
    if (SENSITIVE_FIELD.test(key)) continue;
    if (value === null || typeof value === "boolean") {
      safe[key] = value;
    } else if (typeof value === "number") {
      safe[key] = Number.isFinite(value) ? value : null;
    } else if (typeof value === "string") {
      safe[key] = value.length > MAX_STRING_LENGTH ? value.slice(0, MAX_STRING_LENGTH) : value;
    }
    // objects, arrays, functions and undefined are dropped
  }
  return safe;
}

/**
 * Emit one JSON line that Cloudflare observability can index.
 * ts, level and event always come from the caller's explicit arguments and cannot
 * be overridden through fields.
 */
export function logEvent(level, event, fields = {}) {
  const payload = {
    ...sanitizeFields(fields),
    ts: new Date().toISOString(),
    level,
    event
  };
  const line = JSON.stringify(payload);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

/** Authentication or throttling failure. Carries only a bounded reason label. */
export function logAuthFailure(reason) {
  logEvent("warn", "auth_failure", { reason });
}

/** Budget lifecycle: reserve, settle, denied, settle_failed. */
export function logBudget(event, fields) {
  logEvent(event === "denied" || event === "settle_failed" ? "warn" : "info", `budget_${event}`, fields);
}

/** One tool call. `tool` must be an allowlisted label. */
export function logToolCall(chatId, tool, success, durationMs) {
  logEvent(success ? "info" : "warn", "tool_call", {
    chat_id: chatId,
    tool,
    success: Boolean(success),
    duration_ms: Number.isFinite(durationMs) ? Math.round(durationMs) : null
  });
}

/** One Workers AI invocation with measured reservation and usage. */
export function logModelInvocation(chatId, success, reservedNeurons, actualNeurons) {
  logEvent(success ? "info" : "warn", "model_invocation", {
    chat_id: chatId,
    success: Boolean(success),
    reserved_neurons: reservedNeurons ?? null,
    actual_neurons: actualNeurons ?? null
  });
}
