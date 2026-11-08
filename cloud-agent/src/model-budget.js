import { DAILY_NEURON_BUDGET, INPUT_NEURONS_PER_MILLION, MAX_COMPLETION_TOKENS, OUTPUT_NEURONS_PER_MILLION, TOOL_DEFINITIONS } from "./config.js";
import { logBudget } from "./observability.js";

export function getCompletion(result) {
  if (result && typeof result === "object" && result.response && typeof result.response === "object") return result.response;
  return result;
}

export function estimateReservedNeurons(messages) {
  const payloadBytes = new TextEncoder().encode(JSON.stringify({
    messages,
    tools: TOOL_DEFINITIONS
  })).length;
  const estimatedInputTokens = Math.ceil(payloadBytes * 1.1) + 128;
  return Math.max(1, Math.ceil(
    (estimatedInputTokens * INPUT_NEURONS_PER_MILLION +
      MAX_COMPLETION_TOKENS * OUTPUT_NEURONS_PER_MILLION) / 1_000_000
  ));
}

export function actualNeuronsFromUsage(raw) {
  const completion = getCompletion(raw);
  const usage = raw?.usage ?? completion?.usage;
  if (!usage ||
      !Number.isSafeInteger(usage.prompt_tokens) || usage.prompt_tokens < 0 ||
      !Number.isSafeInteger(usage.completion_tokens) || usage.completion_tokens < 0) {
    return null;
  }
  return Math.max(1, Math.ceil(
    (usage.prompt_tokens * INPUT_NEURONS_PER_MILLION +
      usage.completion_tokens * OUTPUT_NEURONS_PER_MILLION) / 1_000_000
  ));
}

export async function reserveModelBudget(env, messages, chatId) {
  const neurons = estimateReservedNeurons(messages);
  if (neurons > DAILY_NEURON_BUDGET) {
    logBudget("denied", { chat_id: chatId, status: 429, reason: "request_exceeds_daily_budget", reserved_neurons: neurons });
    return { ok: false, status: 429, error: "This request exceeds the remaining daily model budget." };
  }
  const requestId = crypto.randomUUID();
  const id = env.AGENT_BUDGET.idFromName("global");
  const stub = env.AGENT_BUDGET.get(id);
  const response = await stub.fetch(new Request("https://agent-budget.internal/reserve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ request_id: requestId, neurons })
  }));
  if (response.status === 429) {
    const result = await response.json().catch(() => ({}));
    logBudget("denied", { chat_id: chatId, status: 429, reason: "daily_budget_exhausted", reserved_neurons: neurons });
    return {
      ok: false,
      status: 429,
      error: result.error || "The daily model budget is exhausted.",
      retryAfter: response.headers.get("retry-after")
    };
  }
  if (!response.ok) {
    logBudget("reserve_failed", { chat_id: chatId, status: response.status, reserved_neurons: neurons });
    throw new Error("Daily model budget reservation failed.");
  }
  logBudget("reserve", { chat_id: chatId, reserved_neurons: neurons });
  return { ok: true, requestId, reservedNeurons: neurons, stub };
}

export async function settleModelBudget(reservation, raw, success, chatId) {
  const actualNeurons = success ? actualNeuronsFromUsage(raw) : null;
  const response = await reservation.stub.fetch(new Request("https://agent-budget.internal/settle", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      request_id: reservation.requestId,
      success,
      ...(actualNeurons === null ? {} : { actual_neurons: actualNeurons })
    })
  }));
  if (!response.ok) {
    logBudget("settle_failed", { chat_id: chatId, success, status: response.status, reserved_neurons: reservation.reservedNeurons });
    throw new Error("Daily model budget settlement failed.");
  }
  logBudget("settle", { chat_id: chatId, success, reserved_neurons: reservation.reservedNeurons, actual_neurons: actualNeurons });
}
