import { randomBytes } from "node:crypto";
import admissionSigner from "./admission-signer/worker.js";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const testMasterKey = randomBytes(32).toString("base64");
const testSignerEnvironment = {
  ADMISSION_SIGNER_MASTER_KEYS: JSON.stringify({
    activeKeyId: "vitest-kek-v1",
    keys: { "vitest-kek-v1": testMasterKey },
  }),
};

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        serviceBindings: {
          ADMISSION_SIGNER: request => admissionSigner.fetch(request, testSignerEnvironment),
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
