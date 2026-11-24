import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

function directoryFor(tenantId) {
  return env.TENANT_DIRECTORY.get(env.TENANT_DIRECTORY.idFromName(tenantId));
}

describe("TenantDirectory admission signing key custody constraints", () => {
  it("rejects persisting CryptoKey objects directly in tenant-private storage", async () => {
    const tenantId = "admission-key-persistence-tenant";
    const stub = directoryFor(tenantId);
    const keyPair = await crypto.subtle.generateKey(
      { name: "Ed25519" },
      false,
      ["sign", "verify"],
    );
    const payload = new TextEncoder().encode("tenant-admission-key-persistence-v1");

    expect(keyPair.privateKey.extractable).toBe(false);
    expect(keyPair.publicKey.extractable).toBe(true);
    expect(keyPair.privateKey.algorithm.name).toBe("Ed25519");
    expect(keyPair.publicKey.algorithm.name).toBe("Ed25519");

    const signature = await crypto.subtle.sign(
      { name: "Ed25519" },
      keyPair.privateKey,
      payload,
    );
    await expect(
      crypto.subtle.verify(
        { name: "Ed25519" },
        keyPair.publicKey,
        signature,
        payload,
      ),
    ).resolves.toBe(true);

    await expect(
      runInDurableObject(stub, async instance => {
        await instance.ctx.storage.put("admission:signing-key:v1", {
          privateKey: keyPair.privateKey,
          publicKey: keyPair.publicKey,
        });
      }),
    ).rejects.toThrow(/CryptoKey/);

    const stored = await runInDurableObject(stub, async instance =>
      instance.ctx.storage.get("admission:signing-key:v1"),
    );
    expect(stored).toBeUndefined();
  });
});
