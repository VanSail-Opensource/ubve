import { EngineError, assessPrimaryHdr10 } from '@ubve/core';
import type { VideoPixels } from '@ubve/core';
import type { WebGpuRendererOptions } from '@ubve/presentation';
import type { QualityMode } from './player.js';

/** The output API and the source metadata are independent admission boundaries.
 * Neither makes a display, timing, GPU throughput or fidelity claim. */
export function managedGpuOptions(frame: VideoPixels, quality: QualityMode): WebGpuRendererOptions {
  const refuse = (reason: string): never => { throw new EngineError('UNSUPPORTED_PROFILE', `Managed WebGPU cannot admit this frame. ${reason}`, 'caller-fix'); };
  if (frame.format !== 'I420P8' && frame.format !== 'I420P10') refuse('Expected owned planar 4:2:0 storage.');
  if (!(frame.data.buffer instanceof ArrayBuffer)) refuse('A stable, non-shared upload allocation is required.');
  const color = frame.color;
  const hdr = color.transfer === 'pq' || color.transfer === 'smpte2084';
  if (color.range === null) refuse('The decoded sample range is unknown.');
  if (hdr ? color.primaries !== 'bt2020' || color.matrix !== 'bt2020-ncl' : color.primaries !== 'bt709' || color.matrix !== 'bt709' || color.transfer !== 'bt709') {
    refuse('Expected BT.709 SDR or BT.2020 non-constant-luminance PQ.');
  }
  const metadata = frame.signalMetadata;
  const chroma = metadata?.chromaLocation.state === 'known' ? metadata.chromaLocation.value : null;
  if (chroma !== 'center' && chroma !== 'left' && chroma !== 'top-left') return refuse('Chroma siting is unknown, conflicting or not implemented.');
  if (hdr && quality === 'full') {
    if (!metadata || frame.format !== 'I420P10') return refuse('The HDR candidate requires an exact HDR10 signal descriptor and 10-bit planes.');
    const accepted = assessPrimaryHdr10(metadata);
    if (!accepted.admitted) refuse(`HDR10 signal requirements were not met (${accepted.reasons.join(', ')}).`);
    if (metadata.range.state !== 'known' || metadata.range.value !== color.range) refuse('HDR10 signal and decoded plane range disagree.');
  }
  return { output: hdr && quality === 'full' ? 'hdr-candidate' : 'sdr',
    referenceWhiteNits: 203, allowSdrToneMap: quality === 'performance',
    ...(quality === 'performance' ? { maximumHeight: 720 } : {}), chromaLocation: chroma === 'top-left' ? 'topleft' : chroma };
}
