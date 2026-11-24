# Browser composition package instructions

Read the root instructions. This package is the only existing composition root; core never reaches into concrete adapters.

The current source exports interface candidates, including `CreatePlayer`, and intentionally exports no fake `createPlayer` implementation. The implementation task must provide real adapter registration, host mounting, source/session creation and lifecycle cleanup. Until default adapters exist, the type contract requires explicit adapter injection.

The eventual Vue app imports the public browser SDK and observes immutable diagnostic snapshots. Packet/frame/PCM queues never enter Vue reactivity. Native URLs remain distinct from readable random-access sources. A new Player.open disposes the previous Session and constructs a new session identity; Session.dispose is terminal.

Keep DOM objects and platform AbortSignal/clock conversion here or in concrete browser adapters. Introduce separate worker/worklet TypeScript projects when adding those runtimes. Native/remux qualification is an independent task; current non-native measurements do not enable unqualified remux.

Use real browser checks for adapter initialization, transfer, seek, abort, AudioWorklet, renderer and disposal. Distinguish draw submission, graph-clock scheduling and physical output. Missing capabilities must produce an explicit unsupported result, never successful placeholder playback.
