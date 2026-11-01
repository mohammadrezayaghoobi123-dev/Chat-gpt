import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const DAILY_CAP = 1_000;

function budgetStub() {
  return env.AGENT_BUDGET.get(env.AGENT_BUDGET.idFromName("global"));
}

async function reserve(neurons, requestId = crypto.randomUUID()) {
  const response = await budgetStub().fetch(new Request("https://budget.internal/reserve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ request_id: requestId, neurons })
  }));
  return { response, requestId, body: await response.json() };
}

async function settle(requestId, actualNeurons, success = true) {
  return budgetStub().fetch(new Request("https://budget.internal/settle", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ request_id: requestId, actual_neurons: actualNeurons, success })
  }));
}

async function status() {
  const response = await budgetStub().fetch(new Request("https://budget.internal/status"));
  return { response, body: await response.json() };
}

describe("Cloudflare Workers runtime: global daily Neuron budget", () => {
  it("reserves budget before inference and reports the remaining daily allowance", async () => {
    const result = await reserve(600);
    expect(result.response.status).toBe(201);
    expect(result.body.reserved_neurons).toBe(600);

    const current = await status();
    expect(current.response.status).toBe(200);
    expect(current.body.cap_neurons).toBe(DAILY_CAP);
    expect(current.body.used_neurons).toBe(0);
    expect(current.body.reserved_neurons).toBe(600);
    expect(current.body.remaining_neurons).toBe(400);
  });

  it("fails closed when concurrent reservations would exceed the daily cap", async () => {
    const results = await Promise.all([reserve(700), reserve(700)]);
    expect(results.filter(item => item.response.status === 201)).toHaveLength(1);
    expect(results.filter(item => item.response.status === 429)).toHaveLength(1);

    const current = await status();
    expect(current.body.used_neurons + current.body.reserved_neurons).toBeLessThanOrEqual(DAILY_CAP);
  });

  it("settles actual usage and releases unused reserved Neurons", async () => {
    const reservation = await reserve(600);
    expect(reservation.response.status).toBe(201);

    const settled = await settle(reservation.requestId, 250);
    expect(settled.status).toBe(200);

    const next = await reserve(750);
    expect(next.response.status).toBe(201);

    const blocked = await reserve(1);
    expect(blocked.response.status).toBe(429);
  });

  it("charges the full reservation when inference fails or usage metadata is unavailable", async () => {
    const reservation = await reserve(300);
    expect(reservation.response.status).toBe(201);

    const settled = await settle(reservation.requestId, undefined, false);
    expect(settled.status).toBe(200);

    const current = await status();
    expect(current.body.used_neurons).toBe(300);
    expect(current.body.reserved_neurons).toBe(0);
  });

  it("makes settlement idempotent and prevents double charging", async () => {
    const reservation = await reserve(400);
    expect(reservation.response.status).toBe(201);

    expect((await settle(reservation.requestId, 175)).status).toBe(200);
    expect((await settle(reservation.requestId, 175)).status).toBe(200);

    const current = await status();
    expect(current.body.used_neurons).toBe(175);
    expect(current.body.reserved_neurons).toBe(0);
  });

  it("rejects malformed and duplicate reservations", async () => {
    const invalid = await budgetStub().fetch(new Request("https://budget.internal/reserve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request_id: "not-a-uuid", neurons: 50 })
    }));
    expect(invalid.status).toBe(400);

    const requestId = crypto.randomUUID();
    expect((await reserve(100, requestId)).response.status).toBe(201);
    expect((await reserve(100, requestId)).response.status).toBe(409);
  });

  it("starts a fresh budget bucket at the next UTC day without losing in-flight prior-day reservations", async () => {
    const stub = budgetStub();
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    let oldRequestId;

    await runInDurableObject(stub, async (_instance, state) => {
      oldRequestId = crypto.randomUUID();
      await state.storage.put("budget-ledger", {
        days: {
          [yesterday]: {
            used: 900,
            reserved: 100,
            reservations: {
              [oldRequestId]: { neurons: 100, day: yesterday }
            },
            settled: {}
          }
        }
      });
    });

    const todayReservation = await reserve(900);
    expect(todayReservation.response.status).toBe(201);

    const oldDaySettlement = await settle(oldRequestId, 60);
    expect(oldDaySettlement.status).toBe(200);

    const current = await status();
    expect(current.body.used_neurons).toBe(0);
    expect(current.body.reserved_neurons).toBe(900);
  });

  it("records usage above the reservation rather than silently discarding an overrun", async () => {
    const reservation = await reserve(100);
    expect(reservation.response.status).toBe(201);

    const settled = await settle(reservation.requestId, 150);
    expect(settled.status).toBe(200);
    const current = await status();
    expect(current.body.used_neurons).toBe(150);
    expect(current.body.over_budget).toBe(false);
  });
});
