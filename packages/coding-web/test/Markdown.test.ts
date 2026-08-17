import { expect, test } from "vitest"

import { renderMarkdown } from "../src/Markdown.tsx"

test("does not emit raw HTML or unsafe markdown URLs", () => {
  const javascriptScheme = ["java", "script:"].join("")
  const html = renderMarkdown(
    `<script>alert("xss")</script>\n\n[run](${javascriptScheme}alert(1)) ![pixel](data:text/html;base64,abc)`,
  )

  expect(html).not.toContain("<script")
  expect(html).not.toContain(javascriptScheme)
  expect(html).not.toContain("data:")
  expect(html).toContain("run")
  expect(html).toContain("pixel")
})

test("rejects obfuscated dangerous schemes and protocol-relative URLs", () => {
  const javascriptScheme = ["java", "script:"].join("")
  const mixedJavascriptScheme = ["JaVaScRi", "Pt:"].join("")
  const html = renderMarkdown(
    [
      `[mixed](${mixedJavascriptScheme}alert(1))`,
      "[percent](%6a%61%76%61%73%63%72%69%70%74:alert(1))",
      "[entity](java&#x73;cript:alert(1))",
      "[data](%64ata:text/html,boom)",
      "[vb](vBsCrIpT:msgbox(1))",
      "[network](//evil.example/x)",
      '[safe](https://example.com/x?title="quoted")',
    ].join(" "),
  )

  expect(html).not.toContain(javascriptScheme)
  expect(html).not.toContain("data:")
  expect(html).not.toContain("vbscript:")
  expect(html).not.toContain("//evil.example")
  expect(html).toContain('href="https://example.com/x?title=&quot;quoted&quot;"')
})

test("escapes link attributes instead of allowing attribute breaking", () => {
  const html = renderMarkdown(
    '![x" onerror="alert(1)](/pixel.png) [safe](https://example.com "title")',
  )

  expect(html).toContain('alt="x&quot; onerror=&quot;alert(1)"')
  expect(html).toContain('title="title"')
  expect(html).not.toContain('onmouseover="')
})

test("keeps safe links and images", () => {
  const html = renderMarkdown("[docs](https://example.com) ![logo](/logo.svg)")

  expect(html).toContain('href="https://example.com"')
  expect(html).toContain('src="/logo.svg"')
})
