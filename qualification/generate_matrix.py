#!/usr/bin/env python3
"""Generate proposed qualification work, never executed benchmark results.

The catalog is a finite declared support envelope. It is deliberately not a
Cartesian assertion that every codec can inhabit every container at every size.
Only Python's standard library is required.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import itertools
import json
from pathlib import Path

RESOLUTIONS = {
    "720p": [1280, 720],
    "1080p": [1920, 1080],
    "1440p": [2560, 1440],
    "2160p-uhd": [3840, 2160],
}
BOUNDARY_RESOLUTIONS = {
    "900p": [1600, 900], "1800p": [3200, 1800],
    "2160p-dci": [4096, 2160], "ultrawide-1080": [2560, 1080],
    "ultrawide-1440": [3440, 1440], "non-mod16": [1918, 1078],
    "anamorphic": [1440, 1080], "coded-padding": [3840, 2176],
}
PLATFORMS = ["windows", "macos", "ios", "ipados", "android"]
BITRATES = [3, 8, 20, 40, 80, 130, 240]
VIDEO_COMPLEXITY = ["natural-low-motion", "high-motion-texture", "grain-reference-stress"]
SUBTITLE_COMPLEXITY = ["ordinary-dialogue", "dense-karaoke-motion", "vector-blur-font-stress"]
AUDIO_PROFILES = ["truehd-48k-24bit-2ch", "truehd-96k-24bit-8ch", "truehd-192k-24bit-6ch"]

# A profile family needs exact bitstreams and native dimensions before it can
# generate playback cases. fixed-cadence families are not invented as 4K120.
VIDEO = {
    "avc": ["baseline-main-high-8bit420", "high10-10bit420", "high422", "high444-predictive"],
    "hevc": ["main-8bit420", "main10-10bit420", "range-extensions-422-444-12bit"],
    "av1": ["main-8bit420", "main-10bit420", "high-444", "professional-12bit-422-444"],
    "vp9": ["profile0-8bit420", "profile2-10-12bit420", "profiles1-3-444"],
    "vp8": ["8bit420"], "mpeg1": ["declared-level"],
    "mpeg2": ["main-progressive", "main-interlaced", "422-profile"],
    "mpeg4-part2": ["simple", "advanced-simple-gmc-qpel"],
    "vc1": ["simple-main", "advanced-progressive", "advanced-interlaced"],
    "wmv": ["wmv1", "wmv2"], "h263": ["baseline", "plus"],
    "realvideo": ["rv10-rv20", "rv30-rv40"], "flv-video": ["sorenson-spark", "screen-video"],
    "theora": ["declared-pixel-format"], "vvc": ["main10", "multilayer-or-unadmitted-profile"],
    "prores": ["proxy-lt-422-hq", "4444-alpha", "4444xq-alpha"],
    "dnx": ["dnxhd-fixed-profiles", "dnxhr-lb-sq-hq", "dnxhr-hqx-444"],
    "dv": ["dv25-fixed-raster-cadence", "dv50", "dv100"],
    "mjpeg": ["8bit", "12bit"], "jpeg2000": ["lossy", "lossless", "htj2k"],
    "ffv1": ["v1", "v3"], "huffyuv": ["declared-profile"], "utvideo": ["declared-profile"],
    "raw": ["yuv-420-422-444-8-10-12-16bit", "rgb-bgr-alpha", "v210"],
    "image-sequence": ["png-apng", "jpeg-sequence", "tiff-sequence"],
}
AUDIO = {
    "aac": ["lc", "he-v1", "he-v2", "usac-xhe", "latm-loas-versus-adts"],
    "mpeg-audio": ["mp1", "mp2", "mp3"], "opus": ["mono-stereo", "mapping-family1", "other-mapping-families"],
    "vorbis": ["mono-stereo", "multichannel"], "flac": ["16bit", "24bit", "32bit-candidate"],
    "alac": ["declared-depth-rate-layout"], "pcm": ["u8-s16-s24-s32", "f32-f64", "little-big-endian", "bluray-lpcm"],
    "ac3": ["mono-stereo", "5.1"], "eac3": ["independent-dependent-substreams", "joc-object-rendering-separate"],
    "truehd": ["48k-24bit-2ch", "96k-24bit-8ch", "192k-24bit-6ch", "atmos-objects-separate"],
    "mlp": ["dvd-audio-channel-presentation"], "dts": ["core", "es", "96-24", "hra", "ma-xll", "dtsx-separate"],
    "iamf": ["declared-version-codec-profile-mix"], "mpegh": ["declared-profile-presentation"],
    "ac4": ["declared-presentation"], "wma": ["wma1-wma2", "pro", "lossless", "voice"],
    "realaudio": ["cook", "sipr", "atrac3", "ra144-ra288"], "amr": ["nb", "wb"],
    "adpcm": ["ima", "ms", "dv", "other-explicit-variants"],
    "other-lossless": ["ape", "wavpack", "tta", "shorten"], "dsd": ["dsf-dff-to-pcm-disclosed"],
    "spatial-extra": ["auro3d-separate", "ambisonics-channel-map-separate"],
}
SUBTITLES = {
    "webvtt": ["external", "wvtt-in-mp4"], "srt": ["external", "container-text"],
    "ass-ssa": ["fonts-fallback-shaping", "karaoke-transforms", "vector-clips-blur", "collision-wrap"],
    "ttml-imsc": ["text-profile", "image-profile", "stpp-in-mp4"], "tx3g": ["style-boxes"],
    "pgs": ["palettes-objects-windows", "forced-clear-crop"], "dvd-subpicture": ["vobsub-idx-sub", "in-vob"],
    "dvb-subtitle": ["page-region-object-clut"], "xsub": ["declared-palette-resolution"], "cea": ["608", "708"],
    "teletext": ["declared-page-charset"], "arib": ["std-b24-candidate"],
    "legacy-text": ["microdvd", "sami", "subviewer", "pjs-mpl2-candidate"],
}
CONTAINERS = [
    "mp4-m4v-fmp4", "mov", "matroska", "webm", "mpegts-188", "m2ts-192", "ts-204-candidate",
    "bdmv-folder", "bluray-iso-udf", "bdav-avchd", "mpegps-vob", "dvd-linear-title-optional",
    "avi-opendml", "asf-wmv", "rm-rmvb", "flv-f4v", "3gp-3g2", "mxf-declared-op-essence",
    "dv-hdv", "ogg-ogv", "nut", "wtv-dvrms", "elementary-avc-hevc-vvc", "av1-ivf-obu",
    "y4m-raw", "hls-clear-vod", "dash-clear-vod", "hls-dash-live-separate", "imf-dcp-clear-research",
    "zip-store-application-bundle-v1",
]

PACKAGING_PROFILES = {
    "zip-store-application-bundle-v1": {
        "kind": "application-bundle-over-standard-ZIP-STORE",
        "profile": "zip-store-nut-sidecar-ass-v1",
        "endpoint_qualification_status": "UNTESTED",
        "native_gpu_execution_status": "DEFERRED_NOT_QUALIFIED",
        "standard_native_media_container": False,
        "direct_native_absence_claim": "No standard native media entry point is asserted for this application bundle; native codec and device capability still need separate exact-route evidence.",
        "bounds": {"archive_bytes": 536870912, "entries": 4, "manifest_bytes": 65536,
                   "ass_bytes": 524288, "font_bytes": 4194304, "ass_events": 24},
        "selection": "Unchanged original NUT video/audio plus explicitly associated original timed ASS and font; known duration-losing embedded NUT ASS remains an ignored negative control.",
        "dataset_admission_ledger": "bench-v8/extreme-bundle/bundles/manifest.json",
        "dataset_admission_is_endpoint_qualification": False,
        "independent_render_reference_ledger": "bench-v8/extreme-bundle/references/manifest.json",
    },
}

def record_id(case):
    payload = json.dumps(case, sort_keys=True, separators=(",", ":")).encode()
    return "proposal-" + hashlib.sha256(payload).hexdigest()[:16]

def candidates():
    axes = itertools.product(PLATFORMS, RESOLUTIONS.items(), ["full-60", "performance-120"],
                             BITRATES, VIDEO_COMPLEXITY, SUBTITLE_COMPLEXITY, AUDIO_PROFILES)
    for platform, (label, dimensions), mode, bitrate, complexity, subtitles, audio in axes:
        case = {
            "platform": platform, "browser_build": None, "device": None, "display_route": None,
            "browser_engine": None, "hardware_decoder_route": None,
            "source_resolution": label, "coded_dimensions": dimensions,
            "mode": mode, "source_fps": {"num": 60 if mode == "full-60" else 120, "den": 1},
            "video": "av1-main-10bit420-hdr10",
            "hdr_contract": "valid-PQ-BT2020-samples-plus-mastering-display-and-content-light-metadata",
            "av1_level_tier": "choose-for-pixel-rate-bit-rate-and-decoder-buffer-limits",
            "video_bitrate_target_mbps": bitrate, "actual_bitrate": None,
            "video_complexity": complexity, "audio": audio, "subtitle": "ass-ssa",
            "subtitle_complexity": subtitles, "container": "matroska-with-av1-configuration-and-hdr10-metadata",
            "route": "runtime-selected-native-first", "fixture_sha256": None,
            "status": "UNTESTED", "kind": "proposed-test", "trials": [],
            "native_gpu_execution_status": "DEFERRED_NOT_QUALIFIED",
            "validity": "requires-valid-conformance-fixture-and-actual-level-check",
            "required_duration_seconds_per_trial": 3600 if platform in {"ios", "ipados", "android"} else 1800,
            "required_trials": 5,
        }
        case["case_id"] = record_id(case)
        yield case

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=Path("matrix"))
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    catalog = {
        "schema_version": 1, "state": "PROPOSED_NOT_TESTED", "video": VIDEO,
        "audio": AUDIO, "subtitles": SUBTITLES, "containers": CONTAINERS,
        "packaging_profiles": PACKAGING_PROFILES,
        "standard_resolution_samples": RESOLUTIONS, "boundary_resolution_cases": BOUNDARY_RESOLUTIONS,
        "rules": [
            "Every family needs exact admitted profiles; upstream decoder names are not support records.",
            "Fixed-raster/cadence codecs retain real source formats; do not fabricate 4K120 DV or 120fps MPEG-2 level compliance.",
            "HDR10 primary: validate 10-bit BT2020/PQ samples, range/chroma semantics, mastering display metadata and content-light metadata; PQ labels alone are insufficient.",
            "Check AV1 level/tier and container carriage independently; Dolby Vision has separate additional limits only for its optional claims.",
            "Optional AV1 Dolby Vision in Matroska requires dvvC and valid per-frame metadata; AV1 is not standard BDMV video.",
            "Actual bitrate includes mean, p95, maximum windows, audio, subtitles and mux overhead; target bitrate is not evidence.",
            "Native/GPU tests may be deferred by the user; deferred is not passed.",
            "Boundary resolutions and profile families are follow-up validity/correctness cases, not claimed exhaustive execution.",
            "The five OS labels are unresolved families, not five qualified devices. Instantiate exact browser/engine/build, SoC/GPU, display/audio route, power and thermal conditions before executing each case.",
            "A verified application-bundle dataset proves its exact archive/member association only. It does not change UNTESTED endpoint catalog status, qualify native playback, repair the original embedded NUT subtitle failure, or extend the 7560 primary Matroska proposals.",
        ],
    }
    (args.out / "catalog.json").write_text(json.dumps(catalog, indent=2) + "\n")
    optional_dv = []
    for platform, mode, compatibility in itertools.product(PLATFORMS, ["full-60", "performance-120"], [0, 1, 4]):
        case = {"platform": platform, "mode": mode, "coded_dimensions": [3840, 2160],
                "video": f"av1-main-10bit420-dolby-vision-profile10.{compatibility}",
                "audio": "truehd-96k-24bit-8ch", "subtitle": "complex-ass",
                "container": "matroska-with-dvvC-and-T35-EMDF-OBUs",
                "status": "UNTESTED_OPTIONAL", "native_gpu_execution_status": "DEFERRED_NOT_QUALIFIED",
                "validity": "requires-exact-DV-and-AV1-level-tier-fixture-validation",
                "release_role": "Does not block HDR10 primary claim; optional DV claim needs its own fidelity and performance evidence."}
        case["case_id"] = record_id(case)
        optional_dv.append(case)
    (args.out / "optional-dv-matrix.jsonl").write_text("".join(json.dumps(row, separators=(",", ":")) + "\n" for row in optional_dv))
    count = 0
    nominal_seconds = 0
    with (args.out / "priority-matrix.jsonl").open("w") as output:
        for case in candidates():
            output.write(json.dumps(case, separators=(",", ":")) + "\n")
            count += 1
            nominal_seconds += case["required_duration_seconds_per_trial"] * case["required_trials"]
    summary = {
        "status": "ALL_PROPOSALS_UNTESTED", "primary_hdr": "HDR10", "priority_cases": count, "optional_dv_cases": len(optional_dv),
        "axes": {"platforms": 5, "resolutions": 4, "modes": 2, "bitrate_targets": 7,
                 "video_complexity": 3, "subtitle_complexity": 3, "truehd_profiles": 3},
        "video_profile_rows": sum(map(len, VIDEO.values())),
        "audio_profile_rows": sum(map(len, AUDIO.values())),
        "subtitle_profile_rows": sum(map(len, SUBTITLES.values())), "container_rows": len(CONTAINERS),
        "minimum_measurement_hours_serial": nominal_seconds / 3600,
        "additional_cost": "Browser-engine variants, repeated trials after fixes, setup, source generation, output verification and the long-tail corpus are additional.",
        "not_claimed": "All formats, all integer dimensions, all browsers/devices within the five OS families, physical compatibility or any performance pass.",
    }
    (args.out / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary, indent=2))

if __name__ == "__main__":
    main()
