#!/usr/bin/env python3
"""Generate a distinct, short 720p–4K AV1/PQ + TrueHD + ASS screening case.

The encoded output's identity is measured on each host. Encoders/muxers may
produce different bytes across versions. This is not a throughput fixture.
"""
import argparse
from array import array
from hashlib import file_digest, sha256
import json
import math
from pathlib import Path
from subprocess import PIPE, Popen, check_output
import sys

FRAMES = 48
RESOLUTIONS = ('1280x720', '1920x1080', '2560x1440', '3840x2160')


def pq_nits(code):
    m1, m2 = 2610 / 16384, 2523 / 32
    c1, c2, c3 = 3424 / 4096, 2413 / 128, 2392 / 128
    power = ((code - 64) / 876) ** (1 / m2)
    return 10000 * (max(power - c1, 0) / (c2 - c3 * power)) ** (1 / m1)


def serialize_plane(values):
    if sys.byteorder != 'little':
        values.byteswap()
    return values.tobytes()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', required=True, type=Path)
    parser.add_argument('--size', choices=RESOLUTIONS, default='1280x720')
    parser.add_argument('--fps', type=int, choices=(60, 120), default=120)
    parser.add_argument('--audio-source', type=Path, default=Path('test/fixtures/primary/combined-720p60.mkv'))
    args = parser.parse_args()
    width, height = map(int, args.size.split('x'))
    fps = args.fps
    duration = str(FRAMES / fps)
    audio_frames = 48000 * FRAMES // fps
    target = args.out.resolve()
    target.mkdir(parents=True, exist_ok=True)
    ass = target / f'sample-{fps}.ass'
    ass.write_text('''[Script Info]
ScriptType: v4.00+
PlayResX: 1280
PlayResY: 720
[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,DejaVu Sans,44,&H00FFFFFF,&H000080FF,&H00000000,&H99000000,0,0,0,0,100,100,0,0,1,2,1,2,20,20,20,1
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:00.40,Default,,0,0,0,,{\\k20}UBVE {\\k20}120 Hz
Dialogue: 1,0:00:00.00,0:00:00.40,Default,,0,0,0,,{\\an8\\move(360,110,840,120)}Timed ASS
Dialogue: 1,0:00:00.10,0:00:00.36,Default,,0,0,40,,{\\fade(255,0,255,0,80,180,260)}Font and alpha
'''.replace('120 Hz', f'{fps} Hz'), encoding='utf-8')
    # All legal limited-range PQ gray codes with neutral BT.2020 chroma. The
    # bright/dark marker changes shape and location at every source picture.
    shades = (64, 332, 510, 640)
    base_row = array('H', (shades[x // (width // 4)] for x in range(width)))
    neutral = serialize_plane(array('H', [512]) * (width * height // 2))
    high, low, cell = 608, 200, 32
    patch = {code: array('H', [code]) * cell for code in (high, low)}
    cll = math.ceil(pq_nits(max(shades)))
    fall_ceiling = math.ceil(sum(pq_nits(code) for code in shades) / len(shades) + 6 * pq_nits(high) * cell * cell / (width * height))
    mastering = 'G(0.17,0.797)B(0.131,0.046)R(0.708,0.292)WP(0.3127,0.329)L(1000,0.0001)'
    svt = f'lp=2:lookahead=0:enable-hdr=1:color-primaries=9:transfer-characteristics=16:matrix-coefficients=9:color-range=0:mastering-display={mastering}:content-light={cll},{fall_ceiling}'
    case_id = f'{height}p{fps}-signal'
    output = target / f'combined-signal-{height}p{fps}.mkv'
    command = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
               '-f', 'rawvideo', '-pix_fmt', 'yuv420p10le', '-s:v', args.size, '-r', str(fps), '-i', 'pipe:0',
               '-i', str(args.audio_source), '-i', str(ass), '-map', '0:v:0', '-map', '1:a:0', '-map', '2:s:0', '-map', '1:t:0',
               '-c:v', 'libsvtav1', '-preset', '12', '-crf', '32', '-svtav1-params', svt, '-g', str(FRAMES),
               '-pix_fmt', 'yuv420p10le', '-color_range', 'tv', '-color_primaries', 'bt2020', '-color_trc', 'smpte2084', '-colorspace', 'bt2020nc',
               '-c:a', 'copy', '-c:s', 'copy', '-t', duration, '-fflags', '+bitexact', str(output)]
    with Popen(command, stdin=PIPE) as child:
        try:
            for frame in range(FRAMES):
                luma = base_row * height
                for bit in range(6):
                    x = 32 + bit * (cell + 8)
                    for y in range(64, 64 + cell):
                        start = y * width + x
                        luma[start:start + cell] = patch[high if frame & (1 << bit) else low]
                x = 32 + frame * 8
                for y in range(192, 192 + cell):
                    start = y * width + x
                    luma[start:start + cell] = patch[high]
                child.stdin.write(serialize_plane(luma))
                child.stdin.write(neutral)
        finally:
            child.stdin.close()
        if child.wait() != 0:
            raise RuntimeError(f'FFmpeg could not generate the {fps} Hz fixture')

    probe = json.loads(check_output(['ffprobe', '-v', 'error', '-count_frames', '-show_streams', '-of', 'json', str(output)]))
    video, audio, subtitle, attachment = probe['streams']
    expected = {'codec_name': 'av1', 'profile': 'Main', 'width': width, 'height': height, 'pix_fmt': 'yuv420p10le', 'r_frame_rate': f'{fps}/1',
                'avg_frame_rate': f'{fps}/1', 'nb_read_frames': str(FRAMES), 'color_primaries': 'bt2020', 'color_transfer': 'smpte2084', 'color_space': 'bt2020nc', 'color_range': 'tv'}
    if any(video.get(key) != value for key, value in expected.items()):
        raise RuntimeError(f'Unexpected AV1 metadata or source cadence: {video}')
    metadata = json.loads(check_output(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_frames', '-show_entries', 'frame=pts_time:frame_side_data', '-of', 'json', str(output)]))
    video_timestamps = [float(frame['pts_time']) for frame in metadata['frames']]
    if len(video_timestamps) != FRAMES or any(abs(pts - i / fps) > 0.001 for i, pts in enumerate(video_timestamps)):
        raise RuntimeError(f'Encoded timestamps do not contain all {FRAMES} actual {fps} Hz picture opportunities')
    sides = [side for frame in metadata['frames'] for side in frame.get('side_data_list', [])]
    if not any(side['side_data_type'] == 'Mastering display metadata' for side in sides) or not any(
        side['side_data_type'] == 'Content light level metadata' and side.get('max_content') == cll and side.get('max_average') == fall_ceiling for side in sides
    ):
        raise RuntimeError('AV1 mastering or expected content-light side data missing')
    framehash = check_output(['ffmpeg', '-v', 'error', '-i', str(output), '-map', '0:v:0', '-f', 'framehash', '-'], text=True)
    hashes = [line.rsplit(',', 1)[-1].strip() for line in framehash.splitlines() if line and not line.startswith('#')]
    if len(hashes) != FRAMES or len(set(hashes)) != FRAMES:
        raise RuntimeError('Every decoded picture must be unique and independently observed')
    samples = check_output(['ffprobe', '-v', 'error', '-select_streams', 'a:0', '-show_frames', '-show_entries', 'frame=nb_samples', '-of', 'csv=p=0', str(output)], text=True)
    if audio['codec_name'] != 'truehd' or audio['channels'] != 6 or audio['sample_rate'] != '48000' or sum(map(int, samples.split())) != audio_frames:
        raise RuntimeError(f'Unexpected TrueHD layout or decoded sample count: {audio}')
    def prefix_pcm(filename):
        return check_output(['ffmpeg', '-v', 'error', '-i', str(filename), '-map', '0:a:0', '-t', duration, '-c:a', 'pcm_s32le', '-f', 's32le', '-'])
    original_pcm, packaged_pcm = prefix_pcm(args.audio_source), prefix_pcm(output)
    if len(packaged_pcm) != audio_frames * 6 * 4 or original_pcm != packaged_pcm:
        raise RuntimeError('Copied TrueHD prefix does not decode to the exact source PCM')
    if subtitle['codec_name'] != 'ass' or subtitle['nb_read_frames'] != '3' or attachment['codec_type'] != 'attachment':
        raise RuntimeError('Expected three ASS events and attached font')
    video_packet_sizes = check_output(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_packets', '-show_entries', 'packet=size', '-of', 'csv=p=0', str(output)], text=True)
    with args.audio_source.open('rb') as source:
        source_digest = file_digest(source, 'sha256').hexdigest()
    raw = output.read_bytes()
    fixture = {'id': case_id, 'path': output.name, 'sha256': sha256(raw).hexdigest(), 'bytes': len(raw), 'video': expected,
               'audio': {'codec_name': 'truehd', 'channels': 6, 'sample_rate': '48000', 'decoded_sample_frames': audio_frames},
               'subtitle': {'codec_name': 'ass', 'nb_read_frames': '3'},
               'origin': 'Generated 48-frame 10-bit neutral PQ moving-marker input, copied TrueHD prefix and attached font, original three ASS cues',
               'audioAndFontSourceSha256': source_digest, 'av1LevelIndex': video.get('level'),
               'videoPacketMeanMbps': sum(map(int, video_packet_sizes.split())) * 8 / float(duration) / 1e6,
               'decodedPictureSha256': hashes, 'referencePcmS32leSha256': sha256(packaged_pcm).hexdigest(), 'containerMeanMbps': len(raw) * 8 / float(duration) / 1e6,
               'ffmpegVersion': check_output(['ffmpeg', '-version'], text=True).splitlines()[0]}
    manifest_path = target / 'manifest.json'
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {'schema': 1, 'scope': 'Distinct low-complexity generated 60/120 Hz screening fixtures; no playback claim.', 'cases': []}
    manifest['cases'] = sorted([row for row in manifest['cases'] if row['id'] != case_id] + [fixture],
                               key=lambda row: (row['video']['height'], int(row['video']['r_frame_rate'].split('/')[0])))
    manifest_path.write_text(json.dumps(manifest, indent=2) + '\n')
    print(f'{output}: {len(raw)} bytes, {FRAMES} independently decoded unique {fps} Hz pictures, {audio_frames} TrueHD sample frames')


if __name__ == '__main__':
    main()
