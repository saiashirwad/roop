import stylexPostcss from "@stylexjs/postcss-plugin"
import react from "@vitejs/plugin-react"
import { Config, Effect } from "effect"
import { defineConfig } from "vite"

const harnessUrl = Effect.runSync(
  Config.string("HARNESS_URL").pipe(Config.withDefault("http://localhost:8787")),
)

export default defineConfig({
  plugins: [react({ babel: { configFile: true } })],
  css: {
    postcss: {
      plugins: [stylexPostcss({ include: ["src/**/*.{ts,tsx}"] })],
    },
  },
  server: {
    allowedHosts: process.env.AMP_ORB === "1" ? true : [],
    proxy: { "/rpc": harnessUrl },
  },
})
