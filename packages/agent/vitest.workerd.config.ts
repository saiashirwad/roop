import { cloudflareTest } from "@cloudflare/vitest-pool-workers"
import { defineConfig } from "vitest/config"

export default defineConfig({
  plugins: [cloudflareTest({})],
  test: {
    include: ["test-workerd/**/*.test.ts"],
  },
})
