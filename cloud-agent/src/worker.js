import { DurableObject } from "cloudflare:workers";
import { AgentBudget } from "./budget.js";

export { AgentBudget };
import { MAX_COMPLETION_TOKENS, MAX_HISTORY_MESSAGES, MAX_MESSAGE_CHARS, MAX_TOOL_CALLS, MAX_TOOL_ROUNDS, MODEL, REPO_FULL, SESSION_TTL_MS, SYSTEM_PROMPT, TOOL_DEFINITIONS, VERSION } from "./config.js";
import { boundedHistory, consumeRateLimit, createSerialExecutor, extractAssistantText, isSessionExpired, isSessionId, rateLimitClientKey, readTextBounded, recordSessionActivity, validateToolCalls } from "./core.js";
import { logAuthFailure, logEvent, logModelInvocation, logToolCall } from "./observability.js";
import { applySecurityHeaders, json } from "./http.js";
import { TOOL_LABELS, executeTool } from "./tools.js";
import { actualNeuronsFromUsage, getCompletion, reserveModelBudget, settleModelBudget } from "./model-budget.js";
import { constantTimeHexEqual, consumePrincipalRequestLimit, createSessionCapability, hashSessionCapability, isValidPrincipalId, parseRevocationEpoch, resolvePrincipal } from "./auth.js";
import { renderConsole } from "./console.js";

