import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

function directoryFor(tenantId) {
  return env.TENANT_DIRECTORY.get(env.TENANT_DIRECTORY.idFromName(tenantId));
}

describe("TenantDirectory admission signing key custody", () => {
  it("persists non-extractable Ed25519 CryptoKeys in tenant-private storage", async () => {
    const tenantId = "admission-key-persistence-tenant";
    const otherTenantId = "admission-key-persistence-other-tenant";
    const stub = directoryFor(tenantId);
    const otherStub = directoryFor(otherTenantId);
    const keyPair = await crypto.subtle.generateKey(
      { name: "Ed25519" },
      false,
      ["sign", "verify"],
    );
    const keyId = crypto.randomUUID();

    expect(keyPair.privateKey.extractable).toBe(false);
    expect(keyPair.publicKey.extractable).toBe(false);
    expect(keyPair.privateKey.algorithm.name).toBe("Ed25519");
    expect(keyPair.publicKey.algorithm.name).toBe("Ed25519");

    await runInDurableObject(stub, async instance => {
      await instance.ctx.storage.put("admission:signing-key:v1", {
        keyId,
        privateKey: keyPair.privateKey,
        publicKey: keyPair.publicKey,
      });
    });

    const restored = await runInDurableObject(stub, async instance =>
      instance.ctx.storage.get("admission:signing-key:v1"),
    );

    expect(restored).toMatchObject({ keyId });
    expect(restored.privateKey).toBeInstanceOf(CryptoKey);
    expect(restored.publicKey).toBeInstanceOf(CryptoKey);
    expect(restored.privateKey.extractable).toBe(false);
    expect(restored.publicKey.extractable).toBe(false);
    expect(restored.privateKey.usages).toEqual(["sign"]);
    expect(restored.publicKey.usages).toEqual(["verify"]);

    const payload = new TextEncoder().encode("tenant-admission-key-persistence-v1");
    const signature = await crypto.subtle.sign(
      { name: "Ed25519" },
      restored.privateKey,
      payload,
    );
    await expect(
      crypto.subtle.verify(
        { name: "Ed25519" },
        restored.publicKey,
        signature,
        payload,
      ),
    ).resolves.toBe(true);

    await expect(
      crypto.subtle.exportKey("pkcs8", restored.privateKey),
    ).rejects.toThrow();

    const otherTenantKey = await runInDurableObject(otherStub, async instance =>
      instance.ctx.storage.get("admission:signing-key:v1"),
    );
    expect(otherTenantKey).toBeUndefined();
  });
});
