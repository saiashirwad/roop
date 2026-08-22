# Middleware

Middleware wraps model, tool, step, and turn operations. The leftmost middleware is outermost. It
sees input first and the result last.

Model and tool middleware wrap `Stream` values, so cleanup covers the full stream lifetime. Step and
turn middleware wrap `Effect` values. Middleware can rewrite model-facing history, replace a model,
deny a tool, trace work, or add a scoped resource.

Use `Middleware.make` for a value, `Middleware.all` for ordered composition, and `Middleware.layer`
or `Middleware.layerScoped` for Layer construction.
