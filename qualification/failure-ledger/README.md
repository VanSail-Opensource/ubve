# Frozen failure history and admission join

This snapshot records **three actually observed visible-pixel mismatches** from
two retained libmedia cohorts. It is not a proposed test result. The admission
helper and its new tests were written during a reserved CPU measurement window
and are **SOURCE-ONLY / UNTESTED** at creation. The previously executed **22
synthetic `verdict.py` tests remain a separate record** and do not validate the
new helper.

**Later validation:** after the parent released that reservation, all 12 new
synthetic tests passed in the reported 0.004 seconds. The default-route CLI
returned `BLOCKED_UNRESOLVED_FIDELITY_FAILURE` with all three blocking events.
The actual commands and code hashes are retained in
`validation-20261124.json`. The earlier 22 verdict tests were not rerun. These
logic checks do not change any decoder failure or qualify media playback.

## Frozen snapshot

`libmedia-default-simd4-20261124.json` is a read-only snapshot with chained event
hashes, a canonical payload hash and this external whole-file SHA-256 pin:

`0435ad14453158b463980f18df2ee683af371178ed8a738789f981e98a43f733`

Hashes detect modification; they are not signatures or a claim of unmodifiable
storage. Preserve the original bytes. New failures or reviewed dispositions
belong in a successor snapshot or separate resolution record linked to this
pin. Do not overwrite events, change their status, or delete a bad trial after
a retry. The companion `.pin.json` repeats the pin for packaging; the helper
also embeds it so dropping an event and recalculating local hashes cannot
silently replace the expected snapshot.

Every event includes the exact source hash, frame index and PTS, expected and
actual full-frame hashes, decoder binary hash, package/runtime identity,
settings, raw evidence hash, adapter freeze hash and compiled adapter hash.
The associated workspace freeze is retained provenance; it is not independent
attestation of every byte the earlier browser fetched.

The decoder binary is the pinned libmedia release SIMD AV1 module:

`8764bd672a8999ed311b41814b09f62c0633d7c991d6489d1d6e2479286adb7e`

All events use four requested threads and no decoder AVOption override.

| Retained cohort | Fixture suffix | Zero-based frame | Failure |
| --- | --- | ---: | --- |
| Full HDR correctness attempt 2 | `1280x720-120fps-limited-textured-20M.mkv` | 21 | Complete visible-plane SHA mismatch |
| Full HDR correctness attempt 2 | `1280x720-120fps-limited-textured-80M.mkv` | 33 | Complete visible-plane SHA mismatch |
| Held-frame diagnostic | `1280x720-120fps-limited-textured-20M.mkv` | 33 | Both held snapshots identical, both incorrect |

The full fixture names begin `av1-hdr10-pattern-`. Both trials in the first
cohort and the failing diagnostic trial completed all expected frames and
passed HDR metadata comparison. That does not negate pixel corruption.

## Join contract

1. Load the ledger using its externally pinned SHA and verify its payload and
   complete event chain. Missing, modified or malformed history blocks
   admission. Retain and review the linked raw evidence and named freezes.
2. Supply explicit component, binary hash, runtime/package identity, variant,
   thread count, decoder-options object, pixel format, adapter-cohort hash and
   fixture hash. Absence of options is represented by `{}`, not an omitted
   field. Nonempty options require actual successful consumption evidence.
3. Match decoder/runtime/settings **without using the adapter-cohort hash or
   fixture hash to clear a known route defect**. Those fields retain exact
   provenance and identify directly observed cases. A mere instrumentation
   rebuild or a different input does not explain an unresolved decoder fault.
4. Treat explicit known defaults such as `max_frame_delay=0` as the same
   configuration as no override. A different meaningful setting, binary,
   runtime or thread count creates a separate candidate that requires its own
   correctness/regression corpus and reviewed disposition. It gains no pass
   from this helper.
5. Run complete-pipeline qualification separately. `failure_guard.py` never
   emits `PASS` or `admitted:true`. A clean current record, favorable timing,
   or a proposed `verdict.py` pass cannot override a matching unresolved
   failure. The root admission layer must require both a clear reviewed
   failure disposition and all applicable fidelity/pipeline/output evidence.

After the root releases its test reservation, the identity example can be
checked with:

```sh
python3 evidence-kit/qualification/failure_guard.py \
  evidence-kit/qualification/failure-ledger/candidate-default-simd4.json
```

This command was subsequently executed and returned
`BLOCKED_UNRESOLVED_FIDELITY_FAILURE`. The delay-one proposal deliberately has
`decoder_options_consumed:false`: a source-only proposal must not pretend
the setting was applied. Populate that field only from an actual recorded
decoder-open result. Even with consumption established, the helper reports a
new configuration requiring separate qualification.

## Separate validation scope

`test_failure_guard.py` contains separate synthetic integrity/admission tests
for clean-retry suppression, changed adapter and input identities, explicit
default options, meaningful changed settings, unconsumed options, malformed
identity, changed binary, and modified ledger bytes/chain. They are not part
of the prior 22-test result. Their later 12-test result is retained separately;
the frozen failure snapshot was not revised to pretend those tests had run
before it was created.
