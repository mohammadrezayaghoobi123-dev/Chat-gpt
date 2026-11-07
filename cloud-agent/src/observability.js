/**
 * Lightweight structured logging helpers for Master Brain Cloud Agent.
 * Keep payloads free of tokens, session capabilities, and file contents.
 */

/**
 * Emit a structured event that Cloudflare observability can index.
 * Never include secrets, bearer tokens, or session capabilities.
 */
export function logEvent(level, event, fields = {}) {
  const payload = {
    ts: new Date().toISOString(),
    level,
    event,
    ...fields
  };
  // Cloudflare Workers capture console output when observability is enabled.
  if (level === "error") {
    console.error(JSON.stringify(payload));
  } else if (level === "warn") {
    console.warn(JSON.stringify(payload));
  } else {
    console.log(JSON.stringify(payload));
  }
}

export function logAuthFailure(reason, principalHint = null) {
  logEvent("warn", "auth_failure", {
    reason,
    principal_hint: principalHint ? String(principalHint).slice(0, 32) : null
  });
}

export function logBudget(event, fields) {
  logEvent("info", `budget_${event}`, fields);
}

export function logToolCall(name, success, durationMs) {
  logEvent("info", "tool_call", {
    tool: name,
    success: Boolean(success),
    duration_ms: Number.isFinite(durationMs) ? Math.round(durationMs) : null
  });
}

export function logModelInvocation(success, reservedNeurons, actualNeurons) {
  logEvent("info", "model_invocation", {
    success: Boolean(success),
    reserved_neurons: reservedNeurons ?? null,
    actual_neurons: actualNeurons ?? null
  });
}
