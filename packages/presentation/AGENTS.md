# Presentation implementation

Read the root instructions and ADR004–006. This package owns browser presentation,
subtitle output and bounded PCM transport; it never parses video containers or
decodes compressed video. Source packets, native frames and PCM stay outside UI
reactivity. Preserve native encoded HDR where available. A successful API call is
not HDR, physical-output, or 60/120 qualification.

`src/` has DOM types. `worklet/` is checked separately without DOM/window globals.
The asset preparation script emits the worklet and a pinned, one-thread JASSUB
worker with hashes. Keep the exact upstream patch check and notices. Never widen
a subtitle profile silently or fetch script-referenced fonts/images automatically.
