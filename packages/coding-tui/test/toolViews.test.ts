import { expect, it } from "vitest"

import { renderToolCall } from "../src/toolViews.ts"

it("renders a successful undefined (Schema.Void) result as complete", () => {
  const rendered = renderToolCall({
    name: "writeFile",
    params: { path: "README.md", content: "" },
    result: undefined,
    isFailure: false,
  })

  expect(rendered).toContain("\uf00c")
  expect(rendered).not.toContain("\uf10c")
})

it("renders an undefined failed result as failed, not pending", () => {
  const rendered = renderToolCall({
    name: "writeFile",
    params: { path: "README.md", content: "" },
    result: undefined,
    isFailure: true,
  })

  expect(rendered).toContain("\uf00d")
  expect(rendered).not.toContain("\uf10c")
})
