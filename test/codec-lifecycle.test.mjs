import assert from 'node:assert/strict';
import test from 'node:test';
import { BudgetLedger, OwnedLease, byteLength, mediaTime, sessionStamp, timeBase } from '../packages/core/dist/index.js';
import { operationContext } from '../packages/io-demux/dist/index.js';
import { PacketDecoder } from '../packages/wasm-adapters/dist/decoder.js';

const first = sessionStamp('codec-lifecycle', 0), next = sessionStamp(first.sessionId, 1), base = timeBase(1n, 60n);
const op = (stamp = first, signal, timeout = 1000) => operationContext(stamp, 'test', signal, timeout);
const deferred = () => Promise.withResolvers();
const packet = (ledger, stamp = first, payload = new Uint8Array(1), declared = payload.buffer.byteLength) => ({
  id: 'p0', stamp, trackId: 'v0', codecConfigEpoch: 0, decodeSequence: 0, presentationSequence: null, timeBase: base, ptsTicks: 0n, dtsTicks: null,
  durationTicks: 1n, recovery: 'key', timingProvenance: { kind: 'container-exact', originalPtsSeconds: null, transformDescription: null },
  representation: { kind: 'opaque-adapter', reason: 'synthetic lifecycle probe' }, sourceSpans: null,
  bytes: OwnedLease.adopt(ledger.tryReserve(byteLength(declared)), payload),
});
const ledger = () => new BudgetLedger({ bytes: byteLength(32), items: 4, maxSingleItemBytes: byteLength(32) });

class LifecycleProbe extends PacketDecoder {
  effective = {};
  decodeEntered = deferred(); flushEntered = deferred();
  decodeGate; flushGate; shutdownGate; reopenGate;
  flushCount = 0; shutdownCount = 0; openCount = 0;
  constructor() { super(first, 1, 1); }
  async decode(_value, consumed) { this.decodeEntered.resolve(); await this.decodeGate?.promise; consumed(); }
  async flush() { this.flushCount++; this.flushEntered.resolve(); await this.flushGate?.promise; }
  async reopen() { this.openCount++; await this.reopenGate?.promise; }
  async shutdown() { this.shutdownCount++; await this.shutdownGate?.promise; }
  async makeOutput() { await this.emit({ stamp: this.stamp, operationId: 'test', sourcePacketId: 'p0', pts: mediaTime(0n, base), durationTicks: 1n, codecConfigEpoch: 0 }, 17, 1); }
}

test('accepted input cancellation rejects immediately but retains its lease until the command returns', async () => {
  const decoder = new LifecycleProbe(), inputs = ledger(), abort = new AbortController();
  decoder.decodeGate = deferred();
  const source = packet(inputs);
  const result = decoder.trySubmit(source, op(first, abort.signal));
  assert.equal(result.status, 'accepted');
  await decoder.decodeEntered.promise;
  abort.abort();
  await assert.rejects(result.inputConsumed, { code: 'CANCELLED' });
  assert.equal(inputs.snapshot().items, 1);
  assert.equal(decoder.snapshot().inputItems, 1);
  decoder.decodeGate.resolve();
  await decoder.dispose();
  assert.equal(inputs.snapshot().items, 0);
  assert.equal(decoder.snapshot().inputItems, 0);
});

test('concurrent EOS observers share one flush, and a waiting observer can time out without cancelling it', async () => {
  const decoder = new LifecycleProbe(); decoder.flushGate = deferred();
  const primary = decoder.flushEndOfStream(op());
  await decoder.flushEntered.promise;
  await assert.rejects(decoder.flushEndOfStream(op(first, undefined, 10)), { code: 'DEADLINE_EXCEEDED' });
  decoder.flushGate.resolve();
  await primary;
  assert.equal(await decoder.readOutput(op()), null);
  assert.equal(decoder.flushCount, 1);
  await decoder.dispose();
});

test('dispose during reset never starts a new runtime and old admissions report stale epoch', async () => {
  const decoder = new LifecycleProbe(), inputs = ledger(); decoder.decodeGate = deferred(); decoder.shutdownGate = deferred();
  const result = decoder.trySubmit(packet(inputs), op());
  assert.equal(result.status, 'accepted');
  await decoder.decodeEntered.promise;
  const resetting = decoder.reset(next, op(next)), resetRejected = assert.rejects(resetting, { code: 'DISPOSED' });
  await assert.rejects(result.inputConsumed, { code: 'STALE_EPOCH' });
  await assert.rejects(decoder.readOutput(op(next)), { code: 'STALE_EPOCH' });
  const closing = decoder.dispose();
  decoder.decodeGate.resolve(); decoder.shutdownGate.resolve();
  await Promise.all([closing, resetRejected]);
  assert.equal(decoder.openCount, 0);
  assert.equal(decoder.shutdownCount, 1);
  assert.equal(inputs.snapshot().items, 0);
});

test('reset releases undelivered output but does not deallocate recipient-held output', async () => {
  const decoder = new LifecycleProbe();
  await decoder.makeOutput();
  const frame = await decoder.readOutput(op());
  await decoder.reset(next, op(next));
  assert.equal(frame.payload.borrow(), 17);
  assert.equal(decoder.snapshot().output.items, 1);
  frame.payload.release();
  await decoder.makeOutput();
  await decoder.dispose();
  assert.equal(decoder.snapshot().output.items, 0);
});

test('input ownership validation rejects a larger retained backing store without moving the lease', async () => {
  const decoder = new LifecycleProbe(), inputs = ledger();
  const aliased = packet(inputs, first, new Uint8Array(16).subarray(3, 4), 1);
  const result = decoder.trySubmit(aliased, op());
  assert.equal(result.status, 'rejected');
  assert.equal(result.error.code, 'OWNERSHIP_VIOLATION');
  assert.equal(aliased.bytes.state, 'owned');
  aliased.bytes.release();
  await decoder.dispose();
});
