# Extension authoring

Extensions use public values and services. They do not import interpreter files.

The `examples/extensions` directory contains approval, model fallback, context pruning, loop guard,
tool pruning, and subagent examples. Approval defines an `ApprovalService`. Subagents are ordinary
tools that call `AgentRuntime` with an explicit child agent and child session.

Add a core API only when a correct extension cannot use an existing public boundary.
