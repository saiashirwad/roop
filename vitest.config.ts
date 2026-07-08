import { defineConfig } from "vitest/config"

/** Root convenience runner. Package tests go through `turbo run test`. */
export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
  },
})
