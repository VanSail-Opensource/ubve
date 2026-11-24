# Read-only local disc candidate

`DiscSession.open(blob)` uses one owning module Worker for a local UDF image;
`DiscSession.open([{path, blob}, ...])` uses a normalized, immutable folder map.
The exact C providers are libudfread 1.2.0 and libbluray 1.5.0, compiled with
Emscripten 6.0.0. `source(path)` exposes bounded exact reads without extracting
the image or copying clips into a virtual filesystem. `list(path)` exposes a
bounded directory inventory. `inventory` contains title, clip, stream/PID and
chapter records in libbluray's public 90 kHz clock. `validateLinearTitle` and
`locateTitleTime` retain trims and refuse multi-angle and still/menu titles.

This package is **UNQUALIFIED**. It is not wired to a whole-title player. The
reference fixture is a UDF filesystem containing deterministic byte patterns,
not a playable Blu-ray. Browser FileReaderSync execution, fragmented extents,
large local files, real BDMV title references, clip transitions, PID/configuration
changes and disc playback/seek still need evidence. Remote ISO, encrypted discs,
menus and decryption helpers are not admitted. AV1-in-BDMV is not invented here.

## Build and asset provenance

Source archives and their original license texts are in `third_party/disc`.
The build recipe checks source hashes, exact emcc version, checked Meson source
patch points, static linking and external staged libudfread. Native dynamic
loading is replaced by the checked-in refusal shim; no decryptor or JVM can be
resolved through it. The final runtime uses `FILESYSTEM=0` and exposes only the
read-only wrapper and allocator/runtime exports. Assertion checks retain named
WASM imports and exports so the audit can inspect the public ABI.

```sh
python3 scripts/build-disc.py --emsdk /path/to/emsdk --build-tools /path/to/meson-and-ninja
node scripts/prepare-disc-assets.mjs
```

The build manifest binds source/compiler/shim and generated JS/WASM hashes. The
repo contains the generated runtime so a normal application build does not need
to install a native compiler. The source archives and replacement files permit
rebuilding/relinking the separate WASM component.

## Resource and cancellation contract

One local callback reads at most 1 MiB. Images use 2048-byte sectors and are
capped at `(2^32−1)×2048` bytes by the provider's 32-bit block callback. File
handles are capped at 64, directory entries at 4096, folder files at 16384,
titles/clips at 1024 and serialized inventories at 1 MiB. WASM memory has an
explicit 128 MiB maximum. Four RPCs and four MiB of delivered read leases are
admitted at once. The worker's read scratch space and WASM maximum are distinct
from those application leases.

Cancellation/deadline/identity failure retires the complete owner; it cannot
reuse a C call that was interrupted halfway through. Normal close awaits its
acknowledgement and terminates the worker. `physicalMemoryReclamation` remains
`unobserved`, because termination is not an observed physical memory release.
Already delivered byte leases remain charged until their recipient releases them.

## Executed checks

`test/disc.test.mjs` runs actual pinned WASM under Node for the reference UDF hash,
bounded extent callbacks, random reads, malformed-image refusal, source/shim
integrity and ABI inspection. Separate protocol doubles exercise epoch mismatch,
watchdog retirement and ownership after disposal. Pure tests check path identity,
protected-directory refusal and exact title-clock arithmetic. None establishes
browser execution or full media playback.