export class AgentSession extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.runSerial = createSerialExecutor();
  }

  fetch(request) {
    return this.runSerial(() => this.handleRequest(request)).catch(error => {
      if (error?.code === "SESSION_QUEUE_FULL") {
        return json({ error: "Session is busy. Retry shortly." }, 429, { "retry-after": "5" });
      }
      throw error;
    });
  }

  async handleRequest(request) {
    const url = new URL(request.url);
    if (url.pathname === "/initialize" && request.method === "POST") {
      let initialization;
      try {
        const text = await readTextBounded(request.body, request.headers.get("content-length"), 512);
        initialization = JSON.parse(text);
      } catch {
        return json({ error: "Invalid session initialization." }, 400);
      }
      if (!initialization || typeof initialization.token_hash !== "string" ||
          !/^[0-9a-f]{64}$/.test(initialization.token_hash) ||
          !isValidPrincipalId(initialization.principal_id) ||
          typeof initialization.principal_auth_hash !== "string" ||
          !/^[0-9a-f]{64}$/.test(initialization.principal_auth_hash)) {
        return json({ error: "Invalid session initialization." }, 400);
      }
      if (await this.ctx.storage.get("session-token-hash")) {
        return json({ error: "Session is already initialized." }, 409);
      }
      const epoch = parseRevocationEpoch(this.env.AGENT_REVOCATION_EPOCH);
      if (epoch === null) return json({ error: "Session revocation epoch is invalid." }, 503);
      const initializedAt = Date.now();
      await this.ctx.storage.put({
        "revocation-epoch": epoch,
        "session-token-hash": initialization.token_hash,
        "principal-id": initialization.principal_id,
        "principal-auth-hash": initialization.principal_auth_hash,
        "last-activity-at": initializedAt
      });
      await this.ctx.storage.setAlarm(initializedAt + SESSION_TTL_MS);
      return json({ initialized: true }, 201);
    }

    const isHistoryRequest = url.pathname === "/history" && request.method === "GET";
    const isChatRequest = url.pathname === "/chat" && request.method === "POST";
    if (!isHistoryRequest && !isChatRequest) return json({ error: "Not found" }, 404);

    const storedPrincipalId = await this.ctx.storage.get("principal-id");
    const suppliedPrincipalId = request.headers.get("x-principal-id");
    if (!isValidPrincipalId(storedPrincipalId)) {
      return json({ error: "Unauthorized" }, 401, { "www-authenticate": "Session" });
    }
    const currentEpoch = parseRevocationEpoch(this.env.AGENT_REVOCATION_EPOCH);
    if (currentEpoch === null) return json({ error: "Session revocation epoch is invalid." }, 503);
    const sessionEpoch = (await this.ctx.storage.get("revocation-epoch")) ?? 0;
    if (sessionEpoch !== currentEpoch) {
      await this.eraseSession();
      logEvent("warn", "session_revoked", { reason: "epoch" });
      return json({ error: "Session revoked; create a new session." }, 410);
    }
    if (suppliedPrincipalId !== storedPrincipalId) {
      return json({ error: "Session belongs to a different principal." }, 403);
    }
    const storedPrincipalAuthHash = await this.ctx.storage.get("principal-auth-hash");
    const suppliedPrincipalAuthHash = request.headers.get("x-principal-auth-hash");
    if (!constantTimeHexEqual(suppliedPrincipalAuthHash, storedPrincipalAuthHash)) {
      return json({ error: "Session credential has changed; create a new session." }, 403);
    }

    const storedCapabilityHash = await this.ctx.storage.get("session-token-hash");
    const suppliedCapability = request.headers.get("x-session-token");
    if (typeof storedCapabilityHash !== "string" || !/^[0-9a-f]{64}$/.test(storedCapabilityHash) ||
        typeof suppliedCapability !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(suppliedCapability)) {
      return json({ error: "Unauthorized" }, 401, { "www-authenticate": "Session" });
    }
    const suppliedCapabilityHash = await hashSessionCapability(suppliedCapability);
    if (!constantTimeHexEqual(suppliedCapabilityHash, storedCapabilityHash)) {
      return json({ error: "Unauthorized" }, 401, { "www-authenticate": "Session" });
    }

    if (await this.expireIfNeeded()) {
      return json({ error: "Session expired." }, 410);
    }
    const activity = recordSessionActivity(await this.ctx.storage.get("rate-window"), Date.now());
    if (!activity.allowed) {
      return json({ error: "Session rate limit reached. Wait one minute and retry." }, 429);
    }
    await this.ctx.storage.put({
      "rate-window": activity.activeRequests,
      "last-activity-at": activity.lastActivity
    });
    await this.ctx.storage.setAlarm(activity.lastActivity + SESSION_TTL_MS);

    if (isHistoryRequest) {
      return json({ messages: boundedHistory(await this.ctx.storage.get("history")) });
    }

    let body;
    try {
      const text = await readTextBounded(request.body, request.headers.get("content-length"), 12_000);
      body = JSON.parse(text);
    } catch (error) {
      if (error instanceof Error && error.message === "Body exceeds configured limit.") {
        return json({ error: "Request body too large." }, 413);
      }
      return json({ error: "Invalid JSON request." }, 400);
    }
    if (!body || typeof body.message !== "string" || !body.message.trim() || body.message.length > MAX_MESSAGE_CHARS) {
      return json({ error: "message must contain 1–8000 characters." }, 400);
    }

    const history = boundedHistory(await this.ctx.storage.get("history"));
    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      ...history,
      { role: "user", content: body.message.trim() }
    ];
    const chatId = crypto.randomUUID();
    let toolCallsUsed = 0;
    let finalText = "";

    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
        const reservation = await reserveModelBudget(this.env, messages, chatId);
        if (!reservation.ok) {
          return json(
            { error: reservation.error },
            reservation.status,
            reservation.retryAfter ? { "retry-after": reservation.retryAfter } : {}
          );
        }
        let raw;
        try {
          raw = await this.env.AI.run(MODEL, {
            messages,
            tools: TOOL_DEFINITIONS,
            parallel_tool_calls: false,
            max_completion_tokens: MAX_COMPLETION_TOKENS,
            temperature: 0
          });
        } catch (error) {
          logModelInvocation(chatId, false, reservation.reservedNeurons, null);
          await settleModelBudget(reservation, null, false, chatId);
          throw error;
        }
        logModelInvocation(chatId, true, reservation.reservedNeurons, actualNeuronsFromUsage(raw));
        await settleModelBudget(reservation, raw, true, chatId);
        const completion = getCompletion(raw);
        const message = completion?.choices?.[0]?.message;
        if (!message) throw new Error("Model returned no completion message.");

        const rawCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
        if (rawCalls.length === 0) {
          finalText = extractAssistantText(message);
          break;
        }
        let calls;
        try {
          calls = validateToolCalls(rawCalls, MAX_TOOL_CALLS - toolCallsUsed);
        } catch (error) {
          logEvent("warn", "tool_call_rejected", { chat_id: chatId, requested_calls: rawCalls.length });
          throw error;
        }
        messages.push({ ...message, tool_calls: calls });
        for (const call of calls) {
          toolCallsUsed += 1;
          let output;
          const toolStarted = Date.now();
          let toolSucceeded = true;
          try {
            output = await executeTool(call.function.name, call.function.arguments);
          } catch (error) {
            toolSucceeded = false;
            output = { error: error instanceof Error ? error.message : "Tool failed." };
          }
          logToolCall(chatId, TOOL_LABELS.has(call.function.name) ? call.function.name : "unknown", toolSucceeded, Date.now() - toolStarted);
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: JSON.stringify(output).slice(0, 60_000)
          });
        }
      }
    } catch {
      logEvent("error", "chat_failed", { chat_id: chatId, stage: "model_or_tool", tool_calls: toolCallsUsed });
      return json({ error: "The model or a bounded repository tool failed. No project changes were made." }, 503);
    }

    if (!finalText) {
      logEvent("warn", "chat_failed", { chat_id: chatId, stage: "tool_limit", tool_calls: toolCallsUsed });
      return json({ error: "The agent reached its bounded tool-call limit without a final answer." }, 502);
    }
    const nextHistory = boundedHistory([
      ...history,
      { role: "user", content: body.message.trim() },
      { role: "assistant", content: finalText }
    ]).slice(-MAX_HISTORY_MESSAGES);
    const lastActivity = Date.now();
    await this.ctx.storage.put({
      history: nextHistory,
      "last-activity-at": lastActivity
    });
    await this.ctx.storage.setAlarm(lastActivity + SESSION_TTL_MS);
    logEvent("info", "chat_completed", { chat_id: chatId, tool_calls: toolCallsUsed });
    return json({ answer: finalText, model: MODEL, tool_calls: toolCallsUsed, read_only: true });
  }

  async expireIfNeeded() {
    const lastActivity = await this.ctx.storage.get("last-activity-at");
    if (!isSessionExpired(lastActivity, Date.now())) return false;
    await this.eraseSession();
    return true;
  }

  async eraseSession() {
    await this.ctx.storage.delete(["history", "rate-window", "last-activity-at", "session-token-hash", "principal-id", "principal-auth-hash", "revocation-epoch"]);
    await this.ctx.storage.deleteAlarm?.();
  }

  alarm() {
    return this.runSerial(async () => {
      const expired = await this.expireIfNeeded();
      if (!expired) {
        const lastActivity = await this.ctx.storage.get("last-activity-at");
        if (Number.isFinite(lastActivity)) {
          await this.ctx.storage.setAlarm(lastActivity + SESSION_TTL_MS);
        }
      }
    });
  }
}

