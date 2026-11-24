import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BudgetLedger, CancellationController, EngineError, EpochController, OwnedLease, OwnedQueue,
  acceptCurrent, byteLength, byteOffset, byteRange, checkedEnd, compareTime, mediaTime,
  rangeLength, rescale, sessionStamp, sourceIdentity, timeBase, validatePacket,
} from '../packages/core/dist/index.js';
import { FakeCodec, ManualScheduler, MemorySource } from '../packages/testkit/dist/index.js';

const limits = (bytes = 64, items = 8, single = bytes) => ({ bytes: byteLength(bytes), items, maxSingleItemBytes: byteLength(single) });
const lease = (budget, values = [1, 2, 3], destroy) => {
  const reservation = budget.tryReserve(byteLength(values.length));
  assert.ok(reservation);
  return OwnedLease.adopt(reservation, new Uint8Array(values), destroy);
};
const context = (stamp, id, controller = new CancellationController(), deadlineMs = 1000) => ({ stamp, operationId: id, deadlineMs, cancellation: controller.signal });
const packet = (bytes, stamp = sessionStamp('s', 0), id = 'packet') => ({
  id, stamp, trackId: 'video-0', codecConfigEpoch: 0, decodeSequence: 0, presentationSequence: null,
  timeBase: timeBase(1n, 90000n), ptsTicks: -3000n, dtsTicks: null, durationTicks: 3000n,
  timingProvenance: { kind: 'container-exact', originalPtsSeconds: null, transformDescription: null },
  recovery: 'key', representation: { kind: 'source-exact' },
  sourceSpans: [{ source: sourceIdentity('fixture', 'immutable-v1'), range: byteRange(0, bytes.borrow().length) }], bytes,
});
const codeIs = code => error => error instanceof EngineError && error.code === code;
const accepted = submission => { assert.equal(submission.status, 'accepted'); return submission.inputConsumed; };

// Correctness invariants only: these are not throughput or browser tests.
test('checked offsets preserve 500 GiB and reject unsafe integers and range overflow', () => {
  const huge = byteOffset(500n * 1024n ** 3n);
  assert.equal(huge, 536870912000);
  assert.equal(rangeLength(byteRange(huge, huge + 4096)), 4096);
  assert.throws(() => byteOffset(2n ** 53n), codeIs('INVALID_ARGUMENT'));
  assert.throws(() => byteOffset(0.5), codeIs('INVALID_ARGUMENT'));
  assert.throws(() => checkedEnd(byteOffset(Number.MAX_SAFE_INTEGER), byteLength(1)), codeIs('INVALID_ARGUMENT'));
  assert.throws(() => byteRange(10, 9), codeIs('INVALID_ARGUMENT'));
});

test('rational math preserves negative priming and requires explicit rounding', () => {
  const negative = mediaTime(-1n, timeBase(1n, 3n));
  assert.equal(rescale(negative, timeBase(1n, 10n), 'floor').ticks, -4n);
  assert.equal(rescale(negative, timeBase(1n, 10n), 'ceil').ticks, -3n);
  assert.equal(compareTime(mediaTime(3003n, timeBase(1n, 90000n)), mediaTime(1n, timeBase(1001n, 30000n))), 0);
});

test('source-exact packets validate bytes; repacked and API-seconds provenance stay explicit', () => {
  const budget = new BudgetLedger(limits());
  const p = packet(lease(budget));
  validatePacket(p);
  assert.equal(p.dtsTicks, null);
  assert.throws(() => validatePacket({ ...p, sourceSpans: [] }), codeIs('INVALID_PACKET'));
  validatePacket({ ...p, sourceSpans: [{ ...p.sourceSpans[0], range: byteRange(0, 12) }], representation: { kind: 'repacked', transformations: ['adts-header-removed'] } });
  validatePacket({ ...p, sourceSpans: null, representation: { kind: 'opaque-adapter', reason: 'API does not expose spans' }, timingProvenance: { kind: 'api-seconds', originalPtsSeconds: -1 / 30, transformDescription: 'Converted at the documented adapter boundary' } });
  assert.throws(() => validatePacket({ ...p, timingProvenance: { kind: 'api-seconds', originalPtsSeconds: null, transformDescription: null } }), codeIs('INVALID_PACKET'));
  p.bytes.release();
});

