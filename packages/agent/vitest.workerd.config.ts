import { cloudflareTest } from "@cloudflare/vitest-pool-workers"
import { defineConfig } from "vitest/config"

export default defineConfig({
  plugins: [cloudflareTest({ miniflare: { compatibilityDate: "2026-08-11" } })],
  test: {
    include: ["test-workerd/**/*.test.ts"],
  },
})
