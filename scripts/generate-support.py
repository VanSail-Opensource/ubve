#!/usr/bin/env python3
"""Derive implementation support status from the unmodified v8 evaluator."""
import argparse, hashlib, json, pathlib, sys
ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'qualification'))
from verdict import evaluate
from failure_guard import failure_guard, load_ledger

EXPECTED_EVALUATOR = 'af9b96bc98643e7d70e1d4c9eb1cda4163f1ee591f7fe04efba02673a353531f'

def generate():
    if hashlib.sha256((ROOT/'qualification/verdict.py').read_bytes()).hexdigest() != EXPECTED_EVALUATOR:
        raise ValueError('Authoritative v8 evaluator differs from its pinned source')
    ledger = load_ledger()
    blocked = failure_guard(json.loads((ROOT/'qualification/failure-ledger/candidate-default-simd4.json').read_text()), ledger)
    records = []
    for path in sorted((ROOT/'qualification/implementation-records').glob('*.json')):
        raw = json.loads(path.read_text()); verdict = evaluate(raw)
        # A claimed pass also needs auditable existing raw files; syntax alone is insufficient.
        if verdict['status'].startswith('PASS_'):
            evidence = raw.get('raw_evidence_path')
            if not isinstance(evidence, str) or not (ROOT/evidence).is_file():
                verdict = {**verdict, 'status':'INCOMPLETE_EVIDENCE', 'missing_or_inadequate_evidence':[*verdict.get('missing_or_inadequate_evidence',[]), 'Raw evidence artifact is absent']}
        records.append({'record': str(path.relative_to(ROOT)), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'implementationStatus':raw.get('implementation_status'), **verdict})
    return {
        'schema':'ubve-support-v1', 'authoritySha256':EXPECTED_EVALUATOR,
        'status':'NOT_QUALIFIED', 'qualifiedProfiles':[],
        'candidateVerdicts':records, 'retainedFailureGuard':blocked,
        'releaseReady':False,
        'releaseBlockers':[
            'I06 complete browser pipeline has no executed implementation record',
            'I11 paired complete-pipeline improvement and sustained targets remain unmeasured',
            'Native/GPU/physical output remains deferred, never passed',
            'Exact distributed codec corresponding-source and license audit is incomplete',
            'I10 large-index integration and actual disc title playback remain incomplete',
        ],
        'refusedOrUnavailable':[
            {'feature':'dav1d default SIMD/four-thread route','reason':'Retained unresolved pixel mismatches'},
            {'feature':'Managed full HDR output','reason':'Canvas SDR transform cannot preserve full HDR output'},
            {'feature':'Encrypted/remote ISO, menus, BD-J','reason':'Outside the read-only local disc profile'},
            {'feature':'Atmos/object-audio rendering, Dolby Vision, N3 dual-clock output','reason':'No admitted implementation/reference'},
            {'feature':'Large MP4 metadata beyond preflight cap','reason':'Paged primitives are not yet connected to the demux path'},
        ],
        'scope':'Candidate implementation and evidence status only; API probes and short/component tests do not admit a production profile',
    }

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--require-release',action='store_true');args=parser.parse_args()
    report=generate(); data=json.dumps(report,indent=2)+'\n'
    for target in ['evidence/support-status.json','apps/vue-player/public/support-status.json']:
        path=ROOT/target;path.parent.mkdir(parents=True,exist_ok=True);path.write_text(data)
    print(f"Support assessment: {report['status']}; {len(report['qualifiedProfiles'])} qualified profiles; retained failures remain blocked.")
    if args.require_release and not report['releaseReady']:
        print('Deployment condition is not satisfied.',file=sys.stderr);return 1
    return 0
if __name__=='__main__':raise SystemExit(main())
