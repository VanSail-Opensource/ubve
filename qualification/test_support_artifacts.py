"""Synthetic regression checks for release evidence binding, not measurements."""
import hashlib
import importlib.util
from pathlib import Path
import tempfile
import unittest

from test_verdict import synthetic_record

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts' / 'generate-support.py'
SPEC = importlib.util.spec_from_file_location('generate_support', SCRIPT)
SUPPORT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SUPPORT)


class RawEvidenceBinding(unittest.TestCase):
    def setUp(self):
        mount = tempfile.TemporaryDirectory()
        self.addCleanup(mount.cleanup)
        self.mounted = Path(mount.name)
        self.root = self.mounted / 'repo'
        self.root.mkdir()
        self.record = synthetic_record()
        self.data = b'synthetic test only\n'
        self.record['raw_evidence_path'] = 'evidence.json'
        self.record['raw_evidence_sha256'] = hashlib.sha256(self.data).hexdigest()

    def check(self, raw=None):
        return SUPPORT.evaluated_with_artifact(self.record if raw is None else raw, self.root)

    def expect_block(self, message):
        result = self.check()
        self.assertEqual(result['status'], 'INCOMPLETE_EVIDENCE')
        self.assertIn(message, result['missing_or_inadequate_evidence'])
        self.assertNotIn('rawArtifact', result)

    def test_present_file_without_digest_does_not_pass(self):
        (self.root / 'evidence.json').write_bytes(self.data)
        del self.record['raw_evidence_sha256']
        self.expect_block('Missing or invalid raw evidence SHA-256')

    def test_missing_file_does_not_pass(self):
        self.expect_block('Raw evidence artifact is absent or unreadable')

    def test_mutated_file_does_not_pass(self):
        (self.root / 'evidence.json').write_bytes(self.data + b'modified')
        self.expect_block('Raw evidence SHA-256 mismatch')

    def test_empty_file_is_not_evidence_even_with_matching_digest(self):
        (self.root / 'evidence.json').touch()
        self.record['raw_evidence_sha256'] = hashlib.sha256(b'').hexdigest()
        self.expect_block('Raw evidence artifact is not a nonempty file')

    def test_path_traversal_does_not_pass(self):
        (self.mounted / 'evidence.json').write_bytes(self.data)
        self.record['raw_evidence_path'] = '../evidence.json'
        self.expect_block('Raw evidence path must be inside the repository')

    def test_absolute_paths_do_not_pass(self):
        (self.root / 'evidence.json').write_bytes(self.data)
        self.record['raw_evidence_path'] = str(self.root / 'evidence.json')
        self.expect_block('Raw evidence path must be inside the repository')

    def test_symlink_escape_does_not_pass(self):
        outside = self.mounted / 'evidence.json'
        outside.write_bytes(self.data)
        (self.root / 'evidence.json').symlink_to(outside)
        self.expect_block('Raw evidence path must be inside the repository')

    def test_matching_file_does_not_modify_evaluator_classification(self):
        (self.root / 'evidence.json').write_bytes(self.data)
        exact = self.check()
        self.assertEqual(exact['status'], 'PASS_EXACT_CONFIGURATION')
        self.assertEqual(exact['rawArtifact']['bytes'], len(self.data))
        self.record['evidence_class'] = 'browser-full-pipeline'
        self.assertEqual(self.check()['status'], 'PASS_PIPELINE_ONLY')

    def test_measured_failures_and_deferrals_are_never_promoted(self):
        (self.root / 'evidence.json').write_bytes(self.data)
        self.record['trials'][0]['dropped_frames'] = 1
        self.assertEqual(self.check()['status'], 'FAILED')
        self.assertEqual(self.check({'execution_policy': 'deferred-native-gpu-by-user', 'trials': []})['status'], 'DEFERRED_NOT_QUALIFIED')
