import {
  EngineError, OwnedLease, byteLength, checkOperation, mediaTime, sameEpoch,
  sessionStamp, validatePacket,
  type BudgetLedger, type Decoder, type DeadlineScheduler,
  type EffectiveDecoderConfiguration, type EncodedPacket, type OperationContext,
  type OwnedOutput, type Reservation, type SessionStamp, type Submission,
} from '@ubve/core';

/** Deliberately not a media format. Four marker bytes exercise resource lifetimes. */
export interface TestMarker { readonly kind: 'test-marker'; readonly data: Uint8Array; }
interface Pending {
  packet: EncodedPacket;
  input: OwnedLease<Uint8Array>;
  context: OperationContext;
  reservation: Reservation;
  inputConsumed: Promise<void>;
  resolve: () => void;
  reject: (error: EngineError) => void;
  cancelDeadline: () => void;
  unsubscribe: () => void;
}
interface OutputReader {
  context: OperationContext;
  resolve: (output: OwnedOutput<TestMarker> | null) => void;
  reject: (error: EngineError) => void;
  cancelDeadline: () => void;
  unsubscribe: () => void;
}

/** Manually completed fake codec for admission, cancellation and epoch races.
 * It does not parse compressed media, render, or support any actual codec.
 * Output can be completed in a different order from input. Input-consumption
 * promises and the bounded output stream have deliberately separate lifetimes.
 */