test('reservation enforces bytes and count before allocation, and has explicit oversize refusal', () => {
  const budget = new BudgetLedger(limits(8, 2, 6));
  const a = budget.tryReserve(byteLength(6));
  assert.equal(budget.tryReserve(byteLength(3)), null);
  const b = budget.tryReserve(byteLength(2));
  assert.equal(budget.tryReserve(byteLength(0)), null);
  assert.throws(() => budget.tryReserve(byteLength(7)), codeIs('ITEM_TOO_LARGE'));
  a.release(); a.release(); b.release();
  assert.deepEqual(budget.snapshot(), { bytes: 0, items: 0, peakBytes: 8, peakItems: 2 });
});

test('lease moves preserve global accounting and destroy exactly once', () => {
  const budget = new BudgetLedger(limits()); let destroyed = 0;
  const sender = lease(budget, [1, 2, 3], () => { destroyed++; });
  const receiver = sender.move();
  assert.throws(() => sender.borrow(), codeIs('OWNERSHIP_VIOLATION'));
  sender.release();
  assert.equal(budget.snapshot().bytes, 3);
  receiver.release(); receiver.release();
  assert.equal(destroyed, 1);
  assert.equal(budget.snapshot().bytes, 0);
});

test('destructor failure still returns the allocation budget', () => {
  const budget = new BudgetLedger(limits());
  const owned = lease(budget, [1], () => { throw Error('test destruction failure'); });
  assert.throws(() => owned.release(), /test destruction failure/);
  owned.release();
  assert.equal(budget.snapshot().bytes, 0);
});

test('queue admission moves only admitted items and does not double-count backing stores', () => {
  const budget = new BudgetLedger(limits()); const queue = new OwnedQueue(limits(4, 1));
  const a = lease(budget, [1, 2, 3]), b = lease(budget, [4, 5]);
  assert.equal(queue.tryPush(a), true);
  assert.equal(queue.tryPush(b), false);
  assert.equal(b.state, 'owned');
  assert.equal(budget.snapshot().bytes, 5);
  const popped = queue.pop();
  assert.equal(queue.snapshot().bytes, 0);
  assert.equal(budget.snapshot().bytes, 5);
  popped.release(); b.release(); queue.dispose();
  assert.equal(budget.snapshot().bytes, 0);
});

test('stale generations release delivered ownership and disposal is terminal', () => {
  const epochs = new EpochController('s'), budget = new BudgetLedger(limits());
  const old = epochs.capture(); epochs.advance();
  assert.equal(acceptCurrent(epochs, old, lease(budget)), null);
  assert.equal(budget.snapshot().bytes, 0);
  epochs.dispose(); epochs.dispose();
  assert.throws(() => epochs.advance(), codeIs('DISPOSED'));
});

test('cancellation notifies all listeners even when one listener fails', () => {
  const controller = new CancellationController(); let notified = 0;
  controller.signal.subscribe(() => { throw Error('listener failure'); });
  controller.signal.subscribe(() => { notified++; });
  assert.throws(() => controller.abort(), AggregateError);
  controller.abort();
  assert.equal(notified, 1);
});

test('exact memory source handles zero-length EOF, cancellation, bounds, and terminal close', async () => {
  const clock = new ManualScheduler(), budget = new BudgetLedger(limits());
  const source = new MemorySource(new Uint8Array([1, 2, 3]), budget, clock);
  const stamp = sessionStamp('s', 0);
  const empty = await source.readExact(byteRange(3, 3), context(stamp, 'eof'));
  assert.equal(empty.bytes.borrow().length, 0); empty.bytes.release();
  await assert.rejects(source.readExact(byteRange(2, 4), context(stamp, 'past-eof')), codeIs('RANGE_OUTSIDE_SOURCE'));
  const abort = new CancellationController(); abort.abort();
  await assert.rejects(source.readExact(byteRange(0, 1), context(stamp, 'abort', abort)), codeIs('CANCELLED'));
  await source.close(); await source.close();
  await assert.rejects(source.readExact(byteRange(0, 1), context(stamp, 'closed')), codeIs('DISPOSED'));
  assert.equal(budget.snapshot().items, 0);
});

