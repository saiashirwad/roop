# Composition

An `Agent` is a named value that renders one `AgentPlan` before each model request. A `Module`
contributes ordered instructions and typed tools. Module requirements stay in `R`, and module
failures stay in `E`.

`Module.all` keeps declaration order. Empty instruction fragments have no effect. Duplicate tool
names fail with `ToolConflict`; Roop does not select a winner.

Use `Module.when` for a dynamic contribution. Use `Module.provide` or `Module.provideLayer` to
satisfy a module requirement at the composition boundary.
