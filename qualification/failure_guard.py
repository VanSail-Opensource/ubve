#!/usr/bin/env python3
"""Join a pinned immutable failure snapshot before any qualification verdict.

SOURCE-ONLY / UNTESTED when introduced. This helper cannot issue a pass or
close a failure. The existing 22 verdict tests do not exercise this new code.
An adapter/cohort hash change alone does not clear a decoder/settings blocker.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
from pathlib import Path

DEFAULT_LEDGER = Path(__file__).parent / "failure-ledger/libmedia-default-simd4-20261124.json"
DEFAULT_LEDGER_SHA256 = "0435ad14453158b463980f18df2ee683af371178ed8a738789f981e98a43f733"
ROUTE_FIELDS = ("component", "binary_sha256", "variant", "threads", "decoder_options",
                "runtime_id", "pixel_format")
# These are the inspected libdav1d defaults; spelling and meaning are not guessed.
DEFAULT_OPTIONS = {"max_frame_delay": 0, "framethreads": 0, "tilethreads": 0,
                   "filmgrain": -1, "oppoint": -1, "alllayers": 0}


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=True, allow_nan=False).encode()


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def require_hash(value, label):
    if not isinstance(value, str) or re.fullmatch(r"[0-9a-f]{64}", value) is None:
        raise ValueError(f"{label} requires a lowercase SHA-256")
    return value


def normalized_route(value):
    if not isinstance(value, dict) or any(key not in value for key in ROUTE_FIELDS):
        raise ValueError("Exact decoder/runtime/settings identity is incomplete")
    route = {key: value[key] for key in ROUTE_FIELDS}
    for key in ("component", "variant", "runtime_id", "pixel_format"):
        if not isinstance(route[key], str) or not route[key].strip():
            raise ValueError(f"Invalid route {key}")
    require_hash(route["binary_sha256"], "binary_sha256")
    if type(route["threads"]) is not int or route["threads"] < 1:
        raise ValueError("threads must be a positive integer, not a Boolean")
    options = route["decoder_options"]
    if not isinstance(options, dict):
        raise ValueError("decoder_options must explicitly be an object, including {} for no override")
    normalized = {}
    for key, option in options.items():
        if not isinstance(key, str) or not key.strip():
            raise ValueError("Invalid decoder option name")
        if isinstance(option, bool) or option is None:
            raise ValueError("Boolean/null decoder option values are not accepted")
        if key in DEFAULT_OPTIONS:
            if isinstance(option, str) and re.fullmatch(r"[+-]?\d+", option):
                option = int(option)
            if type(option) is not int:
                raise ValueError(f"{key} requires its exact integer value")
            # Explicit default zero must not evade the no-override failure key.
            if option == DEFAULT_OPTIONS[key]:
                continue
        elif not isinstance(option, (str, int, float)):
            raise ValueError("Unsupported decoder option value shape")
        if isinstance(option, float) and not math.isfinite(option):
            raise ValueError("Nonfinite decoder option value")
        normalized[key] = option
    route["decoder_options"] = normalized
    return route


def load_ledger(path=DEFAULT_LEDGER, expected_sha256=DEFAULT_LEDGER_SHA256):
    """Verify external snapshot pin, payload hash and every chained event."""
    require_hash(expected_sha256, "expected ledger SHA-256")
    raw = Path(path).read_bytes()
    if hashlib.sha256(raw).hexdigest() != expected_sha256:
        raise ValueError("Frozen failure ledger bytes differ from the external pin")
    ledger = json.loads(raw)
    if not isinstance(ledger, dict) or ledger.get("schema") != 1:
        raise ValueError("Unknown failure ledger schema")
    payload = dict(ledger)
    supplied_payload_hash = payload.pop("payload_sha256", None)
    if digest(payload) != require_hash(supplied_payload_hash, "payload SHA-256"):
        raise ValueError("Failure ledger payload hash mismatch")
    events = ledger.get("events")
    if not isinstance(events, list) or not events or type(ledger.get("event_count")) is not int:
        raise ValueError("A nonempty frozen event sequence is required")
    if ledger["event_count"] != len(events) or ledger.get("resolutions") != []:
        raise ValueError("Changed event count or unsupported resolution records")
    previous = None
    identities = set()
    for event in events:
        if not isinstance(event, dict):
            raise ValueError("Malformed failure event")
        body = dict(event)
        event_hash = require_hash(body.pop("event_sha256", None), "event SHA-256")
        if digest(body) != event_hash or event.get("previous_event_sha256") != previous:
            raise ValueError("Failure event content or chain changed")
        if event_hash in identities or event.get("status") != "UNRESOLVED":
            raise ValueError("Duplicate or silently closed failure event")
        route = normalized_route(event.get("route_identity"))
        if digest(route) != event.get("decoder_settings_sha256"):
            raise ValueError("Failure route/settings fingerprint mismatch")
        require_hash(event.get("fixture_sha256"), "failure fixture SHA-256")
        actual = require_hash(event.get("actual_sha256"), "actual frame SHA-256")
        expected = require_hash(event.get("expected_sha256"), "expected frame SHA-256")
        if actual == expected:
            raise ValueError("A pixel mismatch event cannot contain equal hashes")
        identities.add(event_hash)
        previous = event_hash
    if previous != ledger.get("head_event_sha256"):
        raise ValueError("Failure ledger head mismatch")
    return ledger


def failure_guard(candidate, ledger):
    """Return a blocking/requalification decision; this never returns PASS."""
    route = normalized_route(candidate)
    fixture_hash = require_hash(candidate.get("fixture_sha256"), "candidate fixture SHA-256")
    adapter_hash = require_hash(candidate.get("adapter_cohort_sha256"), "candidate adapter cohort SHA-256")
    if candidate["decoder_options"] and candidate.get("decoder_options_consumed") is not True:
        raise ValueError("Nonempty decoder options require actual consumption evidence")
    key = digest(route)
    related = [event for event in ledger["events"]
               if event["route_identity"]["component"] == route["component"]]
    blocking = [event for event in related if event["decoder_settings_sha256"] == key]
    exact_adapter = [event["event_sha256"] for event in blocking
                     if event["provenance"]["adapter_cohort_sha256"] == adapter_hash]
    exact_fixture = [event["event_sha256"] for event in blocking
                     if event["fixture_sha256"] == fixture_hash]
    if blocking:
        status = "BLOCKED_UNRESOLVED_FIDELITY_FAILURE"
        reason = "Same decoder/runtime/settings have retained pixel failures; clean retries or instrumentation-only cohort changes cannot clear them."
    elif related:
        status = "NEW_CONFIGURATION_REQUIRES_SEPARATE_QUALIFICATION"
        reason = "Different decoder/runtime/settings are a separate candidate, not an inferred repair or pass. Link regression evidence and an explicit reviewed disposition."
    else:
        status = "NO_MATCHING_FAILURE_IN_THIS_SNAPSHOT_NOT_A_PASS"
        reason = "This finite failure snapshot has no matching component record; required correctness, pipeline and physical evidence remain independent obligations."
    return {"status": status, "admitted": False, "full_playback_qualified": False,
            "reason": reason, "decoder_settings_sha256": key,
            "blocking_event_sha256": [event["event_sha256"] for event in blocking],
            "exact_fixture_failure_event_sha256": exact_fixture,
            "exact_adapter_failure_event_sha256": exact_adapter,
            "related_failure_event_sha256": [event["event_sha256"] for event in related],
            "ledger_id": ledger["ledger_id"], "ledger_payload_sha256": ledger["payload_sha256"],
            "claim_scope": "Failure-history guard only; never a replacement for verdict.py or full required regression/output review"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("candidate", type=Path)
    parser.add_argument("--ledger", type=Path, default=DEFAULT_LEDGER)
    parser.add_argument("--ledger-sha256", default=DEFAULT_LEDGER_SHA256)
    args = parser.parse_args()
    try:
        candidate = json.loads(args.candidate.read_text())
        result = failure_guard(candidate, load_ledger(args.ledger, args.ledger_sha256))
    except (OSError, ValueError, TypeError, KeyError) as error:
        result = {"status": "INCOMPLETE_FAILURE_HISTORY_EVIDENCE", "admitted": False,
                  "full_playback_qualified": False, "error": str(error)}
    print(json.dumps(result, indent=2))
    return 2 if result["status"] == "INCOMPLETE_FAILURE_HISTORY_EVIDENCE" else 0


if __name__ == "__main__":
    raise SystemExit(main())
