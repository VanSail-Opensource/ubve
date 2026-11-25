# Browser composition package instructions

Read the root instructions. This package is the only existing composition root; core never reaches into concrete adapters.

The package exports the public player and the reference composition. The default registry binds native, managed and subtitle candidates to a single output host. Vue consumes immutable snapshots. Keep packet/frame/PCM queues outside Vue reactivity. Native URLs remain distinct from readable random-access sources. A new Player.open retires the previous Session and creates a new identity. Session.dispose is terminal.

Keep DOM objects and platform AbortSignal/clock conversion here or in concrete browser adapters. Introduce separate worker/worklet TypeScript projects when adding those runtimes. Native/remux qualification is an independent task; current non-native measurements do not enable unqualified remux.

Use real browser checks for adapter initialization, transfer, seek, abort, AudioWorklet, renderer and disposal. Distinguish draw submission, graph-clock scheduling and physical output. Missing capabilities must produce an explicit unsupported result, never successful placeholder playback.