export class FakeCodec implements Decoder<TestMarker> {
  readonly effective: EffectiveDecoderConfiguration;
  #stamp: SessionStamp;
  #configEpoch: number;
  #budget: BudgetLedger;
  #scheduler: DeadlineScheduler;
  #pending = new Map<string, Pending>();
  #outputs: OwnedOutput<TestMarker>[] = [];
  #reader: OutputReader | null = null;
  #disposed = false;
  #flushing = false;
  #ended = false;
  constructor(stamp: SessionStamp, budget: BudgetLedger, scheduler: DeadlineScheduler, configEpoch = 0) {
    this.#stamp = sessionStamp(stamp.sessionId, stamp.generation);
    this.#budget = budget;
    this.#scheduler = scheduler;
    this.#configEpoch = configEpoch;
    this.effective = Object.freeze({ codecId: 'test-marker-v1', workers: 0, sharedMemory: false, outputLayout: 'test-marker',
      resources: Object.freeze({ explicitInputBudgetEnforced: false, explicitOutputBudgetEnforced: true,
        internalHeap: 'opaque', internalHeapLimitBytes: null, internalHeapEstimateBytes: null,
        runtimeLifetime: 'session', completeShutdown: 'implemented-and-tested' }) });
  }
  #check(context: OperationContext): void {
    if (this.#disposed) throw new EngineError('DISPOSED', 'Decoder is disposed', 'new-session');
    checkOperation(context, this.#scheduler);
    if (!sameEpoch(context.stamp, this.#stamp)) throw new EngineError('STALE_EPOCH', 'Obsolete operation generation');
  }
  trySubmit(packet: EncodedPacket, context: OperationContext): Submission {
    let reservation: Reservation | null = null;
    let accepted: Pending | null = null;
    try {
      this.#check(context);
      if (this.#flushing) throw new EngineError('INVALID_ARGUMENT', 'Input after EOS requires reset', 'caller-fix');
      validatePacket(packet);
      if (!sameEpoch(packet.stamp, context.stamp)) throw new EngineError('STALE_EPOCH', 'Packet generation differs from operation');
      if (packet.codecConfigEpoch !== this.#configEpoch) throw new EngineError('INVALID_PACKET', 'Configuration epoch differs from decoder', 'caller-fix');
      if (this.#pending.has(context.operationId)) throw new EngineError('INVALID_ARGUMENT', 'Duplicate pending operation identity', 'caller-fix');
      reservation = this.#budget.tryReserve(byteLength(4));
      if (!reservation) return { status: 'backpressure', reason: 'capacity' };
      const input = packet.bytes.move();
      let resolve!: Pending['resolve'], reject!: Pending['reject'];
      const inputConsumed = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
      const pending: Pending = { packet, input, context, reservation, inputConsumed, resolve, reject, cancelDeadline: () => {}, unsubscribe: () => {} };
      accepted = pending;
      this.#pending.set(context.operationId, pending);
      pending.cancelDeadline = this.#scheduler.at(context.deadlineMs, () => this.#fail(context.operationId, new EngineError('DEADLINE_EXCEEDED', 'Decode deadline elapsed')));
      pending.unsubscribe = context.cancellation.subscribe(reason => this.#fail(context.operationId, reason));
      return { status: 'accepted', inputConsumed };
    } catch (error) {
      const failure = error instanceof EngineError ? error : new EngineError('INTERNAL', 'Fake codec submission failed');
      if (accepted) {
        this.#fail(context.operationId, failure);
        return { status: 'accepted', inputConsumed: accepted.inputConsumed };
      }
      reservation?.release();
      return { status: 'rejected', error: failure };
    }
  }
  #remove(id: string): Pending | null {
    const p = this.#pending.get(id);
    if (!p) return null;
    this.#pending.delete(id);
    p.cancelDeadline(); p.unsubscribe();
    return p;
  }
  #fail(id: string, error: EngineError): void {
    const p = this.#remove(id);
    if (!p) return;
    let failure = error;
    try { p.input.release(); } catch { failure = new EngineError('INTERNAL', 'Input destruction failed'); }
    finally { p.reservation.release(); p.reject(failure); }
  }
  #settleReader(output: OwnedOutput<TestMarker> | null, error: EngineError | null = null): void {
    const reader = this.#reader;
    if (!reader) { output?.payload.release(); return; }
    this.#reader = null;
    reader.cancelDeadline(); reader.unsubscribe();
    if (!error) {
      try { this.#check(reader.context); } catch (failure) {
        error = failure instanceof EngineError ? failure : new EngineError('INTERNAL', 'Output read validation failed');
      }
    }
    if (error) { output?.payload.release(); reader.reject(error); }
    else reader.resolve(output);
  }
  /** Tests choose completion order explicitly. This marker codec emits one
   * output per input; the public decoder contract does not require that ratio.
   */
  complete(id: string): boolean {
    const pending = this.#pending.get(id);
    if (!pending) return false;
    try { this.#check(pending.context); } catch (error) {
      this.#fail(id, error instanceof EngineError ? error : new EngineError('INTERNAL', 'Completion check failed'));
      return false;
    }
    const p = this.#remove(id);
    if (!p) return false;
    let lease: OwnedLease<TestMarker> | null = null;
    try {
      let checksum = 0;
      for (const value of p.input.borrow()) checksum = (checksum + value) % 256;
      const marker = new Uint8Array([p.input.borrow().byteLength % 256, checksum, 0xfa, 0xce]);
      const payload = OwnedLease.adopt<TestMarker>(p.reservation, Object.freeze({ kind: 'test-marker', data: marker }));
      lease = payload;
      p.input.release();
      const output = Object.freeze({ stamp: p.context.stamp, operationId: id, sourcePacketId: p.packet.id,
        pts: mediaTime(p.packet.ptsTicks, p.packet.timeBase), durationTicks: p.packet.durationTicks,
        codecConfigEpoch: p.packet.codecConfigEpoch, payload });
      if (this.#reader) this.#settleReader(output); else this.#outputs.push(output);
      p.resolve();
    } catch (error) {
      try { p.input.release(); } finally { lease?.release(); p.reservation.release(); }
      p.reject(error instanceof EngineError ? error : new EngineError('INTERNAL', 'Fake codec completion failed'));
    }
    return true;
  }
  readOutput(context: OperationContext): Promise<OwnedOutput<TestMarker> | null> {
    try {
      this.#check(context);
      if (this.#reader) throw new EngineError('INVALID_ARGUMENT', 'Only one output consumer is admitted', 'caller-fix');
      const output = this.#outputs.shift();
      if (output) return Promise.resolve(output);
      if (this.#ended) return Promise.resolve(null);
    } catch (error) { return Promise.reject(error); }
    return new Promise((resolve, reject) => {
      const reader: OutputReader = { context, resolve, reject, cancelDeadline: () => {}, unsubscribe: () => {} };
      this.#reader = reader;
      reader.cancelDeadline = this.#scheduler.at(context.deadlineMs, () => this.#settleReader(null, new EngineError('DEADLINE_EXCEEDED', 'Output read deadline elapsed')));
      reader.unsubscribe = context.cancellation.subscribe(reason => this.#settleReader(null, reason));
    });
  }
  drain(context: OperationContext): Promise<void> {
    try { this.#check(context); } catch (error) { return Promise.reject(error); }
    const beforeCall = [...this.#pending.values()].map(p => p.inputConsumed);
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let cancelDeadline = () => {}, unsubscribe = () => {};
      const finish = (error: unknown = null) => {
        if (settled) return;
        settled = true; cancelDeadline(); unsubscribe();
        if (error) { reject(error); return; }
        try { this.#check(context); resolve(); } catch (failure) { reject(failure); }
      };
      cancelDeadline = this.#scheduler.at(context.deadlineMs, () => finish(new EngineError('DEADLINE_EXCEEDED', 'Drain deadline elapsed')));
      unsubscribe = context.cancellation.subscribe(finish);
      void Promise.allSettled(beforeCall).then(results => {
        const failed = results.find(result => result.status === 'rejected');
        finish(failed?.status === 'rejected' ? failed.reason : null);
      });
    });
  }
  async flushEndOfStream(context: OperationContext): Promise<void> {
    this.#check(context);
    this.#flushing = true;
    await this.drain(context);
    this.#check(context);
    this.#ended = true;
    if (this.#reader && this.#outputs.length === 0) this.#settleReader(null);
  }
  reset(next: SessionStamp, context: OperationContext): Promise<void> {
    try {
      if (this.#disposed) throw new EngineError('DISPOSED', 'Decoder is disposed', 'new-session');
      checkOperation(context, this.#scheduler);
      if (!sameEpoch(next, context.stamp) || next.sessionId !== this.#stamp.sessionId || next.generation <= this.#stamp.generation) throw new EngineError('INVALID_ARGUMENT', 'Reset requires a later generation and matching operation', 'caller-fix');
      this.#stamp = sessionStamp(next.sessionId, next.generation);
      this.#flushing = false; this.#ended = false;
      for (const id of [...this.#pending.keys()]) this.#fail(id, new EngineError('STALE_EPOCH', 'Decoder reset invalidated pending input'));
      for (const output of this.#outputs.splice(0)) output.payload.release();
      if (this.#reader) this.#settleReader(null, new EngineError('STALE_EPOCH', 'Reset invalidated output read'));
      return Promise.resolve();
    } catch (error) { return Promise.reject(error); }
  }
  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const id of [...this.#pending.keys()]) this.#fail(id, new EngineError('DISPOSED', 'Decoder disposed', 'new-session'));
    for (const output of this.#outputs.splice(0)) output.payload.release();
    if (this.#reader) this.#settleReader(null, new EngineError('DISPOSED', 'Decoder disposed', 'new-session'));
  }
  pendingCount(): number { return this.#pending.size; }
  queuedOutputCount(): number { return this.#outputs.length; }
}
