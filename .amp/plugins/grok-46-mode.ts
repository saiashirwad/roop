// @amp-agent-mode {"key":"grok46","label":"Grok 4.6"}

import type { PluginAPI } from "@ampcode/plugin"

export const description = "Adds a Grok 4.6 agent mode with all available Amp tools."

export default function (amp: PluginAPI) {
  const agent = amp.createAgent({
    model: "xai/grok-4.6",
    instructions:
      "Follow the user's instructions and use the available tools to complete the task.",
    tools: "all",
    reasoningEffort: "high",
    display: { label: "Grok 4.6", color: "#0ea5e9" },
  })

  amp.registerAgentMode({
    key: "grok46",
    label: "Grok 4.6",
    description: "Amp's base agent running on Grok 4.6 with all available tools",
    color: "#0ea5e9",
    agent: agent.definition,
  })
}
