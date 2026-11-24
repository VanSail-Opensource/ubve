#!/usr/bin/env python3
"""Fail-closed evaluator for exact-configuration qualification records.

This validates completeness and declared numerical evidence. It cannot prove
that supplied measurements are truthful; signed/frozen provenance and review
remain required. Missing evidence is never changed into a measured zero.
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

MODES = {"full-60": 60, "performance-120": 120}
PLATFORMS = {"windows", "macos", "ios", "ipados", "android"}
FULL_FIDELITY = ["source_precision", "source_resolution", "no_temporal_reduction", "hdr10_metadata_preserved",
                 "pq_bt2020_output_mapping", "ten_bit_samples_preserved",
                 "truehd_decoder_pcm_exact", "subtitle_semantics_and_fonts", "timeline_and_channels"]
PERFORMANCE_FIDELITY = ["no_temporal_reduction", "declared_transform_reference", "truehd_decoder_pcm_exact",
                        "subtitle_content_and_timing", "timeline_and_channels"]

def finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)

def evaluate(record):
    if not isinstance(record, dict):
        return {"case_id": None, "status": "INCOMPLETE_EVIDENCE", "failures": [],
                "missing_or_inadequate_evidence": ["Record must be an object"],
                "claim_scope": "exact fixture/environment/route/output only"}
    incomplete, failures = [], []
    def result(status):
        return {"case_id": record.get("case_id"), "status": status, "failures": failures,
                "missing_or_inadequate_evidence": incomplete, "claim_scope": "exact fixture/environment/route/output only"}

    if record.get("validity") == "invalid-combination":
        return result("INVALID_COMBINATION")
    if record.get("support") == "unsupported":
        return result("UNSUPPORTED_CONFIGURATION")
    if "trials" in record and not isinstance(record["trials"], list):
        incomplete.append("trials must be an array")
        return result("INCOMPLETE_EVIDENCE")
    if record.get("execution_policy") == "deferred-native-gpu-by-user" and not record.get("trials"):
        return result("DEFERRED_NOT_QUALIFIED")
    if not record.get("trials"):
        return result("UNTESTED")
    if record.get("evidence_class") not in {"browser-full-pipeline", "physical-full-pipeline"}:
        incomplete.append("A component, decode-only, Node, parser or rAF benchmark cannot qualify full playback.")
    if record.get("mode") not in MODES:
        incomplete.append("mode must be full-60 or performance-120")
        return result("INCOMPLETE_EVIDENCE")
    target = MODES[record["mode"]]
    if record.get("validity") != "conformance-verified":
        incomplete.append("Exact codec levels, mappings, metadata and fixture validity not verified.")
    if record.get("platform") not in PLATFORMS:
        incomplete.append("Exact platform family is required; missing mobile identity cannot select a shorter desktop duration.")
    for name in ["case_id", "fixture_sha256", "harness_sha256", "module_manifest_sha256", "browser_build", "os_build", "device",
                 "route", "output_description", "raw_evidence_path"]:
        if not isinstance(record.get(name), str) or not record[name].strip():
            incomplete.append(f"Missing {name}")
    for name in ["fixture_sha256", "harness_sha256", "module_manifest_sha256"]:
        value = record.get(name, "")
        if not isinstance(value, str) or len(value) != 64 or any(c not in "0123456789abcdef" for c in value):
            incomplete.append(f"{name} is not a lowercase SHA-256")
    if record.get("measurement_provenance") == "synthetic":
        incomplete.append("Synthetic evaluator examples do not constitute device measurements.")
    source_fps = record.get("source_fps")
    if not isinstance(source_fps, dict) or any(type(source_fps.get(k)) is not int for k in ("num", "den")) or source_fps != {"num": target, "den": 1}:
        incomplete.append("Strict target needs a genuine 60fps or 120fps 1x source; cadence tests are separate.")
    if not finite(record.get("playback_rate")) or record["playback_rate"] != 1:
        failures.append("Speeding up playback is not this real-time playback gate.")
    if record.get("counting_basis") != "unique-source-pictures-with-deadlines":
        incomplete.append("Frame counts must exclude repeats, interpolation, animation callbacks and decode-only output.")
    required_fidelity = FULL_FIDELITY if record["mode"] == "full-60" else PERFORMANCE_FIDELITY
    checks = record.get("fidelity_checks", {})
    if not isinstance(checks, dict):
        incomplete.append("fidelity_checks must be an object")
        checks = {}
    for name in required_fidelity:
        if checks.get(name) is False:
            failures.append(f"Fidelity failed: {name}")
        elif checks.get(name) is not True:
            incomplete.append(f"Fidelity unverified: {name}")
    optional_features = record.get("optional_features", [])
    if not isinstance(optional_features, list) or any(not isinstance(feature, str) for feature in optional_features):
        incomplete.append("optional_features must be an array of strings")
        optional_features = []
    if "dolby-vision" in optional_features:
        if checks.get("dolby_vision_rendered") is False:
            failures.append("Optional Dolby Vision claim failed its rendering reference.")
        elif checks.get("dolby_vision_rendered") is not True:
            incomplete.append("Optional Dolby Vision claim needs its own rendering reference.")
    transform = record.get("declared_performance_transform")
    if record["mode"] == "performance-120" and (not isinstance(transform, str) or not transform.strip()):
        incomplete.append("Performance mode must identify its exact accepted quality reduction.")
    if len(record["trials"]) < 5:
        incomplete.append("Fewer than five independent sustained trials.")
    required_duration = 3600 if record.get("platform") in {"ios", "ipados", "android"} else 1800
    trial_ids = set()
    for i, trial in enumerate(record["trials"]):
        prefix = f"trial[{i}]"
        if not isinstance(trial, dict):
            incomplete.append(f"{prefix}: trial must be an object")
            continue
        trial_id = trial.get("trial_id")
        if not isinstance(trial_id, str) or not trial_id.strip():
            incomplete.append(f"{prefix}: unique trial_id missing")
        elif trial_id in trial_ids:
            incomplete.append(f"{prefix}: duplicate trial_id cannot count as an independent run")
        else:
            trial_ids.add(trial_id)
        numeric = ["active_seconds", "eligible_source_frames", "unique_on_time_frames", "late_frames", "dropped_frames",
                   "audio_underrun_samples", "max_freeze_ms", "final_window_fps"]
        if any(not finite(trial.get(k)) or trial[k] < 0 for k in numeric):
            incomplete.append(f"{prefix}: missing, nonfinite or negative required measurements")
            continue
        for name in ["eligible_source_frames", "unique_on_time_frames", "late_frames", "dropped_frames", "audio_underrun_samples"]:
            if not isinstance(trial[name], int) or isinstance(trial[name], bool):
                incomplete.append(f"{prefix}: {name} must be an integer count")
        duration = trial["active_seconds"]
        if duration < required_duration:
            incomplete.append(f"{prefix}: requires {required_duration}s active steady state")
        if duration <= 0:
            continue
        if abs(trial["eligible_source_frames"] - duration * target) > 1e-7:
            incomplete.append(f"{prefix}: eligible-count/timeline denominator inconsistent for strict CFR target")
        if trial["unique_on_time_frames"] > trial["eligible_source_frames"]:
            failures.append(f"{prefix}: unique frames exceed source opportunities")
        if trial["unique_on_time_frames"] != trial["eligible_source_frames"] or trial["late_frames"] or trial["dropped_frames"]:
            failures.append(f"{prefix}: strict target lost or delayed eligible source pictures")
        if trial["unique_on_time_frames"] / duration + 1e-9 < target:
            failures.append(f"{prefix}: unique on-time rate below {target}fps")
        if trial["final_window_fps"] + 1e-9 < target:
            failures.append(f"{prefix}: final steady-state window below {target}fps")
        if trial["final_window_fps"] > target + 1e-9:
            incomplete.append(f"{prefix}: final-window unique-picture rate exceeds this 1x CFR source")
        if trial["audio_underrun_samples"] != 0:
            failures.append(f"{prefix}: audio underrun")
        if trial["max_freeze_ms"] > 2000 / target:
            failures.append(f"{prefix}: freeze longer than two source intervals")
        if trial.get("memory_within_admitted_budget") is False:
            failures.append(f"{prefix}: memory budget exceeded")
        elif trial.get("memory_within_admitted_budget") is not True:
            incomplete.append(f"{prefix}: memory budget unverified")
        if trial.get("foreground_continuously") is not True:
            incomplete.append(f"{prefix}: foreground continuity unverified")
        if record.get("evidence_class") == "physical-full-pipeline":
            for key, maximum in [("av_sync_p95_ms", 20), ("av_sync_max_ms", 50)]:
                if not finite(trial.get(key)) or trial[key] < 0:
                    incomplete.append(f"{prefix}: missing physical {key}")
                elif trial[key] > maximum:
                    failures.append(f"{prefix}: {key} exceeded {maximum}ms")
            if finite(trial.get("av_sync_p95_ms")) and finite(trial.get("av_sync_max_ms")) and trial["av_sync_p95_ms"] > trial["av_sync_max_ms"]:
                incomplete.append(f"{prefix}: A/V sync percentile exceeds reported maximum")
    if failures:
        return result("FAILED")
    if incomplete:
        return result("INCOMPLETE_EVIDENCE")
    if record.get("evidence_class") != "physical-full-pipeline":
        return result("PASS_PIPELINE_ONLY")
    if record.get("physical_output_verified") is not True:
        incomplete.append("Physical HDR, audio layout and subtitle output route are not verified.")
        return result("INCOMPLETE_EVIDENCE")
    if not finite(record.get("display_refresh_hz")) or record["display_refresh_hz"] + 1e-9 < target:
        failures.append("Actual active display refresh is below the required unique frame rate or unmeasured.")
        return result("FAILED")
    return result("PASS_EXACT_CONFIGURATION")

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("record", type=Path)
    args = parser.parse_args()
    print(json.dumps(evaluate(json.loads(args.record.read_text())), indent=2))

if __name__ == "__main__":
    main()
