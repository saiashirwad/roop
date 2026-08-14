/// <reference types="vite/client" />

declare module "@stylexjs/postcss-plugin" {
  import type { Plugin } from "postcss"
  const plugin: (options: { include: ReadonlyArray<string> }) => Plugin
  export default plugin
}
