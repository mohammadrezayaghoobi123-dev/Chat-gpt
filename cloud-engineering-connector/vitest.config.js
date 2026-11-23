import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";

const executorFixtureSeed = createHash("sha256").update("exec-fixture-v1").digest();
const executorFixturePkcs8 = Buffer.concat([
  Buffer.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]),
  executorFixtureSeed,
]);
const executorFixturePublicKey = createPublicKey(createPrivateKey({
  key: executorFixturePkcs8,
  format: "der",
  type: "pkcs8",
})).export({ format: "der", type: "spki" }).subarray(-32).toString("base64url");

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        bindings: {
          // Test-only deterministic key. Never copied into Wrangler or Cloudflare secrets.
          LEDGER_WORKER_ASSERTION_KEYS: JSON.stringify({ "test-v1": "3031323334353637383961626364656630313233343536373839616263646566" }),
          ORCHESTRATOR_EXECUTOR_VERIFICATION_KEYS: JSON.stringify({ "executor-ed25519-v1": { publicKey: executorFixturePublicKey, subject: "orchestrator-executor", role: "agent", operations: ["claimTask"] } }),
          LEDGER_OWNER_ASSERTION_KEYS: JSON.stringify({ "owner-v1": "3031323334353637383961626364656630313233343536373839616263646566" }),
          GITHUB_WEBHOOK_OWNER_ID: "335530603",
          GITHUB_WEBHOOK_REPOSITORY: "mohammadrezayaghoobi123-dev/Chat-gpt",
          LEDGER_OWNER_ASSERTION_ACTIVE_KID: "owner-v1",
          GITHUB_WEBHOOK_REPOSITORY_ID: "1398846697",
        },
      },
    }),
  ],
  test: {
    include: ["cloudflare-test/**/*.test.js"],
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
