"""Author small, deterministic codec/packaging fixtures and CPU references.

Use a FFmpeg build with libx264, libx265, libaom, libvpx, libopus, libvorbis,
and libmp3lame. An optional libfdk_aac encoder is only used to author HE-AAC
test data. No external encoder or sample is required by the player.
"""
import argparse
import gzip
import hashlib
import json
from pathlib import Path
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--out', type=Path, required=True)
parser.add_argument('--he-aac', action='store_true')
args = parser.parse_args()
out = args.out.resolve()
out.mkdir(parents=True, exist_ok=True)
cases = []
def run(*argv):
    return subprocess.run(argv, check=True, capture_output=True).stdout

def sha(data):
    return hashlib.sha256(data).hexdigest()

ffmpeg = ['ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error', '-cpuflags', '0', '-filter_threads', '1']
video_in = ['-f', 'lavfi', '-i', 'testsrc2=s=160x96:r=25:d=1.20', '-vf',
            'setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709']
colour = ['-color_range', 'tv', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709']
audio_in = ['-f', 'lavfi', '-i', 'aevalsrc=0.2*sin(2*PI*431*t)|0.15*sin(2*PI*719*t):s=48000:d=1.28:c=stereo']
surround_in = ['-f', 'lavfi', '-i', 'aevalsrc=' + '|'.join(f'0.08*sin(2*PI*{hz}*t)' for hz in (431, 719, 271, 71, 913, 1297)) + ':s=48000:d=1.28:c=5.1(side)']
x265 = ['-x265-params', 'pools=none:frame-threads=1:log-level=error:keyint=10:bframes=2']

def make(name, ext, source, encoding, *, video=False, lossless=False, quality='full', sr=None):
    path = out / f'{name}.{ext}'
    try:
        run(*ffmpeg, '-y', *source, '-map_metadata', '-1', '-threads', '1', *encoding, str(path))
        probe = json.loads(run('ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', str(path)))
        stream = next(s for s in probe['streams'] if s['codec_type'] == ('video' if video else 'audio'))
        ref = subprocess.check_output(['ffmpeg', '-version'], text=True).splitlines()[0]
        expected = {'videoFrames': 0} if not video else {}
        row = {'id': name, 'path': path.name, 'sha256': sha(path.read_bytes()), 'bytes': path.stat().st_size,
               'quality': quality, 'expected': expected,
               'reference': {'tool': ref, 'codec': stream['codec_name'], 'profile': stream.get('profile')}}
        if video:
            decoder = ['-c:v', 'libaom-av1'] if stream['codec_name'] == 'av1' else []
            hashes = run(*ffmpeg, '-threads', '1', *decoder, '-i', str(path), '-map', '0:v:0', '-threads', '1',
                         '-pix_fmt', stream['pix_fmt'], '-fps_mode', 'passthrough', '-f', 'framehash', '-hash', 'sha256', '-')
            hashes = [line.decode().split(',')[-1].strip() for line in hashes.splitlines() if not line.startswith(b'#')]
            row['reference'].update({'kind': 'video', 'format': stream['pix_fmt'], 'frames': hashes})
            expected['videoFrames'] = len(hashes)
        else:
            fmt = 's32le' if lossless else 'f32le'
            pcm = run(*ffmpeg, '-threads', '1', '-flags', '+bitexact', '-i', str(path), '-map', '0:a:0', '-f', fmt, '-c:a', 'pcm_' + fmt, '-')
            channels = stream['channels']
            expected['pcmFrames'] = len(pcm) // (4 * channels)
            row['reference'].update({'kind': 'audio', 'format': fmt, 'rate': int(stream['sample_rate']), 'channels': channels,
                                     'layout': stream.get('channel_layout'), 'sha256': sha(pcm)})
            if not lossless:
                # Keep compressed scalar references so CI needs no FFmpeg.
                pcm_path = out / (name + '.f32le.gz')
                pcm_path.write_bytes(gzip.compress(pcm, mtime=0))
                row['reference']['pcmFile'] = pcm_path.name
                row['reference']['absoluteTolerance'] = .0001
                row['reference']['rmsTolerance'] = .00001
            if sr is not None and row['reference']['rate'] != sr:
                raise RuntimeError(f'{name} decoded rate was not {sr}')
        cases.append(row)
        print(f"{name} {row['reference']['codec']} {row['reference']['profile']} {expected}", flush=True)
    except subprocess.CalledProcessError as error:
        raise RuntimeError(error.stderr.decode('utf-8', errors='replace')) from error

for profile in ['baseline', 'main', 'high']:
    make('avc-' + profile, 'mp4' if profile != 'high' else 'mkv', video_in,
         ['-c:v', 'libx264', '-profile:v', profile, '-pix_fmt', 'yuv420p', '-g', '10', '-bf', '0' if profile == 'baseline' else '2', *colour], video=True)
make('hevc-main', 'mov', video_in, ['-c:v', 'libx265', '-profile:v', 'main', '-pix_fmt', 'yuv420p', *x265, *colour], video=True)
make('hevc-main10', 'mp4', video_in, ['-c:v', 'libx265', '-profile:v', 'main10', '-pix_fmt', 'yuv420p10le', *x265, *colour], video=True)
primary = Path(__file__).resolve().parents[1] / 'primary' / 'combined-720p60.mkv'
if sha(primary.read_bytes()) != '4e681a037ee5a4fdf57ac7512e702012d15b986133e27410e826c45fe76ad187':
    raise RuntimeError('The HDR10 source differs from its frozen identity')
make('hevc-main10-hdr10', 'mkv', ['-i', str(primary), '-map', '0:v:0', '-vf', 'crop=160:96'],
     ['-c:v', 'libx265', '-profile:v', 'main10', '-pix_fmt', 'yuv420p10le', '-x265-params',
      x265[1] + ':hdr10=1:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc:'
      'master-display=G(8500,39850)B(6550,2300)R(35400,14600)WP(15635,16450)L(10000000,1):max-cll=1000,400',
      '-color_range', 'tv', '-color_primaries', 'bt2020', '-color_trc', 'smpte2084', '-colorspace', 'bt2020nc'],
     video=True, quality='performance')
make('av1-main8', 'webm', video_in, ['-c:v', 'libaom-av1', '-cpu-used', '8', '-row-mt', '0', '-pix_fmt', 'yuv420p', *colour], video=True)
make('vp8', 'webm', video_in, ['-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', *colour], video=True)
make('vp9-profile0', 'webm', video_in, ['-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', *colour], video=True)
make('vp9-profile2', 'mp4', video_in, ['-c:v', 'libvpx-vp9', '-cpu-used', '6', '-profile:v', '2', '-pix_fmt', 'yuv420p10le', *colour], video=True)
make('aac-lc', 'm4a', audio_in, ['-c:a', 'aac', '-b:a', '128k'])
make('aac-lc-44100', 'm4a', ['-f', 'lavfi', '-i', audio_in[-1].replace('48000', '44100')], ['-c:a', 'aac', '-b:a', '96k'])
if args.he_aac:
    make('aac-he-v1', 'm4a', audio_in, ['-c:a', 'libfdk_aac', '-profile:a', 'aac_he', '-b:a', '48k'])
    make('aac-he-v2', 'm4a', audio_in, ['-c:a', 'libfdk_aac', '-profile:a', 'aac_he_v2', '-b:a', '32k'])
for ext in ['webm', 'ogg', 'mkv']:
    make('opus-' + ext, ext, audio_in, ['-c:a', 'libopus', '-b:a', '64k'])
for ext in ['webm', 'ogg']:
    make('vorbis-' + ext, ext, audio_in, ['-c:a', 'libvorbis', '-q:a', '4'])
make('mp3', 'mp3', audio_in, ['-c:a', 'libmp3lame', '-q:a', '4'])
make('alac-16', 'm4a', audio_in, ['-c:a', 'alac', '-sample_fmt', 's16p'], lossless=True)
make('alac-24', 'm4a', audio_in, ['-c:a', 'alac', '-sample_fmt', 's32p'], lossless=True)
make('flac-16', 'flac', audio_in, ['-c:a', 'flac', '-sample_fmt', 's16'], lossless=True)
make('flac-24', 'mkv', audio_in, ['-c:a', 'flac', '-sample_fmt', 's32'], lossless=True)
make('pcm-16', 'wav', audio_in, ['-c:a', 'pcm_s16le'], lossless=True)
make('pcm-24', 'mov', audio_in, ['-c:a', 'pcm_s24be'], lossless=True)
make('pcm-f32', 'wav', audio_in, ['-c:a', 'pcm_f32le'])
make('ac3-51', 'mkv', surround_in, ['-c:a', 'ac3', '-b:a', '384k'])
make('eac3-51', 'mkv', surround_in, ['-c:a', 'eac3', '-b:a', '384k'])
make('dts-core-51', 'mkv', surround_in, ['-ac', '6', '-strict', '-2', '-c:a', 'dca', '-b:a', '768k'])
make('avc-aac', 'mp4', ['-i', str(out / 'avc-main.mp4'), '-i', str(out / 'aac-lc-44100.m4a'), '-map', '0:v:0', '-map', '1:a:0'],
     ['-c', 'copy', '-movflags', '+faststart'], video=True)
cases[-1]['expected']['pcmFrames'] = next(row for row in cases if row['id'] == 'aac-lc-44100')['expected']['pcmFrames']
(out / 'manifest.json').write_text(json.dumps({'schema': 'ubve-modern-software-fixtures-v1', 'cases': cases}, indent=2) + '\n', encoding='utf-8')
