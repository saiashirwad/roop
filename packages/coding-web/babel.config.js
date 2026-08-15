export default {
  presets: [
    ["@babel/preset-react", { runtime: "automatic" }],
    ["@babel/preset-typescript", { allExtensions: true, isTSX: true }],
  ],
  plugins: [
    [
      "@stylexjs/babel-plugin",
      {
        runtimeInjection: false,
        unstable_moduleResolution: { rootDir: import.meta.dirname, type: "commonJS" },
      },
    ],
  ],
}
