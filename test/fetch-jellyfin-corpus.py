#!/usr/bin/env python3
"""Download original Jellyfin public test videos and require the mirror's SHA-256.

No media is redistributed by this repository. Downloads and manifests go to the
chosen local directory. Inputs come from the named Jellyfin mirror, not output
from FFmpeg or the system under test.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
from hashlib import file_digest
import json
from pathlib import Path
import re
import subprocess
from urllib.parse import quote

MIRROR = 'https://syd1.mirror.jellyfin.org/test-videos/'
LOCK = json.loads((Path(__file__).parent / 'fixtures/jellyfin-corpus.json').read_text(encoding='utf-8'))
FIXTURES = {row['id']: row for row in LOCK['cases']}


def digest(path):
    with path.open('rb') as source:
        return file_digest(source, 'sha256').hexdigest()


def fetch(root, fixture_id):
    row = FIXTURES[fixture_id]
    relative = row['path']
    url = MIRROR + quote(relative)
    sha, length = row['sha256'], row['bytes']
    relative_path = Path(relative)
    if relative_path.is_absolute() or '..' in relative_path.parts or row['sourceUrl'] != url or row['checksumUrl'] != url + '.sha256sum':
        raise RuntimeError(f'{fixture_id}: invalid local fixture lock')
    curl = ['curl', '--fail', '--silent', '--show-error', '--location', '--proto', '=https', '--proto-redir', '=https',
            '--connect-timeout', '15', '--retry', '2', '--retry-max-time', '60']
    filename = root / relative_path
    filename.parent.mkdir(parents=True, exist_ok=True)
    if not filename.is_file() or filename.stat().st_size != length or digest(filename) != sha:
        raw = subprocess.check_output([*curl, '--max-time', '30', '--max-filesize', '16384', row['checksumUrl']])
        expected = re.match(rb'^\s*([a-fA-F0-9]{64})(?:\s|$)', raw)
        if not expected or expected[1].decode().lower() != sha:
            raise RuntimeError(f'{fixture_id}: the mirror checksum does not match the pinned fixture')
        partial = filename.with_suffix('.part')
        try:
            subprocess.run([*curl, '--max-time', '180', '--max-filesize', str(length), '--output', str(partial), url], check=True)
            if partial.stat().st_size != length or digest(partial) != sha:
                raise RuntimeError(f'{fixture_id}: downloaded bytes do not match the mirror SHA-256')
            partial.replace(filename)
        finally:
            partial.unlink(missing_ok=True)
    print(f"{fixture_id}: {row['bytes']} bytes, SHA-256 verified", flush=True)
    return row


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', required=True, type=Path)
    parser.add_argument('--case', action='append', choices=FIXTURES, help='repeat to select a subset (default: all)')
    parser.add_argument('--jobs', type=int, default=3, choices=range(1, 5))
    args = parser.parse_args()
    cases = list(dict.fromkeys(args.case or FIXTURES))
    args.out.mkdir(parents=True, exist_ok=True)
    with ThreadPoolExecutor(max_workers=args.jobs) as pool:
        results = list(pool.map(lambda fixture_id: fetch(args.out, fixture_id), cases))
    data = {**LOCK, 'cases': results}
    temporary = args.out / 'manifest.json.part'
    temporary.write_text(json.dumps(data, indent=2) + '\n', encoding='utf-8')
    temporary.replace(args.out / 'manifest.json')


if __name__ == '__main__':
    main()
