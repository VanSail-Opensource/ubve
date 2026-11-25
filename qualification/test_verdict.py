"""Synthetic regression tests for false-pass risks; not media measurements."""
import copy
import math
import unittest
from verdict import evaluate, FULL_FIDELITY, PERFORMANCE_FIDELITY

def synthetic_record():
    record = {
        "case_id": "SYNTHETIC_EVALUATOR_TEST_ONLY", "mode": "full-60", "evidence_class": "physical-full-pipeline",
        "validity": "conformance-verified", "platform": "windows", "source_fps": {"num": 60, "den": 1},
        "playback_rate": 1, "counting_basis": "unique-source-pictures-with-deadlines", "display_refresh_hz": 60,
        "physical_output_verified": True, "fidelity_checks": {k: True for k in FULL_FIDELITY}, "trials": []
    }
    for field in ["fixture_sha256", "harness_sha256", "module_manifest_sha256"]:
        record[field] = "0" * 64
    for field in ["browser_build", "os_build", "device", "route", "output_description", "raw_evidence_path"]:
        record[field] = "SYNTHETIC_EVALUATOR_TEST_ONLY"
    for i in range(5):
        record["trials"].append({"trial_id": f"synthetic-trial-{i}", "active_seconds": 1800, "eligible_source_frames": 108000, "unique_on_time_frames": 108000,
            "late_frames": 0, "dropped_frames": 0, "audio_underrun_samples": 0, "max_freeze_ms": 16.667,
            "final_window_fps": 60, "memory_within_admitted_budget": True, "foreground_continuously": True,
            "av_sync_p95_ms": 0, "av_sync_max_ms": 0})
    return record

class FalsePassRisks(unittest.TestCase):
    def test_no_execution_is_not_passed(self):
        self.assertEqual(evaluate({"trials": []})["status"], "UNTESTED")

    def test_deferred_native_is_not_passed(self):
        self.assertEqual(evaluate({"execution_policy": "deferred-native-gpu-by-user", "trials": []})["status"], "DEFERRED_NOT_QUALIFIED")

    def test_synthetic_positive_control(self):
        self.assertEqual(evaluate(synthetic_record())["status"], "PASS_EXACT_CONFIGURATION")

    def test_component_fps_is_not_playback(self):
        record = synthetic_record()
        record["evidence_class"] = "node-component"
        self.assertEqual(evaluate(record)["status"], "INCOMPLETE_EVIDENCE")

    def test_repeats_are_not_unique_pictures(self):
        record = synthetic_record()
        record["counting_basis"] = "requestAnimationFrame-callbacks"
        self.assertEqual(evaluate(record)["status"], "INCOMPLETE_EVIDENCE")

    def test_one_failed_trial_is_not_hidden_by_median(self):
        record = synthetic_record()
        record["trials"][0]["audio_underrun_samples"] = 4768
        self.assertEqual(evaluate(record)["status"], "FAILED")

    def test_hdr10_metadata_detection_is_not_rendering(self):
        record = synthetic_record()
        record["fidelity_checks"]["pq_bt2020_output_mapping"] = None
        self.assertEqual(evaluate(record)["status"], "INCOMPLETE_EVIDENCE")

    def test_optional_dolby_does_not_block_primary_hdr10(self):
        record = synthetic_record()
        record["fidelity_checks"]["dolby_vision_rendered"] = None
        self.assertEqual(evaluate(record)["status"], "PASS_EXACT_CONFIGURATION")
        record["optional_features"] = ["dolby-vision"]
        self.assertEqual(evaluate(record)["status"], "INCOMPLETE_EVIDENCE")

    def test_missing_and_nan_do_not_become_zero(self):
        record = synthetic_record()
        record["trials"][0]["late_frames"] = math.nan
        self.assertEqual(evaluate(record)["status"], "INCOMPLETE_EVIDENCE")

    def test_headless_pipeline_does_not_prove_output(self):
        record = synthetic_record()
        record["evidence_class"] = "browser-full-pipeline"
        self.assertEqual(evaluate(record)["status"], "PASS_PIPELINE_ONLY")

    def test_sixty_hz_output_cannot_qualify_one_twenty(self):
        record = synthetic_record()
        record["display_refresh_hz"] = 30
        self.assertEqual(evaluate(record)["status"], "FAILED")

    def test_bitrate_target_requires_actual_valid_fixture(self):
        record = synthetic_record()
        record["validity"] = "unverified"
        self.assertEqual(evaluate(record)["status"], "INCOMPLETE_EVIDENCE")

    def test_insufficient_mobile_duration(self):
        record = synthetic_record()
        record["platform"] = "ios"
        self.assertEqual(evaluate(record)["status"], "INCOMPLETE_EVIDENCE")

    def test_missing_platform_cannot_select_desktop_duration(self):
        record = synthetic_record()
        del record["platform"]
        self.assertEqual(evaluate(record)["status"], "INCOMPLETE_EVIDENCE")

    def test_duplicate_trials_do_not_count_as_independent(self):
        record = synthetic_record()
        record["trials"][4]["trial_id"] = record["trials"][0]["trial_id"]
        self.assertEqual(evaluate(record)["status"], "INCOMPLETE_EVIDENCE")

    def test_boolean_is_not_measured_playback_rate(self):
        record = synthetic_record()
        record["playback_rate"] = True
        self.assertEqual(evaluate(record)["status"], "FAILED")

    def test_malformed_record_does_not_crash_or_pass(self):
        self.assertEqual(evaluate([])["status"], "INCOMPLETE_EVIDENCE")
        self.assertEqual(evaluate({"trials": "five"})["status"], "INCOMPLETE_EVIDENCE")
        record = synthetic_record()
        record["trials"][0] = None
        self.assertEqual(evaluate(record)["status"], "INCOMPLETE_EVIDENCE")

    def test_decode_speed_cannot_replace_final_unique_frame_rate(self):
        record = synthetic_record()
        record["trials"][0]["final_window_fps"] = 180
        self.assertEqual(evaluate(record)["status"], "INCOMPLETE_EVIDENCE")

    def test_inconsistent_sync_summary_is_not_qualified(self):
        record = synthetic_record()
        record["trials"][0].update({"av_sync_p95_ms": 20, "av_sync_max_ms": 10})
        self.assertEqual(evaluate(record)["status"], "INCOMPLETE_EVIDENCE")

    def test_boolean_fps_denominator_is_not_integer_evidence(self):
        record = synthetic_record()
        record["source_fps"]["den"] = True
        self.assertEqual(evaluate(record)["status"], "INCOMPLETE_EVIDENCE")

    def test_missing_case_identity_is_not_qualified(self):
        record = synthetic_record()
        del record["case_id"]
        self.assertEqual(evaluate(record)["status"], "INCOMPLETE_EVIDENCE")

    def test_performance_transform_must_be_named(self):
        record = synthetic_record()
        record.update({"mode":"performance-120", "source_fps":{"num":120,"den":1},
                       "display_refresh_hz":120, "declared_performance_transform":True,
                       "fidelity_checks":{k:True for k in PERFORMANCE_FIDELITY}})
        for trial in record["trials"]:
            trial.update({"eligible_source_frames":216000,"unique_on_time_frames":216000,
                          "final_window_fps":120,"max_freeze_ms":8})
        self.assertEqual(evaluate(record)["status"], "INCOMPLETE_EVIDENCE")

if __name__ == "__main__":
    unittest.main()
