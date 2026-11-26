#!/usr/bin/env bash
# Rebuild decoder-only assets on Linux/WSL with the pinned Emscripten SDK.
set -euo pipefail
export LC_ALL=C SOURCE_DATE_EPOCH=0
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
sdk=$(realpath "${1:?usage: bash scripts/build-software-codecs.sh EMSDK WORK_DIR}")
mkdir -p "${2:?pass a writable work directory outside the source tree}"
work=$(realpath "$2")
out="$repo/packages/wasm-adapters/runtime"
[[ "$(git -C "$sdk" rev-parse HEAD)" == d223ae73c6998296e3ab27cf81dc2c2c9fd383de ]]
set +u
source "$sdk/emsdk_env.sh"
set -u
emcc --version | head -n1 | grep -F '6.0.0 (afa15e0c56d1292e073c2c91bafc1d5e0cdf0dd3)'
cd "$work"
ffmpeg_sha=8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e
aom_sha=d2b7a1c7f4e47d058066e4d3ed50207718a5a242aa0796be9b9dc4705caa39d8
download() {
  local file=$1 url=$2 digest=$3
  if [[ ! -f "$file" ]]; then
    curl --fail --location --proto '=https' --proto-redir '=https' --retry 2 --max-time 120 -o "$file.part" "$url"
    mv -- "$file.part" "$file"
  fi
  printf '%s  %s\n' "$digest" "$file" | sha256sum --check
}
download ffmpeg-9.0.2.tar.xz https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz "$ffmpeg_sha"
download libaom-b141d9c4.tar.gz https://aomedia.googlesource.com/aom/+archive/b141d9c4.tar.gz "$aom_sha"
if [[ ! -d ffmpeg-9.0.2 ]]; then tar xf ffmpeg-9.0.2.tar.xz; fi
if [[ ! -f libaom/CMakeLists.txt ]]; then
  mkdir -p libaom
  tar xf libaom-b141d9c4.tar.gz -C libaom
fi

jobs=${UBVE_BUILD_JOBS:-6}
emcmake cmake -G Ninja -S libaom -B aom-build -DCMAKE_INSTALL_PREFIX="$work/aom" \
  -DCMAKE_BUILD_TYPE=Release -DAOM_TARGET_CPU=generic -DCONFIG_RUNTIME_CPU_DETECT=0 \
  -DCONFIG_MULTITHREAD=0 -DCONFIG_WEBM_IO=0 -DCONFIG_AV1_ENCODER=0 -DCONFIG_AV1_DECODER=1 \
  -DENABLE_DOCS=0 -DENABLE_TOOLS=0 -DENABLE_EXAMPLES=0 -DENABLE_TESTS=0
cmake --build aom-build --target install --parallel "$jobs"
mkdir -p "$out"
for kind in video audio; do
  mkdir -p "$work/$kind"
  cd "$work/$kind"
  if [[ "$kind" == video ]]; then
    codecs=h264,hevc,libaom_av1,vp8,vp9
    flags=(--enable-libaom)
    libs=("$work/aom/lib/libaom.a")
    maximum=536870912
  else
    codecs=aac,opus,vorbis,mp3float,flac,alac,pcm_s16le,pcm_s16be,pcm_s24le,pcm_s24be,pcm_f32le,pcm_f32be,ac3,eac3,dca
    flags=(--enable-swresample)
    libs=(libswresample/libswresample.a)
    maximum=67108864
  fi
  PKG_CONFIG_LIBDIR="$work/aom/lib/pkgconfig" "$work/ffmpeg-9.0.2/configure" \
    --disable-everything --disable-autodetect --disable-programs --disable-doc \
    --disable-avformat --disable-avdevice --disable-avfilter --disable-swresample --disable-swscale \
    --disable-network --disable-asm --disable-inline-asm --disable-stripping --disable-pthreads \
    --disable-w32threads --disable-os2threads --disable-shared --enable-static \
    --enable-avcodec --enable-avutil --enable-cross-compile --arch=wasm32 --target-os=none \
    --cc=emcc --cxx=em++ --ar=emar --nm="$sdk/upstream/bin/llvm-nm" --ranlib=emranlib \
    --extra-cflags="-O3 -ffile-prefix-map=$work=/ubve-codecs" --enable-decoder="$codecs" "${flags[@]}"
  # Refuse a configuration that silently omitted a named decoder or enabled a non-LGPL option.
  for decoder in ${codecs//,/ }; do
    grep -q "^#define CONFIG_${decoder^^}_DECODER 1$" config_components.h
  done
  make -j"$jobs" libavcodec/libavcodec.a libavutil/libavutil.a "${libs[@]}"
  emcc "$repo/packages/wasm-adapters/native/decode.c" -I"$work/ffmpeg-9.0.2" -I. \
    libavcodec/libavcodec.a "${libs[@]}" libavutil/libavutil.a -O3 \
    -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=web,worker,node -sFILESYSTEM=0 \
    -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY="$maximum" -sSTACK_SIZE=1048576 -sWASM_BIGINT=1 \
    -sEXPORTED_RUNTIME_METHODS=HEAPU8 \
    -sEXPORTED_FUNCTIONS=_malloc,_free,_ubve_open,_ubve_close,_ubve_packet,_ubve_send,_ubve_flush,_ubve_receive,_ubve_release,_ubve_shape,_ubve_plane,_ubve_pts,_ubve_duration \
    -o "$out/$kind.mjs"
done
cp -- "$work/ffmpeg-9.0.2/COPYING.LGPLv2.1" "$out/FFmpeg-COPYING.LGPLv2.1"
cp -- "$work/libaom/LICENSE" "$out/libaom-LICENSE"
cp -- "$work/libaom/PATENTS" "$out/libaom-PATENTS"
python3 - "$repo" "$out" <<'PY'
import hashlib
import json
from pathlib import Path
import sys

repo, out = map(Path, sys.argv[1:])
def sha(file): return hashlib.sha256(file.read_bytes()).hexdigest()
manifest = {
    'schema': 1,
    'abi': 'ubve-software-decode-v1',
    'ffmpeg': {'version': '9.0.2', 'sourceSha256': '8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e'},
    'libaom': {'revision': 'b141d9c4', 'sourceSha256': 'd2b7a1c7f4e47d058066e4d3ed50207718a5a242aa0796be9b9dc4705caa39d8'},
    'emscripten': {'version': '6.0.0', 'revision': 'afa15e0c56d1292e073c2c91bafc1d5e0cdf0dd3', 'emsdk': 'd223ae73c6998296e3ab27cf81dc2c2c9fd383de'},
    'inputs': {name: sha(repo / name) for name in ('scripts/build-software-codecs.sh', 'packages/wasm-adapters/native/decode.c')},
    'files': [{'file': f.name, 'bytes': f.stat().st_size, 'sha256': sha(f)} for f in sorted(out.iterdir()) if f.name != 'build-manifest.json'],
}
(out / 'build-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
PY