async function handleFetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/healthz" && request.method === "GET") {
      const bindings = {
        ai: Boolean(env.AI),
        sessions: Boolean(env.AGENT_SESSIONS),
        budget: Boolean(env.AGENT_BUDGET),
        rate_limiter: Boolean(env.AGENT_RATE_LIMITER)
      };
      const revocationEpochValid = parseRevocationEpoch(env.AGENT_REVOCATION_EPOCH) !== null;
      return json({
        ok: true,
        ready: Object.values(bindings).every(Boolean) && revocationEpochValid,
        revocation_epoch_valid: revocationEpochValid,
        service: "master-brain-cloud-agent",
        version: VERSION,
        model: MODEL,
        repository: REPO_FULL,
        mode: "read-only",
        bindings
      });
    }
    if (url.pathname === "/" && request.method === "GET") {
      const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(18))));
      return new Response(renderConsole(nonce), {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
          "content-security-policy": "default-src 'none'; connect-src 'self'; style-src 'nonce-" + nonce + "'; script-src 'nonce-" + nonce + "'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
        }
      });
    }

    const isCreateSession = url.pathname === "/api/sessions" && request.method === "POST";
    const match = /^\/api\/sessions\/([0-9a-f-]{36})\/(chat|history)$/i.exec(url.pathname);
    if (!isCreateSession && !match) return json({ error: "Not found" }, 404);
    const principal = await resolvePrincipal(request, env);
    if (!principal.ok) {
      logAuthFailure(principal.status === 401 ? "unauthorized" : "identity_unavailable");
      if (principal.status === 401) {
        let authFailureAllowed;
        try {
          const clientKey = rateLimitClientKey(request.headers.get("cf-connecting-ip"));
          if (!clientKey) {
            return json({ error: "A valid Cloudflare client IP is required for authentication throttling." }, 503);
          }
          authFailureAllowed = await consumeRateLimit(
            env.AGENT_RATE_LIMITER,
            "master-brain-cloud-agent-auth-failure:" + clientKey
          );
        } catch {
          logAuthFailure("auth_limiter_unavailable");
          return json({ error: "The authentication rate limiter is unavailable." }, 503);
        }
        if (!authFailureAllowed) {
          logAuthFailure("auth_rate_limited");
          return json({ error: "Authentication attempt rate limit reached." }, 429, { "retry-after": "60" });
        }
      }
      return json({ error: principal.error }, principal.status, principal.status === 401 ? { "www-authenticate": "Bearer" } : {});
    }
    if (parseRevocationEpoch(env.AGENT_REVOCATION_EPOCH) === null) {
      return json({ error: "Session revocation epoch is invalid." }, 503);
    }
    const principalId = principal.principalId;
    const sessionId = match?.[1];
    if (sessionId && !isSessionId(sessionId)) return json({ error: "Invalid session identifier." }, 400);
    if (match) {
      const capability = request.headers.get("x-session-token");
      if (typeof capability !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(capability)) {
        return json({ error: "Session capability required." }, 401, { "www-authenticate": "Session" });
      }
    }

    let principalRate;
    try {
      principalRate = await consumePrincipalRequestLimit(env, principalId);
    } catch {
      return json({ error: "The strict request limiter is unavailable." }, 503);
    }
    if (!principalRate.allowed) {
      return json(
        { error: "Principal or aggregate request rate limit reached." },
        429,
        { "retry-after": principalRate.retryAfter }
      );
    }

    if (isCreateSession) {
      const newSessionId = crypto.randomUUID();
      const sessionCapability = createSessionCapability();
      const tokenHash = await hashSessionCapability(sessionCapability);
      const id = env.AGENT_SESSIONS.idFromName(newSessionId);
      const stub = env.AGENT_SESSIONS.get(id);
      let initialized;
      try {
        initialized = await stub.fetch(new Request("https://agent-session.internal/initialize", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token_hash: tokenHash, principal_id: principalId, principal_auth_hash: principal.principalAuthHash })
        }));
      } catch {
        return json({ error: "Session initialization failed." }, 503);
      }
      if (!initialized.ok) return json({ error: "Session initialization failed." }, 503);
      return json({ session_id: newSessionId, session_token: sessionCapability }, 201);
    }

    const id = env.AGENT_SESSIONS.idFromName(sessionId.toLowerCase());
    const stub = env.AGENT_SESSIONS.get(id);
    const forwarded = new Request("https://agent-session.internal/" + match[2], request);
    const forwardedHeaders = new Headers(forwarded.headers);
    forwardedHeaders.set("x-principal-id", principalId);
    forwardedHeaders.set("x-principal-auth-hash", principal.principalAuthHash);
    return stub.fetch(new Request(forwarded, { headers: forwardedHeaders }));
}

export default {
  async fetch(request, env) {
    try {
      return applySecurityHeaders(request, await handleFetch(request, env));
    } catch {
      return applySecurityHeaders(request, json({ error: "Internal server error" }, 500));
    }
  }
};
