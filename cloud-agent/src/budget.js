import { DurableObject } from "cloudflare:workers";
import { readTextBounded } from "./core.js";

export const DAILY_NEURON_BUDGET = 1_000;
const RESERVATION_TTL_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * 60 * 60 * 1_000;
const MAX_SETTLEMENT_NEURONS = 1_000_000;
const RATE_WINDOW_MS = 60_000;
const PER_PRINCIPAL_REQUEST_LIMIT = 12;
const AGGREGATE_REQUEST_LIMIT = 60;
const MAX_RATE_PRINCIPALS = 128;

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers }
  });
}

function utcDay(timestamp = Date.now()) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function nextUtcMidnight(timestamp = Date.now()) {
  const now = new Date(timestamp);
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
}

function validRequestId(value) {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function newBucket() {
  return { used: 0, reserved: 0, reservations: {}, settled: {} };
}

function validBucket(bucket) {
  if (!bucket || typeof bucket !== "object" ||
      !Number.isSafeInteger(bucket.used) || bucket.used < 0 ||
      !Number.isSafeInteger(bucket.reserved) || bucket.reserved < 0 ||
      !bucket.reservations || typeof bucket.reservations !== "object" ||
      !bucket.settled || typeof bucket.settled !== "object") return false;

  const reservations = Object.entries(bucket.reservations);
  const reservationsValid = reservations.every(([requestId, reservation]) =>
    validRequestId(requestId) &&
    reservation && typeof reservation === "object" &&
    Number.isSafeInteger(reservation.neurons) &&
    reservation.neurons >= 1 && reservation.neurons <= DAILY_NEURON_BUDGET &&
    typeof reservation.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(reservation.day) &&
    Number.isSafeInteger(reservation.created_at) && reservation.created_at >= 0
  );
  const settledValid = Object.entries(bucket.settled).every(([requestId, actual]) =>
    validRequestId(requestId) &&
    Number.isSafeInteger(actual) && actual >= 0 && actual <= MAX_SETTLEMENT_NEURONS
  );
  const reservationTotal = reservations.reduce((total, [, reservation]) => total + reservation.neurons, 0);
  return reservationsValid && settledValid && reservationTotal === bucket.reserved;
}

function validPrincipalId(value) {
  return typeof value === "string" && /^[a-z0-9][a-z0-9_-]{0,31}$/.test(value);
}

function validRateState(state) {
  if (!state || typeof state !== "object" ||
      !Array.isArray(state.global) ||
      !state.principals || typeof state.principals !== "object" ||
      Array.isArray(state.principals) ||
      Object.keys(state.principals).length > MAX_RATE_PRINCIPALS) return false;
  const validTimestamps = values => Array.isArray(values) &&
    values.length <= AGGREGATE_REQUEST_LIMIT &&
    values.every(value => Number.isSafeInteger(value) && value >= 0);
  return validTimestamps(state.global) &&
    Object.entries(state.principals).every(([principalId, values]) =>
      validPrincipalId(principalId) &&
      Array.isArray(values) &&
      values.length <= PER_PRINCIPAL_REQUEST_LIMIT &&
      values.every(value => Number.isSafeInteger(value) && value >= 0)
    );
}

function validLedger(ledger) {
  if (!ledger || typeof ledger !== "object" || !ledger.days || typeof ledger.days !== "object") return false;
  return Object.entries(ledger.days).every(([day, bucket]) =>
    /^\d{4}-\d{2}-\d{2}$/.test(day) && validBucket(bucket)
  );
}

export class AgentBudget extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.queue = Promise.resolve();
  }

  enqueue(operation) {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => undefined);
    return result;
  }

  fetch(request) {
    return this.enqueue(() => this.handleRequest(request));
  }

  async readLedger() {
    const ledger = await this.ctx.storage.get("budget-ledger");
    if (ledger === undefined) return { days: {} };
    if (!validLedger(ledger)) throw new Error("Budget ledger is invalid.");
    return ledger;
  }

  bucketFor(ledger, day) {
    if (!ledger.days[day]) ledger.days[day] = newBucket();
    return ledger.days[day];
  }

  pruneOldDays(ledger, now = Date.now()) {
    const cutoff = utcDay(now - 2 * DAY_MS);
    for (const [day, bucket] of Object.entries(ledger.days)) {
      if (day < cutoff && Object.keys(bucket.reservations).length === 0) {
        delete ledger.days[day];
      }
    }
  }

  async writeLedger(ledger) {
    this.pruneOldDays(ledger);
    await this.ctx.storage.put("budget-ledger", ledger);
    await this.scheduleAlarm(ledger);
  }

  async scheduleAlarm(ledger, now = Date.now()) {
    let next = Number.POSITIVE_INFINITY;
    for (const bucket of Object.values(ledger.days)) {
      for (const reservation of Object.values(bucket.reservations)) {
        if (reservation && Number.isSafeInteger(reservation.created_at)) {
          next = Math.min(next, reservation.created_at + RESERVATION_TTL_MS);
        }
      }
    }
    if (!Number.isFinite(next)) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(Math.max(now + 1_000, next));
  }

  async handleRequest(request) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/request-limit" && request.method === "POST") {
        let body;
        try {
          const text = await readTextBounded(request.body, request.headers.get("content-length"), 1_024);
          body = JSON.parse(text);
        } catch {
          return json({ error: "Invalid request-limit payload." }, 400);
        }
        if (!body || !validRequestId(body.request_id) || !validPrincipalId(body.principal_id)) {
          return json({ error: "A valid request_id and principal_id are required." }, 400);
        }

        const storedRateState = await this.ctx.storage.get("request-rate-state");
        const rateState = storedRateState === undefined
          ? { global: [], principals: {} }
          : storedRateState;
        if (!validRateState(rateState)) throw new Error("Request-rate ledger is invalid.");

        const now = Date.now();
        const cutoff = now - RATE_WINDOW_MS;
        rateState.global = rateState.global.filter(timestamp => timestamp > cutoff);
        for (const [principalId, timestamps] of Object.entries(rateState.principals)) {
          const recent = timestamps.filter(timestamp => timestamp > cutoff);
          if (recent.length) rateState.principals[principalId] = recent;
          else delete rateState.principals[principalId];
        }

        const principalRequests = rateState.principals[body.principal_id] || [];
        const globalBlocked = rateState.global.length >= AGGREGATE_REQUEST_LIMIT;
        const principalBlocked = principalRequests.length >= PER_PRINCIPAL_REQUEST_LIMIT;
        if (globalBlocked || principalBlocked) {
          const retryAt = Math.max(
            globalBlocked ? rateState.global[0] + RATE_WINDOW_MS : now,
            principalBlocked ? principalRequests[0] + RATE_WINDOW_MS : now
          );
          const retryAfter = Math.max(1, Math.ceil((retryAt - now) / 1_000));
          await this.ctx.storage.put("request-rate-state", rateState);
          return json({
            error: globalBlocked ? "Aggregate request rate limit reached." : "Principal request rate limit reached.",
            principal_limit: PER_PRINCIPAL_REQUEST_LIMIT,
            aggregate_limit: AGGREGATE_REQUEST_LIMIT
          }, 429, { "retry-after": String(retryAfter) });
        }

        if (!Object.hasOwn(rateState.principals, body.principal_id) &&
            Object.keys(rateState.principals).length >= MAX_RATE_PRINCIPALS) {
          throw new Error("Request-rate principal capacity reached.");
        }
        rateState.global.push(now);
        principalRequests.push(now);
        rateState.principals[body.principal_id] = principalRequests;
        await this.ctx.storage.put("request-rate-state", rateState);
        return json({
          allowed: true,
          principal_limit: PER_PRINCIPAL_REQUEST_LIMIT,
          aggregate_limit: AGGREGATE_REQUEST_LIMIT
        });
      }

      if (url.pathname === "/status" && request.method === "GET") {
        const ledger = await this.readLedger();
        const day = utcDay();
        const bucket = this.bucketFor(ledger, day);
        return json({
          day,
          cap_neurons: DAILY_NEURON_BUDGET,
          used_neurons: bucket.used,
          reserved_neurons: bucket.reserved,
          remaining_neurons: Math.max(0, DAILY_NEURON_BUDGET - bucket.used - bucket.reserved),
          over_budget: bucket.used + bucket.reserved > DAILY_NEURON_BUDGET
        });
      }

      if ((url.pathname !== "/reserve" && url.pathname !== "/settle") || request.method !== "POST") {
        return json({ error: "Not found." }, 404);
      }

      let body;
      try {
        const text = await readTextBounded(request.body, request.headers.get("content-length"), 2_048);
        body = JSON.parse(text);
      } catch {
        return json({ error: "Invalid budget request." }, 400);
      }
      if (!body || !validRequestId(body.request_id)) {
        return json({ error: "A valid request_id is required." }, 400);
      }

      const ledger = await this.readLedger();
      if (url.pathname === "/reserve") {
        if (!Number.isSafeInteger(body.neurons) || body.neurons < 1 || body.neurons > DAILY_NEURON_BUDGET) {
          return json({ error: "neurons must be an integer within the daily budget." }, 400);
        }
        for (const bucket of Object.values(ledger.days)) {
          if (Object.hasOwn(bucket.reservations, body.request_id) || Object.hasOwn(bucket.settled, body.request_id)) {
            return json({ error: "Duplicate budget request_id." }, 409);
          }
        }

        const day = utcDay();
        const bucket = this.bucketFor(ledger, day);
        if (bucket.used + bucket.reserved + body.neurons > DAILY_NEURON_BUDGET) {
          const retryAfter = Math.max(1, Math.ceil((nextUtcMidnight() - Date.now()) / 1_000));
          return json({
            error: "Daily model budget exhausted.",
            day,
            cap_neurons: DAILY_NEURON_BUDGET,
            used_neurons: bucket.used,
            reserved_neurons: bucket.reserved
          }, 429, { "retry-after": String(retryAfter) });
        }

        bucket.reservations[body.request_id] = {
          neurons: body.neurons,
          day,
          created_at: Date.now()
        };
        bucket.reserved += body.neurons;
        await this.writeLedger(ledger);
        return json({ request_id: body.request_id, day, reserved_neurons: body.neurons }, 201);
      }

      if (typeof body.success !== "boolean") {
        return json({ error: "success must be a boolean." }, 400);
      }

      let reservation;
      let reservationBucket;
      for (const bucket of Object.values(ledger.days)) {
        if (Object.hasOwn(bucket.settled, body.request_id)) {
          return json({
            request_id: body.request_id,
            actual_neurons: bucket.settled[body.request_id],
            already_settled: true
          });
        }
        if (Object.hasOwn(bucket.reservations, body.request_id)) {
          reservation = bucket.reservations[body.request_id];
          reservationBucket = bucket;
          break;
        }
      }
      if (!reservation || !reservationBucket) return json({ error: "Budget reservation not found." }, 404);

      let actualNeurons = reservation.neurons;
      if (body.success && body.actual_neurons !== undefined) {
        if (!Number.isSafeInteger(body.actual_neurons) ||
            body.actual_neurons < 0 || body.actual_neurons > MAX_SETTLEMENT_NEURONS) {
          return json({ error: "actual_neurons is invalid." }, 400);
        }
        actualNeurons = body.actual_neurons;
      }

      reservationBucket.reserved = Math.max(0, reservationBucket.reserved - reservation.neurons);
      reservationBucket.used += actualNeurons;
      reservationBucket.settled[body.request_id] = actualNeurons;
      delete reservationBucket.reservations[body.request_id];
      await this.writeLedger(ledger);

      return json({
        request_id: body.request_id,
        actual_neurons: actualNeurons,
        reservation_overrun: actualNeurons > reservation.neurons,
        over_budget: reservationBucket.used + reservationBucket.reserved > DAILY_NEURON_BUDGET
      });
    } catch {
      return json({ error: "Budget service unavailable; inference is blocked." }, 503);
    }
  }

  alarm() {
    return this.enqueue(async () => {
      const now = Date.now();
      const ledger = await this.readLedger();
      for (const bucket of Object.values(ledger.days)) {
        for (const [requestId, reservation] of Object.entries(bucket.reservations)) {
          if (reservation && Number.isSafeInteger(reservation.created_at) &&
              now - reservation.created_at >= RESERVATION_TTL_MS) {
            bucket.reserved = Math.max(0, bucket.reserved - reservation.neurons);
            bucket.used += reservation.neurons;
            bucket.settled[requestId] = reservation.neurons;
            delete bucket.reservations[requestId];
          }
        }
      }
      this.pruneOldDays(ledger, now);
      await this.ctx.storage.put("budget-ledger", ledger);
      await this.scheduleAlarm(ledger, now);
    });
  }
}
