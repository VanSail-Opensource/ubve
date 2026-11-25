/** Untimed real MP4 byte/PTS and ownership check. Use a manifest with exact case SHA-256 values. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, openAsBlob } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [manifestPath, caseId] = process.argv.slice(2);
if (!manifestPath || !caseId) throw new Error('Usage: node test/io-mp4-reference.mjs <manifest.json> <case-id>');
const moduleUrl = process.env.UBVE_IO_MODULE ? pathToFileURL(resolve(process.env.UBVE_IO_MODULE)) : new URL('../packages/io-demux/dist/index.js', import.meta.url);
const { BlobSource, openMedia } = await import(moduleUrl.href);
const manifest = JSON.parse(await readFile(manifestPath, 'utf8')), fixture = manifest.cases.find(record => record.id === caseId);
assert.ok(fixture && /^[a-f\d]{64}$/.test(fixture.sha256), 'case has an exact fixture SHA-256');
const path = resolve(dirname(manifestPath), fixture.path), verify = createHash('sha256');
for await (const bytes of createReadStream(path)) verify.update(bytes);
assert.equal(verify.digest('hex'), fixture.sha256);
const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_packets', '-show_entries', 'packet=pts_time,data_hash', '-show_data_hash', 'sha256', '-of', 'json', path], {
  encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
});
if (probe.error) throw probe.error;
assert.equal(probe.status, 0, probe.stderr);
const reference = JSON.parse(probe.stdout).packets;
assert.ok(reference.length > 0);
const source = new BlobSource(await openAsBlob(path));
const receipt = { evidenceClass: 'UNTIMED_MP4_PACKET_AND_APPLICATION_OWNERSHIP', fixture: { id: caseId, sha256: fixture.sha256, bytes: source.size },
  route: 'selected-video-packet-demux-only', expectedPackets: reference.length, matchedPackets: 0, open: null, stream: null, disposed: null, error: null };
let session;
try {
  session = await openMedia(source);
  const track = session.tracks.find(track => track.kind === 'video');
  assert.ok(track);
  receipt.open = { stats: { ...source.stats }, cache: session.cache.snapshot(), codec: track.codec, color: track.color, duration: session.duration };
  for await (const packet of session.packets([track.id])) {
    try {
      const expected = reference[receipt.matchedPackets];
      assert.ok(expected, 'no surplus packets');
      const hash = createHash('sha256').update(packet.bytes.borrow()).digest('hex');
      assert.equal('sha256:' + hash, expected.data_hash.toLowerCase(), `packet ${receipt.matchedPackets} compressed bytes`);
      assert.equal(packet.dtsTicks, null);
      const pts = Number(packet.ptsTicks) * Number(packet.timeBase.numerator) / Number(packet.timeBase.denominator);
      // ffprobe emits six decimal places. Our provider exposes seconds, not native ticks.
      assert.ok(Math.abs(pts - Number(expected.pts_time)) <= 0.000000501, `packet ${receipt.matchedPackets} PTS`);
      receipt.matchedPackets++;
    } finally { packet.bytes.release(); }
  }
  assert.equal(receipt.matchedPackets, reference.length);
  receipt.status = 'EXACT_PACKET_CHECK_PASSED';
} catch (error) {
  receipt.status = 'FAILED';
  receipt.error = { code: error.code ?? null, message: error.message };
  process.exitCode = 1;
} finally {
  receipt.stream = { stats: { ...source.stats }, cache: session?.cache.snapshot() ?? null };
  await session?.dispose();
  await source.close();
  receipt.disposed = { stats: { ...source.stats }, cache: session?.cache.snapshot() ?? null, ledger: source.ledger.snapshot() };
  console.log(JSON.stringify(receipt, null, 2));
}
