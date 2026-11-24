# Testkit package instructions

Read the root instructions. This package uses core plus ES2023 only. It must never be imported by production packages.

The fake codec identifies itself as `test-marker-v1`. Its four marker bytes are resource/lifecycle fixtures, not decoded pixels or audio. The manual scheduler advances only under test control, so timing values from it are not performance data. MemorySource copies small fixtures and is not a production source adapter.

Keep tests meaningful: EOF and unsafe offsets; byte/count admission before allocation; ownership after backpressure; exactly-once destruction; stale results; cancellation/deadline; out-of-order output; EOS tail sealing; reset readiness; disposal and retained caller-owned outputs. New promises must settle during cancellation and teardown, and scheduled callbacks must be removed.

Do not weaken the public decoder contract to match the fake's one-marker-per-input behavior. A real codec may emit zero or multiple outputs and may need later input or EOS flush before producing a frame.
