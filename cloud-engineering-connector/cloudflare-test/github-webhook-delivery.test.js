import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

function ledgerFor(name) {
  return env.ORCHESTRATOR_LEDGER.get(env.ORCHESTRATOR_LEDGER.idFromName(name));
}

const delivery = (overrides = {}) => ({
  deliveryId: "gh-delivery-00000001",
  bodySha256: "a".repeat(64),
  eventName: "issues",
  receivedAt: 1_800_000_000_000,
  ...overrides,
});

describe("durable GitHub webhook delivery replay contract", () => {
  it("claims a provider delivery once and persists the claim across RPC calls", async () => {
    const ledger = ledgerFor("github-delivery-single-claim");
    const input = delivery();
    await expect(ledger.claimGitHubDelivery(input)).resolves.toMatchObject({
      claimed: true,
      replay: false,
      deliveryId: input.deliveryId,
      bodySha256: input.bodySha256,
    });
    await expect(ledger.claimGitHubDelivery(input)).resolves.toMatchObject({
      claimed: false,
      replay: true,
      deliveryId: input.deliveryId,
      bodySha256: input.bodySha256,
    });
  });

  it("rejects reuse of one provider delivery ID with a different signed body digest", async () => {
    const ledger = ledgerFor("github-delivery-body-conflict");
    await ledger.claimGitHubDelivery(delivery());
    await expect(ledger.claimGitHubDelivery(delivery({ bodySha256: "b".repeat(64) })))
      .resolves.toMatchObject({
        claimed: false,
        replay: false,
        conflict: true,
        reason: "DELIVERY_ID_CONFLICT",
      });
  });

  it("allows exactly one winner under concurrent delivery claims", async () => {
    const ledger = ledgerFor("github-delivery-concurrent-claim");
    const input = delivery({ deliveryId: "gh-delivery-concurrent-0001" });
    const results = await Promise.all(
      Array.from({ length: 32 }, () => ledger.claimGitHubDelivery(input)),
    );
    expect(results.filter(result => result.claimed)).toHaveLength(1);
    expect(results.filter(result => result.replay)).toHaveLength(31);
    expect(results.some(result => result.conflict)).toBe(false);
  });

  it("rejects malformed delivery identifiers, digests, and timestamps", async () => {
    const ledger = ledgerFor("github-delivery-invalid-input");
    await expect(ledger.claimGitHubDelivery(delivery({ deliveryId: "bad" })))
      .resolves.toMatchObject({ claimed: false, reason: "INVALID_DELIVERY" });
    await expect(ledger.claimGitHubDelivery(delivery({ bodySha256: "not-a-digest" })))
      .resolves.toMatchObject({ claimed: false, reason: "INVALID_DELIVERY" });
    await expect(ledger.claimGitHubDelivery(delivery({ receivedAt: 0 })))
      .resolves.toMatchObject({ claimed: false, reason: "INVALID_DELIVERY" });
  });
});
