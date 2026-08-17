/**
 * Strips markdown code fences, bash heredocs, or extracts OpenAI patch markers,
 * even when surrounded by conversational text.
 */
export const extractPatchBlock = (input: string): string => {
  const trimmed = input.trim()

  // 1. If OpenAI *** Begin Patch marker is present on its own line, extract that section
  const lines = trimmed.split(/\r?\n/)
  const beginIdx = lines.findIndex((l) => l.trim() === "*** Begin Patch")
  if (beginIdx !== -1) {
    const endIdx = lines.findLastIndex((l) => l.trim() === "*** End Patch")
    const extractedLines =
      endIdx !== -1 && endIdx >= beginIdx
        ? lines.slice(beginIdx, endIdx + 1)
        : lines.slice(beginIdx)
    return extractedLines.join("\n").trim()
  }

  // 2. Extract content from markdown code fences anywhere in the string
  const fenceMatch = trimmed.match(/```[a-z0-9_-]*\r?\n([\s\S]*?)\r?\n```/i)
  if (fenceMatch?.[1]) {
    return fenceMatch[1].trim()
  }

  // 3. Extract content from bash heredocs (e.g. cat <<'EOF' ... EOF)
  const heredocMatch = trimmed.match(
    /(?:cat\s+)?<<['"]?([A-Za-z0-9_-]+)['"]?\s*\r?\n([\s\S]*?)\r?\n\s*\1/i,
  )
  if (heredocMatch?.[2]) {
    return heredocMatch[2].trim()
  }

  return trimmed
}

export const normalizePatchText = (input: string): string => {
  const extracted = extractPatchBlock(input)
  return extracted.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim()
}
