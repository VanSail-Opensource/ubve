# Core package instructions

Read the workspace root instructions first. The core compiler has only ES2023 globals; do not import DOM, Node, Vue, or concrete adapters.

Own byte/timeline/packet/source/operation/decoder/output/session contracts and the implemented epoch, lease, reservation and queue helpers. Public signature changes need an integrator-reviewed migration for testkit and browser. Maintain unknown values explicitly and preserve provenance instead of filling missing data with zero.

A lease move invalidates the sending handle; old borrowed JavaScript aliases cannot be revoked, so adapters must end their use before moving. Resource-accounting tests must distinguish queue occupancy, global explicit allocations and opaque third-party memory. Each reservation is either claimed once or released on failure.

Decoder contracts must support reordered/delayed output, finite waits, reset readiness and awaited shutdown. Source contract tests cover EOF, zero length, cancellation, identity and high offsets. Packet invariants distinguish source-exact, repacked and opaque API payloads; internal normalized timestamps retain their evidence provenance.

Keep runtime helpers small and independently testable. Types for Session and physical/browser output remain contracts until their real implementations exist. Add `RENDER_BUDGET` or other error categories deliberately with a caller action and fixture when the corresponding controller is implemented.
