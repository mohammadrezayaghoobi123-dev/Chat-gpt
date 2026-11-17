import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
    }),
  ],
  test: {
    include: ["cloudflare-test/**/*.test.js"],
    exclude: ["cloudflare-test/write-control*.test.js"],
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
