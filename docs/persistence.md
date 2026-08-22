# Persistence

`Journal` is an append-only service with `load` and atomic `append` operations. Each append supplies
an expected revision. A concurrent writer gets `JournalRevisionConflict`.

Roop stores complete semantic events, not token deltas. `History.fromEvents` and `History.toPrompt`
are pure. `JournalMemory` is the reference provider for tests and embedded runs. Database and file
providers belong in separate packages.