test('decoder output capacity is reserved before consuming input', async () => {
  const clock = new ManualScheduler(), input = new BudgetLedger(limits()), output = new BudgetLedger(limits(4, 1));
  const stamp = sessionStamp('s', 0), codec = new FakeCodec(stamp, output, clock);
  const a = packet(lease(input), stamp, 'a'), b = packet(lease(input), stamp, 'b');
  const consumed = accepted(codec.trySubmit(a, context(stamp, 'a')));
  assert.equal(a.bytes.state, 'moved');
  assert.equal(codec.trySubmit(b, context(stamp, 'b')).status, 'backpressure');
  assert.equal(b.bytes.state, 'owned');
  codec.complete('a'); await consumed;
  const frame = await codec.readOutput(context(stamp, 'read-a'));
  assert.deepEqual([...frame.payload.borrow().data], [3, 6, 250, 206]);
  assert.equal(input.snapshot().bytes, 3);
  assert.equal(output.snapshot().bytes, 4);
  frame.payload.release(); b.bytes.release(); await codec.dispose();
  assert.equal(input.snapshot().bytes + output.snapshot().bytes, 0);
});

test('input consumption and output stream allow out-of-order completion without packet-output waits', async () => {
  const clock = new ManualScheduler(), input = new BudgetLedger(limits()), output = new BudgetLedger(limits());
  const stamp = sessionStamp('s', 0), codec = new FakeCodec(stamp, output, clock);
  const a = accepted(codec.trySubmit(packet(lease(input), stamp, 'packet-a'), context(stamp, 'a')));
  const b = accepted(codec.trySubmit(packet(lease(input), stamp, 'packet-b'), context(stamp, 'b')));
  const reading = codec.readOutput(context(stamp, 'read'));
  codec.complete('b'); const second = await reading;
  assert.equal(second.sourcePacketId, 'packet-b'); second.payload.release();
  codec.complete('a'); await Promise.all([a, b]);
  const first = await codec.readOutput(context(stamp, 'read-2')); first.payload.release();
  await codec.flushEndOfStream(context(stamp, 'eos'));
  assert.equal(await codec.readOutput(context(stamp, 'after-eos')), null);
  await codec.dispose(); assert.equal(clock.pendingCount(), 0);
});

test('decoder cancellation releases accepted input and reserved output', async () => {
  const clock = new ManualScheduler(), input = new BudgetLedger(limits()), output = new BudgetLedger(limits());
  const stamp = sessionStamp('s', 0), codec = new FakeCodec(stamp, output, clock), abort = new CancellationController();
  const consumed = accepted(codec.trySubmit(packet(lease(input), stamp), context(stamp, 'a', abort)));
  const rejected = assert.rejects(consumed, codeIs('CANCELLED'));
  abort.abort(); await rejected;
  assert.equal(codec.complete('a'), false);
  assert.equal(input.snapshot().bytes + output.snapshot().bytes, 0);
  await codec.dispose(); assert.equal(clock.pendingCount(), 0);
});

test('finite deadlines settle never-completed input and empty output waits', async () => {
  const clock = new ManualScheduler(), input = new BudgetLedger(limits()), output = new BudgetLedger(limits());
  const stamp = sessionStamp('s', 0), codec = new FakeCodec(stamp, output, clock);
  const consumed = accepted(codec.trySubmit(packet(lease(input), stamp), context(stamp, 'a', undefined, 10)));
  const inputFailure = assert.rejects(consumed, codeIs('DEADLINE_EXCEEDED'));
  const outputFailure = assert.rejects(codec.readOutput(context(stamp, 'read', undefined, 10)), codeIs('DEADLINE_EXCEEDED'));
  clock.advanceTo(10); await Promise.all([inputFailure, outputFailure]);
  assert.equal(input.snapshot().bytes + output.snapshot().bytes, 0);
  await codec.dispose(); assert.equal(clock.pendingCount(), 0);
});

