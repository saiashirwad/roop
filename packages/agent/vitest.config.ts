import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: {
    alias: {
      "@roop/agent/testing": new URL("./src/testing/index.ts", import.meta.url).pathname,
      "@roop/agent": new URL("./src/index.ts", import.meta.url).pathname,
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
  },
})
