export const ignoredPrefixes = [".git", ".repos", "node_modules", "dist", "coverage"] as const

export const isIgnoredPath = (entry: string): boolean =>
  ignoredPrefixes.some((prefix) => entry === prefix || entry.startsWith(`${prefix}/`))
