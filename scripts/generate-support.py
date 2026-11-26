#!/usr/bin/env python3
"""Derive implementation support status from the unmodified v8 evaluator."""
import argparse, hashlib, json, pathlib, re, sys
ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'qualification'))
from verdict import evaluate
from failure_guard import failure_guard, load_ledger

EXPECTED_EVALUATOR = 'af9b96bc98643e7d70e1d4c9eb1cda4163f1ee591f7fe04efba02673a353531f'

def evaluated_with_artifact(raw, root):
    """A passing evaluator result is not enough without immutable raw bytes.

    Digest verification is an artifact-integrity check, not validation of any
    numbers or physical measurement in an otherwise passing record.
    """
    verdict = evaluate(raw)
    if verdict['status'] not in {'PASS_PIPELINE_ONLY', 'PASS_EXACT_CONFIGURATION'}:
        return verdict
    raw_path = raw.get('raw_evidence_path')
    expected = raw.get('raw_evidence_sha256')
    errors = []
    if not isinstance(expected, str) or re.fullmatch(r'[0-9a-f]{64}', expected) is None:
        errors.append('Missing or invalid raw evidence SHA-256')
    root = root.resolve()
    relative = pathlib.PurePosixPath(raw_path) if isinstance(raw_path, str) and raw_path else None
    if relative is None or relative.is_absolute() or '..' in relative.parts or '\\' in raw_path or '\x00' in raw_path:
        errors.append('Raw evidence path must be inside the repository')
    found = None
    if not errors:
        try:
            artifact = (root / relative).resolve(strict=True)
            artifact.relative_to(root)
            if not artifact.is_file() or artifact.stat().st_size == 0:
                errors.append('Raw evidence artifact is not a nonempty file')
            else:
                with artifact.open('rb') as data:
                    actual = hashlib.file_digest(data, 'sha256').hexdigest()
                if actual != expected:
                    errors.append('Raw evidence SHA-256 mismatch')
                else:
                    found = {'path': relative.as_posix(), 'sha256': actual, 'bytes': artifact.stat().st_size}
        except ValueError:
            errors.append('Raw evidence path must be inside the repository')
        except (OSError, RuntimeError):
            errors.append('Raw evidence artifact is absent or unreadable')
    if errors:
        return {**verdict, 'status': 'INCOMPLETE_EVIDENCE',
                'missing_or_inadequate_evidence': [*verdict.get('missing_or_inadequate_evidence', []), *errors]}
    return {**verdict, 'rawArtifact': found}

def generate():
    if hashlib.sha256((ROOT/'qualification/verdict.py').read_bytes()).hexdigest() != EXPECTED_EVALUATOR:
        raise ValueError('Authoritative v8 evaluator differs from its pinned source')
    ledger = load_ledger()
    blocked = failure_guard(json.loads((ROOT/'qualification/failure-ledger/candidate-default-simd4.json').read_text()), ledger)
    records = []
    for path in sorted((ROOT/'qualification/implementation-records').glob('*.json')):
        data = path.read_bytes(); raw = json.loads(data); verdict = evaluated_with_artifact(raw, ROOT)
        records.append({'record': str(path.relative_to(ROOT)), 'sha256': hashlib.sha256(data).hexdigest(),
                        'implementationStatus':raw.get('implementation_status') if isinstance(raw, dict) else None, **verdict})
    return {
        'schema':'ubve-support-v1', 'authoritySha256':EXPECTED_EVALUATOR,
        'status':'NOT_QUALIFIED', 'qualifiedProfiles':[],
        'candidateVerdicts':records, 'retainedFailureGuard':blocked,
        'releaseReady':False,
        'releaseBlockers':[
            'I06 short integrated browser cases completed but include late or dropped pictures; no sustained 60/120 configuration passed',
            'I11 scoped CPU/raster results do not qualify any complete player route',
            'Native MSE short screening does not verify GPU acceleration, target devices or physical output',
            'Exact distributed corresponding-source review and complete notices remain incomplete',
            'I10 exact large MP4 index and disc title components are not wired to complete playback',
        ],
        'refusedOrUnavailable':[
            {'feature':'dav1d default SIMD/four-thread route','reason':'Retained unresolved pixel mismatches'},
            {'feature':'Qualified managed full HDR output','reason':'Canvas SDR is not full HDR, and the explicit WebGPU candidate is unqualified'},
            {'feature':'Encrypted/remote ISO, menus, BD-J','reason':'Outside the read-only local disc profile'},
            {'feature':'Atmos/object-audio rendering, Dolby Vision, N3 dual-clock output','reason':'No admitted implementation/reference'},
            {'feature':'Large MP4 metadata beyond preflight cap','reason':'Paged primitives are not yet connected to the demux path'},
        ],
        'scope':'Candidate implementation and evidence status only; API probes and short/component tests do not admit a production profile',
    }

def main():
    argparse.ArgumentParser(description=__doc__).parse_args()
    report=generate(); data=json.dumps(report,indent=2)+'\n'
    for target in ['evidence/support-status.json','apps/vue-player/public/support-status.json']:
        path=ROOT/target;path.parent.mkdir(parents=True,exist_ok=True);path.write_text(data)
    print(f"Support assessment: {report['status']}; {len(report['qualifiedProfiles'])} qualified profiles; retained failures remain blocked.")
    return 0
if __name__=='__main__':raise SystemExit(main())
