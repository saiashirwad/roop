import stylexPostcss from "@stylexjs/postcss-plugin"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [react({ babel: { configFile: true } })],
  css: {
    postcss: {
      plugins: [stylexPostcss({ include: ["src/**/*.{ts,tsx}"] })],
    },
  },
  server: {
    proxy: { "/rpc": process.env["HARNESS_URL"] ?? "http://localhost:8787" },
  },
})