test('reset invalidates pending work and releases queued old-epoch output before ready', async () => {
  const clock = new ManualScheduler(), input = new BudgetLedger(limits()), output = new BudgetLedger(limits());
  const stamp = sessionStamp('s', 0), next = sessionStamp('s', 1), codec = new FakeCodec(stamp, output, clock);
  const a = accepted(codec.trySubmit(packet(lease(input), stamp, 'a'), context(stamp, 'a')));
  const b = accepted(codec.trySubmit(packet(lease(input), stamp, 'b'), context(stamp, 'b')));
  codec.complete('a'); await a;
  const rejected = assert.rejects(b, codeIs('STALE_EPOCH'));
  const readiness = codec.reset(next, context(next, 'reset'));
  assert.equal(codec.queuedOutputCount(), 0);
  await Promise.all([readiness, rejected]);
  assert.equal(input.snapshot().bytes + output.snapshot().bytes, 0);
  const p = packet(lease(input), stamp, 'old');
  const result = codec.trySubmit(p, context(stamp, 'old'));
  assert.equal(result.status, 'rejected'); assert.equal(p.bytes.state, 'owned'); p.bytes.release();
  await codec.dispose(); assert.equal(clock.pendingCount(), 0);
});

test('dispose settles pending input and reads, releases queued output, and remains terminal', async () => {
  const clock = new ManualScheduler(), input = new BudgetLedger(limits()), output = new BudgetLedger(limits());
  const stamp = sessionStamp('s', 0), codec = new FakeCodec(stamp, output, clock);
  const consumed = accepted(codec.trySubmit(packet(lease(input), stamp), context(stamp, 'a')));
  const inputFailure = assert.rejects(consumed, codeIs('DISPOSED'));
  const outputFailure = assert.rejects(codec.readOutput(context(stamp, 'read')), codeIs('DISPOSED'));
  await codec.dispose(); await codec.dispose(); await Promise.all([inputFailure, outputFailure]);
  assert.equal(input.snapshot().bytes + output.snapshot().bytes, 0);
  await assert.rejects(codec.readOutput(context(stamp, 'closed')), codeIs('DISPOSED'));
  assert.equal(clock.pendingCount(), 0);
});

test('drain waits only for already-accepted input; flush seals admission and exposes EOS', async () => {
  const clock = new ManualScheduler(), input = new BudgetLedger(limits()), output = new BudgetLedger(limits());
  const stamp = sessionStamp('s', 0), codec = new FakeCodec(stamp, output, clock);
  const a = accepted(codec.trySubmit(packet(lease(input), stamp, 'a'), context(stamp, 'a')));
  const drained = codec.drain(context(stamp, 'drain'));
  const b = accepted(codec.trySubmit(packet(lease(input), stamp, 'b'), context(stamp, 'b')));
  codec.complete('a'); await Promise.all([a, drained]);
  assert.equal(codec.pendingCount(), 1);
  const flush = codec.flushEndOfStream(context(stamp, 'flush'));
  const extra = packet(lease(input), stamp, 'extra');
  assert.equal(codec.trySubmit(extra, context(stamp, 'extra')).status, 'rejected'); extra.bytes.release();
  codec.complete('b'); await Promise.all([b, flush]);
  (await codec.readOutput(context(stamp, 'read-a'))).payload.release();
  (await codec.readOutput(context(stamp, 'read-b'))).payload.release();
  assert.equal(await codec.readOutput(context(stamp, 'eos')), null);
  await codec.dispose(); assert.equal(input.snapshot().bytes + output.snapshot().bytes, 0);
});
