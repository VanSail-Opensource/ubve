# Implementation and phase record

The v8 specification in `docs/specification` is the source of requirements. The canonical phases remain I00–I12. Each phase is developed and reviewed separately. Independent implementation proceeds while CI runs; no pending CI result is counted as passing.

| Phase | Implementation | Qualification |
|---|---|---|
| I00 bootstrap | Imported pinned foundation; CI and reproducible dependencies | Local execution pending |
| I01 contracts | In progress | Pending |
| I02 source/demux | In progress in isolated worktree | Pending |
| I03 codec adapters | In progress in isolated worktree | Pending |
| I04 presentation | In progress in isolated worktree | Hardware output deferred |
| I05 SDK and Vue | In progress in isolated worktree | Pending |
| I06 integrated evidence | Pending composition | NOT QUALIFIED |
| I07 HTTP | In progress with source owner | Pending |
| I08 native/remux/bridge | In progress with source owner | Hardware output deferred |
| I09 cinema extensions | In progress with presentation owner | Pending |
| I10 indexes/discs | Pending | Pending |
| I11 optimization | Pending measured bottleneck | NOT QUALIFIED |
| I12 release assessment | Pending | NOT QUALIFIED |

There are zero qualified production configurations in the supplied baseline. Full quality requires at least 60 unique source pictures per second; performance mode requires 120, with the declared spatial transform and every required audio/subtitle semantic. Native/GPU execution is deferred by the user's instruction; deferred is never a pass.
