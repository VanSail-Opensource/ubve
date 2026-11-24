#!/usr/bin/env bash
# Generate a clear two-clip BDMV fixture. This is build/fixture tooling only.
set -euo pipefail
if [[ $# -ne 2 ]]; then
  echo 'Usage: bash reproduce.sh /path/to/tsMuxeR /path/to/new-output-directory' >&2
  exit 2
fi
muxer=$(realpath -- "$1")
output=$(realpath -m -- "$2")
test ! -e "$output"
printf '%s  %s\n' 'e1e2caeb624876c22d1ee1cb545d4ded9da4c5138b2259f36fd236b0f67e2e47' "$muxer" | sha256sum --check --status
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
cd "$work"
ffmpeg -hide_banner -loglevel error -f lavfi -i 'smptehdbars=size=1280x720:rate=24' -frames:v 48 -an -c:v libx264 -threads:v 1 -profile:v high -level:v 4.1 -pix_fmt yuv420p -x264-params 'bluray-compat=1:vbv-maxrate=25000:vbv-bufsize=30000:keyint=12:min-keyint=12:scenecut=0:open-gop=0:repeat-headers=1' -f h264 source.h264
ffmpeg -hide_banner -loglevel error -f lavfi -i 'sine=frequency=997:sample_rate=48000:duration=2' -ac 2 -c:a ac3 -b:a 192k source.ac3
cat > fixture.meta <<'M2TS'
MUXOPT --blu-ray --vbr --split-duration=1s --custom-chapters=00:00:00.000;00:00:01.000
V_MPEG4/ISO/AVC, source.h264, fps=24, insertSEI, contSPS
A_AC3, source.ac3, lang=eng
M2TS
"$muxer" fixture.meta "$output"
