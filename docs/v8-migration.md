# v8 source-only migration record

The v8 starter copies the existing v7 implementation-starter source, tests, package lock, toolchain and validation history. It excludes dependency directories, generated package builds and compiler cache output. `v8-source-migration.json` records the retained source/evidence hashes. No production player or new codec implementation is added by this documentation update.

The historical 23 tests remain historical evidence for the unchanged core/testkit/browser-contract code. The current v8 primary additions—AV1 I420P10, exact integer-capable TrueHD PCM, HDR static metadata, subtitle/font descriptors, native output modes and exact qualification—need deliberate production interfaces/adapters. Do not infer that a policy field already exists in the TypeScript source.

Changed documents: README, START-HERE, canonical I00–I12 task cards/index, ADR002, relevant proposed policies and their integration notes. Original policies are archived. Native encoded HDR and a one-clock lossless soundtrack bridge now precede unnecessary managed video decode; hardware execution remains deferred. The release gate follows the accompanying evidence-kit's executable verdict, with no 0.995 exception.

Exact primary pins are Mediabunny/TrueHD/FLAC 1.66.4, libmedia 1.3.1 with common 2.3.0, npm libav.js 6.11.9 with generated ABI 6.11.9.0.2, and JASSUB 2.5.38. The preserved starter package lock still contains only its original development dependencies; source-selection policy is not a claimed production install.

The parent v8 evidence bundle owns actual experiments, fixture/reference artifacts and all successful/failed run records. Its `bench-v8/libmedia` directory includes the real decoder, lifecycle and HDR-struct corrections; none is silently imported into the production registry. The schema/evaluator is under `evidence-kit/qualification`. Artifact paths in these documents refer to that companion bundle where explicitly stated.

This migration uses source/document checks only. It does not rerun npm installation, TypeScript build, the historical 23-test suite or any media/native/GPU benchmark. Future verification must be reserved and recorded separately.
