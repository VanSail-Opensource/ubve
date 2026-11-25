"""SOURCE-ONLY new tests; not included in the retained 22 verdict tests.

Run only after the root releases the current reserved measurement window.
All candidate variations are synthetic logic checks, never decoder trials.
"""
import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from failure_guard import load_ledger, failure_guard, canonical


class FailureHistoryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.ledger = load_ledger()
        cls.candidate = json.loads((Path(__file__).parent / "failure-ledger/candidate-default-simd4.json").read_text())

    def run_candidate(self, **changes):
        candidate = copy.deepcopy(self.candidate)
        candidate.update(changes)
        return failure_guard(candidate, self.ledger)

    def test_unchanged_route_retains_all_three_failures(self):
        result = self.run_candidate()
        self.assertEqual(result["status"], "BLOCKED_UNRESOLVED_FIDELITY_FAILURE")
        self.assertEqual(len(result["blocking_event_sha256"]), 3)
        self.assertFalse(result["admitted"])

    def test_clean_retry_cannot_erase_retained_failure(self):
        result = self.run_candidate(current_trial_status="passed", proposed_verdict="PASS_EXACT_CONFIGURATION")
        self.assertEqual(result["status"], "BLOCKED_UNRESOLVED_FIDELITY_FAILURE")

    def test_adapter_rehash_is_not_a_decoder_repair(self):
        result = self.run_candidate(adapter_cohort_sha256="a" * 64)
        self.assertEqual(result["status"], "BLOCKED_UNRESOLVED_FIDELITY_FAILURE")
        self.assertEqual(result["exact_adapter_failure_event_sha256"], [])

    def test_different_input_does_not_clear_route_defect(self):
        result = self.run_candidate(fixture_sha256="b" * 64)
        self.assertEqual(result["status"], "BLOCKED_UNRESOLVED_FIDELITY_FAILURE")
        self.assertEqual(result["exact_fixture_failure_event_sha256"], [])

    def test_explicit_default_option_keeps_same_route(self):
        result = self.run_candidate(decoder_options={"max_frame_delay": "0"}, decoder_options_consumed=True)
        self.assertEqual(result["status"], "BLOCKED_UNRESOLVED_FIDELITY_FAILURE")

    def test_delay_one_is_unqualified_new_configuration(self):
        result = self.run_candidate(decoder_options={"max_frame_delay": 1}, decoder_options_consumed=True)
        self.assertEqual(result["status"], "NEW_CONFIGURATION_REQUIRES_SEPARATE_QUALIFICATION")
        self.assertFalse(result["admitted"])
        self.assertEqual(len(result["related_failure_event_sha256"]), 3)

    def test_unconsumed_setting_is_incomplete(self):
        with self.assertRaises(ValueError):
            self.run_candidate(decoder_options={"max_frame_delay": 1}, decoder_options_consumed=False)

    def test_new_binary_cannot_inherit_pass(self):
        result = self.run_candidate(binary_sha256="c" * 64)
        self.assertEqual(result["status"], "NEW_CONFIGURATION_REQUIRES_SEPARATE_QUALIFICATION")
        self.assertFalse(result["full_playback_qualified"])

    def test_missing_option_identity_is_not_defaulted(self):
        candidate = copy.deepcopy(self.candidate)
        del candidate["decoder_options"]
        with self.assertRaises(ValueError):
            failure_guard(candidate, self.ledger)

    def test_boolean_thread_count_is_not_integer(self):
        with self.assertRaises(ValueError):
            self.run_candidate(threads=True)

    def test_modified_snapshot_fails_external_pin(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "changed.json"
            path.write_text(json.dumps(self.ledger) + "\n")
            with self.assertRaises(ValueError):
                load_ledger(path)

    def test_changed_event_fails_chain_even_with_new_file_pin(self):
        changed = copy.deepcopy(self.ledger)
        changed["events"][0]["actual_sha256"] = "d" * 64
        del changed["payload_sha256"]
        changed["payload_sha256"] = hashlib.sha256(canonical(changed)).hexdigest()
        raw = json.dumps(changed).encode()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "changed.json"
            path.write_bytes(raw)
            with self.assertRaises(ValueError):
                load_ledger(path, hashlib.sha256(raw).hexdigest())


if __name__ == "__main__":
    unittest.main()
