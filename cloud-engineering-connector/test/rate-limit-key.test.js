// The anonymous rate limiter must key IPv6 clients by their /64 (a single subscriber normally controls a
// whole /64, so per-address keys make the limit trivially bypassable) and must fail closed on identities it
// cannot parse. The limiter binding is a declared stub; no real Cloudflare call is made.
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../worker.js";

const H = { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-03-26" };
async function status(ip) {
  const keys = [];
  const env = { PUBLIC_READ_ONLY: "true", MCP_RATE_LIMITER: { limit: async ({ key }) => { keys.push(key); return { success: true }; } } };
  const headers = { ...H, ...(ip === undefined ? {} : { "cf-connecting-ip": ip }) };
  const r = await worker.fetch(new Request("https://x.test/mcp", { method: "POST", headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }), env);
  return { status: r.status, key: keys[0] };
}

test("addresses in one IPv6 /64 share a rate-limit key; different /64s do not", async () => {
  const a = await status("2001:db8:1:2::1"), b = await status("2001:db8:1:2:ffff:ffff:ffff:ffff");
  const c = await status("2001:0DB8:0001:0002:0000:0000:0000:0003"), d = await status("2001:db8:1:3::1");
  assert.equal(a.status, 200);
  assert.equal(a.key, b.key); assert.equal(a.key, c.key);
  assert.notEqual(a.key, d.key);
});

test("IPv4 and IPv4-mapped IPv6 clients are keyed per address and never collapse to one bucket", async () => {
  const a = await status("203.0.113.7"), b = await status("203.0.113.8");
  const m1 = await status("::ffff:203.0.113.7"), m2 = await status("::ffff:203.0.113.8");
  assert.notEqual(a.key, b.key);
  assert.equal(a.key, m1.key);
  assert.notEqual(m1.key, m2.key);
});

test("malformed or multi-valued client identities fail closed with 503", async () => {
  for (const ip of ["1.1.1.1, 2.2.2.2", "999.1.1.1", "not-an-ip", "2001:db8::1::2", "1:2:3:4:5:6:7:8:9", "::g", "1.1.1"]) {
    const out = await status(ip);
    assert.equal(out.status, 503, "accepted: " + JSON.stringify(ip));
    assert.equal(out.key, undefined);
  }
});
